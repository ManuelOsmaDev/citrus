import { createEnvironment, listEnvironments, readEnvironment, saveEnvironment, setSecret } from "../environments.js";
import { secretAccount } from "../secrets.js";
import { slugify } from "../paths.js";
import { createRequest } from "../workspace.js";

/**
 * Si un secreto ya existe con otro valor, no lo pisa: lo guarda con otro nombre
 * y actualiza las referencias de las requests.
 */
function renameInModel(model, from, to) {
  const swap = (text) => String(text).split(`{{${from}}}`).join(`{{${to}}}`);
  model.url = swap(model.url);
  for (const row of model.headers ?? []) row.value = swap(row.value);
  if (model.auth?.token) model.auth.token = swap(model.auth.token);
  if (model.auth?.password) model.auth.password = swap(model.auth.password);
  if (model.auth?.value) model.auth.value = swap(model.auth.value);
  if (model.body?.text) model.body.text = swap(model.body.text);
  for (const row of model.body?.rows ?? []) row.value = swap(row.value);
}

/**
 * Escribe en el workspace lo que devolvió un importador.
 * Nunca pisa requests ni variables existentes.
 *
 * @param {object} args
 * @param {{model: object, name?: string, folder?: string[]}[]} args.requests
 * @param {{name: string, value: string}[]} [args.secrets]
 * @param {Record<string,string>} [args.variables]
 * @param {string|null} [args.envId] entorno que recibe secretos y variables
 * @param {string} [args.folder] carpeta destino dentro de collections/
 */
export async function applyImport({ root, requests, secrets = [], variables = {}, environments = [], envId, store, folder = "" }) {
  const warnings = [];
  const created = [];
  const models = requests.map((r) => r.model);
  const storedSecrets = [];
  const createdEnvs = [];

  const known = (await listEnvironments(root)).map((e) => e.id);
  for (const env of environments) {
    if (known.includes(env.id)) continue;
    await createEnvironment(root, env.id);
    await saveEnvironment(root, env.id, { variables: env.variables, aws: env.aws });
    createdEnvs.push(env.id);
  }

  if (envId) {
    for (const secret of secrets) {
      let name = secret.name;
      for (let i = 2; ; i++) {
        const current = await store.get(secretAccount(root, envId, name));
        if (current === null || current === secret.value) break;
        name = `${secret.name}_${i}`;
      }
      await setSecret(root, envId, name, secret.value, store);
      if (name !== secret.name) models.forEach((m) => renameInModel(m, secret.name, name));
      storedSecrets.push(name);
    }
    const env = await readEnvironment(root, envId);
    const fresh = Object.fromEntries(Object.entries(variables).filter(([k]) => !Object.hasOwn(env.variables, k)));
    if (Object.keys(fresh).length) await saveEnvironment(root, envId, { variables: { ...env.variables, ...fresh } });
  } else if (secrets.length) {
    warnings.push(`Sin entorno activo: define estos secretos a mano: ${secrets.map((s) => s.name).join(", ")}.`);
  }

  for (const request of requests) {
    const parts = [folder, ...(request.folder ?? []).map((f) => slugify(f))].filter(Boolean);
    const name = request.name ?? request.model.name;
    const { id } = await createRequest(root, { folder: parts.join("/"), name, model: request.model, extra: request.extra });
    created.push(id);
  }
  return { created, storedSecrets, createdEnvs, warnings };
}
