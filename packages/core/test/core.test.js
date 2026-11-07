import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, describe, it } from "node:test";
import selfsigned from "selfsigned";
import {
  applyImport,
  buildScope,
  createEnvironment,
  createRequest,
  describeEnvironment,
  emptyModel,
  importCurl,
  importPostman,
  initWorkspace,
  interpolate,
  keychainStore,
  listEnvironments,
  listTree,
  memoryStore,
  openWorkspace,
  prepareRequest,
  prettyJson,
  readHistory,
  readRequest,
  requestPath,
  resolveEnvironment,
  runRequest,
  saveEnvironment,
  saveRequest,
  secretAccount,
  sendHttp,
  setSecret,
} from "../src/index.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "citrus-test-"));

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

describe("variables", () => {
  it("expande variables anidadas", () => {
    const scope = buildScope({ variables: { host: "api.x", base: "https://{{host}}/v1" } });
    assert.equal(interpolate("{{ base }}/a", scope), "https://api.x/v1/a");
  });
  it("no reexpande el contenido de un secreto", () => {
    const scope = buildScope({ variables: { a: "x" }, secrets: { s: "{{a}}" } });
    assert.equal(interpolate("{{s}}", scope), "{{a}}");
  });
  it("detecta ciclos", () => {
    assert.throws(() => buildScope({ variables: { a: "{{b}}", b: "{{a}}" } }), { code: "VAR_CYCLE" });
  });
  it("anota las que faltan", () => {
    const missing = new Set();
    assert.equal(interpolate("{{nada}}", new Map(), missing), "{{nada}}");
    assert.deepEqual([...missing], ["nada"]);
  });
});

describe("workspace", () => {
  it("crea la estructura y agrega .citrus/ al .gitignore sin duplicar", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules");
    await initWorkspace(root, { name: "demo" });
    await openWorkspace(root);
    const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    assert.match(ignore, /node_modules/);
    assert.equal(ignore.match(/\.citrus\//g).length, 1);
    assert.deepEqual((await listEnvironments(root)).map((e) => e.id), ["local"]);
  });

  it("rechaza ids que salen de la colección", async () => {
    const root = await tmp();
    await initWorkspace(root);
    await assert.rejects(requestPath(root, "../../secreto.citrus.yaml"), { code: "PATH_OUTSIDE" });
    await assert.rejects(requestPath(root, "C:/Windows/x.citrus.yaml"), { code: "PATH_OUTSIDE" });
    await assert.rejects(requestPath(root, "archivo.txt"), { code: "BAD_REQUEST_ID" });
  });

  it("al guardar conserva comentarios y campos que no edita", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const yaml = `# comentario de cabecera
name: Crear pedido
method: POST
url: "{{baseUrl}}/orders"
headers:
  Authorization: "Bearer {{token}}" # el token vive en el llavero
body:
  json:
    productId: 42
observe:
  logs: true
  db: { connection: main, tables: [orders] }
assert:
  - status == 201
capture:
  lastOrderId: body.id
`;
    await fs.mkdir(path.join(root, "collections/orders"), { recursive: true });
    await fs.writeFile(path.join(root, "collections/orders/create.citrus.yaml"), yaml);

    const { model } = await readRequest(root, "orders/create.citrus.yaml");
    assert.equal(model.method, "POST");
    assert.deepEqual(JSON.parse(model.body.text), { productId: 42 });

    const unchanged = await saveRequest(root, "orders/create.citrus.yaml", model);
    assert.equal(unchanged.raw.includes("# el token vive en el llavero"), true);

    model.url = "{{baseUrl}}/orders/v2";
    model.headers.push({ key: "X-Off", value: "1", enabled: false });
    const { raw } = await saveRequest(root, "orders/create.citrus.yaml", model);
    assert.match(raw, /# comentario de cabecera/);
    assert.match(raw, /# el token vive en el llavero/);
    assert.match(raw, /status == 201/);
    assert.match(raw, /lastOrderId: body.id/);
    assert.match(raw, /tables: \[ orders \]|tables: \[orders\]/);
    assert.match(raw, /orders\/v2/);

    const reread = await readRequest(root, "orders/create.citrus.yaml");
    assert.deepEqual(reread.model.headers.find((h) => h.key === "X-Off"), { key: "X-Off", value: "1", enabled: false });
  });

  it("lista lambdas e ignora el resto; un YAML roto no tumba el árbol", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const dir = path.join(root, "collections/workers");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "pay.sqs.citrus.yaml"), "name: Pago\ntype: lambda\nfunction: f\n");
    await fs.writeFile(path.join(dir, "roto.citrus.yaml"), "name: [sin cerrar\n");
    await fs.writeFile(path.join(dir, "nota.txt"), "x");
    const [folder] = await listTree(root);
    assert.deepEqual(folder.children.map((c) => c.type), ["lambda", "invalid"]);
    const { model } = await readRequest(root, "workers/pay.sqs.citrus.yaml");
    assert.equal(model.type, "lambda");
  });

  it("no pisa una request con el mismo nombre", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const a = await createRequest(root, { name: "Mi Pedido!" });
    const b = await createRequest(root, { name: "Mi Pedido!" });
    assert.equal(a.id, "mi-pedido.citrus.yaml");
    assert.equal(b.id, "mi-pedido-2.citrus.yaml");
  });

  it("conserva enteros largos del JSON", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const { id } = await createRequest(root, { name: "big" });
    const model = emptyModel("big");
    model.body = { mode: "json", text: '{"id": 12345678901234567890}', rows: [], file: "" };
    await saveRequest(root, id, model);
    assert.match((await readRequest(root, id)).model.body.text, /12345678901234567890/);
  });
});

describe("entornos y secretos", () => {
  it("hereda variables y la protección de los padres", async () => {
    const root = await tmp();
    await initWorkspace(root);
    await createEnvironment(root, "base");
    await saveEnvironment(root, "base", { variables: { a: "1", b: "2" }, protected: true });
    await createEnvironment(root, "hijo");
    await saveEnvironment(root, "hijo", { variables: { b: "3" }, protected: false, extends: "base" });
    const env = await resolveEnvironment(root, "hijo", memoryStore());
    assert.equal(env.scope.get("a"), "1");
    assert.equal(env.scope.get("b"), "3");
    assert.equal(env.protected, true);
  });

  it("detecta herencia circular y no la deja escrita", async () => {
    const root = await tmp();
    await initWorkspace(root);
    await createEnvironment(root, "a");
    await createEnvironment(root, "b");
    await saveEnvironment(root, "a", { extends: "b" });
    await assert.rejects(saveEnvironment(root, "b", { extends: "a" }), { code: "ENV_CYCLE" });
    await resolveEnvironment(root, "b", memoryStore());
  });

  it("el valor del secreto no llega al YAML ni a la descripción", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    await setSecret(root, "local", "token", "super-secreto-123", store);
    const yaml = await fs.readFile(path.join(root, "environments/local.yaml"), "utf8");
    assert.match(yaml, /token/);
    assert.doesNotMatch(yaml, /super-secreto-123/);
    const described = await describeEnvironment(root, "local", store);
    assert.doesNotMatch(JSON.stringify(described), /super-secreto-123/);
    assert.deepEqual(described.secrets, [{ name: "token", isSet: true, own: true }]);
  });

  it("un YAML con aws y db los conserva al guardar", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const file = path.join(root, "environments/local.yaml");
    await fs.writeFile(file, "name: local\n# mi perfil\naws:\n  profile: p\ndb:\n  main:\n    host: h\nvariables: {}\n");
    await saveEnvironment(root, "local", { variables: { x: "1" } });
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /# mi perfil/);
    assert.match(text, /profile: p/);
    assert.match(text, /host: h/);
  });

  it("un entorno de otra ruta no comparte secretos", () => {
    assert.notEqual(secretAccount("C:/a", "dev", "t"), secretAccount("C:/b", "dev", "t"));
  });

  it("llavero real: guarda, lee, parte valores largos y borra", async () => {
    const store = keychainStore({ service: "citrus-test" });
    const account = `test:${Date.now()}`;
    const long = "x".repeat(5000);
    try {
      assert.equal(await store.get(account), null);
      await store.set(account, "corto");
      assert.equal(await store.get(account), "corto");
      await store.set(account, long);
      assert.equal(await store.get(account), long);
      await store.set(account, "otra-vez-corto");
      assert.equal(await store.get(account), "otra-vez-corto");
    } finally {
      await store.delete(account);
    }
    assert.equal(await store.get(account), null);
  });
});

describe("prepareRequest", () => {
  const scope = buildScope({ variables: { base: "http://h", name: 'con "comillas"' } });

  it("exige todas las variables", async () => {
    const model = { ...emptyModel(), url: "{{base}}/{{falta}}" };
    await assert.rejects(prepareRequest(model, scope), { code: "MISSING_VARS", details: { names: ["falta"] } });
  });
  it("no rompe el JSON con comillas en una variable", async () => {
    const model = { ...emptyModel(), method: "POST", url: "{{base}}", body: { mode: "json", text: '{"a":"{{name}}"}' } };
    const out = await prepareRequest(model, scope);
    assert.deepEqual(JSON.parse(out.body.toString()), { a: 'con "comillas"' });
    assert.ok(out.headers.some(([k, v]) => k === "Content-Type" && v === "application/json"));
  });
  it("acepta {{var}} sin comillas en JSON", async () => {
    const s = buildScope({ variables: { n: "7" } });
    const model = { ...emptyModel(), method: "POST", url: "http://h", body: { mode: "json", text: '{"a": {{n}}}' } };
    assert.equal((await prepareRequest(model, s)).body.toString(), '{"a": 7}');
  });
  it("niega archivos fuera del workspace", async () => {
    const root = await tmp();
    const model = { ...emptyModel(), method: "POST", url: "http://h", body: { mode: "binary", file: "../../.ssh/id_rsa" } };
    await assert.rejects(prepareRequest(model, scope, { root }), { code: "PATH_OUTSIDE" });
    const abs = { ...model, body: { mode: "binary", file: path.join(os.homedir(), ".ssh/id_rsa") } };
    await assert.rejects(prepareRequest(abs, scope, { root }), { code: "PATH_OUTSIDE" });
  });
  it("niega autenticación no soportada en vez de mandar sin credenciales", async () => {
    const model = { ...emptyModel(), url: "http://h", auth: { type: "unsupported", name: "sigv4" } };
    await assert.rejects(prepareRequest(model, scope), { code: "UNSUPPORTED_AUTH" });
  });
  it("arma multipart con boundary", async () => {
    const model = { ...emptyModel(), method: "POST", url: "http://h", body: { mode: "multipart", rows: [{ key: "a", value: "1", enabled: true }] } };
    const out = await prepareRequest(model, scope);
    const type = out.headers.find(([k]) => k === "Content-Type")[1];
    assert.match(type, /^multipart\/form-data; boundary=/);
    assert.match(out.body.toString(), /name="a"/);
  });
  it("agrega el esquema si falta y la autenticación por query", async () => {
    const model = { ...emptyModel(), url: "localhost:3000/x", auth: { type: "apikey", key: "k", value: "v", in: "query" } };
    assert.equal((await prepareRequest(model, scope)).url, "http://localhost:3000/x?k=v");
  });
});

describe("sendHttp", () => {
  let server;
  let port;
  let other;
  let otherPort;
  let lastOther;

  before(async () => {
    other = http.createServer((req, res) => {
      lastOther = req.headers;
      res.end("otro origen");
    });
    otherPort = await listen(other);
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const route = req.url.split("?")[0];
        if (route === "/echo") {
          res.setHeader("content-type", "application/json");
          res.setHeader("set-cookie", ["a=1", "b=2"]);
          return res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
        }
        if (route === "/gzip") {
          res.setHeader("content-encoding", "gzip");
          return res.end(zlib.gzipSync("descomprimido"));
        }
        if (route === "/r303") {
          res.statusCode = 303;
          res.setHeader("location", "/echo");
          return res.end();
        }
        if (route === "/r307") {
          res.statusCode = 307;
          res.setHeader("location", "/echo");
          return res.end();
        }
        if (route === "/cross") {
          res.statusCode = 302;
          res.setHeader("location", `http://127.0.0.1:${otherPort}/x`);
          return res.end();
        }
        if (route === "/loop") {
          res.statusCode = 302;
          res.setHeader("location", "/loop");
          return res.end();
        }
        if (route === "/slow") return void setTimeout(() => res.end("tarde"), 5000);
        res.statusCode = 404;
        res.end("no");
      });
    });
    port = await listen(server);
  });
  after(() => {
    server.closeAllConnections();
    server.close();
    other.closeAllConnections();
    other.close();
  });

  const req = (route, extra = {}) => ({ method: "GET", url: `http://127.0.0.1:${port}${route}`, headers: [], ...extra });

  it("devuelve status, headers repetidos y timings", async () => {
    const res = await sendHttp(req("/echo"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers["set-cookie"], ["a=1", "b=2"]);
    assert.ok(res.timings.total > 0);
    assert.ok(res.timings.tcp >= 0);
    assert.equal(res.timings.tls, 0);
  });
  it("mide DNS cuando hay que resolver un nombre", async () => {
    const res = await sendHttp({ ...req("/echo"), url: `http://localhost:${port}/echo` });
    assert.ok(res.timings.dns > 0);
  });
  it("descomprime gzip", async () => {
    assert.equal((await sendHttp(req("/gzip"))).body.toString(), "descomprimido");
  });
  it("303 cambia a GET y quita el body; 307 lo conserva", async () => {
    const a = await sendHttp(req("/r303", { method: "POST", body: Buffer.from("x") }));
    assert.equal(JSON.parse(a.body).method, "GET");
    assert.equal(JSON.parse(a.body).body, "");
    const b = await sendHttp(req("/r307", { method: "POST", body: Buffer.from("x") }));
    assert.equal(JSON.parse(b.body).method, "POST");
    assert.equal(JSON.parse(b.body).body, "x");
    assert.equal(b.redirects.length, 1);
  });
  it("no reenvía credenciales a otro origen", async () => {
    await sendHttp(req("/cross", {
      headers: [["Authorization", "Bearer s"], ["X-Mi-Clave", "k"], ["X-Ok", "1"]],
      sensitiveHeaders: ["X-Mi-Clave"],
    }));
    assert.equal(lastOther.authorization, undefined);
    assert.equal(lastOther["x-mi-clave"], undefined);
    assert.equal(lastOther["x-ok"], "1");
  });
  it("corta los bucles de redirección", async () => {
    await assert.rejects(sendHttp(req("/loop")), { code: "TOO_MANY_REDIRECTS" });
  });
  it("cancela y respeta el timeout", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(sendHttp(req("/slow"), { signal: ctl.signal }), { code: "CANCELLED" });
    await assert.rejects(sendHttp(req("/slow"), { timeoutMs: 50 }), { code: "TIMEOUT" });
  });
  it("explica una conexión rechazada", async () => {
    await assert.rejects(sendHttp({ method: "GET", url: "http://127.0.0.1:1/", headers: [] }), { code: "ECONNREFUSED" });
  });

  it("mide TLS y rechaza certificados autofirmados por defecto", async () => {
    const pems = selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 2, keySize: 2048 });
    const secure = https.createServer({ key: pems.private, cert: pems.cert }, (_, res) => res.end("seguro"));
    const securePort = await listen(secure);
    const url = `https://127.0.0.1:${securePort}/`;
    try {
      await assert.rejects(sendHttp({ method: "GET", url, headers: [] }), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      const res = await sendHttp({ method: "GET", url, headers: [] }, { rejectUnauthorized: false });
      assert.equal(res.body.toString(), "seguro");
      assert.ok(res.timings.tls > 0);
    } finally {
      secure.closeAllConnections();
      secure.close();
    }
  });
});

describe("runRequest", () => {
  let server;
  let port;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ auth: req.headers.authorization, big: 1 }).replace('"big":1', '"big":12345678901234567890'));
    });
    port = await listen(server);
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  async function setup() {
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    await saveEnvironment(root, "local", { variables: { base: `http://127.0.0.1:${port}` } });
    await setSecret(root, "local", "token", "abc-secreto", store);
    const model = { ...emptyModel("Prueba"), url: "{{base}}/x", auth: { type: "bearer", token: "{{token}}" } };
    return { root, store, model };
  }

  it("envía el secreto pero lo enmascara en sent y en el historial", async () => {
    const { root, store, model } = await setup();
    const { result } = await runRequest({ root, model, envId: "local", store });
    assert.equal(result.status, 200);
    const sent = JSON.stringify(result.sent);
    assert.doesNotMatch(sent, /abc-secreto/);
    assert.match(sent, /••••••/);
    assert.match(result.body.text, /Bearer abc-secreto/);
    assert.match(result.body.text, /12345678901234567890/);
    const onDisk = await fs.readFile(path.join(root, ".citrus/history.jsonl"), "utf8");
    assert.doesNotMatch(onDisk, /abc-secreto/);
    const [entry] = await readHistory(root);
    assert.equal(entry.status, 200);
    assert.equal(entry.url, "{{base}}/x");
  });

  it("entorno protegido: GET pasa; lo demás exige confirmación", async () => {
    const { root, store, model } = await setup();
    await saveEnvironment(root, "local", { protected: true });
    await runRequest({ root, model, envId: "local", store });
    const post = { ...model, method: "POST" };
    await assert.rejects(runRequest({ root, model: post, envId: "local", store }), { code: "DENIED_PROTECTED" });
    await assert.rejects(runRequest({ root, model: post, envId: "local", store, confirm: async () => false }), { code: "DENIED_PROTECTED" });
    let seen;
    const ok = await runRequest({ root, model: post, envId: "local", store, confirm: async (i) => ((seen = i), true) });
    assert.equal(ok.result.status, 200);
    assert.equal(seen.method, "POST");
  });

  it("un secreto sin valor no se manda", async () => {
    const { root, model } = await setup();
    await assert.rejects(runRequest({ root, model, envId: "local", store: memoryStore() }), {
      code: "MISSING_VARS",
      message: /Secretos sin valor: token/,
    });
  });

  it("registra errores en el historial", async () => {
    const { root, store } = await setup();
    await assert.rejects(runRequest({ root, model: { ...emptyModel("e"), url: "http://127.0.0.1:1/" }, envId: "local", store }));
    assert.equal((await readHistory(root))[0].error, "ECONNREFUSED");
  });

});

describe("prettyJson", () => {
  it("indenta sin alterar números ni strings", () => {
    const out = prettyJson('{"a":12345678901234567890,"b":[1, 2],"c":{},"d":"x:{,}\\"y"}');
    assert.equal(out, '{\n  "a": 12345678901234567890,\n  "b": [\n    1,\n    2\n  ],\n  "c": {},\n  "d": "x:{,}\\"y"\n}');
  });
});

describe("importCurl", () => {
  it("entiende un POST JSON típico y extrae el token", () => {
    const { model, secrets } = importCurl(`curl -X POST 'https://api.x.com/orders?a=1' \\
      -H 'Content-Type: application/json' \\
      -H "Authorization: Bearer abc.def" \\
      --data-raw '{"productId":42}'`);
    assert.equal(model.method, "POST");
    assert.equal(model.url, "https://api.x.com/orders?a=1");
    assert.equal(model.body.mode, "json");
    assert.equal(JSON.parse(model.body.text).productId, 42);
    assert.equal(model.headers.find((h) => h.key === "Authorization").value, "Bearer {{authorization}}");
    assert.deepEqual(secrets, [{ name: "authorization", value: "abc.def" }]);
  });
  it("infiere POST con -d y arma form", () => {
    const { model } = importCurl("curl https://x.com/login -d user=ana -d 'nota=a%20b'");
    assert.equal(model.method, "POST");
    assert.equal(model.body.mode, "form");
    assert.deepEqual(model.body.rows.map((r) => [r.key, r.value]), [["user", "ana"], ["nota", "a b"]]);
  });
  it("-u, -G, formas pegadas y flags agrupados", () => {
    const a = importCurl("curl -sSL -XDELETE -u ana:clave https://x.com/a");
    assert.equal(a.model.method, "DELETE");
    assert.equal(a.model.auth.username, "ana");
    assert.equal(a.model.auth.password, "{{basic_password}}");
    assert.deepEqual(a.secrets, [{ name: "basic_password", value: "clave" }]);
    const b = importCurl("curl -G https://x.com/s --data-urlencode 'q=a b'");
    assert.equal(b.model.method, "GET");
    assert.equal(b.model.url, "https://x.com/s?q=a%20b");
  });
  it("saca claves del query, del JSON y del multipart", () => {
    const { model, secrets } = importCurl(`curl 'https://x.com/a?api_key=K1&b=2' -H 'content-type: application/json' -d '{"password":"P1","ok":"si"}'`);
    assert.equal(model.url, "https://x.com/a?api_key={{api_key}}&b=2");
    assert.deepEqual(JSON.parse(model.body.text), { password: "{{password}}", ok: "si" });
    assert.deepEqual(secrets.map((s) => s.value), ["K1", "P1"]);
    const multi = importCurl("curl https://x.com -F 'a=1' -F 'f=@foto.png;type=image/png'");
    assert.equal(multi.model.body.mode, "multipart");
    assert.deepEqual(multi.model.body.rows[1], { key: "f", value: "foto.png", enabled: true, isFile: true });
  });
  it("comandos con errores dan un mensaje claro", () => {
    assert.throws(() => importCurl("wget x"), { code: "BAD_CURL" });
    assert.throws(() => importCurl("curl 'sin cerrar"), { code: "BAD_CURL" });
    assert.throws(() => importCurl("curl -X POST"), { code: "BAD_CURL" });
  });
  it("no toca lo que ya es variable", () => {
    const { secrets } = importCurl("curl https://x.com -H 'Authorization: Bearer {{t}}'");
    assert.deepEqual(secrets, []);
  });
});

describe("importPostman", () => {
  const collection = {
    info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "tok-123" }] },
    variable: [{ key: "baseUrl", value: "https://api.x" }, { key: "apiSecret", value: "s3" }],
    event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }],
    item: [
      {
        name: "Pedidos",
        item: [
          {
            name: "Crear",
            request: {
              method: "POST",
              url: { raw: "{{baseUrl}}/orders?a=1", query: [{ key: "off", value: "2", disabled: true }] },
              header: [{ key: "X-A", value: "1" }, { key: "X-B", value: "2", disabled: true }],
              body: { mode: "raw", raw: '{"a":1}', options: { raw: { language: "json" } } },
            },
          },
          {
            name: "Sin auth",
            request: { method: "GET", url: "{{baseUrl}}/p", auth: { type: "noauth" } },
          },
          {
            name: "Firmada",
            request: { method: "GET", url: "{{baseUrl}}/s", auth: { type: "awsv4", awsv4: [] } },
          },
          {
            name: "Form",
            request: { method: "POST", url: "{{baseUrl}}/f", body: { mode: "urlencoded", urlencoded: [{ key: "a", value: "1" }] } },
          },
        ],
      },
    ],
  };

  it("convierte carpetas, auth heredada, disabled, bodies y variables", () => {
    const out = importPostman(collection);
    assert.equal(out.requests.length, 4);
    const [crear, sinAuth, firmada, form] = out.requests;
    assert.deepEqual(crear.folder, ["Pedidos"]);
    assert.equal(crear.model.body.mode, "json");
    assert.equal(crear.model.auth.token, "{{bearer_token}}");
    assert.equal(crear.model.headers[1].enabled, false);
    assert.equal(crear.model.disabledQuery[0].key, "off");
    assert.equal(sinAuth.model.auth.type, "none");
    assert.equal(firmada.model.auth.type, "none");
    assert.equal(form.model.body.mode, "form");
    assert.deepEqual(out.variables, { baseUrl: "https://api.x" });
    assert.deepEqual(out.secrets.map((s) => s.name).sort(), ["apiSecret", "bearer_token"]);
    assert.ok(out.warnings.some((w) => w.includes("awsv4")));
    assert.ok(out.warnings.some((w) => w.includes("script")));
  });

  it("rechaza lo que no es una colección", () => {
    assert.throws(() => importPostman("no json"), { code: "BAD_POSTMAN" });
    assert.throws(() => importPostman({ item: [] }), { code: "BAD_POSTMAN" });
  });

  it("aplica el import sin dejar secretos en disco y sin pisar nada", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    await saveEnvironment(root, "local", { variables: { baseUrl: "http://mio" } });
    await setSecret(root, "local", "bearer_token", "otro-valor", store);

    const out = importPostman(collection);
    const report = await applyImport({ root, ...out, envId: "local", store });
    assert.equal(report.created.length, 4);
    assert.ok(report.created[0].startsWith("pedidos/"));
    assert.ok(report.storedSecrets.includes("bearer_token_2"));

    const { model } = await readRequest(root, report.created[0]);
    assert.equal(model.auth.token, "{{bearer_token_2}}");
    assert.equal(await store.get(secretAccount(root, "local", "bearer_token")), "otro-valor");
    assert.equal(await store.get(secretAccount(root, "local", "bearer_token_2")), "tok-123");

    const env = await fs.readFile(path.join(root, "environments/local.yaml"), "utf8");
    assert.match(env, /http:\/\/mio/);
    const everything = [env, ...(await Promise.all(report.created.map((id) => readRequest(root, id).then((r) => r.raw))))].join("\n");
    assert.doesNotMatch(everything, /tok-123|s3\b/);
  });

  it("una carpeta de Postman con ../ no escapa de la colección", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const out = importPostman({
      info: { schema: "x/collection/v2.1.0/" },
      item: [{ name: "../../fuera", item: [{ name: "../evil", request: { method: "GET", url: "http://x" } }] }],
    });
    const { created } = await applyImport({ root, ...out, envId: "local", store: memoryStore() });
    assert.equal(created[0], "fuera/evil.citrus.yaml");
    await fs.access(path.join(root, "collections/fuera/evil.citrus.yaml"));
  });
});
