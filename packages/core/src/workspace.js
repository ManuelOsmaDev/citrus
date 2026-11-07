import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { CitrusError } from "./errors.js";
import { emptyModel, modelFromFile, modelToPatch } from "./model.js";
import { freeName, insideRoot, slugify } from "./paths.js";

export const CONFIG_FILE = "citrus.config.yaml";
export const COLLECTIONS_DIR = "collections";
export const ENVIRONMENTS_DIR = "environments";
export const STATE_DIR = ".citrus";
const REQUEST_EXT = ".citrus.yaml";

const exists = (p) => fs.access(p).then(() => true, () => false);

export const isWorkspace = (root) => exists(path.join(root, CONFIG_FILE));

/** Asegura que el historial y los datos locales nunca entren al repo. */
async function ensureGitignore(root) {
  const file = path.join(root, ".gitignore");
  const entry = `${STATE_DIR}/`;
  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${current}${prefix}# Citrus: historial y estado local\n${entry}\n`);
}

/** Crea un workspace nuevo. No pisa archivos existentes. */
export async function initWorkspace(root, { name } = {}) {
  if (await isWorkspace(root)) return openWorkspace(root);
  await fs.mkdir(path.join(root, COLLECTIONS_DIR), { recursive: true });
  await fs.mkdir(path.join(root, ENVIRONMENTS_DIR), { recursive: true });
  const title = name || path.basename(path.resolve(root));
  await fs.writeFile(path.join(root, CONFIG_FILE), YAML.stringify({ name: title, version: 1, defaultEnvironment: "local" }));
  const env = path.join(root, ENVIRONMENTS_DIR, "local.yaml");
  if (!(await exists(env))) {
    await fs.writeFile(env, YAML.stringify({ name: "local", protected: false, variables: { baseUrl: "http://localhost:3000" }, secrets: [] }));
  }
  return openWorkspace(root);
}

export async function openWorkspace(root) {
  const resolved = path.resolve(root);
  if (!(await isWorkspace(resolved))) {
    throw new CitrusError("NOT_WORKSPACE", `La carpeta no es un workspace de Citrus: falta ${CONFIG_FILE}.`);
  }
  let config;
  try {
    config = YAML.parse(await fs.readFile(path.join(resolved, CONFIG_FILE), "utf8")) ?? {};
  } catch (e) {
    throw new CitrusError("BAD_CONFIG", `${CONFIG_FILE} no es YAML válido: ${e.message}`);
  }
  await fs.mkdir(path.join(resolved, COLLECTIONS_DIR), { recursive: true });
  await ensureGitignore(resolved);
  return {
    root: resolved,
    name: String(config.name ?? path.basename(resolved)),
    defaultEnvironment: config.defaultEnvironment ? String(config.defaultEnvironment) : null,
  };
}

/** Ruta absoluta de una request a partir de su id (ruta relativa a collections/). */
export async function requestPath(root, id) {
  if (typeof id !== "string" || !id.endsWith(REQUEST_EXT)) {
    throw new CitrusError("BAD_REQUEST_ID", `Id de request inválido: ${id}`);
  }
  return insideRoot(path.join(root, COLLECTIONS_DIR), id);
}

async function summarize(file, id, fallback) {
  try {
    const model = modelFromFile(YAML.parse(await fs.readFile(file, "utf8")), fallback);
    return { kind: "request", id, name: model.name, type: model.type, method: model.method ?? null };
  } catch (e) {
    return { kind: "request", id, name: fallback, type: "invalid", method: null, error: e.message };
  }
}

/** Árbol de colecciones. Un archivo inválido aparece marcado, no rompe el resto. */
export async function listTree(root) {
  const base = path.join(root, COLLECTIONS_DIR);
  const walk = async (dir, prefix) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const folders = [];
    const requests = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        folders.push({ kind: "folder", name: entry.name, path: rel, children: await walk(path.join(dir, entry.name), rel) });
      } else if (entry.isFile() && entry.name.endsWith(REQUEST_EXT)) {
        requests.push(await summarize(path.join(dir, entry.name), rel, entry.name.slice(0, -REQUEST_EXT.length)));
      }
    }
    return [...folders, ...requests];
  };
  return walk(base, "");
}

export async function readRequest(root, id) {
  const file = await requestPath(root, id);
  const text = await fs.readFile(file, "utf8");
  let data;
  try {
    data = YAML.parse(text);
  } catch (e) {
    throw new CitrusError("BAD_YAML", `El archivo no es YAML válido: ${e.message}`);
  }
  return { id, model: modelFromFile(data, path.basename(id, REQUEST_EXT)), raw: text };
}

/**
 * Guarda solo lo que cambió, sobre el documento original.
 * Comentarios y campos que la UI no edita (assert, observe, capture…) quedan intactos.
 */
export async function saveRequest(root, id, model) {
  const file = await requestPath(root, id);
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new CitrusError("BAD_YAML", `No se guardó: el archivo tiene YAML inválido (${doc.errors[0].message}).`);
  if (doc.contents === null) doc.contents = doc.createNode({});

  const current = doc.toJS() ?? {};
  for (const [key, value] of Object.entries(modelToPatch(model))) {
    if (value === undefined) doc.delete(key);
    else if (!isDeepStrictEqual(current[key], value)) doc.set(key, doc.createNode(value));
  }
  const output = doc.toString();
  await fs.writeFile(file, output);
  return { id, raw: output };
}

/** Crea una request en una carpeta de la colección. Nunca pisa un archivo existente. */
export async function createRequest(root, { folder = "", name, model, extra } = {}) {
  const base = path.join(root, COLLECTIONS_DIR);
  await fs.mkdir(base, { recursive: true });
  const dir = folder ? await insideRoot(base, folder) : base;
  await fs.mkdir(dir, { recursive: true });
  const fileName = await freeName(dir, slugify(name), REQUEST_EXT);
  const id = folder ? `${folder.replace(/\\/g, "/")}/${fileName}` : fileName;
  const data = model ?? emptyModel(name);
  const doc = new YAML.Document({});
  for (const [key, value] of Object.entries(modelToPatch({ ...data, name: name ?? data.name }))) {
    if (value !== undefined) doc.set(key, doc.createNode(value));
  }
  for (const [key, value] of Object.entries(extra ?? {})) doc.set(key, doc.createNode(value));
  await fs.writeFile(path.join(dir, fileName), doc.toString());
  return { id };
}

export async function createFolder(root, { parent = "", name }) {
  const base = path.join(root, COLLECTIONS_DIR);
  const rel = [parent, slugify(name)].filter(Boolean).join("/");
  await fs.mkdir(await insideRoot(base, rel), { recursive: true });
  return { path: rel };
}
