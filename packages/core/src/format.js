/**
 * Indenta JSON recorriendo el texto, sin JSON.parse + stringify.
 * Así los enteros largos y los decimales se muestran exactamente como los mandó el servidor.
 * Espera JSON ya validado.
 */
export function prettyJson(text, indent = 2) {
  let out = "";
  let depth = 0;
  const newline = () => `\n${" ".repeat(depth * indent)}`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let next = i + 1;
      while (/\s/.test(text[next] ?? "")) next++;
      if (text[next] === close) {
        out += c + close;
        i = next;
      } else {
        depth++;
        out += c + newline();
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += newline() + c;
    } else if (c === ",") {
      out += c + newline();
    } else if (c === ":") {
      out += ": ";
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

const TEXT_TYPE = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|graphql|csv|html/i;

function languageOf(contentType, text) {
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.includes("javascript")) return "javascript";
  if (type.includes("css")) return "css";
  if (type.includes("yaml")) return "yaml";
  return /^\s*[[{]/.test(text) ? "json" : "plaintext";
}

function decodeText(buffer, contentType) {
  const charset = /charset=["']?([\w-]+)/i.exec(String(contentType ?? ""))?.[1] ?? "utf-8";
  const looksText = TEXT_TYPE.test(String(contentType ?? ""));
  try {
    return new TextDecoder(charset, { fatal: !looksText }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: !looksText }).decode(buffer);
    } catch {
      return null;
    }
  }
}

/** Prepara el cuerpo de una respuesta para mostrarlo: texto, idioma y tope de tamaño. */
export function describeBody(buffer, contentType, { maxChars = 5 * 1024 * 1024 } = {}) {
  const text = decodeText(buffer, contentType);
  if (text === null || text.includes("\u0000")) {
    return { isBinary: true, text: "", raw: "", language: "plaintext", tooLarge: false, size: buffer.length };
  }
  const tooLarge = text.length > maxChars;
  const shown = tooLarge ? text.slice(0, maxChars) : text;
  const language = languageOf(contentType, shown);
  let pretty = shown;
  if (language === "json" && !tooLarge) {
    try {
      JSON.parse(shown);
      pretty = prettyJson(shown);
    } catch {
      pretty = shown;
    }
  }
  return { isBinary: false, text: pretty, raw: shown, language: tooLarge && language === "json" ? "plaintext" : language, tooLarge, size: buffer.length };
}
