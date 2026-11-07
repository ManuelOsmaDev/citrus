// Construye la página con `tangerine build` y copia lo que el HTML no lleva adentro.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

// Los datos de descarga salen del instalador real: tamaño y hash nunca se escriben a mano.
const appDir = path.join(root, "..", "app");
const { version } = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
const file = `Citrus-Setup-${version}.exe`;
const installer = path.join(appDir, "release", file);
let release = null;
if (fs.existsSync(installer)) {
  const data = fs.readFileSync(installer);
  release = {
    version,
    file,
    size: `${Math.round(data.length / 1048576)} MB`,
    sha256: createHash("sha256").update(data).digest("hex"),
    // Con CITRUS_DOWNLOAD_URL el archivo vive fuera del sitio, por ejemplo en GitHub Releases.
    url: process.env.CITRUS_DOWNLOAD_URL || `downloads/${file}`,
  };
}
fs.writeFileSync(
  path.join(root, "src", "release.tng"),
  `// Generado por scripts/build.mjs.\nexport let RELEASE = ${release ? `from_json('${JSON.stringify(release)}')` : "nil"}\n`,
);

const cli = path.join(packageDir("tangerine-lang"), "bin", "tangerine.js");
const result = spawnSync(process.execPath, [cli, "build"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

const out = path.join(root, "dist", "assets");
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, "assets"), out, { recursive: true });
fs.copyFileSync(path.join(packageDir("@fontsource-variable/geist"), "files", "geist-latin-wght-normal.woff2"), path.join(out, "geist.woff2"));
fs.copyFileSync(path.join(packageDir("@fontsource-variable/geist-mono"), "files", "geist-mono-latin-wght-normal.woff2"), path.join(out, "geist-mono.woff2"));
if (release && !process.env.CITRUS_DOWNLOAD_URL) {
  const downloads = path.join(root, "dist", "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  fs.copyFileSync(installer, path.join(downloads, file));
}
console.log(`Página lista en packages/site/dist. ${release ? `Descarga: ${release.url} (${release.size})` : "Sin instalador: genera uno con npm run dist."}`);
