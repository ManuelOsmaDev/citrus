// API de ejemplo para probar Citrus sin internet: npm run demo:api
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4010);
const orders = [
  { id: 1001, productId: 7, quantity: 1, status: "paid", createdAt: "2026-11-01T14:03:00.000Z" },
  { id: 1002, productId: 42, quantity: 3, status: "pending", createdAt: "2026-11-02T09:41:00.000Z" },
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- MySQL temporal ----------
// Lo baja mysql-memory-server la primera vez. Sin él, la API corre igual y solo falta el diff.
const DB_PORT = Number(process.env.DEMO_DB_PORT ?? 3307);
let database = null;
let sql = null;

async function startDatabase() {
  try {
    const { createDB } = await import("mysql-memory-server");
    const mysql = await import("mysql2/promise");
    database = await createDB({ dbName: "app", username: "root", port: DB_PORT, logLevel: "ERROR" });
    sql = await mysql.createConnection({ host: "127.0.0.1", port: database.port, user: "root", database: "app", dateStrings: true });
    await sql.query("CREATE TABLE orders (id INT PRIMARY KEY, product_id INT, quantity INT, status VARCHAR(20), created_at DATETIME)");
    await sql.query("CREATE TABLE order_items (id INT PRIMARY KEY AUTO_INCREMENT, order_id INT, sku VARCHAR(30), price DECIMAL(10,2))");
    for (const o of orders) {
      await sql.query("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", [o.id, o.productId, o.quantity, o.status, o.createdAt.slice(0, 19).replace("T", " ")]);
    }
    console.log(`MySQL de demo en el puerto ${database.port}`);
  } catch (err) {
    console.log(`Sin MySQL de demo (${err.message}). La API corre igual, sin diff de base.`);
  }
}

async function stopDatabase() {
  await sql?.end().catch(() => {});
  await database?.stop().catch(() => {});
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopDatabase().finally(() => process.exit(0)));
}

// ---------- CloudWatch simulado ----------
// Como en AWS real: el id de API Gateway no es el de la Lambda y los logs tardan en llegar.
const INGEST_DELAY_MS = 1500;
const logEvents = [];
const warmFunctions = new Set();
let streamCount = 0;

function recordInvocation(fn, status, input) {
  const lambdaId = crypto.randomUUID();
  const traceRoot = `1-${Date.now().toString(16)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const cold = !warmFunctions.has(fn);
  warmFunctions.add(fn);
  const stream = `2026/11/06/[$LATEST]demo${cold ? ++streamCount : streamCount}`;
  const at = Date.now();
  const iso = new Date(at).toISOString();
  const duration = (20 + Math.random() * 90).toFixed(2);
  const add = (offset, message) => {
    const event = { timestamp: at + offset, message, logStreamName: stream, eventId: crypto.randomUUID(), ingestionTime: at + offset, fn };
    setTimeout(() => logEvents.push(event), INGEST_DELAY_MS);
  };
  if (cold) add(-1, "INIT_START Runtime Version: nodejs:20.v1");
  add(0, `START RequestId: ${lambdaId} Version: $LATEST`);
  add(2, `${iso}\t${lambdaId}\tINFO\tProcesando ${fn}`);
  add(3, JSON.stringify({ level: status >= 400 ? 40 : 30, msg: "Consulta a MySQL", table: "orders", rows: orders.length, input }));
  if (status >= 400) add(4, `${iso}\t${lambdaId}\tERROR\tLa request falló con ${status}`);
  add(5, `END RequestId: ${lambdaId}`);
  add(6, `REPORT RequestId: ${lambdaId}\tDuration: ${duration} ms\tBilled Duration: ${Math.ceil(duration)} ms\tMemory Size: 256 MB\tMax Memory Used: ${70 + orders.length} MB\t${cold ? "Init Duration: 212.40 ms\t" : ""}\nXRAY TraceId: ${traceRoot}\tSegmentId: ${crypto.randomUUID().slice(0, 16)}\tSampled: true`);
  return { traceRoot, lambdaId };
}

function filterLogEvents(input) {
  const fn = String(input.logGroupName).split("-").pop();
  const terms = [...String(input.filterPattern ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return logEvents
    .filter((e) => e.fn === fn)
    .filter((e) => !terms.length || terms.some((term) => e.message.includes(term)))
    .filter((e) => !input.logStreamNames || input.logStreamNames.includes(e.logStreamName))
    .filter((e) => (input.startTime === undefined || e.timestamp >= input.startTime) && (input.endTime === undefined || e.timestamp <= input.endTime))
    .map(({ fn: _fn, ...event }) => event);
}

function send(res, status, data, fn, input) {
  const headers = { "content-type": "application/json", "x-amzn-requestid": crypto.randomUUID() };
  if (fn) headers["x-amzn-trace-id"] = `Root=${recordInvocation(fn, status, input).traceRoot};Sampled=1`;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://demo");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  if (url.pathname === "/__stop" && req.method === "POST") {
    await stopDatabase();
    res.end("ok", () => process.exit(0));
    return;
  }

  const target = String(req.headers["x-amz-target"] ?? "");
  if (target.endsWith("FilterLogEvents")) {
    res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
    return res.end(JSON.stringify({ events: filterLogEvents(JSON.parse(Buffer.concat(chunks).toString())) }));
  }
  const invoke = /^\/2015-03-31\/functions\/([^/]+)\/invocations$/.exec(url.pathname);
  if (invoke) {
    const fn = decodeURIComponent(invoke[1]).split("-").pop();
    const { lambdaId } = recordInvocation(fn, 200, null);
    const tail = `START RequestId: ${lambdaId}\nREPORT RequestId: ${lambdaId}\tDuration: 18.20 ms\tBilled Duration: 19 ms\tMemory Size: 256 MB\tMax Memory Used: 71 MB\t\n`;
    res.writeHead(200, { "content-type": "application/json", "x-amzn-requestid": lambdaId, "x-amz-log-result": Buffer.from(tail).toString("base64") });
    return res.end(JSON.stringify({ ok: true, simulated: true }));
  }

  await wait(30 + Math.random() * 90);

  if (url.pathname === "/orders" && req.method === "GET") {
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return send(res, 200, { orders: orders.filter((o) => !status || o.status === status).slice(0, limit) }, "listOrders");
  }
  if (url.pathname === "/orders" && req.method === "POST") {
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) return send(res, 401, { error: "Falta el token" }, "createOrder");
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return send(res, 400, { error: "El body no es JSON" }, "createOrder");
    }
    const order = { id: 1000 + orders.length + 1, ...input, status: "pending", createdAt: new Date().toISOString() };
    orders.push(order);
    await sql?.query("INSERT INTO orders VALUES (?, ?, ?, ?, NOW())", [order.id, order.productId ?? null, order.quantity ?? null, order.status]);
    await sql?.query("INSERT INTO order_items (order_id, sku, price) VALUES (?, ?, ?)", [order.id, `SKU-${order.productId ?? 0}`, 60000]);
    return send(res, 201, order, "createOrder", input);
  }
  const pay = /^\/orders\/(\d+)\/pay$/.exec(url.pathname);
  if (pay && req.method === "POST") {
    const order = orders.find((o) => o.id === Number(pay[1]));
    if (!order) return send(res, 404, { error: "No existe" }, "payOrder");
    order.status = "paid";
    await sql?.query("UPDATE orders SET status = 'paid' WHERE id = ?", [order.id]);
    return send(res, 200, order, "payOrder");
  }
  const match = /^\/orders\/(\d+)$/.exec(url.pathname);
  if (match && req.method === "GET") {
    const order = orders.find((o) => o.id === Number(match[1]));
    return order ? send(res, 200, order) : send(res, 404, { error: "No existe" });
  }
  send(res, 404, { error: "Ruta no encontrada" });
});

await startDatabase();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`API de demo en http://localhost:${server.address().port}`);
});
