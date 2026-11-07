import fs from "node:fs/promises";
import path from "node:path";
import { CitrusError } from "./errors.js";

/** Convierte un nombre en un nombre de archivo seguro y legible. */
export function slugify(name, fallback = "sin-nombre") {
  const slug = String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

/**
 * Une una ruta relativa a `root` y exige que quede dentro.
 * Sigue enlaces simbólicos de lo que ya existe, para que un enlace no saque la ruta de la carpeta.
 */
export async function insideRoot(root, relative) {
  const rel = String(relative ?? "");
  const outside = () => new CitrusError("PATH_OUTSIDE", `La ruta '${rel}' queda fuera del workspace.`);
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw outside();

  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  const isInside = (parent, child) => {
    const r = path.relative(parent, child);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  if (!isInside(base, full)) throw outside();

  const realBase = await fs.realpath(base);
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(realBase, real)) throw outside();
      break;
    } catch (e) {
      if (e instanceof CitrusError) throw e;
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return full;
}

/** Elige un nombre libre dentro de `dir`: base.ext, base-2.ext, base-3.ext… */
export async function freeName(dir, base, ext) {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
}
