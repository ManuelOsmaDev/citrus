// Instala el .exe de verdad, lo usa contra la demo y lo desinstala.
// Lo que falla al empaquetar (asar, módulos nativos, procesos aparte) solo aparece aquí.
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
const { version } = createRequire(import.meta.url)("../package.json");
const installer = path.join(appDir, "release", `Citrus-Setup-${version}.exe`);
const shots = process.env.CITRUS_SHOTS ?? path.join(os.tmpdir(), "citrus-shots");
const SERVICE = "citrus-instalado";

const run = (file, args) =>
  new Promise((resolve, reject) => {
    // Como lo lanza Windows: NSIS se cae si hereda los handles nulos de un spawn de Node.
    const list = args.map((a) => `'${a}'`).join(",");
    const command = `$p = Start-Process -FilePath '${file}' -ArgumentList ${list} -PassThru -Wait; exit $p.ExitCode`;
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} terminó con código ${code}`))));
  });
const exists = (p) => fs.access(p).then(() => true, () => false);

await fs.mkdir(shots, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-inst-"));
const target = path.join(temp, "Citrus");
const exe = path.join(target, "Citrus.exe");
const workspace = path.join(temp, "workspace");
await fs.cp(path.join(repo, "examples", "serverless-mysql-demo"), workspace, { recursive: true });

console.log(`· instala ${path.basename(installer)} (${Math.round((await fs.stat(installer)).size / 1048576)} MB)`);
await run(installer, ["/S", `/D=${target}`]);
assert.ok(await exists(exe), "El instalador no dejó Citrus.exe");

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
const store = keychainStore({ service: SERVICE });
await store.set(secretAccount(workspace, "dev", "token"), "token-de-prueba");

/** Abre el .exe como lo hace Windows y le pregunta al sistema si la ventana está visible. */
function windowOpensForRealUser() {
  const script = `
Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'
$env:CITRUS_USER_DATA = '${path.join(temp, "user-data-real")}'
$p = Start-Process '${exe}' -PassThru
$visible = $false
for ($i = 0; $i -lt 30 -and -not $visible; $i++) {
  Start-Sleep -Milliseconds 500
  foreach ($m in Get-Process Citrus -ErrorAction SilentlyContinue) {
    if ($m.MainWindowHandle -ne 0 -and [U.W]::IsWindowVisible($m.MainWindowHandle)) { $visible = $true }
  }
}
Get-Process Citrus -ErrorAction SilentlyContinue | Stop-Process -Force
if ($visible) { exit 0 } else { exit 1 }
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { stdio: "ignore" }).once("exit", (code) => resolve(code === 0));
  });
}

console.log("· arranque real: la ventana aparece");
// Se comprueba dentro del try: un fallo aquí no debe saltarse la desinstalación.
const realWindow = await windowOpensForRealUser();
await new Promise((r) => setTimeout(r, 800));

let failed = false;
const problems = [];
const app = await electron.launch({
  executablePath: exe,
  args: [],
  env: { ...process.env, CITRUS_WORKSPACE: workspace, CITRUS_USER_DATA: path.join(temp, "user-data"), CITRUS_KEYRING_SERVICE: SERVICE },
});
try {
  assert.ok(realWindow, "La ventana no aparece en un arranque real");
  const page = await app.firstWindow();
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 40/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  // Lanzado por Playwright, el .exe arranca con la ventana oculta y sin frames. Un arranque real la
  // muestra, y eso se comprueba aparte en windowOpensForRealUser.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  const res = page.locator('[data-pane="response"]');
  const step = (name) => console.log(`· ${name}`);

  step("abre, lee la colección, carga Monaco y las fuentes");
  await page.waitForSelector(".tree-row");
  assert.equal(await page.locator(".tangerine-fallo").count(), 0);
  await page.waitForFunction(() => !!window.monaco, null, { timeout: 30000 });
  assert.ok(await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('13px "Geist"');
  }), "La fuente Geist no cargó");

  step("HTTP, secreto del llavero nativo, logs y diff de MySQL");
  await page.locator('[data-request="orders/create-order.citrus.yaml"]').click();
  await page.locator(".send").click();
  await res.locator('[data-status="201"]').waitFor();
  await res.locator(".stat", { hasText: "en Lambda" }).waitFor({ timeout: 20000 });
  await res.locator('[data-restab="logs"]').click();
  await res.locator(".log-row", { hasText: "Procesando createOrder" }).waitFor();
  await res.locator('[data-restab="db"]').click();
  await res.locator(".db-row.ins").first().waitFor();

  step("binlog: el driver de replicación funciona empaquetado");
  await page.locator('[data-subtab="observe"]').click();
  await page.locator('[data-pane="request"] select.input').nth(1).selectOption("binlog");
  await page.locator(".send").click();
  await res.locator('[data-db-mode="binlog"]').waitFor();
  await res.locator(".db-row.ins").first().waitFor();

  step("Lambda local: lanza el proceso aparte desde el asar");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await page.locator('[data-request="workers/process-payment.sqs.citrus.yaml"]').click();
  await page.locator('[data-pane="request"] .monaco-editor').waitFor();
  await page.locator(".send").click();
  await res.locator('[data-lambda="ok"]').waitFor();
  await res.locator('[data-restab="logs"]').click();
  await res.locator(".log-row", { hasText: "Cobrando pedido" }).waitFor();

  step("Lambda AWS: carga el SDK empaquetado");
  await page.locator(".mode-switch button", { hasText: "AWS" }).click();
  await page.locator(".send").click();
  await res.locator('[data-lambda="ok"]').waitFor();
  await res.locator(".log-row", { hasText: "Procesando processPayment" }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: path.join(shots, "instalado.png") });

  assert.deepEqual(problems, [], "Errores en la consola");
  console.log("\nINSTALADO OK");
} catch (err) {
  failed = true;
  console.error("\nFALLÓ:", err, problems);
  await app.windows()[0]?.screenshot({ path: path.join(shots, "instalado-fallo.png") }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  await fetch(`${apiUrl}/__stop`, { method: "POST" }).catch(() => {});
  apiProcess.kill();
  await store.delete(secretAccount(workspace, "dev", "token"));
  console.log("· desinstala");
  await run(path.join(target, "Uninstall Citrus.exe"), ["/S"]).catch((e) => console.error(e.message));
  // El desinstalador se copia a sí mismo y sigue en segundo plano.
  for (let i = 0; i < 40 && (await exists(exe)); i++) await new Promise((r) => setTimeout(r, 500));
  if (await exists(exe)) {
    failed = true;
    console.error("El desinstalador no borró Citrus.exe");
  }
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
