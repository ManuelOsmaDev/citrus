// Prueba de punta a punta: abre la app real, manda requests a un servidor local y revisa disco y llavero.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { keychainStore, secretAccount } from "@citrus/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..");
const repo = path.join(appDir, "..", "..");
const require = createRequire(import.meta.url);
const shots = process.env.CITRUS_SHOTS ?? path.join(os.tmpdir(), "citrus-shots");
const SERVICE = "citrus-e2e";

await fs.mkdir(shots, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-e2e-"));
const workspace = path.join(temp, "workspace");
await fs.cp(path.join(repo, "examples", "serverless-mysql-demo"), workspace, { recursive: true });

// La API de demo corre de verdad, en un puerto libre.
const apiProcess = spawn(process.execPath, [path.join(repo, "examples", "serverless-mysql-demo", "demo-api.mjs")], { env: { ...process.env, PORT: "0", DEMO_DB_PORT: "0" } });
let dbPort = null;
const apiUrl = await new Promise((resolve, reject) => {
  apiProcess.stdout.on("data", (d) => {
    const db = /MySQL de demo en el puerto (\d+)/.exec(String(d));
    if (db) dbPort = db[1];
    const m = /http:\/\/localhost:(\d+)/.exec(String(d));
    if (m) resolve(`http://localhost:${m[1]}`);
  });
  apiProcess.once("exit", () => reject(new Error("La API de demo terminó")));
});
const devEnv = path.join(workspace, "environments", "dev.yaml");
await fs.writeFile(devEnv, (await fs.readFile(devEnv, "utf8")).replaceAll("http://localhost:4010", apiUrl).replace("port: 3307", `port: ${dbPort}`));

const electronBin = require("electron");
const appHandle = await electron.launch({
  executablePath: electronBin,
  args: [appDir],
  env: { ...process.env, CITRUS_WORKSPACE: workspace, CITRUS_USER_DATA: path.join(temp, "user-data"), CITRUS_KEYRING_SERVICE: SERVICE },
});

const problems = [];
let failed = false;
try {
  const page = await appHandle.firstWindow();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});

  const step = (name) => console.log(`· ${name}`);
  const shot = async (name) => {
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
    await page.waitForTimeout(260);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  const resPane = page.locator('[data-pane="response"]');
  const openReq = (id) => page.locator(`[data-request="${id}"]`).click();
  const send = () => page.locator(".send").click();

  step("arranca sin errores y lee la colección");
  await page.waitForSelector(".tree-row");
  assert.equal(await page.locator(".tangerine-fallo").count(), 0, "Tangerine falló al arrancar");
  for (const name of ["Crear pedido", "Listar pedidos", "Ver pedido", "Procesar pago"]) {
    await page.locator(".tree-row", { hasText: name }).waitFor();
  }
  await page.waitForFunction(() => !!window.monaco, null, { timeout: 30000 });
  await shot("01-inicio");

  step("GET con variables: 200, cuerpo en Monaco y tiempos");
  await openReq("orders/list-orders.citrus.yaml");
  await page.locator(".url-mirror .var-ok").waitFor();
  assert.match(await page.locator(".resolved").innerText(), new RegExp(apiUrl.replace(/\//g, "\\/")));
  await send();
  await resPane.locator('[data-status="200"]').waitFor();
  await resPane.locator(".monaco-editor .view-line").first().waitFor();
  await shot("02-respuesta");
  await resPane.locator('[data-restab="timings"]').click();
  await resPane.locator(".waterfall").waitFor();
  await shot("03-tiempos");

  step("Params y URL se mantienen sincronizados");
  await page.locator('[data-subtab="params"]').click();
  const rows = page.locator('[data-pane="request"] .kv-row:not(.ghost)');
  assert.equal(await rows.count(), 3);
  await rows.nth(0).locator("input.input").nth(1).fill("5 y &");
  assert.equal(await page.locator(".url-input").inputValue(), "{{baseUrl}}/orders?limit=5%20y%20%26&status=paid");
  await page.locator(".url-input").fill("{{baseUrl}}/orders?limit=10&status=paid&x=1");
  assert.equal(await page.locator('[data-pane="request"] .kv-row:not(.ghost)').count(), 4);
  await page.locator(".url-input").fill("{{baseUrl}}/orders?limit=10&status=paid");

  step("secreto faltante: bloquea el envío y lo explica");
  await openReq("orders/create-order.citrus.yaml");
  await send();
  await resPane.locator(".err-card", { hasText: "token" }).waitFor();
  await shot("04-falta-secreto");

  step("define el secreto en el modal: 201");
  await page.locator('[title="Editar entornos y secretos"]').click();
  const modal = page.locator(".modal");
  await modal.locator(".secret-row", { hasText: "token" }).locator('input[type="password"]').fill("token-de-prueba-e2e");
  await shot("05-entornos");
  await modal.locator(".secret-row", { hasText: "token" }).getByRole("button", { name: "Guardar" }).click();
  await modal.locator(".tag.ok").waitFor();
  await modal.locator(".modal-foot").getByRole("button", { name: "Cerrar" }).click();
  await send();
  await resPane.locator('[data-status="201"]').waitFor();
  const scope = keychainStore({ service: SERVICE });
  assert.equal(await scope.get(secretAccount(workspace, "dev", "token")), "token-de-prueba-e2e");
  const devYaml = await fs.readFile(devEnv, "utf8");
  assert.doesNotMatch(devYaml, /token-de-prueba-e2e/);

  step("Enviado enmascara el secreto; el historial no lo guarda");
  await resPane.locator('[data-restab="sent"]').click();
  const sentText = await resPane.innerText();
  assert.doesNotMatch(sentText, /token-de-prueba-e2e/);
  assert.match(sentText, /••••••/);
  const history = await fs.readFile(path.join(workspace, ".citrus", "history.jsonl"), "utf8");
  assert.doesNotMatch(history, /token-de-prueba-e2e/);

  step("Ctrl+S guarda y conserva observe, assert y comentarios");
  await page.locator('[data-subtab="headers"]').click();
  const ghost = page.locator('[data-pane="request"] .kv-row.ghost');
  await ghost.locator("input.input").first().fill("X-Prueba");
  await page.locator('[data-pane="request"] .kv-row').nth(1).locator("input.input").nth(1).fill("si");
  await page.locator(".tab.on .unsaved").waitFor();
  await page.keyboard.press("Control+s");
  await page.locator(".tab.on .unsaved").waitFor({ state: "detached" });
  const yaml = await fs.readFile(path.join(workspace, "collections/orders/create-order.citrus.yaml"), "utf8");
  assert.match(yaml, /X-Prueba: si/);
  assert.match(yaml, /# observe, assert y capture/);
  assert.match(yaml, /db\.orders\.inserted == 1/);
  assert.match(yaml, /lastOrderId: body\.id/);

  step("Monaco edita el body y Ctrl+Enter envía");
  await page.locator('[data-subtab="body"]').click();
  await page.locator('[data-pane="request"] .monaco-editor').waitFor();
  await page.locator('[data-pane="request"] .monaco-editor .view-lines').click();
  // setValue en vez de teclear: el autocierre de comillas de Monaco alteraría el texto.
  await page.evaluate(() => {
    const editable = window.monaco.editor.getEditors().find((e) => !e.getRawOptions().readOnly);
    editable.setValue('{"productId": 99, "quantity": 1}');
    editable.focus();
  });
  await page.keyboard.press("Control+Enter");
  await resPane.locator('[data-status="201"]').waitFor();
  await page.locator(".tab.on .unsaved").waitFor();
  await shot("06-body-monaco");

  step("entorno protegido: pide confirmación; si se niega, no envía");
  await page.locator("[data-env-select]").selectOption("staging");
  await page.locator(".env-picker.protected").waitFor();
  await appHandle.evaluate(({ dialog }) => {
    globalThis.__asked = 0;
    dialog.showMessageBox = async () => {
      globalThis.__asked += 1;
      return { response: 1 };
    };
  });
  await send();
  await resPane.locator(".err-card", { hasText: "protegido" }).waitFor();
  assert.equal(await appHandle.evaluate(() => globalThis.__asked), 1);
  await shot("07-protegido");
  await page.locator("[data-env-select]").selectOption("dev");
  await page.locator(".env-picker.protected").waitFor({ state: "detached" });

  step("importa cURL: mueve el token al llavero y no lo deja en el YAML");
  await page.getByRole("button", { name: "Importar" }).first().click();
  await page.locator(".modal textarea").fill(`curl -X POST ${apiUrl}/orders -H 'Authorization: Bearer cURL-SECRETO-123' -H 'Content-Type: application/json' -d '{"productId":1}'`);
  await shot("08-importar");
  await page.locator(".modal").getByRole("button", { name: "Importar cURL" }).click();
  await page.locator(".modal h2", { hasText: "Importación lista" }).waitFor();
  await page.locator(".modal").getByRole("button", { name: "Listo" }).click();
  const imported = await fs.readdir(path.join(workspace, "collections", "importadas"));
  assert.equal(imported.length, 1);
  const importedYaml = await fs.readFile(path.join(workspace, "collections", "importadas", imported[0]), "utf8");
  assert.doesNotMatch(importedYaml, /cURL-SECRETO-123/);
  assert.match(importedYaml, /Bearer \{\{authorization\}\}/);
  assert.equal(await scope.get(secretAccount(workspace, "dev", "authorization")), "cURL-SECRETO-123");
  await page.locator(".tab.on", { hasText: "POST" }).waitFor();
  await send();
  await resPane.locator('[data-status="201"]').waitFor();

  step("importa Postman: carpetas y advertencias");
  const postmanFile = path.join(temp, "tienda.postman.json");
  await fs.writeFile(postmanFile, JSON.stringify({
    info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "POSTMAN-SECRETO" }] },
    item: [{ name: "Clientes", item: [
      { name: "Listar clientes", request: { method: "GET", url: "{{baseUrl}}/orders" } },
      { name: "Firmada", request: { method: "GET", url: "{{baseUrl}}/s", auth: { type: "awsv4", awsv4: [] } } },
    ] }],
  }));
  await appHandle.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, postmanFile);
  await page.getByRole("button", { name: "Importar" }).first().click();
  await page.locator(".modal").getByRole("button", { name: "Colección de Postman" }).click();
  await page.locator(".modal .warn-list", { hasText: "awsv4" }).waitFor();
  await page.locator(".modal").getByRole("button", { name: "Listo" }).click();
  await page.locator(".tree-row", { hasText: "Listar clientes" }).waitFor();
  const postmanYaml = await fs.readFile(path.join(workspace, "collections/importadas/tienda/clientes/listar-clientes.citrus.yaml"), "utf8");
  assert.doesNotMatch(postmanYaml, /POSTMAN-SECRETO/);
  assert.match(postmanYaml, /\{\{bearer_token\}\}/);
  await page.locator(".tab.on", { hasText: "Listar clientes" }).locator(".icon-btn").click();

  step("guardar un entorno conserva aws y los comentarios");
  await page.locator('[title="Editar entornos y secretos"]').click();
  await page.locator(".modal .chip", { hasText: "staging" }).click();
  await page.locator(".modal .switch-row").waitFor();
  await page.locator(".modal .kv-row.ghost input.input").first().waitFor();
  await page.locator(".modal .kv-row.ghost input.input").first().fill("nueva");
  await page.locator(".modal .kv-row input.input").nth(3).fill("valor-e2e");
  await shot("05b-entorno-staging");
  await page.locator(".modal").getByRole("button", { name: "Guardar entorno" }).click();
  await page.locator(".toast", { hasText: "Entorno guardado" }).waitFor();
  await page.locator(".modal .modal-foot").getByRole("button", { name: "Cerrar" }).click();
  const stagingYaml = await fs.readFile(path.join(workspace, "environments/staging.yaml"), "utf8");
  assert.match(stagingYaml, /nueva: valor-e2e/);
  assert.match(stagingYaml, /profile: mi-perfil/);
  assert.match(stagingYaml, /# Pide confirmación/);
  assert.match(stagingYaml, /extends: dev/);
  assert.match(stagingYaml, /protected: true/);

  step("Tests: resultados, valor real al fallar y generar desde la respuesta");
  await openReq("orders/create-order.citrus.yaml");
  await send();
  await resPane.locator('[data-status="201"]').waitFor();
  await resPane.locator('[data-tests="ok"]').click();
  await resPane.locator(".test-row.pass", { hasText: "body.id exists" }).waitFor();
  await resPane.locator(".capture-row", { hasText: "lastOrderId" }).waitFor();
  step("Logs de CloudWatch: espera, llegan y completan tests y métricas");
  await resPane.locator("[data-cold], .stat", { hasText: "en Lambda" }).first().waitFor();
  await resPane.locator(".test-row.pass", { hasText: "logs.errors == 0" }).waitFor();
  await resPane.locator(".test-row.pass", { hasText: "lambda.duration < 500" }).waitFor();
  await resPane.locator(".test-row.pass", { hasText: "db.orders.inserted == 1" }).waitFor();
  await shot("13-tests");
  await resPane.locator('[data-restab="logs"]').click();
  await resPane.locator(".log-row", { hasText: "Procesando createOrder" }).waitFor();
  await resPane.locator(".log-row", { hasText: "REPORT RequestId" }).waitFor();
  await resPane.locator(".log-row.clickable", { hasText: "Consulta a MySQL" }).click();
  await resPane.locator(".log-text", { hasText: '"table": "orders"' }).waitFor();
  await resPane.locator("[data-trace]").waitFor();
  await shot("21-logs-cloudwatch");
  await resPane.locator('[data-restab="timings"]').click();
  await resPane.locator("td", { hasText: "de 256 MB" }).waitFor();
  const tabsFit = await resPane.locator(".subtabs").evaluate((e) => e.scrollWidth <= e.clientWidth);
  assert.ok(tabsFit, "Las pestañas de la respuesta no caben en el panel");
  await resPane.locator(".waterfall .hint", { hasText: "fueron la Lambda" }).waitFor();
  await shot("22-tiempos-lambda");
  await resPane.locator('[data-restab="tests"]').click();

  step("Pantalla de espera: los logs tardan y se indica");
  await send();
  await resPane.locator("[data-logs-waiting]").waitFor();
  await resPane.locator('[data-restab="logs"]').click();
  await resPane.locator(".log-status", { hasText: "Esperando logs" }).waitFor();
  await shot("23-esperando-logs");
  await resPane.locator(".log-row", { hasText: "REPORT RequestId" }).waitFor({ timeout: 20000 });
  assert.equal(await resPane.locator("[data-cold]").count(), 0, "Solo la primera invocación es cold start");
  await resPane.locator('[data-restab="tests"]').click();

  step("Observar: se edita y se guarda en el YAML");
  await page.locator('[data-subtab="observe"]').click();
  await page.locator("[data-observe-lambda]").fill("otra-{{stage}}-fn");
  await page.locator(".tab.on .unsaved").waitFor();
  await page.locator("[data-observe-lambda]").fill("orders-service-{{stage}}-createOrder");
  await page.locator('[data-subtab="tests"]').click();
  await page.locator("[data-tests-input]").fill("status == 500");
  await page.locator("[data-generate-tests]").click();
  const generated = await page.locator("[data-tests-input]").inputValue();
  assert.match(generated, /status == 201/);
  assert.match(generated, /body\.id exists/);
  await page.locator("[data-tests-input]").fill("status == 500");
  await send();
  await resPane.locator('[data-tests="fail"]').click();
  await resPane.locator(".test-row.fail .test-why", { hasText: "201" }).waitFor();
  await page.locator("[data-tests-input]").fill("status == 201\nbody.id exists");
  await send();
  await resPane.locator('[data-tests="ok"]').waitFor();

  step("Base de datos: snapshot muestra filas nuevas y la conexión se prueba");
  await resPane.locator('[data-restab="db"]').click();
  await resPane.locator('[data-db-mode="snapshot"]').waitFor();
  await resPane.locator(".db-table h4", { hasText: "order_items" }).waitFor();
  assert.ok(await resPane.locator(".db-row.ins").count() >= 2);
  await shot("24-db-snapshot");
  await page.locator('[title="Editar entornos y secretos"]').click();
  await page.locator('[data-db-test="main"]').click();
  await page.locator(".db-conn .hint", { hasText: "Este usuario puede escribir" }).waitFor();
  await shot("25-db-conexion");
  await page.locator(".modal .modal-foot").getByRole("button", { name: "Cerrar" }).click();

  step("Base de datos: un UPDATE resalta el campo y usa la captura en el WHERE");
  await openReq("orders/pay-order.citrus.yaml");
  await send();
  await resPane.locator('[data-status="200"]').waitFor();
  await resPane.locator('[data-restab="db"]').click();
  await resPane.locator(".db-cell.changed .db-new", { hasText: "paid" }).waitFor();
  await shot("26-db-update");
  await resPane.locator('[data-restab="tests"]').click();
  await resPane.locator(".test-row.pass", { hasText: "db.orders.new[status=paid] exists" }).waitFor();

  step("Base de datos: modo binlog desde Observar");
  await page.locator(".tab", { hasText: "Crear pedido" }).click();
  await page.locator('[data-subtab="observe"]').click();
  await page.locator("[data-observe-db]").waitFor();
  await page.locator('[data-pane="request"] select.input').nth(1).selectOption("binlog");
  await shot("27-observar");
  await send();
  await resPane.locator('[data-status="201"]').waitFor();
  await resPane.locator('[data-restab="db"]').click();
  await resPane.locator('[data-db-mode="binlog"]').waitFor();
  await resPane.locator(".db-row.ins").first().waitFor();
  await shot("28-db-binlog");
  await page.locator('[data-pane="request"] select.input').nth(1).selectOption("");
  await page.locator('[data-subtab="body"]').click();
  await send();
  await resPane.locator('[data-db-mode="snapshot"]').waitFor();
  await resPane.locator('[data-restab="tests"]').click();

  step("Cambios: compara con el envío anterior");
  await resPane.locator('[data-restab="diff"]').click();
  await resPane.locator(".monaco-diff-editor").waitFor();
  await shot("14-cambios");

  step("Lambda en modo AWS contra el emulador: payload y logs de CloudWatch");
  await openReq("workers/process-payment.sqs.citrus.yaml");
  await page.locator(".mode-switch button", { hasText: "AWS" }).click();
  await page.locator(".url-input.plain").fill("payments-{{stage}}-processPayment");
  await send();
  await resPane.locator('[data-lambda="ok"]').waitFor();
  await resPane.locator('[data-restab="logs"]').click();
  await resPane.locator(".log-row", { hasText: "Procesando processPayment" }).waitFor({ timeout: 20000 });
  await page.locator(".mode-switch button", { hasText: "Local" }).click();

  step("Lambda local: pide confianza, usa la captura y muestra logs");
  await openReq("workers/process-payment.sqs.citrus.yaml");
  await page.locator('[data-pane="request"] .monaco-editor').waitFor();
  await send();
  await resPane.locator(".err-card", { hasText: "confianza" }).waitFor();
  await appHandle.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await send();
  await resPane.locator('[data-lambda="ok"]').waitFor();
  await resPane.locator('[data-tests="ok"]').waitFor();
  await resPane.locator('[data-restab="logs"]').click();
  await resPane.locator(".log-row", { hasText: "Cobrando pedido" }).click();
  assert.match(await resPane.locator(".log-list").innerText(), /orderId/);
  await shot("15-lambda-logs");
  await resPane.locator('[data-restab="metrics"]').click();
  await resPane.locator("td", { hasText: "Cold start" }).waitFor();
  await page.locator('[data-subtab="event"]').click();
  await page.locator('[data-template]').selectOption("s3");
  await page.locator(".tab.on .unsaved").waitFor();
  await page.keyboard.press("Control+s");
  await page.locator(".tab.on .unsaved").waitFor({ state: "detached" });
  assert.match(await fs.readFile(path.join(workspace, "collections/workers/process-payment.sqs.citrus.yaml"), "utf8"), /template: s3/);

  step("Importa serverless.yml y corre el handler importado");
  const slsDir = path.join(workspace, "proyecto");
  await fs.mkdir(path.join(slsDir, "src"), { recursive: true });
  await fs.writeFile(path.join(slsDir, "src", "h.mjs"), "export const run = async (e) => ({ ok: true, path: e.rawPath });");
  await fs.writeFile(path.join(slsDir, "serverless.yml"), "service: tienda\nprovider:\n  stage: qa\n  environment:\n    T: !Ref Tabla\nfunctions:\n  crear:\n    handler: src/h.run\n    events:\n      - httpApi: POST /pedidos\n");
  await appHandle.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, path.join(slsDir, "serverless.yml"));
  await page.getByRole("button", { name: "Importar" }).first().click();
  await page.locator(".modal").getByRole("button", { name: "serverless.yml o SAM" }).click();
  await page.locator(".modal h2", { hasText: "Importación lista" }).waitFor();
  await page.locator(".modal").getByRole("button", { name: "Listo" }).click();
  await page.locator(".tree-row", { hasText: "crear · Lambda directa" }).click();
  await page.locator(".tab.on", { hasText: "Lambda directa" }).waitFor();
  await send();
  await resPane.locator('[data-lambda="ok"]').waitFor();
  assert.match(await fs.readFile(path.join(workspace, "environments/qa.yaml"), "utf8"), /stage: qa/);

  step("Detector de secretos: bloquea el guardado y mueve al llavero");
  await openReq("orders/get-order.citrus.yaml");
  await page.locator('[data-subtab="headers"]').click();
  const fake = "eyJhbGciOiJIUzI1NiJ9.ZTJlLWZha2UtcGF5bG9hZA.ZmFrZS1maXJtYS1lMmU";
  await page.locator('[data-pane="request"] .kv-row.ghost input.input').first().fill("Authorization");
  await page.locator('[data-pane="request"] .kv-row').first().locator("input.input").nth(1).fill(`Bearer ${fake}`);
  await page.keyboard.press("Control+s");
  await page.locator(".finding", { hasText: "Token JWT" }).waitFor();
  assert.doesNotMatch(await page.locator(".modal").innerText(), /ZTJlLWZha2U/);
  await shot("16-detector");
  await page.locator(".modal").getByRole("button", { name: "Mover al llavero" }).click();
  await page.locator(".tab.on .unsaved").waitFor({ state: "detached" });
  const guarded = await fs.readFile(path.join(workspace, "collections/orders/get-order.citrus.yaml"), "utf8");
  assert.doesNotMatch(guarded, /ZTJlLWZha2U/);
  assert.match(guarded, /Bearer \{\{jwt_token\}\}/);

  step("Copiar como código sin revelar el secreto");
  await page.locator('[data-pane="request"]').getByRole("button", { name: "Código" }).click();
  await page.locator(".modal .monaco-editor .view-line").first().waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().startsWith("curl")));
  await shot("17-codigo");
  const snippet = await page.evaluate(() => window.monaco.editor.getEditors().find((e) => e.getValue().startsWith("curl")).getValue());
  assert.match(snippet, /\{\{jwt_token\}\}/);
  assert.doesNotMatch(snippet, /ZTJlLWZha2U/);
  await page.keyboard.press("Escape");
  await page.locator(".modal .modal-foot").getByRole("button", { name: "Cerrar" }).click().catch(() => {});

  step("Correr una carpeta: resultados por paso");
  await page.locator(".folder-row", { hasText: "orders" }).hover();
  await page.locator(".folder-row", { hasText: "orders" }).locator('[title="Correr esta carpeta"]').click();
  await page.locator("[data-run-summary]").waitFor();
  assert.ok(await page.locator(".run-step").count() >= 3);
  await shot("18-carpeta");
  await page.locator(".modal .modal-foot").getByRole("button", { name: "Cerrar" }).click();

  step("Paleta de comandos: Ctrl+K abre y navega");
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("listped");
  await page.locator(".palette-row.on", { hasText: "Listar pedidos" }).waitFor();
  await shot("19-paleta");
  await page.keyboard.press("Enter");
  await page.locator(".tab.on", { hasText: "Listar pedidos" }).waitFor();

  step("Distribución apilada");
  await page.locator('[title="Cambiar distribución de paneles"]').click();
  await page.locator(".split.stack").waitFor();
  await shot("20-apilado");
  await page.locator('[title="Cambiar distribución de paneles"]').click();

  step("error de conexión legible y tema claro");
  await page.locator(".tree-row", { hasText: "Ver pedido" }).click();
  await page.locator(".url-input").fill("http://127.0.0.1:1/x");
  await send();
  await resPane.locator(".err-card", { hasText: "rechazó la conexión" }).waitFor();
  await page.locator(".url-input").fill("{{baseUrl}}/orders/1001");
  await send();
  await resPane.locator('[data-status="200"]').waitFor();
  await resPane.locator('[data-restab="body"]').click();
  await page.locator('[title="Cambiar tema"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await shot("09-claro");
  await page.locator(".segmented button", { hasText: "Historial" }).click();
  await page.locator(".hist-row").first().waitFor();
  await shot("10-historial");

  step("salir avisa de cambios sin guardar y lleva a la bienvenida");
  await page.locator(".crumb").click();
  await page.getByRole("button", { name: "Seguir sin guardar" }).click();
  await page.locator(".welcome h1").waitFor();
  await page.locator(".recent").first().waitFor();
  await shot("11-bienvenida-clara");
  await page.locator('[title="Cambiar tema"]').click();
  await shot("12-bienvenida");

  const fatal = problems.filter((p) => !/404.*\/orders|status of 40/.test(p));
  assert.deepEqual(fatal, [], "Errores en la consola de la página");
  console.log(`\nE2E OK. Capturas en ${shots}`);
} catch (err) {
  failed = true;
  console.error("\nE2E FALLÓ:", err);
  console.error("Consola:", problems);
  await appHandle.windows()[0]?.screenshot({ path: path.join(shots, "fallo.png") }).catch(() => {});
} finally {
  await appHandle.close().catch(() => {});
  // Por HTTP y no con kill: en Windows un kill dejaría el mysqld de la demo huérfano.
  await fetch(`${apiUrl}/__stop`, { method: "POST" }).catch(() => {});
  apiProcess.kill();
  const scope = keychainStore({ service: SERVICE });
  for (const name of ["token", "authorization", "bearer_token", "jwt_token"]) await scope.delete(secretAccount(workspace, "dev", name));
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
