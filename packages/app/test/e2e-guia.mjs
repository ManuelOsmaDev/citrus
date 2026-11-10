// Primer uso detrás de un proxy, como en una empresa: la guía, el ejemplo y un host que solo el proxy conoce.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..");
const require = createRequire(import.meta.url);
const shots = process.env.CITRUS_SHOTS ?? path.join(os.tmpdir(), "citrus-shots");
await fs.mkdir(shots, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "citrus-guia-"));
const userData = path.join(temp, "user-data");

// API "interna": solo se llega a ella a través del proxy.
const api = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, ruta: req.url }));
});
await new Promise((ok) => api.listen(0, "127.0.0.1", ok));
const apiPort = api.address().port;

// El proxy de la empresa: el único que sabe llegar a api.empresa.invalid.
const tunnels = [];
const proxy = http.createServer((req, res) => res.writeHead(405).end());
proxy.on("connect", (req, client, head) => {
  tunnels.push(req.url);
  const [host, port] = req.url.split(":");
  const internal = host.endsWith(".invalid");
  const upstream = net.connect(internal ? apiPort : Number(port), internal ? "127.0.0.1" : host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
const proxyPort = proxy.address().port;

// Requests que el ejemplo encontrará ya en su carpeta.
const folder = path.join(userData, "ejemplo", "collections", "tienda");
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(folder, "empresa.citrus.yaml"), `name: API de la empresa\nmethod: GET\nurl: http://api.empresa.invalid:80/lock\n`);
await fs.writeFile(path.join(folder, "publica.citrus.yaml"), `name: HTTPS real\nmethod: GET\nurl: https://example.com/\n`);

const launch = (args = []) =>
  electron.launch({
    // Con CITRUS_EXE se prueba el programa empaquetado en vez del código.
    executablePath: process.env.CITRUS_EXE || require("electron"),
    args: process.env.CITRUS_EXE ? args : [appDir, ...args],
    env: { ...process.env, CITRUS_USER_DATA: userData, CITRUS_WORKSPACE: "" },
  });

const step = (name) => console.log(`· ${name}`);
const problems = [];
let failed = false;
let appHandle = await launch([`--proxy-server=127.0.0.1:${proxyPort}`]);
try {
  let page = await appHandle.firstWindow();
  const watch = (p) => {
    p.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
    p.on("pageerror", (e) => problems.push(String(e)));
  };
  watch(page);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

  step("primer uso: aparece la guía");
  await page.locator(".tour-panel").waitFor({ timeout: 30000 });
  await page.locator(".tour-panel h2", { hasText: "lo que pasó adentro" }).waitFor();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(shots, "guia-1.png") });
  await page.locator(".tour-panel .btn", { hasText: "Siguiente" }).click();
  await page.locator(".tour-item", { hasText: "cold start" }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, "guia-2.png") });
  await page.locator(".tour-panel .btn", { hasText: "Siguiente" }).click();

  step("abre el ejemplo y recorre los pasos");
  await page.locator(".tour-panel .btn", { hasText: "Probar con un ejemplo" }).click();
  await page.locator(".tour-card", { hasText: "Tus requests" }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(shots, "guia-3.png") });
  await page.locator(".tour-card .btn", { hasText: "Siguiente" }).click();
  await page.locator(".tour-card", { hasText: "Envía la request" }).waitFor();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(shots, "guia-4.png") });
  await page.locator(".tour-card .btn", { hasText: "Enviar por mí" }).click();

  step("el ejemplo responde 200 y la guía avanza sola");
  await page.locator('[data-pane="response"] [data-status="200"]').waitFor({ timeout: 20000 });
  await page.locator(".tour-card", { hasText: "La respuesta" }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(shots, "guia-5.png") });
  assert.equal(tunnels.length, 0, "el ejemplo local no debe pasar por el proxy");
  for (const title of ["Lo que pasó adentro", "Pruebas en cada envío", "Entornos", "Cualquier acción con Ctrl+K", "Trae tus endpoints"]) {
    await page.locator(".tour-card .btn", { hasText: "Siguiente" }).click();
    await page.locator(".tour-card", { hasText: title }).waitFor({ timeout: 5000 });
    const box = await page.locator(".tour-card").boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800, `${title}: la tarjeta se sale`);
  }
  await page.locator(".tour-card .btn", { hasText: "Terminar" }).click();
  await page.locator(".tour-card", { hasText: "Ya sabes lo básico" }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, "guia-6.png") });
  await page.locator(".tour-card .btn", { hasText: "Seguir explorando" }).click();
  assert.equal(await page.locator(".tour-layer").count(), 0);

  const resPane = page.locator('[data-pane="response"]');
  step("proxy del sistema: llega a un host que solo el proxy conoce");
  await page.locator('[data-request="tienda/empresa.citrus.yaml"]').click();
  await page.locator(".send").click();
  await resPane.locator('[data-status="200"]').waitFor({ timeout: 20000 });
  assert.ok(tunnels.includes("api.empresa.invalid:80"), `No pasó por el proxy: ${tunnels}`);

  step("HTTPS real por el túnel con los certificados de Windows");
  await page.locator('[data-request="tienda/publica.citrus.yaml"]').click();
  await page.locator(".send").click();
  await resPane.locator('[data-status="200"]').waitFor({ timeout: 40000 });
  assert.ok(tunnels.includes("example.com:443"));

  step("proxy manual: se guarda cifrado");
  await page.keyboard.press("Control+k");
  await page.locator(".palette input, input.palette-input").first().fill("Configurar proxy");
  await page.keyboard.press("Enter");
  const input = page.locator(".modal input").first();
  await input.fill(`http://127.0.0.1:${proxyPort}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent.includes("pasan por"));
  const settings = await fs.readFile(path.join(userData, "settings.json"), "utf8");
  assert.ok(!settings.includes(String(proxyPort)), "el proxy quedó sin cifrar");
  assert.ok(JSON.parse(settings).welcomed, "no marcó la bienvenida");
  await appHandle.close();

  step("segundo arranque, sin proxy de sistema: sin guía y usa el proxy manual");
  tunnels.length = 0;
  appHandle = await launch();
  page = await appHandle.firstWindow();
  watch(page);
  await page.locator(".tree-row").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(".tour-layer").count(), 0, "la guía salió dos veces");
  await page.locator('[data-request="tienda/empresa.citrus.yaml"]').click();
  await page.locator(".send").click();
  await page.locator('[data-pane="response"] [data-status="200"]').waitFor({ timeout: 20000 });
  assert.ok(tunnels.includes("api.empresa.invalid:80"));

  const real = problems.filter((p) => !/favicon|Failed to load resource/.test(p));
  assert.deepEqual(real, []);
  console.log("GUIA OK");
} catch (err) {
  failed = true;
  console.error(err);
  console.error("Consola:", problems);
  await appHandle.windows()[0]?.screenshot({ path: path.join(shots, "guia-fallo.png") }).catch(() => {});
} finally {
  await appHandle.close().catch(() => {});
  api.close();
  proxy.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
