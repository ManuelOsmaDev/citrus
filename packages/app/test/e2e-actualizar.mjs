// Actualización real: instala una versión vieja, encuentra la nueva en un servidor local y se reinstala sola.
// Uso: node test/e2e-actualizar.mjs <instalador-viejo.exe> <carpeta-con-latest.yml> <version-nueva>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const [installer, feed, newVersion] = process.argv.slice(2);
const temp = fs.mkdtempSync(path.join(process.env.CITRUS_TEST_DIR ?? os.tmpdir(), "citrus-upd-"));
const target = path.join(temp, "Citrus");
const exe = path.join(target, "Citrus.exe");
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const list = args.map((a) => `'${a}'`).join(",");
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", `$p = Start-Process -FilePath '${file}' -ArgumentList ${list} -PassThru -Wait; exit $p.ExitCode`], { stdio: "ignore" });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${file}: ${code}`))));
  });
const version = () => execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item '${exe}').VersionInfo.ProductVersion`]).toString().trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const file = path.join(feed, decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1));
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));

let failed = false;
try {
  await run(installer, ["/S", `/D=${target}`]);
  const before = version();
  console.log("· instalada", before);
  assert.notEqual(before, newVersion);
  const app = await electron.launch({
    executablePath: exe,
    env: { ...process.env, CITRUS_USER_DATA: path.join(temp, "user-data"), CITRUS_UPDATE_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  const page = await app.firstWindow();
  await page.locator("[data-update-lock]").waitFor({ timeout: 60000 });
  console.log("· la app queda bloqueada mientras descarga");
  const install = page.locator(".update-card .btn", { hasText: "Actualizar ahora" });
  await install.waitFor({ timeout: 180000 });
  assert.match(await page.locator(".update-card").innerText(), new RegExp(newVersion.replaceAll(".", "[.]")));
  const covered = await page.evaluate(() => {
    const top = document.elementFromPoint(innerWidth / 2, 12);
    return { insideLock: !!top?.closest("[data-update-lock]"), appInert: document.querySelector("#app").inert };
  });
  assert.deepEqual(covered, { insideLock: true, appInert: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(process.env.CITRUS_SHOTS ?? path.join(os.tmpdir(), "citrus-shots"), "bloqueo.png") });
  console.log("· pulsa Actualizar ahora");
  await install.click();
  for (let i = 0; i < 120 && !version().startsWith(newVersion); i++) await wait(1000);
  assert.ok(version().startsWith(newVersion), version());
  console.log("ACTUALIZADA a", version());
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process Citrus -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdio: "ignore" });
  } catch {
    // Ya no había ningún Citrus abierto.
  }
  await wait(1500);
  await run(path.join(target, "Uninstall Citrus.exe"), ["/S"]).catch((e) => console.error(e.message));
  server.close();
}
process.exit(failed ? 1 : 0);
