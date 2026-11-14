// Exportar una carpeta para quien no usa Citrus: una colección de Postman o un archivo con comandos curl.
// Nunca llevan el valor de un secreto: quedan como {{nombre}}.
import { resolveEnvironment } from "./environments.js";
import { CitrusError } from "./errors.js";
import { buildSnippet } from "./snippets.js";
import { listTree, readRequest } from "./workspace.js";

function findFolder(nodes, folder) {
  if (!folder) return nodes;
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.path === folder) return node.children;
    const inner = findFolder(node.children, folder);
    if (inner) return inner;
  }
  return null;
}

async function requestsIn(root, folder) {
  const nodes = findFolder(await listTree(root), folder);
  if (!nodes) throw new CitrusError("FOLDER_NOT_FOUND", `No existe la carpeta ${folder}.`);
  return nodes;
}

const enabled = (row) => row.enabled !== false;

function postmanBody(body) {
  switch (body?.mode) {
    case "json":
      return { mode: "raw", raw: body.text ?? "", options: { raw: { language: "json" } } };
    case "raw":
      return { mode: "raw", raw: body.text ?? "" };
    case "form":
      return { mode: "urlencoded", urlencoded: (body.rows ?? []).map((r) => ({ key: r.key, value: r.value, disabled: !enabled(r) || undefined })) };
    case "multipart":
      return {
        mode: "formdata",
        formdata: (body.rows ?? []).map((r) =>
          r.isFile ? { key: r.key, type: "file", src: r.value, disabled: !enabled(r) || undefined } : { key: r.key, value: r.value, type: "text", disabled: !enabled(r) || undefined },
        ),
      };
    case "binary":
      return { mode: "file", file: { src: body.file ?? "" } };
    default:
      return undefined;
  }
}

function postmanAuth(auth) {
  const kv = (pairs) => Object.entries(pairs).map(([key, value]) => ({ key, value, type: "string" }));
  switch (auth?.type) {
    case "bearer":
      return { type: "bearer", bearer: kv({ token: auth.token ?? "" }) };
    case "basic":
      return { type: "basic", basic: kv({ username: auth.username ?? "", password: auth.password ?? "" }) };
    case "apikey":
      return { type: "apikey", apikey: kv({ key: auth.key ?? "", value: auth.value ?? "", in: auth.in === "query" ? "query" : "header" }) };
    default:
      return undefined;
  }
}

function postmanItem(model) {
  const request = {
    method: model.method,
    header: (model.headers ?? []).filter((h) => h.key).map((h) => ({ key: h.key, value: h.value, disabled: !enabled(h) || undefined })),
    url: model.url,
  };
  const body = postmanBody(model.body);
  if (body) request.body = body;
  const auth = postmanAuth(model.auth);
  if (auth) request.auth = auth;
  return { name: model.name, request };
}

async function walkPostman(root, nodes, warnings, counter) {
  const items = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      items.push({ name: node.name, item: await walkPostman(root, node.children, warnings, counter) });
      continue;
    }
    if (node.type === "invalid") {
      warnings.push(`${node.id}: el YAML no es válido y no se exportó.`);
      continue;
    }
    const { model } = await readRequest(root, node.id);
    if (model.type === "lambda") {
      warnings.push(`${model.name}: es una Lambda. Postman no invoca Lambdas, así que no se exportó.`);
      continue;
    }
    if (model.scripts?.before || model.scripts?.after) warnings.push(`${model.name}: sus scripts están en Tangerine y Postman no los entiende. Se exportó sin ellos.`);
    items.push(postmanItem(model));
    counter.count++;
  }
  return items;
}

/** Variables del entorno para la colección. Los secretos van vacíos: cada persona pone los suyos. */
async function postmanVariables(root, envId, store) {
  if (!envId) return [];
  const env = await resolveEnvironment(root, envId, store, {}, { loadAws: false });
  const values = env.variableNames.filter((n) => !env.secretNames.includes(n)).map((key) => ({ key, value: env.scope.get(key) ?? "" }));
  const secrets = env.secretNames.map((key) => ({ key, value: "", description: "Secreto: escribe tu propio valor." }));
  return [...values, ...secrets];
}

/** Una colección de Postman v2.1 lista para File > Import. */
export async function exportPostman({ root, folder = "", name, envId = null, store }) {
  const nodes = await requestsIn(root, folder);
  const warnings = [];
  const counter = { count: 0 };
  const item = await walkPostman(root, nodes, warnings, counter);
  const collection = {
    info: {
      name: name || folder.split("/").pop() || "Citrus",
      description: "Exportada desde Citrus.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item,
    variable: await postmanVariables(root, envId, store),
  };
  return { text: `${JSON.stringify(collection, null, 2)}\n`, count: counter.count, warnings };
}

/** Un comando curl por request, con las variables del entorno ya puestas y los secretos como {{nombre}}. */
export async function exportCurl({ root, folder = "", envId = null, store }) {
  const nodes = await requestsIn(root, folder);
  const warnings = [];
  const parts = [`# Exportado desde Citrus. Los secretos quedan como {{nombre}}: reemplázalos antes de correr cada comando.\n`];
  let count = 0;
  const walk = async (list, trail) => {
    for (const node of list) {
      if (node.kind === "folder") {
        await walk(node.children, [...trail, node.name]);
        continue;
      }
      if (node.type === "invalid") {
        warnings.push(`${node.id}: el YAML no es válido y no se exportó.`);
        continue;
      }
      const { model } = await readRequest(root, node.id);
      if (model.type === "lambda") {
        warnings.push(`${model.name}: es una Lambda y no tiene un comando curl. No se exportó.`);
        continue;
      }
      const title = [...trail, model.name].join(" / ");
      parts.push(`# ${title}\n${await buildSnippet({ root, model, envId, store, language: "curl" })}\n`);
      count++;
    }
  };
  await walk(nodes, []);
  return { text: parts.join("\n"), count, warnings };
}
