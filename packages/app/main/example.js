// El ejemplo de la guía de inicio: una API pequeña que corre dentro de la app.
// Solo escucha en 127.0.0.1, así funciona sin internet y detrás de cualquier proxy.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { initWorkspace } from "@citrus/core";

const products = [
  { id: 1, nombre: "Mandarina", precio: 3200, stock: 40 },
  { id: 2, nombre: "Limón", precio: 2800, stock: 75 },
  { id: 3, nombre: "Naranja", precio: 2500, stock: 12 },
];

let started = null;

function reply(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function handle(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const route = new URL(req.url, "http://localhost").pathname;
    if (route === "/productos" && req.method === "GET") return reply(res, 200, products);
    if (route === "/productos" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        return reply(res, 400, { error: "El cuerpo no es JSON válido" });
      }
      return reply(res, 201, { id: products.length + 1, ...body });
    }
    const one = /^\/productos\/(\d+)$/.exec(route);
    if (one && req.method === "GET") {
      const found = products.find((p) => p.id === Number(one[1]));
      return found ? reply(res, 200, found) : reply(res, 404, { error: "Ese producto no existe" });
    }
    reply(res, 404, { error: "Ruta no encontrada" });
  });
}

/** Arranca la API una sola vez y devuelve su puerto. */
function startExampleApi() {
  started ??= new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(server.address().port);
    });
  });
  return started;
}

const REQUESTS = {
  "listar-productos": `name: Listar productos
method: GET
url: "{{baseUrl}}/productos"
assert:
  - status == 200
`,
  "crear-producto": `name: Crear producto
method: POST
url: "{{baseUrl}}/productos"
body:
  json:
    nombre: Toronja
    precio: 3600
assert:
  - status == 201
  - body.id exists
`,
  "producto-inexistente": `name: Producto que no existe
method: GET
url: "{{baseUrl}}/productos/999"
assert:
  - status == 404
`,
};

export const EXAMPLE_FIRST_REQUEST = "tienda/listar-productos.citrus.yaml";

/** Deja listo el workspace de ejemplo. El puerto cambia en cada arranque, por eso se reescribe el entorno. */
export async function prepareExample(root) {
  const port = await startExampleApi();
  await initWorkspace(root, { name: "Ejemplo de Citrus" });
  const folder = path.join(root, "collections", "tienda");
  await fs.mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(REQUESTS)) {
    await fs.writeFile(path.join(folder, `${name}.citrus.yaml`), text, { flag: "wx" }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  const env = `name: local\nprotected: false\nvariables:\n  baseUrl: http://127.0.0.1:${port}\n`;
  await fs.writeFile(path.join(root, "environments", "local.yaml"), env);
}
