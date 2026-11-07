import { CitrusError } from "./errors.js";
import { setSecret } from "./environments.js";
import { looksSensitive, secretCollector } from "./importers/secrets.js";

// Antes de guardar: lo que se escribe en un .citrus.yaml termina en Git.
const PATTERNS = [
  { kind: "Clave de AWS", hint: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "Token JWT", hint: "jwt_token", regex: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g },
  { kind: "Token de GitHub", hint: "github_token", regex: /\bgh[pousr]_\w{30,}\b/g },
  { kind: "Token de Slack", hint: "slack_token", regex: /\bxox[abprs]-[\w-]{10,}/g },
  { kind: "Clave de Stripe", hint: "stripe_key", regex: /\b[sr]k_live_\w{10,}/g },
  { kind: "Clave de API", hint: "api_key", regex: /\bsk-[\w-]{20,}/g },
  { kind: "Clave privada", hint: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie)$/i;
const isReference = (text) => /\{\{[^}]+\}\}/.test(text);

function collectStrings(value, where, out) {
  if (typeof value === "string") out.push({ where, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${where}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectStrings(v, where ? `${where}.${k}` : k, out);
  }
}

/** Busca credenciales escritas a mano. Cada hallazgo lleva el valor: nunca se manda a la UI tal cual. */
export function scanModel(model) {
  const findings = [];
  const add = (where, kind, hint, value) => {
    if (value && !findings.some((f) => f.value === value)) findings.push({ where, kind, hint, value });
  };

  const strings = [];
  collectStrings({ url: model.url, body: model.body?.text, event: model.eventText }, "", strings);
  for (const row of [...(model.headers ?? []), ...(model.body?.rows ?? [])]) {
    collectStrings(row.value, row.key, strings);
  }
  for (const { where, text } of strings) {
    for (const { kind, hint, regex } of PATTERNS) {
      for (const match of text.matchAll(regex)) add(where, kind, hint, match[0]);
    }
  }
  // Después de los patrones: si ya se reconoció el tipo exacto, ese nombre es mejor.
  for (const row of [...(model.headers ?? []), ...(model.body?.rows ?? [])]) {
    if (row.isFile === true || !row.value || row.enabled === false || isReference(row.value)) continue;
    if (!CREDENTIAL_HEADER.test(row.key) && !looksSensitive(row.key)) continue;
    const value = String(row.value).replace(/^(Bearer|Basic|Token)\s+/i, "");
    if (!findings.some((f) => String(row.value).includes(f.value))) add(row.key, "Credencial", row.key, value);
  }
  const auth = model.auth ?? {};
  if (auth.type === "bearer" && auth.token && !isReference(auth.token)) add("Auth", "Token", "bearer_token", auth.token);
  if (auth.type === "basic" && auth.password && !isReference(auth.password)) add("Auth", "Contraseña", "basic_password", auth.password);
  if (auth.type === "apikey" && auth.value && !isReference(auth.value)) add("Auth", "Clave de API", auth.key || "api_key", auth.value);
  return findings;
}

/** Versión segura para mostrar: nunca incluye el valor completo. */
export const publicFindings = (findings) =>
  findings.map(({ where, kind, value }) => ({ where, kind, preview: value.length > 8 ? `${value.slice(0, 4)}…` : "••••" }));

function replaceDeep(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "key" ? v : replaceDeep(v, from, to)]));
  }
  return value;
}

/** Guarda los valores en el llavero y deja {{nombre}} en el modelo. */
export async function moveFindingsToSecrets({ root, envId, model, findings, store }) {
  if (!envId) throw new CitrusError("NO_ENV", "Elige un entorno para guardar los secretos.");
  const collector = secretCollector();
  let out = model;
  const names = [];
  for (const finding of findings) {
    const name = collector.name(finding.hint, finding.value);
    await setSecret(root, envId, name, finding.value, store);
    out = replaceDeep(out, finding.value, `{{${name}}}`);
    names.push(name);
  }
  return { model: out, names };
}
