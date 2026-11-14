import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { CitrusError } from "./errors.js";
import { readAwsVariables } from "./awsvars.js";
import { secretAccount } from "./secrets.js";
import { buildScope } from "./variables.js";
import { ENVIRONMENTS_DIR } from "./workspace.js";

const VALID_ID = /^[\w.-]+$/;
const VALID_SECRET = /^[\w.$-]+$/;

function envFile(root, id) {
  if (!VALID_ID.test(String(id)) || String(id).startsWith(".")) {
    throw new CitrusError("BAD_ENV", `Nombre de entorno inválido: ${id}`);
  }
  return path.join(root, ENVIRONMENTS_DIR, `${id}.yaml`);
}

export async function readEnvironment(root, id) {
  let text;
  try {
    text = await fs.readFile(envFile(root, id), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new CitrusError("ENV_NOT_FOUND", `No existe el entorno '${id}'.`);
    throw e;
  }
  let data;
  try {
    data = YAML.parse(text) ?? {};
  } catch (e) {
    throw new CitrusError("BAD_YAML", `environments/${id}.yaml no es YAML válido: ${e.message}`);
  }
  return {
    id,
    name: String(data.name ?? id),
    protected: data.protected === true,
    extends: data.extends ? String(data.extends) : null,
    variables: data.variables && typeof data.variables === "object" ? data.variables : {},
    secrets: Array.isArray(data.secrets) ? data.secrets.map(String) : [],
    aws: data.aws && typeof data.aws === "object" ? data.aws : null,
    awsVariables:
      data.awsVariables && typeof data.awsVariables === "object"
        ? Object.fromEntries(Object.entries(data.awsVariables).map(([k, v]) => [k, String(v ?? "")]))
        : {},
    db: data.db && typeof data.db === "object" ? data.db : null,
  };
}

export async function listEnvironments(root) {
  const files = await fs.readdir(path.join(root, ENVIRONMENTS_DIR)).catch(() => []);
  const out = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".yaml")) continue;
    const id = file.slice(0, -".yaml".length);
    if (!VALID_ID.test(id)) continue;
    try {
      const env = await readEnvironment(root, id);
      out.push({ id, name: env.name, protected: env.protected, extends: env.extends });
    } catch (e) {
      out.push({ id, name: id, protected: true, extends: null, error: e.message });
    }
  }
  return out;
}

/** Del entorno base al pedido, con detección de ciclos en `extends`. */
async function chainOf(root, id) {
  const chain = [];
  const seen = new Set();
  for (let current = id; current; ) {
    if (seen.has(current)) throw new CitrusError("ENV_CYCLE", `Herencia circular de entornos en '${current}'.`);
    seen.add(current);
    const env = await readEnvironment(root, current);
    chain.unshift(env);
    current = env.extends;
  }
  return chain;
}

/**
 * Resuelve un entorno con herencia y secretos.
 * `protected` lo decide el entorno pedido o cualquiera de sus padres: heredar no lo desactiva.
 */
/**
 * Todo lo que un envío necesita de un entorno: variables, secretos, AWS y bases.
 * Con `loadAws: false` no consulta AWS: las variables de AWS quedan como nombres sin valor.
 */
export async function resolveEnvironment(root, id, store, captures = {}, { loadAws = true } = {}) {
  const chain = await chainOf(root, id);
  const variables = Object.assign({}, ...chain.map((e) => e.variables));
  const db = Object.assign({}, ...chain.map((e) => e.db ?? {}));
  const aws = Object.assign({}, ...chain.map((e) => e.aws ?? {}));
  const awsVariables = Object.assign({}, ...chain.map((e) => e.awsVariables ?? {}));
  const awsNames = Object.keys(awsVariables);
  const passwordSecrets = Object.values(db).map((d) => d?.passwordSecret).filter(Boolean).map(String);
  const keychainNames = [...new Set([...chain.flatMap((e) => e.secrets), ...passwordSecrets])].filter((n) => !awsNames.includes(n));
  const secretNames = [...keychainNames, ...awsNames];
  const secrets = {};
  const missingSecrets = [];
  for (const name of keychainNames) {
    let value = null;
    // Primero el entorno pedido y luego sus padres.
    for (const env of [...chain].reverse()) {
      value = await store.get(secretAccount(root, env.id, name));
      if (value !== null) break;
    }
    if (value === null) missingSecrets.push(name);
    else secrets[name] = value;
  }
  // Solo cuando hacen falta: enviar, correr una carpeta o probar una conexión.
  if (loadAws && awsNames.length) Object.assign(secrets, await readAwsVariables(awsVariables, aws));
  return {
    id,
    protected: chain.some((e) => e.protected),
    // Lo capturado se trata como literal: la respuesta de un servidor no debe expandir variables.
    scope: buildScope({ variables, secrets: { ...captures, ...secrets } }),
    aws,
    awsVariables,
    db,
    secretValues: Object.values(secrets),
    secretNames,
    missingSecrets,
    variableNames: Object.keys(variables),
  };
}

/** Lo que la UI puede ver de un entorno. Nunca incluye el valor de un secreto. */
export async function describeEnvironment(root, id, store, captures = {}) {
  const env = await readEnvironment(root, id);
  const resolved = await resolveEnvironment(root, id, store, captures, { loadAws: false });
  const shown = {};
  for (const name of resolved.variableNames) {
    if (!resolved.secretNames.includes(name)) shown[name] = resolved.scope.get(name);
  }
  for (const [name, val] of Object.entries(captures)) {
    if (!resolved.secretNames.includes(name)) shown[name] = val;
  }
  return {
    ...env,
    effectiveProtected: resolved.protected,
    resolved: shown,
    captured: Object.keys(captures),
    dbNames: Object.keys(resolved.db),
    // Perfil y región que de verdad se usan, incluidos los heredados.
    awsResolved: resolved.aws,
    secrets: resolved.secretNames.map((name) => ({
      name,
      isSet: !resolved.missingSecrets.includes(name),
      own: env.secrets.includes(name) || name in env.awsVariables,
      ...(resolved.awsVariables[name] ? { fromAws: resolved.awsVariables[name] } : {}),
    })),
  };
}

/** Actualiza un entorno y conserva comentarios y bloques que la UI no edita (aws, db). */
export async function saveEnvironment(root, id, { variables, protected: isProtected, extends: parent, aws, awsVariables, db }) {
  const file = envFile(root, id);
  const previous = await fs.readFile(file, "utf8").catch(() => "");
  const doc = YAML.parseDocument(previous);
  if (doc.errors.length) throw new CitrusError("BAD_YAML", `No se guardó: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({ name: id });
  if (variables !== undefined) doc.set("variables", doc.createNode(variables));
  if (isProtected !== undefined) doc.set("protected", isProtected === true);
  if (awsVariables !== undefined) {
    if (Object.keys(awsVariables ?? {}).length) doc.set("awsVariables", doc.createNode(awsVariables));
    else doc.delete("awsVariables");
  }
  if (aws !== undefined) {
    if (Object.keys(aws ?? {}).length) doc.set("aws", doc.createNode(aws));
    else doc.delete("aws");
  }
  if (db !== undefined && !isDeepStrictEqual(doc.toJS()?.db ?? {}, db)) {
    if (Object.keys(db).length) doc.set("db", doc.createNode(db));
    else doc.delete("db");
  }
  if (parent !== undefined) {
    if (parent) doc.set("extends", String(parent));
    else doc.delete("extends");
  }
  await fs.writeFile(file, doc.toString());
  if (parent) {
    // Una herencia inválida no debe quedar escrita: rompería el entorno.
    try {
      await chainOf(root, id);
    } catch (e) {
      await fs.writeFile(file, previous);
      throw e;
    }
  }
  return readEnvironment(root, id);
}

export async function createEnvironment(root, id) {
  const file = envFile(root, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, YAML.stringify({ name: id, protected: false, variables: {}, secrets: [] }), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") throw new CitrusError("ENV_EXISTS", `Ya existe el entorno '${id}'.`);
    throw e;
  }
  return { id };
}

async function editSecretNames(root, id, change) {
  const file = envFile(root, id);
  const doc = YAML.parseDocument(await fs.readFile(file, "utf8"));
  if (doc.errors.length) throw new CitrusError("BAD_YAML", `No se guardó: ${doc.errors[0].message}`);
  const names = doc.toJS()?.secrets;
  doc.set("secrets", doc.createNode(change(Array.isArray(names) ? names.map(String) : [])));
  await fs.writeFile(file, doc.toString());
}

/** Guarda el valor en el llavero. En el YAML solo queda el nombre. */
export async function setSecret(root, id, name, value, store) {
  if (!VALID_SECRET.test(String(name))) {
    throw new CitrusError("BAD_SECRET", "El nombre del secreto solo admite letras, números, punto, guion y guion bajo.");
  }
  if (typeof value !== "string" || !value) throw new CitrusError("BAD_SECRET", "El secreto no puede estar vacío.");
  await readEnvironment(root, id);
  await store.set(secretAccount(root, id, name), value);
  await editSecretNames(root, id, (names) => (names.includes(name) ? names : [...names, name]));
}

export async function deleteSecret(root, id, name, store) {
  await store.delete(secretAccount(root, id, name));
  await editSecretNames(root, id, (names) => names.filter((n) => n !== name));
}
