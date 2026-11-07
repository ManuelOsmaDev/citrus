import { createHash } from "node:crypto";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";

// Credential Manager de Windows limita cada entrada a unos 1280 caracteres, y un JWT de
// Cognito los supera. Los valores largos se reparten en varias entradas.
const CHUNK = 1000;
const MARK = "citrus-chunks:";

/**
 * Identifica el workspace por su ruta, no por un campo del repo.
 * Así un repo clonado no puede hacerse pasar por otro y leer sus secretos.
 */
export function workspaceScope(root) {
  let resolved = path.resolve(root);
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

export const secretAccount = (root, envId, name) => `${workspaceScope(root)}:${envId}:${name}`;

/** Secretos en el llavero del sistema: Keychain, Credential Manager o libsecret. */
export function keychainStore({ service = process.env.CITRUS_KEYRING_SERVICE || "citrus" } = {}) {
  const entry = (account) => new Entry(service, account);
  const read = (account) => {
    try {
      return entry(account).getPassword() ?? null;
    } catch (e) {
      if (/no.*(entry|password|matching)|not found/i.test(String(e?.message))) return null;
      throw e;
    }
  };
  const drop = (account) => {
    try {
      entry(account).deleteCredential();
    } catch {
      // No existía: no hay nada que borrar.
    }
  };
  const remove = (account) => {
    const head = read(account);
    if (head?.startsWith(MARK)) {
      const count = Number(head.slice(MARK.length));
      for (let i = 0; i < count; i++) drop(`${account}#${i}`);
    }
    drop(account);
  };

  return {
    async get(account) {
      const head = read(account);
      if (head === null || !head.startsWith(MARK)) return head;
      let value = "";
      for (let i = 0, n = Number(head.slice(MARK.length)); i < n; i++) {
        const part = read(`${account}#${i}`);
        if (part === null) return null;
        value += part;
      }
      return value;
    },
    async set(account, value) {
      remove(account);
      if (value.length <= CHUNK && !value.startsWith(MARK)) {
        entry(account).setPassword(value);
        return;
      }
      const count = Math.ceil(value.length / CHUNK);
      for (let i = 0; i < count; i++) entry(`${account}#${i}`).setPassword(value.slice(i * CHUNK, (i + 1) * CHUNK));
      entry(account).setPassword(`${MARK}${count}`);
    },
    async delete(account) {
      remove(account);
    },
  };
}

/** Almacén en memoria para pruebas. */
export function memoryStore() {
  const data = new Map();
  return {
    data,
    get: async (account) => data.get(account) ?? null,
    set: async (account, value) => void data.set(account, value),
    delete: async (account) => void data.delete(account),
  };
}
