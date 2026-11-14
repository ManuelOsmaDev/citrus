// Variables que viven en AWS: Parameter Store (ssm:) y Secrets Manager (secret:).
// Se leen al enviar, se tratan como secretos y nunca se escriben en ningún archivo.
import { CitrusError } from "./errors.js";
import { awsClientOptions } from "./lambda.js";

const CACHE_MS = 5 * 60_000;
const cache = new Map();

/** `ssm:/app/dev/clave`, `secret:prod/api` o `secret:prod/api#apiKey` para una clave de un secreto JSON. */
export function parseAwsReference(reference) {
  const text = String(reference ?? "").trim();
  const ssm = /^ssm:(.+)$/.exec(text);
  if (ssm && ssm[1].trim()) return { kind: "ssm", name: ssm[1].trim() };
  const secret = /^secret:([^#]+)(?:#(.+))?$/.exec(text);
  if (secret && secret[1].trim()) return { kind: "secret", id: secret[1].trim(), key: secret[2]?.trim() || null };
  throw new CitrusError("AWS_REFERENCE", `'${text}' no es una referencia válida. Usa ssm:/ruta/del/parametro o secret:nombre-del-secreto#clave.`);
}

function friendly(err, name, reference, kind) {
  if (err instanceof CitrusError) return err;
  const type = err?.name ?? "";
  const where = `la variable ${name} (${reference})`;
  if (["ParameterNotFound", "ResourceNotFoundException"].includes(type)) {
    return new CitrusError("AWS_VARIABLE_NOT_FOUND", `No existe ${reference} en AWS. Revisa el nombre y la región de ${where}.`);
  }
  if (["AccessDeniedException", "UnrecognizedClientException"].includes(type)) {
    const permission = kind === "ssm" ? "ssm:GetParameter" : "secretsmanager:GetSecretValue";
    return new CitrusError("ACCESS_DENIED", `AWS negó el acceso a ${where}. Tu usuario necesita el permiso ${permission}, y kms:Decrypt si está cifrado.`);
  }
  if (type === "CredentialsProviderError") {
    return new CitrusError("NO_CREDENTIALS", `No encontré credenciales de AWS para leer ${where}. Configura tu perfil en el entorno o con aws configure.`);
  }
  return new CitrusError("AWS_VARIABLE", `No pude leer ${where}: ${err?.message ?? err}`);
}

async function readSsm(name, options) {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const client = new SSMClient(options);
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return String(res.Parameter?.Value ?? "");
  } finally {
    client.destroy();
  }
}

async function readSecret(id, key, options) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient(options);
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
    const text = res.SecretString ?? (res.SecretBinary ? Buffer.from(res.SecretBinary).toString("utf8") : "");
    if (!key) return text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CitrusError("AWS_VARIABLE", `El secreto ${id} no es JSON, así que no tiene la clave '${key}'. Quita #${key} de la referencia.`);
    }
    if (data === null || typeof data !== "object" || !(key in data)) {
      throw new CitrusError("AWS_VARIABLE", `El secreto ${id} no tiene la clave '${key}'.`);
    }
    const value = data[key];
    return typeof value === "string" ? value : JSON.stringify(value);
  } finally {
    client.destroy();
  }
}

/** Lee todas las variables de AWS de un entorno. Guarda cada valor 5 minutos para no consultar en cada envío. */
export async function readAwsVariables(references, aws = {}, { now = Date.now() } = {}) {
  const entries = Object.entries(references ?? {});
  if (!entries.length) return {};
  const options = await awsClientOptions(aws);
  const out = {};
  for (const [name, reference] of entries) {
    const parsed = parseAwsReference(reference);
    const key = JSON.stringify([aws.profile ?? null, options.region, aws.endpoint ?? null, String(reference).trim()]);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) {
      out[name] = hit.value;
      continue;
    }
    try {
      const value = parsed.kind === "ssm" ? await readSsm(parsed.name, options) : await readSecret(parsed.id, parsed.key, options);
      cache.set(key, { value, at: now });
      out[name] = value;
    } catch (err) {
      throw friendly(err, name, String(reference).trim(), parsed.kind);
    }
  }
  return out;
}

/** Para las pruebas y para "Volver a leer de AWS". */
export function clearAwsVariableCache() {
  cache.clear();
}
