import fs from "node:fs/promises";
import { CitrusError } from "./errors.js";
import { insideRoot } from "./paths.js";
import { interpolate, interpolateDeep } from "./variables.js";

const hasHeader = (headers, name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
const active = (rows = []) => rows.filter((r) => r.enabled !== false && r.key);

/** Un entero largo no puede pasar por JSON.parse sin perder dígitos. */
const hasUnsafeNumber = (text) => /(^|[^\w."-])-?\d{16,}/.test(text);

/** Dentro de JSON los valores se reemplazan ya parseados, así una comilla no rompe el documento. */
function jsonBody(text, scope, missing) {
  if (!hasUnsafeNumber(text)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Tiene {{var}} sin comillas: se reemplaza como texto.
      return interpolate(text, scope, missing);
    }
    return JSON.stringify(interpolateDeep(parsed, scope, missing));
  }
  return interpolate(text, scope, missing);
}

async function workspaceFile(root, relative) {
  if (!relative) throw new CitrusError("BAD_BODY", "Falta indicar el archivo del body.");
  // Una colección clonada no debe poder mandar archivos de fuera del workspace, como ~/.ssh.
  const file = await insideRoot(root, relative);
  try {
    return { file, data: await fs.readFile(file) };
  } catch (e) {
    throw new CitrusError("BAD_BODY", `No se pudo leer '${relative}': ${e.code ?? e.message}`);
  }
}

async function buildBody(body, scope, missing, root, headers) {
  const setType = (type) => {
    if (!hasHeader(headers, "content-type")) headers.push(["Content-Type", type]);
  };
  switch (body?.mode) {
    case undefined:
    case "none":
      return null;
    case "json": {
      if (!body.text?.trim()) return null;
      setType("application/json");
      return Buffer.from(jsonBody(body.text, scope, missing));
    }
    case "raw":
      return body.text ? Buffer.from(interpolate(body.text, scope, missing)) : null;
    case "form": {
      const params = new URLSearchParams();
      for (const r of active(body.rows)) params.append(interpolate(r.key, scope, missing), interpolate(r.value, scope, missing));
      setType("application/x-www-form-urlencoded");
      return Buffer.from(params.toString());
    }
    case "multipart": {
      const form = new FormData();
      for (const r of active(body.rows)) {
        const name = interpolate(r.key, scope, missing);
        if (r.isFile) {
          const rel = interpolate(r.value, scope, missing);
          const { data } = await workspaceFile(root, rel);
          form.append(name, new Blob([data]), rel.split(/[\\/]/).pop());
        } else {
          form.append(name, interpolate(r.value, scope, missing));
        }
      }
      // Response serializa el multipart y genera el boundary correcto.
      const encoded = new Response(form);
      const type = encoded.headers.get("content-type");
      const out = Buffer.from(await encoded.arrayBuffer());
      const existing = headers.findIndex(([k]) => k.toLowerCase() === "content-type");
      if (existing >= 0) headers.splice(existing, 1);
      headers.push(["Content-Type", type]);
      return out;
    }
    case "binary": {
      const { data } = await workspaceFile(root, interpolate(body.file, scope, missing));
      setType("application/octet-stream");
      return data;
    }
    default:
      throw new CitrusError("UNSUPPORTED_BODY", "Este tipo de body todavía no se puede enviar.");
  }
}

/**
 * Convierte el modelo en una request lista para enviar.
 * Si falta una variable lanza error: mandar `{{token}}` literal a un servidor nunca es lo que se quiere.
 */
export async function prepareRequest(model, scope, { root, missingSecrets = [] } = {}) {
  const missing = new Set();
  const headers = active(model.headers).map((r) => [interpolate(r.key, scope, missing), interpolate(r.value, scope, missing)]);
  const sensitiveHeaders = [];
  let rawUrl = interpolate(model.url ?? "", scope, missing).trim();
  const queryAuth = [];

  const auth = model.auth ?? { type: "none" };
  if (auth.type === "bearer") {
    headers.push(["Authorization", `Bearer ${interpolate(auth.token, scope, missing)}`]);
  } else if (auth.type === "basic") {
    const credentials = `${interpolate(auth.username, scope, missing)}:${interpolate(auth.password, scope, missing)}`;
    headers.push(["Authorization", `Basic ${Buffer.from(credentials).toString("base64")}`]);
  } else if (auth.type === "apikey") {
    const key = interpolate(auth.key, scope, missing);
    const value = interpolate(auth.value, scope, missing);
    if (auth.in === "query") queryAuth.push([key, value]);
    else {
      headers.push([key, value]);
      sensitiveHeaders.push(key);
    }
  } else if (auth.type === "unsupported") {
    throw new CitrusError("UNSUPPORTED_AUTH", `La autenticación '${auth.name}' todavía no está soportada. No se envió la request.`);
  }

  const body = await buildBody(model.body, scope, missing, root, headers);

  if (missing.size) {
    const names = [...missing];
    const secretsOnly = names.filter((n) => missingSecrets.includes(n));
    const detail = secretsOnly.length ? ` Secretos sin valor: ${secretsOnly.join(", ")}.` : "";
    throw new CitrusError("MISSING_VARS", `Faltan variables en el entorno: ${names.join(", ")}.${detail}`, { names });
  }
  if (!rawUrl) throw new CitrusError("BAD_URL", "Escribe una URL.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) rawUrl = `http://${rawUrl}`;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CitrusError("BAD_URL", `La URL no es válida: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CitrusError("BAD_URL", `Protocolo no soportado: ${url.protocol}`);
  }
  for (const [k, v] of queryAuth) url.searchParams.append(k, v);

  if (!hasHeader(headers, "user-agent")) headers.push(["User-Agent", "Citrus/0.1"]);
  if (!hasHeader(headers, "accept")) headers.push(["Accept", "*/*"]);
  if (!hasHeader(headers, "accept-encoding")) headers.push(["Accept-Encoding", "gzip, deflate, br"]);

  return {
    method: String(model.method ?? "GET").toUpperCase(),
    url: url.href,
    // undici calcula Content-Length a partir del body; uno escrito a mano puede no coincidir.
    headers: headers.filter(([k]) => k.toLowerCase() !== "content-length"),
    body,
    sensitiveHeaders,
  };
}
