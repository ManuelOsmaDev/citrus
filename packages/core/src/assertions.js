import { isDeepStrictEqual } from "node:util";
import { interpolate } from "./variables.js";

// Evalúa las líneas de `assert:` sin eval: un repo clonado no puede ejecutar código con ellas.
const LINE = /^(\S+)\s+(==|!=|<=|>=|<|>|contains|not exists|exists)(?:\s+(.*))?$/;
/** Dependen de fases que aún no existen: se informan como pendientes, no como fallos. */
const NOT_AVAILABLE = {
  db: "Necesita observe.db en esta request, y que la base responda.",
  logs: "Necesita los logs: activa observe.logs en esta request.",
  lambda: "Necesita los logs: activa observe.logs en esta request.",
};
const WAITING = "Esperando los logs de CloudWatch.";

export function readPath(root, path) {
  const tokens = String(path).match(/[^.[\]]+/g) ?? [];
  let current = root;
  for (const token of tokens) {
    if (current == null) return undefined;
    const filter = Array.isArray(current) ? /^([\w$]+)=(.*)$/.exec(token) : null;
    if (filter) {
      // db.orders.new[status=paid]: las filas que cumplen. Vacío cuenta como que no existe.
      const matches = current.filter((row) => row && String(row[filter[1]]) === filter[2]);
      current = matches.length ? matches : undefined;
    } else if (token === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = current.length;
    } else if (typeof current === "object" && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseExpected(raw, scope) {
  const text = interpolate(String(raw ?? "").trim(), scope ?? new Map());
  try {
    return JSON.parse(text);
  } catch {
    return text.replace(/^(['"])(.*)\1$/, "$2");
  }
}

function lookup(path, ctx) {
  const [head, ...rest] = String(path).split(".");
  if (head === "headers") return ctx.headers?.[rest.join(".").toLowerCase()];
  return readPath(ctx, path);
}

const short = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "sin valor";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

function compare(op, actual, expected) {
  switch (op) {
    case "exists": return actual !== undefined && actual !== null;
    case "not exists": return actual === undefined || actual === null;
    case "==":
    case "!=": {
      const same = actual !== null && typeof actual === "object"
        ? isDeepStrictEqual(actual, expected)
        : String(actual) === String(expected);
      return op === "==" ? same : !same;
    }
    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => isDeepStrictEqual(item, expected) || String(item) === String(expected));
      return typeof actual === "string" && actual.includes(String(expected));
    default: {
      const a = Number(actual);
      const b = Number(expected);
      if (actual == null || Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
    }
  }
}

/** @returns {{text: string, status: "pass"|"fail"|"pending"|"invalid", actual?: string, reason?: string}[]} */
export function evaluateAssertions(lines, ctx, scope) {
  return (lines ?? []).map((raw) => {
    const text = String(raw).trim();
    const match = LINE.exec(text);
    if (!match) return { text, status: "invalid", reason: "No entiendo esta línea. Ejemplo: status == 201" };
    const [, path, op, expectedRaw] = match;
    const head = path.split(/[.[]/)[0];
    if (Object.hasOwn(NOT_AVAILABLE, head) && ctx[head] === undefined) {
      return { text, status: "pending", reason: ctx.observing && head !== "db" ? WAITING : NOT_AVAILABLE[head] };
    }
    const needsValue = op !== "exists" && op !== "not exists";
    if (needsValue && !expectedRaw) return { text, status: "invalid", reason: `Falta el valor después de ${op}.` };
    const actual = lookup(path, ctx);
    const passed = compare(op, actual, needsValue ? parseExpected(expectedRaw, scope) : undefined);
    return { text, status: passed ? "pass" : "fail", actual: short(actual) };
  });
}

/** Evalúa los tests que estaban pendientes ahora que llegaron los datos. Los demás no cambian. */
export function completePending(tests, ctx, scope) {
  return tests.map((test) => (test.status === "pending" ? evaluateAssertions([test.text], ctx, scope)[0] : test));
}

/** Vuelve a evaluar los tests de base de datos con una comparación nueva. */
export function reevaluateDb(tests, ctx, scope) {
  return tests.map((test) => (/^db\b/.test(test.text) ? evaluateAssertions([test.text], ctx, scope)[0] : test));
}

/** Lee los valores de `capture:`. Se guardan en texto, listos para usar como {{variable}}. */
export function runCaptures(rows, ctx) {
  const captured = {};
  const missing = [];
  for (const row of rows ?? []) {
    if (row.enabled === false || !row.key) continue;
    const value = lookup(row.value, ctx);
    if (value === undefined) missing.push(row.key);
    else captured[row.key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return { captured, missing };
}

export const summarizeTests = (tests) => ({
  pass: tests.filter((t) => t.status === "pass").length,
  fail: tests.filter((t) => t.status === "fail" || t.status === "invalid").length,
  pending: tests.filter((t) => t.status === "pending").length,
});
