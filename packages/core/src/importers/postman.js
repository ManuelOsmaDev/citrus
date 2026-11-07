import { CitrusError } from "../errors.js";
import { emptyModel } from "../model.js";
import { extractSecrets, looksSensitive, secretCollector } from "./secrets.js";

const kv = (auth, key) => {
  const section = auth?.[auth?.type];
  if (Array.isArray(section)) return section.find((e) => e.key === key)?.value;
  return section?.[key];
};

function convertAuth(auth, warnings, where) {
  if (!auth || auth.type === "noauth") return { type: "none" };
  switch (auth.type) {
    case "bearer":
      return { type: "bearer", token: String(kv(auth, "token") ?? "") };
    case "basic":
      return { type: "basic", username: String(kv(auth, "username") ?? ""), password: String(kv(auth, "password") ?? "") };
    case "apikey":
      return {
        type: "apikey",
        key: String(kv(auth, "key") ?? ""),
        value: String(kv(auth, "value") ?? ""),
        in: kv(auth, "in") === "query" ? "query" : "header",
      };
    default:
      warnings.push(`${where}: la autenticación '${auth.type}' todavía no está soportada y no se importó.`);
      return { type: "none" };
  }
}

function urlOf(url) {
  if (typeof url === "string") return url;
  if (!url) return "";
  if (typeof url.raw === "string" && url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join(".") : (url.host ?? "");
  const pathText = Array.isArray(url.path) ? url.path.join("/") : (url.path ?? "");
  const protocol = url.protocol ? `${url.protocol}://` : "";
  const query = (url.query ?? []).filter((q) => !q.disabled).map((q) => `${q.key}=${q.value ?? ""}`).join("&");
  return `${protocol}${host}${pathText ? `/${pathText}` : ""}${query ? `?${query}` : ""}`;
}

function convertBody(body, model, warnings, where) {
  const empty = { mode: "none", text: "", rows: [], file: "" };
  if (!body || !body.mode || body.disabled) return empty;
  const rows = (list) =>
    (list ?? []).map((p) => ({ key: String(p.key ?? ""), value: String(p.value ?? ""), enabled: p.disabled !== true }));
  switch (body.mode) {
    case "raw": {
      const language = body.options?.raw?.language;
      const text = String(body.raw ?? "");
      if (language === "json" || (!language && /^\s*[[{]/.test(text))) return { ...empty, mode: "json", text };
      const types = { xml: "application/xml", html: "text/html", javascript: "application/javascript", text: "text/plain" };
      if (types[language] && !model.headers.some((h) => h.key.toLowerCase() === "content-type")) {
        model.headers.push({ key: "Content-Type", value: types[language], enabled: true });
      }
      return { ...empty, mode: "raw", text };
    }
    case "urlencoded":
      return { ...empty, mode: "form", rows: rows(body.urlencoded) };
    case "formdata":
      return {
        ...empty,
        mode: "multipart",
        rows: (body.formdata ?? []).map((p) => {
          const isFile = p.type === "file";
          if (isFile) warnings.push(`${where}: revisa la ruta del archivo del campo '${p.key}'.`);
          const src = Array.isArray(p.src) ? (p.src[0] ?? "") : (p.src ?? "");
          return { key: String(p.key ?? ""), value: String(isFile ? src : (p.value ?? "")), enabled: p.disabled !== true, isFile };
        }),
      };
    case "file":
      warnings.push(`${where}: revisa la ruta del archivo del body.`);
      return { ...empty, mode: "binary", file: String(body.file?.src ?? "") };
    case "graphql": {
      warnings.push(`${where}: GraphQL se importó como JSON. La introspección llega en una fase posterior.`);
      let variables = body.graphql?.variables;
      try {
        if (typeof variables === "string" && variables.trim()) variables = JSON.parse(variables);
      } catch {
        // Quedan como texto.
      }
      return { ...empty, mode: "json", text: JSON.stringify({ query: body.graphql?.query ?? "", variables: variables || undefined }, null, 2) };
    }
    default:
      warnings.push(`${where}: el body '${body.mode}' no se importó.`);
      return empty;
  }
}

/**
 * Convierte una colección de Postman v2.0 o v2.1.
 * Devuelve requests por carpeta, secretos extraídos, variables y advertencias de lo que no se pudo traer.
 */
export function importPostman(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new CitrusError("BAD_POSTMAN", "El archivo no es JSON válido.");
    }
  }
  const schema = String(data?.info?.schema ?? "");
  if (!Array.isArray(data?.item) || !/collection\/v2\.[01]/.test(schema)) {
    throw new CitrusError("BAD_POSTMAN", "No parece una colección de Postman v2.0 o v2.1.");
  }

  const warnings = [];
  const requests = [];
  const collector = secretCollector();
  let scripts = 0;

  const countScripts = (node) => {
    scripts += (node.event ?? []).filter((e) => (e.script?.exec ?? []).some((line) => String(line).trim())).length;
  };

  const walk = (items, folder, inheritedAuth) => {
    for (const item of items ?? []) {
      countScripts(item);
      if (Array.isArray(item.item)) {
        walk(item.item, [...folder, String(item.name ?? "carpeta")], item.auth ?? inheritedAuth);
        continue;
      }
      const req = item.request;
      if (!req) continue;
      const name = String(item.name ?? "Request");
      const where = [...folder, name].join(" / ");
      const model = emptyModel(name);
      model.method = String(typeof req === "string" ? "GET" : (req.method ?? "GET")).toUpperCase();
      model.url = urlOf(typeof req === "string" ? req : req.url);
      const disabledQuery = typeof req === "object" ? (req.url?.query ?? []).filter((q) => q.disabled) : [];
      model.disabledQuery = disabledQuery.map((q) => ({ key: String(q.key), value: String(q.value ?? ""), enabled: false }));
      const headers = Array.isArray(req.header) ? req.header : [];
      model.headers = headers.map((h) => ({ key: String(h.key ?? ""), value: String(h.value ?? ""), enabled: h.disabled !== true }));
      model.body = convertBody(req.body, model, warnings, where);
      const auth = req.auth && req.auth.type !== "inherit" ? req.auth : inheritedAuth;
      model.auth = convertAuth(auth, warnings, where);
      extractSecrets(model, collector);
      requests.push({ folder, name, model });
    }
  };
  countScripts(data);
  walk(data.item, [], data.auth);

  if (scripts) warnings.push(`${scripts} script(s) de Postman no se importaron: los scripts llegan en una fase posterior.`);

  // Las variables de colección con nombre sensible se tratan como secretos.
  const variables = {};
  const secrets = collector.list();
  for (const v of data.variable ?? []) {
    if (!v.key || v.value == null || v.value === "") continue;
    if (looksSensitive(v.key)) {
      if (!secrets.some((s) => s.name === v.key)) secrets.push({ name: String(v.key), value: String(v.value) });
    } else {
      variables[v.key] = String(v.value);
    }
  }

  return { name: String(data.info?.name ?? "Postman"), requests, secrets, variables, warnings };
}
