import { CitrusError } from "./errors.js";

const VAR = /\{\{\s*([\w.$-]+)\s*\}\}/g;

/**
 * Construye el mapa final de variables.
 * Las variables pueden referirse a otras y a secretos. Los secretos son literales:
 * su contenido nunca se vuelve a expandir.
 */
export function buildScope({ variables = {}, secrets = {} } = {}) {
  const raw = new Map(Object.entries(variables).map(([k, v]) => [k, String(v ?? "")]));
  const secretMap = new Map(Object.entries(secrets));
  const done = new Map(secretMap);

  const expand = (name, stack) => {
    if (done.has(name)) return done.get(name);
    if (!raw.has(name)) return undefined;
    if (stack.includes(name)) {
      throw new CitrusError("VAR_CYCLE", `Referencia circular entre variables: ${[...stack, name].join(" -> ")}`);
    }
    const value = raw.get(name).replace(VAR, (whole, inner) => expand(inner, [...stack, name]) ?? whole);
    done.set(name, value);
    return value;
  };
  for (const name of raw.keys()) expand(name, []);
  return done;
}

/** Reemplaza {{var}} en un texto. Los nombres sin valor se anotan en `missing`. */
export function interpolate(text, scope, missing) {
  return String(text).replace(VAR, (whole, name) => {
    if (scope.has(name)) return scope.get(name);
    missing?.add(name);
    return whole;
  });
}

/** Igual que interpolate, pero recorre listas y objetos. Solo toca strings. */
export function interpolateDeep(value, scope, missing) {
  if (typeof value === "string") return interpolate(value, scope, missing);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [interpolate(k, scope, missing), interpolateDeep(v, scope, missing)]),
    );
  }
  return value;
}

/** Oculta valores de secretos en un texto que se va a mostrar. */
export function maskSecrets(text, secretValues) {
  let out = String(text);
  for (const secret of secretValues) {
    if (secret) out = out.split(secret).join("••••••");
  }
  return out;
}
