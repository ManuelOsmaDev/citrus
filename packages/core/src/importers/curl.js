import { CitrusError } from "../errors.js";
import { emptyModel } from "../model.js";
import { extractSecrets, secretCollector } from "./secrets.js";

/** Separa un comando como lo haría bash. También acepta la continuación ^ de cmd.exe. */
export function tokenize(input) {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").replace(/`\r?\n/g, " ");
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < text.length && /["\\$`]/.test(text[i + 1])) current += text[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "$" && text[i + 1] === "'") {
      // $'...' de bash: basta con el escape más común.
      quote = "'";
      started = true;
      i++;
    } else if (c === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) throw new CitrusError("BAD_CURL", "El comando tiene comillas sin cerrar.");
  if (started) tokens.push(current);
  return tokens;
}

const WITH_VALUE = new Map(
  Object.entries({
    "-X": "method", "--request": "method",
    "-H": "header", "--header": "header",
    "-d": "data", "--data": "data", "--data-raw": "data", "--data-ascii": "data", "--data-binary": "data",
    "--data-urlencode": "urlencode",
    "--json": "json",
    "-F": "form", "--form": "form", "--form-string": "formstring",
    "-u": "user", "--user": "user",
    "-A": "agent", "--user-agent": "agent",
    "-e": "referer", "--referer": "referer",
    "-b": "cookie", "--cookie": "cookie",
    "--url": "url",
    "-T": "upload", "--upload-file": "upload",
    "-o": "ignore", "--output": "ignore", "-m": "ignore", "--max-time": "ignore", "--connect-timeout": "ignore",
    "--retry": "ignore", "-x": "ignore", "--proxy": "ignore", "-w": "ignore", "--write-out": "ignore",
    "--cacert": "ignore", "--cert": "ignore", "--key": "ignore", "-c": "ignore", "--cookie-jar": "ignore",
  }),
);
const FLAGS = new Map(
  Object.entries({ "-G": "get", "--get": "get", "-I": "head", "--head": "head" }),
);

function parseArgs(tokens) {
  const options = [];
  const urls = [];
  const unknown = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (WITH_VALUE.has(t)) {
      if (i + 1 >= tokens.length) throw new CitrusError("BAD_CURL", `Falta el valor de ${t}.`);
      options.push([WITH_VALUE.get(t), tokens[++i]]);
    } else if (FLAGS.has(t)) {
      options.push([FLAGS.get(t), true]);
    } else if (t.startsWith("--") && t.includes("=") && WITH_VALUE.has(t.slice(0, t.indexOf("=")))) {
      const at = t.indexOf("=");
      options.push([WITH_VALUE.get(t.slice(0, at)), t.slice(at + 1)]);
    } else if (/^-[A-Za-z]/.test(t) && !t.startsWith("--")) {
      // Forma pegada (-XPOST, -H'a: b') o banderas juntas (-sSL, -sX POST).
      for (let j = 1; j < t.length; j++) {
        const short = `-${t[j]}`;
        if (WITH_VALUE.has(short)) {
          const rest = t.slice(j + 1);
          if (rest) options.push([WITH_VALUE.get(short), rest]);
          else if (i + 1 < tokens.length) options.push([WITH_VALUE.get(short), tokens[++i]]);
          else throw new CitrusError("BAD_CURL", `Falta el valor de ${short}.`);
          break;
        }
        if (FLAGS.has(short)) options.push([FLAGS.get(short), true]);
      }
    } else if (t.startsWith("-") && t.length > 1) {
      unknown.push(t);
    } else {
      urls.push(t);
    }
  }
  return { options, urls, unknown };
}

const decodeForm = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/** Convierte un comando cURL en un modelo de request, con las credenciales ya extraídas. */
export function importCurl(input) {
  const tokens = tokenize(String(input ?? "").trim());
  if (tokens[0] !== "curl") throw new CitrusError("BAD_CURL", "El texto no empieza con 'curl'.");
  const { options, urls, unknown } = parseArgs(tokens.slice(1));

  const model = emptyModel("Importada de cURL");
  const warnings = unknown.length ? [`Opciones de cURL ignoradas: ${[...new Set(unknown)].join(", ")}`] : [];
  const data = [];
  const urlencoded = [];
  const form = [];
  let method = null;
  let url = urls[0] ?? "";
  let asQuery = false;
  let isHead = false;

  for (const [kind, value] of options) {
    switch (kind) {
      case "method": method = value.toUpperCase(); break;
      case "url": url = value; break;
      case "header": {
        const at = value.indexOf(":");
        if (at > 0) model.headers.push({ key: value.slice(0, at).trim(), value: value.slice(at + 1).trim(), enabled: true });
        break;
      }
      case "data": data.push(value); break;
      case "urlencode": urlencoded.push(value); break;
      case "json":
        data.push(value);
        model.headers.push({ key: "Content-Type", value: "application/json", enabled: true });
        break;
      case "form":
      case "formstring": {
        const at = value.indexOf("=");
        if (at <= 0) break;
        const raw = value.slice(at + 1);
        const isFile = kind === "form" && raw.startsWith("@");
        form.push({ key: value.slice(0, at), value: isFile ? raw.slice(1).split(";")[0] : raw, enabled: true, isFile });
        break;
      }
      case "user": {
        const at = value.indexOf(":");
        model.auth = { type: "basic", username: at < 0 ? value : value.slice(0, at), password: at < 0 ? "" : value.slice(at + 1) };
        break;
      }
      case "agent": model.headers.push({ key: "User-Agent", value, enabled: true }); break;
      case "referer": model.headers.push({ key: "Referer", value, enabled: true }); break;
      case "cookie":
        if (value.includes("=")) model.headers.push({ key: "Cookie", value, enabled: true });
        break;
      case "upload":
        model.body = { ...model.body, mode: "binary", file: value };
        method ??= "PUT";
        warnings.push(`Revisa la ruta del archivo '${value}': debe quedar dentro del workspace.`);
        break;
      case "get": asQuery = true; break;
      case "head": isHead = true; break;
      default: break;
    }
  }
  if (!url) throw new CitrusError("BAD_CURL", "El comando no tiene URL.");

  const pairs = urlencoded.map((v) => {
    const at = v.indexOf("=");
    return at < 0 ? [v, ""] : [v.slice(0, at), v.slice(at + 1)];
  });

  if (asQuery) {
    const query = [...data, ...pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)].join("&");
    if (query) url += (url.includes("?") ? "&" : "?") + query;
  } else if (form.length) {
    model.body = { ...model.body, mode: "multipart", rows: form };
    if (form.some((f) => f.isFile)) warnings.push("Revisa las rutas de los archivos: deben quedar dentro del workspace.");
  } else if (pairs.length) {
    const rows = pairs.map(([key, value]) => ({ key, value, enabled: true }));
    for (const part of data.join("&").split("&").filter(Boolean)) {
      const at = part.indexOf("=");
      rows.push({ key: at < 0 ? part : part.slice(0, at), value: at < 0 ? "" : part.slice(at + 1), enabled: true });
    }
    model.body = { ...model.body, mode: "form", rows };
  } else if (data.length) {
    const text = data.join("&");
    const type = model.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
    if (/json/i.test(type) || (!type && /^\s*[[{]/.test(text))) {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Se conserva tal cual.
      }
      model.body = { ...model.body, mode: "json", text: pretty };
    } else if (!type || /x-www-form-urlencoded/i.test(type)) {
      const rows = text.split("&").filter(Boolean).map((part) => {
        const at = part.indexOf("=");
        return { key: decodeForm(at < 0 ? part : part.slice(0, at)), value: at < 0 ? "" : decodeForm(part.slice(at + 1)), enabled: true };
      });
      model.body = { ...model.body, mode: "form", rows };
    } else {
      model.body = { ...model.body, mode: "raw", text };
    }
  }

  model.url = url;
  model.method = method ?? (isHead ? "HEAD" : asQuery ? "GET" : model.body.mode !== "none" ? "POST" : "GET");
  try {
    const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, "x"));
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    model.name = `${model.method} ${tail ? `/${tail}` : parsed.hostname}`;
  } catch {
    model.name = `${model.method} ${url}`.slice(0, 60);
  }

  const collector = secretCollector();
  extractSecrets(model, collector);
  return { model, secrets: collector.list(), warnings };
}
