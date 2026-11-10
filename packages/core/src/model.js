// Traduce entre el YAML de una request (pensado para PRs) y el modelo de edición (filas).
import { CitrusError } from "./errors.js";

const row = (key, value, enabled = true) => ({ key: String(key), value: value == null ? "" : String(value), enabled });

function mapToRows(map, enabled) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(map)) {
    if (Array.isArray(value)) for (const v of value) rows.push(row(key, v, enabled));
    else rows.push(row(key, value, enabled));
  }
  return rows;
}

function rowsToMap(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.key) continue;
    if (!Object.hasOwn(out, r.key)) out[r.key] = r.value;
    else if (Array.isArray(out[r.key])) out[r.key].push(r.value);
    else out[r.key] = [out[r.key], r.value];
  }
  return Object.keys(out).length ? out : undefined;
}

const enabledRows = (rows = []) => rows.filter((r) => r.enabled !== false);
const disabledRows = (rows = []) => rows.filter((r) => r.enabled === false);

/** Los enteros de más de 15 dígitos perderían precisión si pasan por JSON.parse. */
const hasUnsafeNumber = (text) => /(^|[^\w."-])-?\d{16,}/.test(text);

function bodyFromFile(body, disabled) {
  const empty = { mode: "none", text: "", rows: [], file: "" };
  if (body == null) return empty;
  if (typeof body !== "object") return { ...empty, mode: "raw", text: String(body) };
  if ("json" in body) {
    const text = typeof body.json === "string" ? body.json : JSON.stringify(body.json, null, 2);
    return { ...empty, mode: "json", text };
  }
  if ("form" in body) {
    return { ...empty, mode: "form", rows: [...mapToRows(body.form, true), ...mapToRows(disabled?.form, false)] };
  }
  if ("multipart" in body) {
    const parts = Array.isArray(body.multipart) ? body.multipart : [];
    return {
      ...empty,
      mode: "multipart",
      rows: parts.map((p) => ({
        ...row(p.name ?? "", p.file ?? p.value ?? "", p.disabled !== true),
        isFile: p.file != null,
      })),
    };
  }
  if ("raw" in body) return { ...empty, mode: "raw", text: String(body.raw ?? "") };
  if ("binary" in body) return { ...empty, mode: "binary", file: String(body.binary ?? "") };
  return { ...empty, mode: "unsupported", original: body };
}

function bodyToFile(body) {
  switch (body?.mode) {
    case "json": {
      const text = body.text ?? "";
      if (!text.trim()) return undefined;
      if (hasUnsafeNumber(text)) return { json: text };
      try {
        const parsed = JSON.parse(text);
        // Un string suelto queda como texto literal para no confundirlo al releer.
        return { json: typeof parsed === "string" ? text : parsed };
      } catch {
        // Con {{var}} sin comillas el texto no es JSON todavía: se guarda tal cual.
        return { json: text };
      }
    }
    case "form": {
      const form = rowsToMap(enabledRows(body.rows));
      return form || disabledRows(body.rows).some((r) => r.key) ? { form: form ?? {} } : undefined;
    }
    case "multipart": {
      const parts = (body.rows ?? [])
        .filter((r) => r.key)
        .map((r) => ({
          name: r.key,
          ...(r.isFile ? { file: r.value } : { value: r.value }),
          ...(r.enabled === false ? { disabled: true } : {}),
        }));
      return parts.length ? { multipart: parts } : undefined;
    }
    case "raw":
      return body.text ? { raw: body.text } : undefined;
    case "binary":
      return body.file ? { binary: body.file } : undefined;
    case "unsupported":
      return body.original;
    default:
      return undefined;
  }
}

function authFromFile(auth) {
  if (!auth || typeof auth !== "object" || !auth.type || auth.type === "none") return { type: "none" };
  switch (auth.type) {
    case "bearer":
      return { type: "bearer", token: String(auth.token ?? "") };
    case "basic":
      return { type: "basic", username: String(auth.username ?? ""), password: String(auth.password ?? "") };
    case "apikey":
      return {
        type: "apikey",
        key: String(auth.key ?? ""),
        value: String(auth.value ?? ""),
        in: auth.in === "query" ? "query" : "header",
      };
    default:
      return { type: "unsupported", name: String(auth.type), original: auth };
  }
}

function authToFile(auth) {
  switch (auth?.type) {
    case "bearer":
      return { type: "bearer", token: auth.token ?? "" };
    case "basic":
      return { type: "basic", username: auth.username ?? "", password: auth.password ?? "" };
    case "apikey":
      return { type: "apikey", key: auth.key ?? "", value: auth.value ?? "", in: auth.in === "query" ? "query" : "header" };
    case "unsupported":
      return auth.original;
    default:
      return undefined;
  }
}

const testsFromFile = (list) => (Array.isArray(list) ? list.map(String) : []);
const testsToFile = (list) => {
  const lines = (list ?? []).map((line) => String(line).trim()).filter(Boolean);
  return lines.length ? lines : undefined;
};

function lambdaToPatch(model) {
  let event;
  try {
    event = JSON.parse(model.eventText?.trim() || "{}");
  } catch (e) {
    throw new CitrusError("BAD_EVENT", `El evento no es JSON válido: ${e.message}`);
  }
  return {
    name: model.name,
    type: "lambda",
    function: model.function,
    mode: model.mode,
    handler: model.handler || undefined,
    cwd: model.cwd || undefined,
    event,
    observe: model.observe ?? undefined,
    assert: testsToFile(model.assert),
    capture: rowsToMap(enabledRows(model.capture ?? [])),
  };
}

/** Modelo de edición a partir del YAML ya parseado. */
export function modelFromFile(data, fallbackName = "Request") {
  const doc = data && typeof data === "object" ? data : {};
  const name = String(doc.name ?? fallbackName);
  if (doc.type === "lambda") {
    return {
      type: "lambda",
      name,
      function: String(doc.function ?? ""),
      mode: doc.mode === "local" ? "local" : "remote",
      handler: String(doc.handler ?? ""),
      cwd: String(doc.cwd ?? ""),
      eventText: JSON.stringify(doc.event ?? {}, null, 2),
      observe: doc.observe && typeof doc.observe === "object" ? doc.observe : null,
      assert: testsFromFile(doc.assert),
      capture: mapToRows(doc.capture, true),
    };
  }
  return {
    type: "http",
    name,
    method: String(doc.method ?? "GET").toUpperCase(),
    url: String(doc.url ?? ""),
    headers: [...mapToRows(doc.headers, true), ...mapToRows(doc.disabled?.headers, false)],
    disabledQuery: mapToRows(doc.disabled?.query, false),
    body: bodyFromFile(doc.body, doc.disabled),
    auth: authFromFile(doc.auth),
    observe: doc.observe && typeof doc.observe === "object" ? doc.observe : null,
    assert: testsFromFile(doc.assert),
    capture: mapToRows(doc.capture, true),
    scripts: { before: String(doc.scripts?.before ?? ""), after: String(doc.scripts?.after ?? "") },
  };
}

function scriptsToFile(scripts) {
  const before = scripts?.before?.trim() ? scripts.before : undefined;
  const after = scripts?.after?.trim() ? scripts.after : undefined;
  return before || after ? { ...(before ? { before } : {}), ...(after ? { after } : {}) } : undefined;
}

/** Campos a escribir en el YAML. `undefined` significa borrar la clave. */
export function modelToPatch(model) {
  if (model.type === "lambda") return lambdaToPatch(model);
  const disabled = {};
  const disabledHeaders = rowsToMap(disabledRows(model.headers));
  const disabledQuery = rowsToMap(model.disabledQuery ?? []);
  const disabledForm = model.body?.mode === "form" ? rowsToMap(disabledRows(model.body.rows)) : undefined;
  if (disabledHeaders) disabled.headers = disabledHeaders;
  if (disabledQuery) disabled.query = disabledQuery;
  if (disabledForm) disabled.form = disabledForm;

  return {
    name: model.name,
    method: model.method,
    url: model.url,
    headers: rowsToMap(enabledRows(model.headers)),
    auth: authToFile(model.auth),
    body: bodyToFile(model.body),
    disabled: Object.keys(disabled).length ? disabled : undefined,
    observe: model.observe ?? undefined,
    assert: testsToFile(model.assert),
    capture: rowsToMap(enabledRows(model.capture ?? [])),
    scripts: scriptsToFile(model.scripts),
  };
}

/** Modelo vacío para una request nueva. */
export function emptyModel(name = "Nueva request") {
  return {
    type: "http",
    name,
    method: "GET",
    url: "",
    headers: [],
    disabledQuery: [],
    body: { mode: "none", text: "", rows: [], file: "" },
    auth: { type: "none" },
    observe: null,
    assert: [],
    capture: [],
    scripts: { before: "", after: "" },
  };
}
