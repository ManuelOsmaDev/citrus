// Explorador de logs, variables de AWS, mover requests y exportar.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import YAML from "yaml";
import {
  clearAwsVariableCache,
  createFolder,
  createRequest,
  describeEnvironment,
  exportCurl,
  exportPostman,
  initWorkspace,
  listLambdaFunctions,
  moveRequest,
  parseAwsReference,
  readRequest,
  renameFolder,
  resolveEnvironment,
  searchLambdaLogs,
} from "../src/index.js";

const store = { get: async () => null };
const T = 1_790_000_000_000;
const A = "aaaaaaaa-1111-2222-3333-000000000001";
const B = "bbbbbbbb-1111-2222-3333-000000000002";
const C = "cccccccc-1111-2222-3333-000000000003";
const report = (id, extra = "") => `REPORT RequestId: ${id}\tDuration: 40.00 ms\tBilled Duration: 40 ms\tMemory Size: 256 MB\tMax Memory Used: 80 MB\t${extra}`;
const LOGS = [
  { timestamp: T - 3000, message: `START RequestId: ${A} Version: $LATEST` },
  { timestamp: T - 2990, message: `2026-11-14T10:00:00.010Z\t${A}\tINFO\tCreando pedido 42` },
  { timestamp: T - 2980, message: report(A, "Init Duration: 300.00 ms") },
  { timestamp: T - 2000, message: `START RequestId: ${B} Version: $LATEST` },
  { timestamp: T - 1990, message: `2026-11-14T10:00:01.010Z\t${B}\tERROR\tError: no hay stock` },
  { timestamp: T - 1980, message: report(B) },
  { timestamp: T - 1000, message: `START RequestId: ${C} Version: $LATEST` },
  { timestamp: T - 10, message: `2026-11-14T10:00:03.000Z ${C} Task timed out after 3.00 seconds` },
  { timestamp: T - 5, message: report(C) },
];

/** Un AWS de mentira en 127.0.0.1: CloudWatch Logs, Lambda, Parameter Store y Secrets Manager. */
async function fakeAws({ denyLambda = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const target = String(req.headers["x-amz-target"] ?? "");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
      calls.push(target || `${req.method} ${req.url}`);
      const json = (status, data, type = "application/x-amz-json-1.1") => {
        res.writeHead(status, { "content-type": type });
        res.end(JSON.stringify(data));
      };
      if (target.endsWith("FilterLogEvents")) {
        const pattern = String(body.filterPattern ?? "");
        const terms = [...pattern.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        const errorWords = pattern.includes("?ERROR") ? ["ERROR", "Error", "error", "Exception", "Task timed out"] : [];
        const words = [...terms, ...errorWords];
        const events = LOGS.filter((e) => (!words.length || words.some((w) => e.message.includes(w))) && e.timestamp >= body.startTime && e.timestamp <= body.endTime);
        return json(200, { events });
      }
      if (target === "AmazonSSM.GetParameter") {
        if (body.Name === "/app/db") return json(200, { Parameter: { Name: body.Name, Value: "clave-de-ssm-123" } });
        return json(400, { __type: "ParameterNotFound", message: "no existe" });
      }
      if (target === "secretsmanager.GetSecretValue") {
        return json(200, { SecretString: JSON.stringify({ apiKey: "llave-de-secrets-456" }) });
      }
      if (req.url.startsWith("/2015-03-31/functions")) {
        if (denyLambda) {
          res.writeHead(403, { "content-type": "application/json", "x-amzn-errortype": "AccessDeniedException" });
          return res.end(JSON.stringify({ message: "denied" }));
        }
        return json(200, { Functions: [{ FunctionName: "pedidos-crear" }, { FunctionName: "auth-login" }] }, "application/json");
      }
      json(400, { __type: "UnknownOperation" });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    calls,
    aws: { endpoint: `http://127.0.0.1:${server.address().port}`, region: "us-east-1" },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("explorador de logs", () => {
  let aws;
  before(async () => {
    aws = await fakeAws();
  });
  after(() => aws.close());

  it("muestra las últimas invocaciones de la más nueva a la más vieja, con sus métricas", async () => {
    const out = await searchLambdaLogs({ aws: aws.aws, functionName: "pedidos-crear", sinceMinutes: 60, now: T });
    assert.equal(out.logGroup, "/aws/lambda/pedidos-crear");
    assert.deepEqual(out.invocations.map((i) => i.requestId), [C, B, A]);
    const first = out.invocations.find((i) => i.requestId === A);
    assert.equal(first.coldStart, true);
    assert.equal(first.duration, 40);
    assert.equal(first.memory, 80);
    assert.ok(first.logs.some((l) => l.text === "Creando pedido 42"));
  });

  it("filtra solo las que fallaron, incluido un timeout", async () => {
    const out = await searchLambdaLogs({ aws: aws.aws, functionName: "pedidos-crear", onlyErrors: true, now: T });
    assert.deepEqual(out.invocations.map((i) => i.requestId), [C, B]);
    assert.equal(out.invocations[0].timedOut, true);
  });

  it("busca por texto", async () => {
    const out = await searchLambdaLogs({ aws: aws.aws, functionName: "pedidos-crear", text: "pedido 42", now: T });
    assert.deepEqual(out.invocations.map((i) => i.requestId), [A]);
  });

  it("pide la función antes de buscar", async () => {
    await assert.rejects(searchLambdaLogs({ aws: aws.aws }), (e) => e.code === "NO_FUNCTION");
  });

  it("lista las Lambdas y, sin permiso, explica por qué no", async () => {
    assert.deepEqual((await listLambdaFunctions({ aws: aws.aws })).functions, ["auth-login", "pedidos-crear"]);
    const denied = await fakeAws({ denyLambda: true });
    try {
      const out = await listLambdaFunctions({ aws: denied.aws });
      assert.deepEqual(out.functions, []);
      assert.match(out.error, /lambda:ListFunctions/);
    } finally {
      denied.close();
    }
  });
});

describe("variables desde AWS, mover y exportar", () => {
  let root;
  let aws;
  before(async () => {
    aws = await fakeAws();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-novedades-"));
    await initWorkspace(root, { name: "prueba" });
    await fs.writeFile(
      path.join(root, "environments", "dev.yaml"),
      YAML.stringify({
        name: "dev",
        variables: { baseUrl: "https://api.ejemplo.com" },
        secrets: ["token"],
        aws: aws.aws,
        awsVariables: { dbPass: "ssm:/app/db", apiKey: "secret:prod/api#apiKey" },
      }),
    );
  });
  after(async () => {
    aws.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("entiende las referencias y rechaza las que no son válidas", () => {
    assert.deepEqual(parseAwsReference("ssm:/app/db"), { kind: "ssm", name: "/app/db" });
    assert.deepEqual(parseAwsReference("secret:prod/api#apiKey"), { kind: "secret", id: "prod/api", key: "apiKey" });
    assert.throws(() => parseAwsReference("/app/db"), (e) => e.code === "AWS_REFERENCE");
  });

  it("lee los valores al enviar, los trata como secretos y los guarda unos minutos", async () => {
    clearAwsVariableCache();
    const env = await resolveEnvironment(root, "dev", store);
    assert.equal(env.scope.get("dbPass"), "clave-de-ssm-123");
    assert.equal(env.scope.get("apiKey"), "llave-de-secrets-456");
    assert.ok(env.secretValues.includes("clave-de-ssm-123"));
    const before = aws.calls.length;
    await resolveEnvironment(root, "dev", store);
    assert.equal(aws.calls.length, before, "volvió a consultar AWS");
  });

  it("al describir el entorno no consulta AWS y no muestra valores", async () => {
    clearAwsVariableCache();
    const before = aws.calls.length;
    const info = await describeEnvironment(root, "dev", store);
    assert.equal(aws.calls.length, before);
    const fromAws = info.secrets.filter((s) => s.fromAws);
    assert.deepEqual(fromAws.map((s) => s.name), ["dbPass", "apiKey"]);
    assert.ok(!JSON.stringify(info).includes("clave-de-ssm-123"));
  });

  it("explica una referencia que no existe en AWS", async () => {
    clearAwsVariableCache();
    await fs.writeFile(path.join(root, "environments", "malo.yaml"), YAML.stringify({ name: "malo", aws: aws.aws, awsVariables: { x: "ssm:/no/existe" } }));
    await assert.rejects(resolveEnvironment(root, "malo", store), (e) => e.code === "AWS_VARIABLE_NOT_FOUND" && /\/no\/existe/.test(e.message));
  });

  it("mueve una request de carpeta y renombra carpetas", async () => {
    await createFolder(root, { name: "origen" });
    await createFolder(root, { name: "destino" });
    const { id } = await createRequest(root, { folder: "origen", name: "Mover" });
    const moved = await moveRequest(root, id, "destino");
    assert.equal(moved.id, "destino/mover.citrus.yaml");
    assert.equal((await readRequest(root, moved.id)).model.name, "Mover");
    await assert.rejects(readRequest(root, id));
    const renamed = await renameFolder(root, "destino", "Final");
    assert.deepEqual(renamed, { from: "destino", to: "final" });
    assert.equal((await readRequest(root, "final/mover.citrus.yaml")).model.name, "Mover");
    await assert.rejects(renameFolder(root, "origen", "final"), (e) => e.code === "FOLDER_EXISTS");
    await assert.rejects(moveRequest(root, "final/mover.citrus.yaml", "no-existe"), (e) => e.code === "FOLDER_NOT_FOUND");
  });

  it("exporta a Postman con las variables y sin secretos", async () => {
    await createFolder(root, { name: "compartir" });
    const { id } = await createRequest(root, { folder: "compartir", name: "Crear" });
    const file = path.join(root, "collections", id);
    const doc = YAML.parse(await fs.readFile(file, "utf8"));
    Object.assign(doc, { method: "POST", url: "{{baseUrl}}/pedidos", auth: { type: "bearer", token: "{{token}}" }, body: { json: { id: 1 } } });
    await fs.writeFile(file, YAML.stringify(doc));
    await fs.writeFile(path.join(root, "collections", "compartir", "fn.citrus.yaml"), YAML.stringify({ name: "Una Lambda", type: "lambda", function: "f", mode: "remote" }));

    const out = await exportPostman({ root, folder: "compartir", envId: "dev", store });
    const collection = JSON.parse(out.text);
    assert.equal(out.count, 1);
    assert.match(collection.info.schema, /v2\.1\.0/);
    const item = collection.item.find((i) => i.name === "Crear");
    assert.equal(item.request.method, "POST");
    assert.equal(item.request.url, "{{baseUrl}}/pedidos");
    assert.equal(item.request.auth.bearer[0].value, "{{token}}");
    assert.equal(item.request.body.options.raw.language, "json");
    assert.deepEqual(collection.variable.find((v) => v.key === "baseUrl").value, "https://api.ejemplo.com");
    assert.equal(collection.variable.find((v) => v.key === "token").value, "");
    assert.ok(out.warnings.some((w) => /Lambda/.test(w)));
    assert.ok(!out.text.includes("clave-de-ssm-123"));
  });

  it("exporta a cURL con las variables puestas y los secretos como {{nombre}}", async () => {
    const out = await exportCurl({ root, folder: "compartir", envId: "dev", store });
    assert.equal(out.count, 1);
    assert.match(out.text, /# Crear\ncurl/);
    assert.match(out.text, /https:\/\/api\.ejemplo\.com\/pedidos/);
    assert.match(out.text, /\{\{token\}\}/);
  });
});
