// Scripts antes y después de enviar, escritos en Tangerine.
// Corren aislados: solo tienen lo que se les da aquí, sin acceso a archivos ni al sistema.
import crypto from "node:crypto";
import { fromJS, Tangerine, toJS } from "tangerine-lang";
import { CitrusError } from "./errors.js";
import { sendHttp } from "./http.js";
import { interpolate, maskSecrets } from "./variables.js";

const LIMIT_MS = 30_000;
const SECRET_HEADERS = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;

export const hasScript = (code) => typeof code === "string" && code.trim() !== "";

const native = (name, f) => Object.assign(f, { tngName: name });

function nativeMap(entries) {
  const map = Object.create(null);
  for (const [key, f] of Object.entries(entries)) map[key] = native(key, f);
  return map;
}

function text(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(toJS(value));
}

function keepSecret(env, value) {
  if (value.length >= 8 && !env.secretValues.includes(value)) env.secretValues.push(value);
}

function httpClient(env, signal) {
  const fill = (value) => interpolate(String(value), env.scope, new Set());
  async function send(method, url, body, options) {
    const opts = options ? toJS(options) : {};
    const headers = Object.entries(opts.headers ?? {}).map(([k, v]) => [k, fill(v)]);
    let payload = null;
    const plain = body === null || body === undefined ? null : toJS(body);
    if (typeof plain === "string") payload = Buffer.from(fill(plain));
    else if (plain !== null) {
      payload = Buffer.from(fill(JSON.stringify(plain)));
      if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
    }
    const res = await sendHttp({ method, url: fill(url), headers, body: payload }, { signal, timeoutMs: LIMIT_MS });
    const raw = res.body.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    return fromJS({ status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text: raw, json });
  }
  return nativeMap({
    get: (url, options) => send("GET", url, null, options),
    delete: (url, options) => send("DELETE", url, null, options),
    post: (url, body, options) => send("POST", url, body, options),
    put: (url, body, options) => send("PUT", url, body, options),
    patch: (url, body, options) => send("PATCH", url, body, options),
  });
}

function natives(env, captures, signal) {
  const http = httpClient(env, signal);
  const hash = (name, value) => crypto.createHash(name).update(text(value)).digest("hex");
  return {
    env: nativeMap({
      get: (name) => env.scope.get(String(name)) ?? null,
      set: (name, value) => {
        const stored = text(value);
        env.scope.set(String(name), stored);
        if (captures) captures[String(name)] = stored;
        keepSecret(env, stored);
        return null;
      },
    }),
    http,
    // Las de Tangerine usarían otra salida a internet: estas pasan por el proxy y los certificados de Citrus.
    fetch_json: async (url) => (await http.get(url)).json,
    fetch_text: async (url) => (await http.get(url)).text,
    sha256: (value) => hash("sha256", value),
    md5: (value) => hash("md5", value),
    hmac_sha256: (key, value) => crypto.createHmac("sha256", text(key)).update(text(value)).digest("hex"),
    base64: (value) => Buffer.from(text(value)).toString("base64"),
    base64_decode: (value) => Buffer.from(text(value), "base64").toString("utf8"),
    url_encode: (value) => encodeURIComponent(text(value)),
    uuid: () => crypto.randomUUID(),
    timestamp: () => Math.floor(Date.now() / 1000),
    timestamp_ms: () => Date.now(),
    jwt_payload: (token) => {
      try {
        return fromJS(JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")));
      } catch {
        return null;
      }
    },
  };
}

function reason(err) {
  if (err?.tngMessage) return err.tngMessage;
  if (err?.message) return err.message;
  const value = err?.value;
  return String(value?.message ?? value ?? err);
}

/** Ejecuta un script y devuelve lo que `req` quedó valiendo. */
async function execute({ code, phase, env, captures, signal, logs, req, res }) {
  const label = phase === "before" ? "antes" : "despues";
  const tng = new Tangerine({
    stepLimit: 5_000_000,
    globalPlugins: false,
    output: (line) => logs.push({ phase, text: maskSecrets(line, env.secretValues) }),
    onError: (message) => logs.push({ phase, error: true, text: maskSecrets(message, env.secretValues) }),
  });
  tng.defineAll(natives(env, captures, signal));
  const request = req ? fromJS(req) : null;
  if (request) tng.define("req", request);
  if (res) tng.define("res", fromJS(res));
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`El script tardó más de ${LIMIT_MS / 1000} segundos.`)), LIMIT_MS);
  });
  try {
    // En la misma línea que el código, para que los números de línea de los errores coincidan.
    await Promise.race([tng.run(`async fn __script() { ${code}\n}\n__script()`, { file: `script ${label}` }), expired]);
  } finally {
    clearTimeout(timer);
  }
  return request ? toJS(request) : null;
}

function requestView(model) {
  const headers = {};
  for (const row of model.headers ?? []) {
    if (row.enabled !== false && row.key) headers[row.key] = row.value;
  }
  const mode = model.body?.mode;
  const body = mode === "json" || mode === "raw" ? (model.body.text ?? "") : null;
  return { method: model.method, url: model.url, headers, body };
}

function applyEdits(model, edited, env) {
  const before = requestView(model);
  const headers = edited.headers && typeof edited.headers === "object" ? edited.headers : {};
  const rows = [];
  const seen = new Set();
  for (const row of model.headers ?? []) {
    if (row.enabled === false || !row.key) {
      rows.push(row);
    } else if (row.key in headers) {
      seen.add(row.key);
      rows.push({ ...row, value: String(headers[row.key]) });
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!seen.has(key)) rows.push({ key, value: String(value), enabled: true });
  }
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.test(key) && before.headers[key] !== value) {
      keepSecret(env, String(value));
      const token = /^\S+\s+(.+)$/.exec(String(value))?.[1];
      if (token) keepSecret(env, token);
    }
  }
  const next = { ...model, method: String(edited.method ?? model.method).toUpperCase(), url: String(edited.url ?? model.url), headers: rows };
  if (edited.body !== before.body && edited.body !== null && edited.body !== undefined) {
    const isText = typeof edited.body === "string";
    next.body = {
      ...model.body,
      mode: isText ? (model.body?.mode === "json" ? "json" : "raw") : "json",
      text: isText ? edited.body : JSON.stringify(edited.body),
    };
  }
  return next;
}

/** Corre el script previo y devuelve el modelo con los cambios. Si falla, no se envía nada. */
export async function runBeforeScript({ model, env, captures, signal, logs }) {
  try {
    const edited = await execute({ code: model.scripts.before, phase: "before", env, captures, signal, logs, req: requestView(model) });
    return applyEdits(model, edited, env);
  } catch (err) {
    throw new CitrusError("SCRIPT_ERROR", `Falló el script de antes de enviar. ${maskSecrets(reason(err), env.secretValues)}`);
  }
}

/** Corre el script posterior. Un fallo aquí se muestra, pero la respuesta ya llegó y no se pierde. */
export async function runAfterScript({ model, env, captures, signal, logs, res }) {
  try {
    await execute({ code: model.scripts.after, phase: "after", env, captures, signal, logs, res });
  } catch (err) {
    logs.push({ phase: "after", error: true, text: maskSecrets(reason(err), env.secretValues) });
  }
}
