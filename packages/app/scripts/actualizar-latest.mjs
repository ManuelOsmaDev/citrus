// Firmar el instalador cambia sus bytes. Esto vuelve a calcular lo que electron-updater comprueba:
// el SHA-512 y el tamaño en latest.yml, y el .blockmap de las descargas parciales.
// Uso: node scripts/actualizar-latest.mjs release/Citrus-Setup-0.2.1.exe
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const installer = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(installer)) {
  console.error("Indica la ruta del instalador. Ejemplo: release/Citrus-Setup-0.2.1.exe");
  process.exit(1);
}

const name = path.basename(installer);
const version = /Citrus-Setup-(.+)\.exe$/.exec(name)?.[1];
if (!version) {
  console.error(`No reconozco la versión en ${name}.`);
  process.exit(1);
}

const sha512 = crypto.createHash("sha512").update(fs.readFileSync(installer)).digest("base64");
const size = fs.statSync(installer).size;

const { appBuilderPath } = require("app-builder-bin");
execFileSync(appBuilderPath, ["blockmap", "--input", installer, "--output", `${installer}.blockmap`], { stdio: "ignore" });

const yml = `version: ${version}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${size}
path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
fs.writeFileSync(path.join(path.dirname(installer), "latest.yml"), yml);
console.log(`latest.yml: ${name}, ${size} bytes`);
