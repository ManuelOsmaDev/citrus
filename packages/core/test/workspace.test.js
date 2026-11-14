import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createEnvironment,
  createRequest,
  duplicateRequest,
  initWorkspace,
  readEnvironment,
  readRequest,
  renameRequest,
  saveEnvironment,
} from "../src/index.js";

describe("renombrar, duplicar y AWS del entorno", () => {
  let root;
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-editar-"));
    await initWorkspace(root, { name: "prueba" });
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  it("renombra sin mover el archivo y conserva tests y comentarios", async () => {
    const { id } = await createRequest(root, { folder: "tienda", name: "Viejo", extra: { assert: ["status == 200"] } });
    const file = path.join(root, "collections", id);
    await fs.appendFile(file, "# nota a mano\n");
    const out = await renameRequest(root, id, "  Nuevo nombre ");
    assert.equal(out.id, id);
    const r = await readRequest(root, id);
    assert.equal(r.model.name, "Nuevo nombre");
    assert.match(r.raw, /status == 200/);
    assert.match(r.raw, /# nota a mano/);
    await assert.rejects(renameRequest(root, id, "   "), (e) => e.code === "BAD_NAME");
  });

  it("duplica la request completa en la misma carpeta, sin pisar nada", async () => {
    const { id } = await createRequest(root, { folder: "tienda", name: "Original", extra: { assert: ["status == 201"], observe: { logs: true } } });
    const copy = await duplicateRequest(root, id, "Original (copia)");
    assert.notEqual(copy.id, id);
    assert.ok(copy.id.startsWith("tienda/"), copy.id);
    const r = await readRequest(root, copy.id);
    assert.equal(r.model.name, "Original (copia)");
    assert.match(r.raw, /status == 201/);
    assert.match(r.raw, /logs: true/);
    const again = await duplicateRequest(root, id, "Original (copia)");
    assert.notEqual(again.id, copy.id);
    assert.equal((await readRequest(root, id)).model.name, "Original");
  });

  it("guarda el perfil y la región de AWS y los quita si quedan vacíos", async () => {
    await createEnvironment(root, "dev");
    await saveEnvironment(root, "dev", { aws: { profile: "mi-perfil", region: "us-east-1" } });
    assert.deepEqual((await readEnvironment(root, "dev")).aws, { profile: "mi-perfil", region: "us-east-1" });
    await saveEnvironment(root, "dev", { aws: {} });
    assert.equal((await readEnvironment(root, "dev")).aws, null);
  });
});
