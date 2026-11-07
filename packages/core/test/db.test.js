// Corre contra un MySQL real y temporal. La primera vez descarga el servidor oficial.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDB } from "mysql-memory-server";
import mysql from "mysql2/promise";
import {
  diffTable,
  emptyModel,
  initWorkspace,
  memoryStore,
  readEnvironment,
  readRequest,
  resolveEnvironment,
  runFolder,
  runRequest,
  saveEnvironment,
  saveRequest,
  setSecret,
  sslFor,
  testDbConnection,
} from "../src/index.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "citrus-db-"));
const statuses = (tests) => tests.map((t) => t.status);

describe("diffTable, sin base", () => {
  const t = (rows, pk = ["id"]) => ({ pk, columns: ["id", "a"], rows });
  it("detecta altas, bajas y campos cambiados", () => {
    const out = diffTable("x", t([{ id: "1", a: "x" }, { id: "2", a: "y" }]), t([{ id: "1", a: "z" }, { id: "3", a: "w" }]));
    assert.deepEqual(out.inserted, [{ id: "3", a: "w" }]);
    assert.deepEqual(out.deleted, [{ id: "2", a: "y" }]);
    assert.deepEqual(out.updated[0].changed, ["a"]);
  });
  it("sin clave primaria compara filas repetidas como multiconjunto", () => {
    const row = { id: "1", a: "x" };
    const out = diffTable("x", t([row, row], []), t([row], []));
    assert.equal(out.deleted.length, 1);
    assert.equal(out.inserted.length, 0);
  });
});

describe("sslFor", () => {
  it("exige TLS fuera de esta máquina", () => {
    assert.equal(sslFor({ host: "127.0.0.1" }), undefined);
    assert.equal(sslFor({ host: "x.abc.us-east-1.rds.amazonaws.com" }), "Amazon RDS");
    assert.deepEqual(sslFor({ host: "db.miempresa.com" }), { rejectUnauthorized: true });
    assert.equal(sslFor({ host: "db.miempresa.com", ssl: false }), undefined);
  });
});

describe("MySQL real", () => {
  let server;
  let admin;
  let api;
  let apiPort;
  let root;
  let store;

  before(async () => {
    server = await createDB({ dbName: "app", username: "root", logLevel: "ERROR" });
    admin = await mysql.createConnection({ host: "127.0.0.1", port: server.port, user: "root", database: "app" });
    await admin.query("CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(20), total DECIMAL(10,2), big BIGINT, meta JSON, created DATETIME, secret_note VARCHAR(60))");
    await admin.query("CREATE TABLE sin_pk (a INT, b VARCHAR(10))");
    await admin.query("CREATE TABLE enorme (id INT PRIMARY KEY)");
    await admin.query("CREATE USER 'lector'@'%' IDENTIFIED BY 'clave-lectura'");
    await admin.query("GRANT SELECT ON app.* TO 'lector'@'%'");
    // El "backend": escribe en MySQL según la ruta que recibe.
    api = http.createServer(async (req, res) => {
      if (req.url === "/create") await admin.query("INSERT INTO orders VALUES (1, 'new', 10.50, 9007199254740993, '{\"a\":1}', '2026-11-06 20:00:00', 'token-secreto-db')");
      if (req.url === "/pay") await admin.query("UPDATE orders SET status = 'paid' WHERE id = 1");
      if (req.url === "/del") await admin.query("DELETE FROM orders WHERE id = 1");
      if (req.url === "/nopk") await admin.query("INSERT INTO sin_pk VALUES (1, 'x')");
      if (req.url === "/nada") await admin.query("SELECT 1");
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    apiPort = api.address().port;
  });

  after(async () => {
    api?.closeAllConnections();
    api?.close();
    await admin?.end();
    await server?.stop();
  });

  async function workspace(db) {
    root = await tmp();
    await initWorkspace(root);
    store = memoryStore();
    await saveEnvironment(root, "local", { db: { main: { host: "127.0.0.1", port: server.port, database: "app", user: "lector", passwordSecret: "dbPassword", ...db } } });
    await setSecret(root, "local", "dbPassword", "clave-lectura", store);
    await setSecret(root, "local", "nota", "token-secreto-db", store);
  }
  const model = (route, observeDb, assertions = []) => ({
    ...emptyModel("x"),
    url: `http://127.0.0.1:${apiPort}${route}`,
    observe: { db: { connection: "main", ...observeDb } },
    assert: assertions,
  });
  const send = (route, observeDb, assertions, extra = {}) => runRequest({ root, model: model(route, observeDb, assertions), envId: "local", store, ...extra });
  const clean = () => admin.query("DELETE FROM orders");

  it("snapshot: alta, cambio y baja con un usuario de solo lectura", async () => {
    await workspace({});
    await clean();
    const tables = ["orders"];
    const created = await send("/create", { tables }, ["db.orders.inserted == 1", "db.orders.new[0].status == new", "db.orders.updated == 0", "db.x.inserted == 1"]);
    assert.equal(created.result.db.mode, "snapshot");
    assert.deepEqual(statuses(created.result.tests), ["pass", "pass", "pass", "fail"]);
    const row = created.result.db.tables[0].inserted[0];
    assert.equal(row.total, "10.50");
    assert.equal(row.big, "9007199254740993", "los BIGINT no pierden precisión");
    assert.equal(row.meta, '{"a":1}');
    assert.equal(row.created, "2026-11-06 20:00:00");
    assert.equal(row.secret_note, "••••••", "los secretos del entorno se enmascaran");

    const paid = await send("/pay", { tables }, ["db.orders.updated == 1", "db.orders.new[status=paid] exists", "db.orders.new[status=otro] exists"]);
    assert.deepEqual(statuses(paid.result.tests), ["pass", "pass", "fail"]);
    assert.deepEqual(paid.result.db.tables[0].updated[0].changed, ["status"]);
    assert.equal(paid.result.db.tables[0].updated[0].before.status, "new");

    const gone = await send("/del", { tables }, ["db.orders.deleted == 1", "db.orders.removed[0].id == 1"]);
    assert.deepEqual(statuses(gone.result.tests), ["pass", "pass"]);
    const quiet = await send("/nada", { tables });
    assert.equal(quiet.result.db.changes, 0);
  });

  it("nunca escribe: la conexión es de solo lectura aunque el usuario pueda", async () => {
    await workspace({ user: "root", passwordSecret: undefined });
    await clean();
    await assert.rejects(
      (async () => {
        const c = await mysql.createConnection({ host: "127.0.0.1", port: server.port, user: "root", database: "app" });
        try {
          await c.query("START TRANSACTION READ ONLY");
          await c.query("INSERT INTO sin_pk VALUES (9, 'z')");
        } finally {
          await c.end();
        }
      })(),
      /READ ONLY/,
    );
    const out = await send("/nada", { tables: [{ name: "orders", where: "id = 1; DROP TABLE orders" }] });
    assert.match(out.result.db.tables[0].error, /no se permite/);
    const [tables] = await admin.query("SHOW TABLES LIKE 'orders'");
    assert.equal(tables.length, 1);
    for (const where of ["1 INTO OUTFILE 'x'", "1 UNION SELECT 1", "sleep(10)"]) {
      const bad = await send("/nada", { tables: [{ name: "orders", where }] });
      assert.match(bad.result.db.tables[0].error, /no se permite/);
    }
  });

  it("WHERE: escapa los valores capturados y filtra", async () => {
    await workspace({});
    await clean();
    await admin.query("INSERT INTO orders (id, status) VALUES (5, 'a'), (6, 'b')");
    const captures = { evil: "5' OR '1'='1", ok: "5" };
    const scoped = await runRequest({ root, model: model("/nada", { tables: [{ name: "orders", where: "id = {{ok}}" }] }), envId: "local", store, captures });
    assert.equal(scoped.result.db.tables[0].error, undefined);
    const hostile = await runRequest({ root, model: { ...model("/create", { tables: [{ name: "orders", where: "status = {{evil}}" }] }) }, envId: "local", store, captures });
    assert.equal(hostile.result.db.tables[0].inserted.length, 0, "la comilla no abre el filtro a toda la tabla");
    assert.equal(hostile.result.db.tables[0].error, undefined);
  });

  it("sin clave primaria, tablas inferidas y tope de filas", async () => {
    await workspace({ maxRows: 3 });
    await clean();
    await admin.query("DELETE FROM sin_pk");
    const inferred = await send("/nopk", {});
    const names = inferred.result.db.tables.map((t) => t.name);
    assert.ok(names.includes("orders") && names.includes("sin_pk"));
    assert.equal(inferred.result.db.tables.find((t) => t.name === "sin_pk").inserted.length, 1);
    await admin.query("INSERT INTO enorme VALUES (1), (2), (3), (4)");
    const big = await send("/nada", { tables: ["enorme"] });
    assert.match(big.result.db.tables[0].error, /más de 3 filas/);
    const missing = await send("/nada", { tables: ["no_existe"] });
    assert.match(missing.result.db.tables[0].error, /no existe/i);
  });

  it("una base caída no impide la request, y el error se explica", async () => {
    await workspace({ port: 1 });
    const out = await send("/nada", { tables: ["orders"] }, ["status == 200", "db.orders.inserted == 0"]);
    assert.equal(out.result.status, 200);
    assert.match(out.result.db.error.message, /rechazó la conexión/);
    assert.deepEqual(statuses(out.result.tests), ["pass", "pending"]);
    await workspace({ user: "nadie" });
    assert.match((await send("/nada", { tables: ["orders"] })).result.db.error.message, /rechazó al usuario/);
    await workspace({ passwordSecret: "noDefinido" });
    assert.match((await send("/nada", { tables: ["orders"] })).result.db.error.message, /noDefinido/);
  });

  it("refresh compara otra vez contra la primera foto, para escrituras tardías", async () => {
    await workspace({});
    await clean();
    const out = await send("/nada", { tables: ["orders"] }, ["db.orders.inserted == 1"]);
    assert.deepEqual(statuses(out.result.tests), ["fail"]);
    await admin.query("INSERT INTO orders (id, status) VALUES (7, 'tarde')");
    const again = await out.refreshDb(out.result.tests);
    assert.equal(again.db.tables[0].inserted[0].status, "tarde");
    assert.deepEqual(statuses(again.tests), ["pass"]);
  });

  it("binlog: ve cada escritura, en orden y sin tope de filas", async () => {
    await workspace({ user: "root", passwordSecret: undefined, mode: "binlog" });
    await clean();
    const tables = ["orders"];
    const created = await send("/create", { tables }, ["db.orders.inserted == 1", "db.orders.new[0].big == 9007199254740993"]);
    assert.equal(created.result.db.mode, "binlog");
    assert.equal(created.result.db.error, undefined);
    assert.equal(created.result.tests[0].status, "pass");
    const row = created.result.db.tables[0].inserted[0];
    assert.equal(row.status, "new");
    assert.equal(row.secret_note, "••••••");
    const paid = await send("/pay", { tables }, ["db.orders.updated == 1"]);
    assert.deepEqual(paid.result.db.tables[0].updated[0].changed, ["status"]);
    assert.deepEqual(paid.result.db.tables[0].pk, ["id"]);
    assert.equal((await send("/del", { tables }, ["db.orders.deleted == 1"])).result.tests[0].status, "pass");
    await admin.query("DELETE FROM sin_pk");
    const other = await send("/nopk", { tables });
    assert.equal(other.result.db.changes, 0, "solo mira las tablas pedidas");
  });

  it("binlog sin permisos lo explica y la request sale igual", async () => {
    await workspace({ mode: "binlog" });
    const out = await send("/nada", { tables: ["orders"] });
    assert.equal(out.result.status, 200);
    assert.match(out.result.db.error.message, /REPLICATION/);
  });

  it("una request fallida o denegada no deja conexiones abiertas", async () => {
    await workspace({ user: "root", passwordSecret: undefined, mode: "binlog" });
    await assert.rejects(runRequest({ root, model: { ...model("/x", { tables: ["orders"] }), url: "http://127.0.0.1:1/" }, envId: "local", store }));
    await new Promise((r) => setTimeout(r, 200));
    const [dumps] = await admin.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE COMMAND LIKE 'Binlog Dump%'");
    assert.equal(Number(dumps[0].n), 0);
  });

  it("probar conexión avisa si el usuario puede escribir", async () => {
    await workspace({});
    const env = await resolveEnvironment(root, "local", store);
    const lector = await testDbConnection(env, "main");
    assert.equal(lector.canWrite, false);
    assert.equal(lector.binlog, true);
    assert.equal(lector.canReplicate, false);
    await workspace({ user: "root", passwordSecret: undefined });
    assert.equal((await testDbConnection(await resolveEnvironment(root, "local", store), "main")).canWrite, true);
  });

  it("el YAML conserva observe.db y db del entorno; correr carpeta los usa", async () => {
    await workspace({});
    await clean();
    assert.equal((await readEnvironment(root, "local")).secrets.includes("dbPassword"), true);
    const file = path.join(root, "collections", "a.citrus.yaml");
    await fs.writeFile(file, `# nota\nname: A\nmethod: GET\nurl: http://127.0.0.1:${apiPort}/create\nobserve:\n  db:\n    connection: main\n    tables: [orders]\nassert:\n  - db.orders.inserted == 1\n`);
    const read = await readRequest(root, "a.citrus.yaml");
    const { raw } = await saveRequest(root, "a.citrus.yaml", read.model);
    assert.match(raw, /# nota/);
    assert.match(raw, /tables: \[ orders \]|tables: \[orders\]/);
    const run = await runFolder({ root, envId: "local", store });
    assert.equal(run.ok, true);
  });
});
