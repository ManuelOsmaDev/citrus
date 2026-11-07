// Los importadores nunca dejan credenciales en el YAML: las sacan a secretos y dejan {{nombre}}.

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-amz-security-token)$/i;
const SENSITIVE_NAME = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|private)/i;

/** Reparte nombres de secreto: el mismo valor reutiliza su nombre; otro valor recibe sufijo. */
export function secretCollector() {
  const byValue = new Map();
  const byName = new Map();
  return {
    name(hint, value) {
      if (byValue.has(value)) return byValue.get(value);
      const base = String(hint).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "secreto";
      let name = base;
      for (let i = 2; byName.has(name); i++) name = `${base}_${i}`;
      byValue.set(value, name);
      byName.set(name, value);
      return name;
    },
    list: () => [...byName].map(([name, value]) => ({ name, value })),
  };
}

export const looksSensitive = (name) => SENSITIVE_NAME.test(String(name));

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function scrubJson(text, take) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value && !value.includes("{{") && looksSensitive(key)) {
        node[key] = take(key, value);
        changed = true;
      } else walk(value);
    }
  };
  walk(data);
  return changed ? JSON.stringify(data, null, 2) : text;
}

/** Reemplaza en el modelo las credenciales literales por variables. */
export function extractSecrets(model, collector) {
  const take = (hint, value) => `{{${collector.name(hint, value)}}}`;

  for (const row of model.headers ?? []) {
    if (!row.value || String(row.value).includes("{{")) continue;
    if (!SENSITIVE_HEADER.test(row.key) && !looksSensitive(row.key)) continue;
    const scheme = /^(Bearer|Basic|Token)\s+(\S.*)$/i.exec(row.value);
    row.value = scheme ? `${scheme[1]} ${take(row.key, scheme[2])}` : take(row.key, row.value);
  }

  const auth = model.auth;
  if (auth?.type === "bearer" && auth.token && !auth.token.includes("{{")) auth.token = take("bearer_token", auth.token);
  if (auth?.type === "basic" && auth.password && !auth.password.includes("{{")) auth.password = take("basic_password", auth.password);
  if (auth?.type === "apikey" && auth.value && !auth.value.includes("{{")) auth.value = take(auth.key || "api_key", auth.value);

  // Credenciales en el query string, por ejemplo ?api_key=abc
  model.url = String(model.url ?? "").replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, sep, key, value) => {
    if (!value || value.includes("{{") || !looksSensitive(key)) return whole;
    return `${sep}${key}=${take(key, decodeSafe(value))}`;
  });

  const bodyRows = model.body?.mode === "form" || model.body?.mode === "multipart" ? model.body.rows : [];
  for (const row of bodyRows) {
    if (!row.isFile && row.value && !String(row.value).includes("{{") && looksSensitive(row.key)) row.value = take(row.key, row.value);
  }

  if (model.body?.mode === "json" && model.body.text) model.body.text = scrubJson(model.body.text, take);
  return model;
}
