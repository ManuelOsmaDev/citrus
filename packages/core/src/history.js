import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./workspace.js";

const FILE = "history.jsonl";
const KEEP = 500;

const historyFile = (root) => path.join(root, STATE_DIR, FILE);

/**
 * Agrega una entrada al historial local.
 * Guarda la URL con {{variables}} y sin bodies ni headers, para que no quede ningún secreto en disco.
 */
export async function appendHistory(root, entry) {
  const file = historyFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > KEEP * 1.2) await fs.writeFile(file, `${lines.slice(-KEEP).join("\n")}\n`);
}

/** Entradas de la más nueva a la más vieja. Una línea dañada se ignora. */
export async function readHistory(root, limit = 200) {
  const text = await fs.readFile(historyFile(root), "utf8").catch(() => "");
  const out = [];
  for (const line of text.split("\n").filter(Boolean).reverse()) {
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
    if (out.length >= limit) break;
  }
  return out;
}

export async function clearHistory(root) {
  await fs.rm(historyFile(root), { force: true });
}
