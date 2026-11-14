import { resolveEnvironment } from "./environments.js";
import { prepareRequest } from "./prepare.js";
import { buildScope } from "./variables.js";

const AUTOMATIC = new Set(["user-agent", "accept", "accept-encoding"]);
const shell = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

function curl(req, bodyText) {
  const lines = [`curl -X ${req.method} ${shell(req.url)}`];
  for (const [k, v] of req.headers) lines.push(`  -H ${shell(`${k}: ${v}`)}`);
  if (bodyText != null) lines.push(`  --data-raw ${shell(bodyText)}`);
  return lines.join(" \\\n");
}

function jsHeaders(req) {
  return JSON.stringify(Object.fromEntries(req.headers), null, 2).replace(/\n/g, "\n  ");
}

function fetchSnippet(req, bodyText) {
  const body = bodyText != null ? `,\n  body: ${JSON.stringify(bodyText)}` : "";
  return `const response = await fetch(${JSON.stringify(req.url)}, {\n  method: ${JSON.stringify(req.method)},\n  headers: ${jsHeaders(req)}${body}\n});\nconst data = await response.json();`;
}

function axiosSnippet(req, bodyText) {
  const body = bodyText != null ? `,\n  data: ${JSON.stringify(bodyText)}` : "";
  return `const { data } = await axios({\n  method: ${JSON.stringify(req.method.toLowerCase())},\n  url: ${JSON.stringify(req.url)},\n  headers: ${jsHeaders(req)}${body}\n});`;
}

const WRITERS = { curl, fetch: fetchSnippet, axios: axiosSnippet };

/**
 * Genera código listo para pegar. Los secretos quedan como {{nombre}}:
 * un snippet se comparte en chats y PRs, así que nunca lleva el valor real.
 */
export async function buildSnippet({ root, model, envId, store, language = "curl" }) {
  const env = envId ? await resolveEnvironment(root, envId, store, {}, { loadAws: false }) : null;
  const variables = {};
  for (const name of env?.variableNames ?? []) {
    if (!env.secretNames.includes(name)) variables[name] = env.scope.get(name);
  }
  const secrets = Object.fromEntries((env?.secretNames ?? []).map((name) => [name, `{{${name}}}`]));
  const scope = buildScope({ variables, secrets });

  const draft = structuredClone(model);
  if (draft.auth?.type === "basic") {
    // Codificar {{secreto}} en base64 daría un header que parece válido y no lo es.
    draft.headers = [...(draft.headers ?? []), { key: "Authorization", value: `Basic <base64 de ${draft.auth.username}:${draft.auth.password}>`, enabled: true }];
    draft.auth = { type: "none" };
  }
  const req = await prepareRequest(draft, scope, { root, missingSecrets: [] });
  req.headers = req.headers.filter(([k]) => !AUTOMATIC.has(k.toLowerCase()));
  const textual = !["binary", "multipart"].includes(draft.body?.mode);
  const bodyText = req.body && textual ? req.body.toString("utf8") : null;
  const snippet = (WRITERS[language] ?? curl)(req, bodyText);
  return req.body && !textual ? `${snippet}\n\n# El body es un archivo: agrégalo a mano.` : snippet;
}
