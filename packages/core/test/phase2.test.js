import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyImport,
  buildEvent,
  buildSnippet,
  completePending,
  fetchInvocationLogs,
  fetchObservedLogs,
  functionNameOf,
  logGroupOf,
  requestIdsFromHeaders,
  traceUrl,
  emptyModel,
  evaluateAssertions,
  importServerless,
  initWorkspace,
  invokeLocal,
  invokeRemote,
  logEntry,
  memoryStore,
  moveFindingsToSecrets,
  parseReport,
  publicFindings,
  readEnvironment,
  readRequest,
  runCaptures,
  runFolder,
  runRequest,
  saveEnvironment,
  saveRequest,
  scanModel,
  setSecret,
} from "../src/index.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "citrus-p2-"));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const statuses = (tests) => tests.map((t) => t.status);

describe("assertions", () => {
  const ctx = { status: 201, time: 120, headers: { "content-type": "application/json" }, body: { id: 7, tags: ["a"], name: "ana", items: [{ sku: "x" }] } };
  it("evalúa operadores y rutas", () => {
    const lines = ["status == 201", "status != 500", "time < 500", "body.id exists", "body.nada not exists", "body.tags contains a", "body.name contains an", "body.items[0].sku == x", "body.items.length == 1", 'headers.Content-Type contains "json"'];
    assert.deepEqual(statuses(evaluateAssertions(lines, ctx)), lines.map(() => "pass"));
  });
  it("informa el valor real cuando falla", () => {
    const [t] = evaluateAssertions(["status == 200"], ctx);
    assert.equal(t.status, "fail");
    assert.equal(t.actual, "201");
  });
  it("db y logs quedan pendientes, no fallan", () => {
    assert.deepEqual(statuses(evaluateAssertions(["db.orders.inserted == 1", "logs.errors == 0", "lambda.duration < 5"], ctx)), ["pending", "pending", "pending"]);
    const done = completePending(evaluateAssertions(["status == 201", "logs.errors == 0", "lambda.duration < 5", "db.x == 1"], ctx), { logs: { errors: 0 }, lambda: { duration: 9 } });
    assert.deepEqual(statuses(done), ["pass", "pass", "fail", "pending"]);
  });
  it("una línea rara se marca inválida y nunca ejecuta código", () => {
    globalThis.__hack = false;
    assert.deepEqual(statuses(evaluateAssertions(["process.exit(1)", "status =="], ctx)), ["invalid", "invalid"]);
    assert.equal(evaluateAssertions(["__proto__.polluted exists"], ctx)[0].status, "fail");
  });
  it("captura valores y avisa de los que faltan", () => {
    const { captured, missing } = runCaptures([{ key: "id", value: "body.id" }, { key: "x", value: "body.x" }, { key: "off", value: "body.id", enabled: false }], ctx);
    assert.deepEqual(captured, { id: "7" });
    assert.deepEqual(missing, ["x"]);
  });
});

describe("modelo", () => {
  it("edita tests y lambda sin perder lo demás", async () => {
    const root = await tmp();
    await initWorkspace(root);
    await fs.writeFile(path.join(root, "collections/a.citrus.yaml"), "# c\nname: A\nmethod: GET\nurl: http://x\nassert:\n  - status == 200\ncapture:\n  id: body.id\nobserve:\n  logs: true\n");
    const { model } = await readRequest(root, "a.citrus.yaml");
    assert.deepEqual(model.assert, ["status == 200"]);
    assert.equal(model.capture[0].value, "body.id");
    model.assert.push("time < 100");
    const { raw } = await saveRequest(root, "a.citrus.yaml", model);
    assert.match(raw, /time < 100/);
    assert.match(raw, /# c/);
    assert.match(raw, /observe:/);

    await fs.writeFile(path.join(root, "collections/l.citrus.yaml"), "name: L\ntype: lambda\nfunction: f-{{stage}}\nmode: remote\nevent:\n  template: sqs\n  records: []\nassert:\n  - result.ok == true\n");
    const lam = (await readRequest(root, "l.citrus.yaml")).model;
    lam.mode = "local";
    lam.handler = "src/x.y";
    const saved = await saveRequest(root, "l.citrus.yaml", lam);
    assert.match(saved.raw, /handler: src\/x\.y/);
    assert.match(saved.raw, /template: sqs/);
    lam.eventText = "{ no es json";
    await assert.rejects(saveRequest(root, "l.citrus.yaml", lam), { code: "BAD_EVENT" });
  });
});

describe("eventos", () => {
  it("arma los eventos reales de AWS", () => {
    assert.equal(buildEvent({ template: "sqs", records: [{ body: { a: 1 } }] }).Records[0].body, '{"a":1}');
    assert.equal(buildEvent({ template: "apigw-v2", method: "post", path: "/x", body: { a: 1 } }).requestContext.http.method, "POST");
    assert.equal(buildEvent({ template: "s3", records: [{ bucket: "b", key: "k" }] }).Records[0].s3.object.key, "k");
    assert.equal(buildEvent({ template: "eventbridge", source: "s" }).source, "s");
    assert.deepEqual(buildEvent({ a: 1 }), { a: 1 });
    assert.deepEqual(buildEvent({ template: "constructor" }), { template: "constructor" });
  });
});

describe("Lambda local", () => {
  async function project() {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "h.mjs"), `
      export const ok = async (event, context) => {
        console.log("hola", event.n);
        console.log(JSON.stringify({ level: "warn", msg: "ojo" }));
        console.error("fallo menor");
        return { n: event.n * 2, env: process.env.MI_VAR ?? null, leak: process.env.CITRUS_NO_HEREDAR ?? null, id: context.awsRequestId };
      };
      export const boom = async () => { throw new RangeError("explotó"); };
      export const cb = (event, context, done) => { setTimeout(() => done(null, "por callback"), 5); };
      export const lento = () => new Promise(() => setTimeout(() => {}, 60000));
    `);
    await fs.writeFile(path.join(dir, "c.cjs"), "exports.h = async () => 'cjs'; exports.mal = 1;");
    await fs.writeFile(path.join(dir, "t.ts"), "");
    return dir;
  }

  it("devuelve payload, logs con nivel, métricas y aísla el entorno", async () => {
    const cwd = await project();
    process.env.CITRUS_NO_HEREDAR = "secreto-del-padre";
    const out = await invokeLocal({ cwd, handler: "h.ok", event: { n: 21 }, variables: { MI_VAR: "v" } });
    delete process.env.CITRUS_NO_HEREDAR;
    const payload = JSON.parse(out.payload);
    assert.equal(payload.n, 42);
    assert.equal(payload.env, "v");
    assert.equal(payload.leak, null);
    assert.ok(payload.id);
    assert.equal(out.functionError, null);
    assert.ok(out.durationMs >= 0 && out.initMs > 0 && out.memoryMb > 0);
    assert.deepEqual(out.logs.map((l) => l.level).sort(), ["error", "info", "warn"]);
    assert.ok(out.logs.find((l) => l.level === "warn").json);
  });
  it("informa errores, callbacks, CommonJS y timeouts", async () => {
    const cwd = await project();
    const boom = await invokeLocal({ cwd, handler: "h.boom", event: {} });
    assert.equal(boom.functionError, "Unhandled");
    assert.equal(JSON.parse(boom.payload).errorType, "RangeError");
    assert.equal((await invokeLocal({ cwd, handler: "h.cb", event: {} })).payload, '"por callback"');
    assert.equal((await invokeLocal({ cwd, handler: "c.h", event: {} })).payload, '"cjs"');
    assert.equal((await invokeLocal({ cwd, handler: "c.mal", event: {} })).functionError, "Init");
    assert.equal((await invokeLocal({ cwd, handler: "h.lento", event: {}, timeoutMs: 300 })).functionError, "Timeout");
  });
  it("explica un handler que no existe, TypeScript y formato malo", async () => {
    const cwd = await project();
    assert.throws(() => invokeLocal({ cwd, handler: "no.x", event: {} }), { code: "NO_HANDLER" });
    assert.throws(() => invokeLocal({ cwd, handler: "t.x", event: {} }), { code: "TS_HANDLER" });
    assert.throws(() => invokeLocal({ cwd, handler: "sinpunto", event: {} }), { code: "BAD_HANDLER" });
    assert.throws(() => invokeLocal({ cwd, handler: "../fuera.run", event: {} }), { code: "HANDLER_OUTSIDE" });
  });
  it("runRequest exige confianza y confirmación; enmascara secretos en los logs", async () => {
    const root = await tmp();
    await initWorkspace(root);
    await fs.writeFile(path.join(root, "h.mjs"), "export const f = async (e) => { console.log('token ' + process.env.token); return { orderId: e.Records[0].body }; };");
    const store = memoryStore();
    await setSecret(root, "local", "token", "valor-super-secreto", store);
    const model = {
      type: "lambda", name: "L", function: "f", mode: "local", handler: "h.f",
      eventText: JSON.stringify({ template: "sqs", records: [{ body: "{{baseUrl}}" }] }),
      assert: ["result.orderId exists", "lambda.duration < 60000", "logs.errors == 0", "db.x == 1"],
      capture: [{ key: "pedido", value: "result.orderId", enabled: true }],
    };
    await assert.rejects(runRequest({ root, model, envId: "local", store }), { code: "DENIED_TRUST" });
    const captures = {};
    const { result } = await runRequest({ root, model, envId: "local", store, captures, trust: async () => true });
    assert.equal(result.kind, "lambda");
    assert.deepEqual(statuses(result.tests), ["pass", "pass", "pass", "pending"]);
    assert.doesNotMatch(JSON.stringify(result.logs), /valor-super-secreto/);
    assert.equal(captures.pedido, "http://localhost:3000");
    await saveEnvironment(root, "local", { protected: true });
    await assert.rejects(runRequest({ root, model, envId: "local", store, trust: async () => true }), { code: "DENIED_PROTECTED" });
  });
});

describe("Lambda remota", () => {
  it("firma, envía el evento y lee métricas de REPORT (contra un endpoint simulado)", async () => {
    let seen;
    const report = "START RequestId: a\nhola\nREPORT RequestId: a\tDuration: 12.50 ms\tBilled Duration: 13 ms\tMemory Size: 128 MB\tMax Memory Used: 64 MB\tInit Duration: 200.10 ms\n";
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = { url: req.url, auth: req.headers.authorization, type: req.headers["x-amz-log-type"], body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { "x-amz-log-result": Buffer.from(report).toString("base64"), "x-amz-function-error": "Unhandled", "x-amzn-requestid": "r1" });
        res.end('{"errorMessage":"mal"}');
      });
    });
    const port = await listen(server);
    process.env.AWS_ACCESS_KEY_ID = "AKIAFAKEFAKEFAKEFAKE";
    process.env.AWS_SECRET_ACCESS_KEY = "falsa";
    try {
      const out = await invokeRemote({ functionName: "mi-fn", event: { a: 1 }, aws: { region: "us-east-1", endpoint: `http://127.0.0.1:${port}` } });
      assert.match(seen.url, /\/functions\/mi-fn\/invocations/);
      assert.match(seen.auth, /^AWS4-HMAC-SHA256/);
      assert.equal(seen.type, "Tail");
      assert.equal(seen.body, '{"a":1}');
      assert.equal(out.functionError, "Unhandled");
      assert.equal(out.durationMs, 12.5);
      assert.equal(out.billedMs, 13);
      assert.equal(out.memoryMb, 64);
      assert.equal(out.initMs, 200.1);
      assert.equal(out.coldStart, true);
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      server.closeAllConnections();
      server.close();
    }
  });
  it("no deja desviar el endpoint a otro host", async () => {
    await assert.rejects(invokeRemote({ functionName: "f", event: {}, aws: { endpoint: "https://evil.example.com" } }), { code: "BAD_ENDPOINT" });
  });
  it("parseReport sin Init Duration no es cold start", () => {
    assert.equal(parseReport("REPORT Duration: 1 ms").initMs, null);
    assert.equal(logEntry("[ERROR] algo").level, "error");
    assert.equal(logEntry('{"level":30,"msg":"x"}').level, "info");
  });
});

describe("flujos", () => {
  it("las capturas pasan a la siguiente request y un fallo no detiene el resto", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/login") return res.end('{"token":"abc"}');
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    });
    const port = await listen(server);
    const root = await tmp();
    await initWorkspace(root);
    const dir = path.join(root, "collections/flujo");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "1-login.citrus.yaml"), `name: Login\nmethod: POST\nurl: http://127.0.0.1:${port}/login\ncapture:\n  tok: body.token\nassert:\n  - status == 200\n`);
    await fs.writeFile(path.join(dir, "2-me.citrus.yaml"), `name: Me\nmethod: GET\nurl: http://127.0.0.1:${port}/me\nheaders:\n  Authorization: "Bearer {{tok}}"\nassert:\n  - body.auth == Bearer abc\n`);
    await fs.writeFile(path.join(dir, "3-falla.citrus.yaml"), `name: Falla\nmethod: GET\nurl: http://127.0.0.1:${port}/x\nassert:\n  - status == 500\n`);
    await fs.writeFile(path.join(dir, "4-sin-var.citrus.yaml"), `name: SinVar\nmethod: GET\nurl: "{{nada}}"\n`);
    try {
      const out = await runFolder({ root, folder: "flujo", envId: "local", store: memoryStore() });
      assert.deepEqual(out.steps.map((s) => s.ok), [true, true, false, false]);
      assert.equal(out.ok, false);
      assert.equal(out.captures.tok, "abc");
      assert.match(out.steps[3].error, /nada/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("detector de secretos", () => {
  it("encuentra credenciales escritas a mano y no las referencias", () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(20)}.${"b".repeat(20)}`;
    const model = {
      ...emptyModel(),
      url: "https://x.com?k=AKIAIOSFODNN7EXAMPLE",
      headers: [{ key: "Authorization", value: `Bearer ${jwt}`, enabled: true }, { key: "X-Api-Key", value: "{{clave}}", enabled: true }, { key: "Accept", value: "a/b", enabled: true }],
      body: { mode: "json", text: '{"gh":"ghp_0123456789012345678901234567890123"}', rows: [] },
      auth: { type: "basic", username: "ana", password: "clave-real" },
    };
    const found = scanModel(model);
    assert.deepEqual(found.map((f) => f.kind).sort(), ["Clave de AWS", "Contraseña", "Token JWT", "Token de GitHub"].sort());
    assert.doesNotMatch(JSON.stringify(publicFindings(found)), /clave-real|AKIAIOSFODNN7EXAMPLE|ghp_0123456789/);
    assert.deepEqual(scanModel({ ...emptyModel(), url: "{{baseUrl}}/x", auth: { type: "bearer", token: "{{t}}" } }), []);
  });
  it("mueve lo encontrado al llavero y deja la referencia", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    const model = { ...emptyModel(), url: "http://x", auth: { type: "bearer", token: "tok-literal-123" }, headers: [] };
    const out = await moveFindingsToSecrets({ root, envId: "local", model, findings: scanModel(model), store });
    assert.equal(out.model.auth.token, "{{bearer_token}}");
    assert.deepEqual((await readEnvironment(root, "local")).secrets, ["bearer_token"]);
    await assert.rejects(moveFindingsToSecrets({ root, envId: null, model, findings: [], store }), { code: "NO_ENV" });
  });
});

describe("snippets", () => {
  it("nunca incluye el valor de un secreto", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    await setSecret(root, "local", "token", "valor-real", store);
    const model = { ...emptyModel(), method: "POST", url: "{{baseUrl}}/a", auth: { type: "bearer", token: "{{token}}" }, body: { mode: "json", text: `{"a":"it's"}` } };
    for (const language of ["curl", "fetch", "axios"]) {
      const code = await buildSnippet({ root, model, envId: "local", store, language });
      assert.doesNotMatch(code, /valor-real/);
      assert.match(code, /\{\{token\}\}/);
      assert.match(code, /localhost:3000\/a/);
    }
    assert.match(await buildSnippet({ root, model, envId: "local", store, language: "curl" }), /it'\\''s/);
    const basic = await buildSnippet({ root, model: { ...model, auth: { type: "basic", username: "a", password: "{{token}}" } }, envId: "local", store });
    assert.match(basic, /<base64 de a:\{\{token\}\}>/);
  });
});

describe("import serverless", () => {
  const yml = `
service: pedidos
provider:
  name: aws
  stage: staging
  region: eu-west-1
  environment:
    TABLE: !Ref Tabla
functions:
  crear:
    handler: src/crear.handler
    events:
      - httpApi: POST /orders
      - http: { path: "orders/{id}", method: get }
  pagar:
    handler: src/pagar.handler
    events:
      - sqs:
          arn: !GetAtt Cola.Arn
      - schedule: rate(5 minutes)
  suelta:
    handler: src/suelta.run
  rara:
    handler: src/rara.run
    events:
      - alexaSkill: x
`;
  it("lee Serverless Framework con etiquetas de CloudFormation", () => {
    const out = importServerless(yml, "..");
    assert.equal(out.kind, "Serverless Framework");
    const names = out.requests.map((r) => r.name);
    assert.ok(names.includes("POST /orders"));
    assert.ok(names.includes("GET /orders/{id}"));
    assert.ok(names.includes("crear · Lambda directa"));
    assert.ok(names.includes("pagar · SQS"));
    assert.ok(names.includes("pagar · Programado"));
    assert.ok(names.includes("suelta · Lambda directa"));
    const get = out.requests.find((r) => r.name === "GET /orders/{id}");
    assert.equal(get.model.url, "{{baseUrl}}/orders/{{id}}");
    assert.equal(get.extra.observe.lambda, "pedidos-{{stage}}-crear");
    const direct = out.requests.find((r) => r.name === "crear · Lambda directa");
    assert.equal(direct.model.handler, "src/crear.handler");
    assert.equal(direct.model.cwd, "..");
    assert.equal(JSON.parse(direct.model.eventText).template, "apigw-v2");
    assert.equal(out.environment.id, "staging");
    assert.equal(out.environment.aws.region, "eu-west-1");
    assert.equal(out.environment.variables.id, "1");
    assert.ok(out.warnings.some((w) => w.includes("alexaSkill")));
  });
  it("lee SAM", () => {
    const out = importServerless(`
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: nodejs20.x
Resources:
  Crear:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Environment:
        Variables:
          T: !Ref Tabla
      Events:
        Api:
          Type: Api
          Properties: { Path: /orders, Method: post }
        Cola:
          Type: SQS
          Properties: { Queue: !GetAtt Q.Arn }
  Tabla:
    Type: AWS::DynamoDB::Table
`);
    assert.equal(out.kind, "AWS SAM");
    assert.deepEqual(out.requests.map((r) => r.name), ["POST /orders", "Crear · Lambda directa", "Crear · SQS"]);
    assert.equal(out.requests[1].model.handler, "src/app.handler");
    assert.equal(JSON.parse(out.requests[1].model.eventText).template, "apigw-v1");
  });
  it("rechaza lo que no reconoce", () => {
    assert.throws(() => importServerless("a: 1"), { code: "NOT_SERVERLESS" });
    assert.throws(() => importServerless("a: [1"), { code: "BAD_YAML" });
  });
  it("escribe archivos y crea el entorno sin pisar uno existente", async () => {
    const root = await tmp();
    await initWorkspace(root);
    const parsed = importServerless(yml, "..");
    const report = await applyImport({ root, requests: parsed.requests, environments: [parsed.environment], store: memoryStore() });
    assert.equal(report.created.length, parsed.requests.length);
    const env = await readEnvironment(root, "staging");
    assert.equal(env.variables.stage, "staging");
    assert.equal(env.aws.region, "eu-west-1");
    const file = report.created.find((id) => id.includes("orders-id"));
    const { raw } = await readRequest(root, file);
    assert.match(raw, /observe:/);
    await saveEnvironment(root, "staging", { variables: { baseUrl: "https://mia" } });
    await applyImport({ root, requests: [], environments: [parsed.environment], store: memoryStore() });
    assert.equal((await readEnvironment(root, "staging")).variables.baseUrl, "https://mia");
  });
});

describe("logs de CloudWatch", () => {
  const LAMBDA_ID = "11111111-aaaa-bbbb-cccc-222222222222";
  const OTHER_ID = "33333333-aaaa-bbbb-cccc-444444444444";
  const APIGW_ID = "apigw-id-123456";
  const TRACE = "1-abc-def456";
  const stream = "2026/11/06/[$LATEST]abc";
  const T = 1_780_000_000_000;
  const report = (id, extra = "") => `REPORT RequestId: ${id}\tDuration: 41.50 ms\tBilled Duration: 42 ms\tMemory Size: 256 MB\tMax Memory Used: 88 MB\t${extra}`;
  const coldLog = [
    { timestamp: T - 300, logStreamName: stream, message: "INIT_START Runtime Version: nodejs:20" },
    { timestamp: T, logStreamName: stream, message: `START RequestId: ${LAMBDA_ID} Version: $LATEST` },
    { timestamp: T + 5, logStreamName: stream, message: `2026-11-06T20:00:00.005Z\t${LAMBDA_ID}\tINFO\tCreando pedido con ${APIGW_ID}` },
    { timestamp: T + 6, logStreamName: stream, message: '{"level":50,"msg":"pino sin requestId, token valor-super-secreto"}' },
    { timestamp: T + 7, logStreamName: stream, message: `END RequestId: ${LAMBDA_ID}` },
    { timestamp: T + 8, logStreamName: stream, message: report(LAMBDA_ID, `Init Duration: 210.00 ms\t\nXRAY TraceId: ${TRACE}\tSegmentId: 9\tSampled: true`) },
    { timestamp: T + 9, logStreamName: stream, message: `START RequestId: ${OTHER_ID} Version: $LATEST` },
    { timestamp: T + 10, logStreamName: stream, message: "línea de la siguiente invocación" },
  ];

  async function mock(events, { failWith } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({ target: req.headers["x-amz-target"], input });
        if (failWith) {
          res.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
          return res.end(JSON.stringify({ __type: failWith, message: "falló" }));
        }
        const terms = [...String(input.filterPattern ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        const found = events.filter((e) =>
          (!terms.length || terms.some((term) => e.message.includes(term))) &&
          (!input.logStreamNames || input.logStreamNames.includes(e.logStreamName)) &&
          (input.startTime === undefined || e.timestamp >= input.startTime) &&
          (input.endTime === undefined || e.timestamp <= input.endTime));
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        res.end(JSON.stringify({ events: found }));
      });
    });
    const port = await listen(server);
    return { calls, aws: { endpoint: `http://127.0.0.1:${port}`, region: "eu-west-1" }, close() { server.closeAllConnections(); server.close(); } };
  }
  const observation = (over = {}) => ({ logGroup: "/aws/lambda/f", ids: [], traceRoot: null, sampled: false, startMs: T - 100, endMs: T + 100, exact: false, pinned: null, ...over });

  it("lee ids de headers y nombres de función", () => {
    const out = requestIdsFromHeaders({ "x-amzn-requestid": APIGW_ID, "x-amzn-trace-id": `Root=${TRACE};Sampled=1`, "x-amz-apigw-id": 'mal"id' });
    assert.deepEqual(out, { ids: [APIGW_ID], traceRoot: TRACE, sampled: true });
    assert.equal(functionNameOf("arn:aws:lambda:us-east-1:1:function:mi-fn:prod"), "mi-fn");
    assert.equal(logGroupOf("mi-fn:prod"), "/aws/lambda/mi-fn");
    assert.match(traceUrl("us-east-1", TRACE), /us-east-1\.console\.aws\.amazon\.com.*xray:traces\/1-abc-def456/);
    assert.equal(traceUrl("evil.com/x", TRACE), null);
  });

  it("del id de API Gateway llega a la invocación: líneas sin id, métricas y nada de la siguiente", async () => {
    const server = await mock(coldLog);
    try {
      const out = await fetchInvocationLogs({ observation: observation({ ids: [APIGW_ID] }), aws: server.aws });
      assert.equal(out.state, "ready");
      assert.equal(out.requestId, LAMBDA_ID);
      assert.equal(out.approximate, false);
      assert.deepEqual(out.logs.map((l) => l.level), ["system", "system", "info", "error", "system", "system"]);
      assert.equal(out.logs[2].text, `Creando pedido con ${APIGW_ID}`);
      assert.ok(out.logs[3].json);
      assert.ok(!out.logs.some((l) => l.text.includes("siguiente")));
      assert.deepEqual(
        { d: out.lambda.duration, b: out.lambda.billed, m: out.lambda.memory, s: out.lambda.memorySize, i: out.lambda.init, c: out.lambda.coldStart },
        { d: 41.5, b: 42, m: 88, s: 256, i: 210, c: true },
      );
      assert.equal(out.traceId, TRACE);
      assert.equal(out.region, "eu-west-1");
      assert.match(server.calls[0].target, /FilterLogEvents/);
    } finally {
      server.close();
    }
  });

  it("también llega por la traza de X-Ray", async () => {
    const server = await mock(coldLog);
    try {
      const out = await fetchInvocationLogs({ observation: observation({ ids: ["no-esta-en-logs"], traceRoot: TRACE }), aws: server.aws });
      assert.equal(out.requestId, LAMBDA_ID);
    } finally {
      server.close();
    }
  });

  it("sin id en común: una sola invocación se marca aproximada; varias no se adivinan", async () => {
    const one = await mock(coldLog.slice(0, 6));
    const many = await mock(coldLog);
    try {
      const a = await fetchInvocationLogs({ observation: observation(), aws: one.aws });
      assert.equal(a.state, "ready");
      assert.equal(a.approximate, true);
      const b = await fetchInvocationLogs({ observation: observation(), aws: many.aws });
      assert.equal(b.state, "ambiguous");
      assert.deepEqual(b.candidates.map((c) => c.id), [LAMBDA_ID, OTHER_ID]);
      const c = await fetchInvocationLogs({ observation: observation({ pinned: LAMBDA_ID }), aws: many.aws });
      assert.equal(c.state, "ready");
    } finally {
      one.close();
      many.close();
    }
  });

  it("recién enviada, no confunde sus logs con los de una invocación anterior", async () => {
    const now = Date.now();
    const previous = coldLog.slice(0, 6).map((e) => ({ ...e, timestamp: now - 1000 + (e.timestamp - T) }));
    const server = await mock(previous);
    try {
      const recent = observation({ ids: ["de-esta-invocacion"], startMs: now - 100, endMs: now });
      assert.equal((await fetchInvocationLogs({ observation: recent, aws: server.aws })).state, "waiting");
      const noIds = observation({ startMs: now - 100, endMs: now });
      assert.equal((await fetchInvocationLogs({ observation: noIds, aws: server.aws })).state, "waiting");
    } finally {
      server.close();
    }
  });

  it("sigue esperando sin eventos o sin REPORT, y entrega lo parcial", async () => {
    const empty = await mock([]);
    const partial = await mock(coldLog.slice(1, 3));
    try {
      assert.equal((await fetchInvocationLogs({ observation: observation({ ids: [APIGW_ID] }), aws: empty.aws })).state, "waiting");
      const out = await fetchInvocationLogs({ observation: observation({ ids: [LAMBDA_ID], exact: true, pinned: LAMBDA_ID }), aws: partial.aws });
      assert.equal(out.state, "waiting");
      assert.equal(out.logs.length, 2);
    } finally {
      empty.close();
      partial.close();
    }
  });

  it("explica los errores de AWS", async () => {
    const missing = await mock([], { failWith: "ResourceNotFoundException" });
    const denied = await mock([], { failWith: "AccessDeniedException" });
    try {
      await assert.rejects(fetchInvocationLogs({ observation: observation({ ids: [APIGW_ID] }), aws: missing.aws }), { code: "LOG_GROUP_NOT_FOUND" });
      await assert.rejects(fetchInvocationLogs({ observation: observation({ ids: [APIGW_ID] }), aws: denied.aws }), { code: "ACCESS_DENIED", message: /logs:FilterLogEvents/ });
    } finally {
      missing.close();
      denied.close();
    }
    await assert.rejects(fetchInvocationLogs({ observation: observation(), aws: { endpoint: "https://evil.example.com" } }), { code: "BAD_ENDPOINT" });
  });

  it("flujo HTTP completo: observa, enmascara secretos y completa tests", async () => {
    const api = http.createServer((_, res) => {
      res.writeHead(201, { "content-type": "application/json", "x-amzn-requestid": APIGW_ID });
      res.end("{}");
    });
    const apiPort = await listen(api);
    const cloud = await mock(coldLog.map((e) => ({ ...e, timestamp: Date.now() + (e.timestamp - T) })));
    const root = await tmp();
    await initWorkspace(root);
    const store = memoryStore();
    await saveEnvironment(root, "local", { variables: { stage: "dev" }, aws: cloud.aws });
    await setSecret(root, "local", "token", "valor-super-secreto", store);
    const model = {
      ...emptyModel("x"),
      url: `http://127.0.0.1:${apiPort}/`,
      observe: { logs: true, lambda: "svc-{{stage}}-crear", db: { connection: "main" } },
      assert: ["status == 201", "lambda.duration < 100", "logs.errors == 0", "lambda.coldStart == true", "db.x == 1"],
    };
    try {
      const { result } = await runRequest({ root, model, envId: "local", store });
      assert.equal(result.observation.logGroup, "/aws/lambda/svc-dev-crear");
      assert.deepEqual(statuses(result.tests), ["pass", "pending", "pending", "pending", "pending"]);
      assert.match(result.tests[1].reason, /Esperando/);
      const out = await fetchObservedLogs({ root, observation: result.observation, tests: result.tests, envId: "local", store });
      assert.equal(out.state, "ready");
      assert.deepEqual(statuses(out.tests), ["pass", "pass", "fail", "pass", "pending"]);
      assert.equal(out.tests[2].actual, "1");
      assert.doesNotMatch(JSON.stringify(out.logs), /valor-super-secreto/);
      assert.match(out.traceUrl, /eu-west-1/);

      const dir = path.join(root, "collections");
      await fs.writeFile(path.join(dir, "o.citrus.yaml"), `name: O\nmethod: GET\nurl: http://127.0.0.1:${apiPort}/\nobserve:\n  logs: true\n  lambda: f\nassert:\n  - logs.errors == 1\n`);
      const run = await runFolder({ root, envId: "local", store, logsTimeoutMs: 2000 });
      assert.equal(run.ok, true);
      assert.equal(run.steps[0].summary.pass, 1);
    } finally {
      api.closeAllConnections();
      api.close();
      cloud.close();
    }
  });

  it("sin observe.logs no observa; con una variable faltante lo explica", async () => {
    const api = http.createServer((_, res) => res.end("{}"));
    const port = await listen(api);
    const root = await tmp();
    await initWorkspace(root);
    try {
      const base = { ...emptyModel("x"), url: `http://127.0.0.1:${port}/` };
      assert.equal((await runRequest({ root, model: base, store: memoryStore() })).result.observation, undefined);
      const missing = await runRequest({ root, model: { ...base, observe: { logs: true, lambda: "{{nada}}" } }, store: memoryStore() });
      assert.match(missing.result.observation.error, /nada/);
      const off = await runRequest({ root, model: { ...base, observe: { logs: false, lambda: "f" } }, store: memoryStore() });
      assert.equal(off.result.observation, undefined);
    } finally {
      api.closeAllConnections();
      api.close();
    }
  });
});
