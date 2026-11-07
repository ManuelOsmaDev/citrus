// Construye la UI con `tangerine build` y le agrega un CSP estricto.
// tangerine build deja el intérprete y los plugins como <script> en línea: se autorizan por hash,
// así no hace falta 'unsafe-inline' y ningún otro script en línea puede correr.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..", "ui");
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("tangerine-lang/package.json")), "bin", "tangerine.js");

const result = spawnSync(process.execPath, [cli, "build"], { cwd: uiDir, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

const file = path.join(uiDir, "dist", "index.html");
const html = fs.readFileSync(file, "utf8");

const hashes = [];
for (const match of html.matchAll(/<script(?![^>]*\b(?:type|src)=)[^>]*>([\s\S]*?)<\/script>/g)) {
  // El parser de HTML normaliza los saltos de línea antes de que el navegador calcule el hash.
  const text = match[1].replace(/\r\n?/g, "\n");
  hashes.push(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
}

const csp = [
  "default-src 'none'",
  `script-src 'self' ${hashes.join(" ")}`,
  // Monaco inserta estilos en tiempo de ejecución.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
fs.writeFileSync(file, html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${meta}`));
console.log(`CSP agregado (${hashes.length} scripts en línea autorizados por hash).`);
