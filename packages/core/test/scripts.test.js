import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import YAML from "yaml";
import { emptyModel, modelFromFile, modelToPatch } from "../src/model.js";
import { runRequest } from "../src/runner.js";

describe("scripts", () => {
  let server, base, root;
  let seen = [];

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-scripts-"));
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/login") return res.end(JSON.stringify({ token: "token-secreto-123" }));
        res.end(JSON.stringify({ ok: true, token: "nuevo-token-456" }));
      });
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const model = (fields) => ({ ...emptyModel("x"), method: "POST", url: `${base}/api`, ...fields });
  const go = (m, captures = {}) => {
    seen = [];
    return runRequest({ root, model: m, envId: null, store: null, captures }).then((r) => r.result);
  };

  it("pone un Bearer token y lo oculta en lo enviado", async () => {
    const res = await go(model({ scripts: { before: 'req.headers["Authorization"] = "Bearer abcdefghij123"', after: "" } }));
    assert.equal(seen[0].headers.authorization, "Bearer abcdefghij123");
    assert.ok(!JSON.stringify(res.sent).includes("abcdefghij123"));
  });

  it("inicia sesión, guarda el token y lo usa como {{token}}", async () => {
    const code = "let login = await http.post('" + base + "/login', { usuario: \"ana\" })\nenv.set(\"token\", login.json.token)";
    const captures = {};
    await go(model({ headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }], scripts: { before: code, after: "" } }), captures);
    assert.equal(seen[0].url, "/login");
    assert.equal(JSON.parse(seen[0].body).usuario, "ana");
    assert.equal(seen[1].headers.authorization, "Bearer token-secreto-123");
    assert.equal(captures.token, "token-secreto-123");
  });

  it("firma el body con HMAC y cambia el body", async () => {
    await go(model({ body: { mode: "json", text: '{"a":1}', rows: [], file: "" }, scripts: { before: 'req.headers["X-Firma"] = hmac_sha256("clave", req.body)\nreq.body = to_json({ a: 2 })', after: "" } }));
    assert.equal(seen[0].headers["x-firma"], crypto.createHmac("sha256", "clave").update('{"a":1}').digest("hex"));
    assert.deepEqual(JSON.parse(seen[0].body), { a: 2 });
  });

  it("después de recibir guarda datos y escribe en la consola", async () => {
    const captures = {};
    const res = await go(model({ scripts: { before: "", after: 'env.set("token", res.json.token)\nlog("estado", res.status)' } }), captures);
    assert.equal(captures.token, "nuevo-token-456");
    assert.equal(res.scripts[0].text, "estado 200");
  });

  it("si falla antes, no envía nada", async () => {
    await assert.rejects(go(model({ scripts: { before: "no_existe()", after: "" } })), (e) => e.code === "SCRIPT_ERROR" && /no_existe/.test(e.message));
    assert.equal(seen.length, 0);
  });

  it("si falla después, conserva la respuesta", async () => {
    const res = await go(model({ scripts: { before: "", after: "no_existe()" } }));
    assert.equal(res.status, 200);
    assert.equal(res.scripts[0].error, true);
  });

  it("no puede tocar el sistema", async () => {
    for (const code of ['read_file("c:/windows/win.ini")', 'process.exit(1)', 'require("fs")']) {
      await assert.rejects(go(model({ scripts: { before: code, after: "" } })), (e) => e.code === "SCRIPT_ERROR");
    }
  });

  it("un ciclo infinito se detiene", async () => {
    await assert.rejects(go(model({ scripts: { before: "while true { }", after: "" } })), (e) => e.code === "SCRIPT_ERROR");
  });

  it("se guarda en el YAML y vuelve igual", () => {
    const m = model({ scripts: { before: 'log("a")', after: "" } });
    const back = modelFromFile(YAML.parse(YAML.stringify(modelToPatch(m))));
    assert.deepEqual(back.scripts, { before: 'log("a")', after: "" });
    assert.equal(modelToPatch(model({})).scripts, undefined);
  });
});
