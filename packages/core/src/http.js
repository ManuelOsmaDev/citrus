import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { Agent, request } from "undici";
import { CitrusError } from "./errors.js";

const MAX_REDIRECTS = 10;
const MAX_BYTES = 100 * 1024 * 1024;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Nunca se reenvían a otro origen en una redirección. */
const SENSITIVE = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

const ms = (from, to) => (from == null || to == null ? 0 : Math.max(0, Number((to - from).toFixed(2))));
const clock = () => performance.now();

/** Conector propio: es la única forma de medir DNS, TCP y TLS por separado. */
function timedConnector(marks, { rejectUnauthorized }) {
  return (opts, callback) => {
    const hostname = String(opts.hostname).replace(/^\[|\]$/g, "");
    const secure = opts.protocol === "https:";
    const port = Number(opts.port) || (secure ? 443 : 80);
    let settled = false;
    const finish = (err, socket) => {
      if (settled) return;
      settled = true;
      if (err) socket?.destroy();
      callback(err, err ? null : socket);
    };

    marks.connectStart = clock();
    const tcp = net.connect({
      host: hostname,
      port,
      lookup(host, options, cb) {
        marks.dnsStart = clock();
        dns.lookup(host, options, (err, address, family) => {
          marks.dnsEnd = clock();
          cb(err, address, family);
        });
      },
    });
    tcp.once("error", (err) => finish(err, tcp));
    tcp.once("connect", () => {
      marks.tcpEnd = clock();
      if (!secure) return finish(null, tcp);
      marks.tlsStart = clock();
      const secureSocket = tls.connect({
        socket: tcp,
        servername: opts.servername || (net.isIP(hostname) ? undefined : hostname),
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized,
      });
      secureSocket.once("error", (err) => finish(err, secureSocket));
      secureSocket.once("secureConnect", () => {
        marks.tlsEnd = clock();
        finish(null, secureSocket);
      });
    });
  };
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      return { buffer: Buffer.concat(chunks), size, truncated: true };
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), size, truncated: false };
}

const decoders = {
  gzip: promisify(zlib.gunzip),
  "x-gzip": promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
};

/** Descomprime con tope para frenar bombas de compresión. Si falla, devuelve los bytes tal cual. */
async function decode(buffer, encoding) {
  const decoder = decoders[String(encoding ?? "").toLowerCase()];
  if (!decoder || !buffer.length) return buffer;
  try {
    return await decoder(buffer, { maxOutputLength: MAX_BYTES });
  } catch {
    return buffer;
  }
}

function friendlyError(err, url, timedOut, aborted) {
  if (aborted) return new CitrusError("CANCELLED", "Request cancelada.");
  if (timedOut) return new CitrusError("TIMEOUT", "Se agotó el tiempo de espera.");
  const code = err?.code ?? err?.cause?.code ?? "";
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const known = {
    ENOTFOUND: `No se encontró el host ${host}.`,
    EAI_AGAIN: `No se pudo resolver ${host}. Revisa tu conexión.`,
    ECONNREFUSED: `${host} rechazó la conexión. ¿Está corriendo el servidor?`,
    ECONNRESET: `${host} cerró la conexión.`,
    ETIMEDOUT: `${host} no respondió a tiempo.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `El certificado de ${host} es autofirmado.`,
    SELF_SIGNED_CERT_IN_CHAIN: `La cadena de certificados de ${host} incluye uno autofirmado.`,
    CERT_HAS_EXPIRED: `El certificado de ${host} venció.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `El certificado no corresponde a ${host}.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `No se pudo verificar el certificado de ${host}.`,
  };
  return new CitrusError(code || "HTTP_ERROR", known[code] ?? `Falló la request: ${err?.message ?? err}`);
}

/**
 * Envía una request y mide cada fase.
 * Usa una conexión nueva por salto: sin pool, los tiempos de DNS, TCP y TLS son reales.
 *
 * @param {{ method: string, url: string, headers: [string,string][], body?: Buffer|null, sensitiveHeaders?: string[] }} prepared
 * @param {{ signal?: AbortSignal, timeoutMs?: number, followRedirects?: boolean, rejectUnauthorized?: boolean }} [options]
 */
export async function sendHttp(prepared, options = {}) {
  const { signal, timeoutMs = 60_000, followRedirects = true, rejectUnauthorized = true } = options;
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const combined = AbortSignal.any([signal, timeout].filter(Boolean));
  const startedAt = clock();
  const redirects = [];

  let { method, url, headers, body } = prepared;
  const sensitive = new Set([...SENSITIVE, ...(prepared.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);

  for (let hop = 0; ; hop++) {
    const marks = {};
    const agent = new Agent({
      connect: timedConnector(marks, { rejectUnauthorized }),
      headersTimeout: 0,
      bodyTimeout: 0,
      pipelining: 0,
    });
    try {
      const requestStart = clock();
      const res = await request(url, {
        method,
        headers: headers.flat(),
        body: body ?? undefined,
        dispatcher: agent,
        signal: combined,
      });
      const headersAt = clock();

      const location = res.headers.location;
      if (followRedirects && REDIRECT.has(res.statusCode) && location) {
        await res.body.dump().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new CitrusError("TOO_MANY_REDIRECTS", `Más de ${MAX_REDIRECTS} redirecciones.`);
        const next = new URL(location, url);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new CitrusError("BAD_REDIRECT", `Redirección a un protocolo no soportado: ${next.protocol}`);
        }
        redirects.push({ status: res.statusCode, from: url, to: next.href });
        const dropsBody = (res.statusCode === 303 && method !== "HEAD") || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST");
        if (dropsBody) {
          method = "GET";
          body = null;
          headers = headers.filter(([k]) => k.toLowerCase() !== "content-type");
        }
        if (next.origin !== new URL(url).origin) {
          headers = headers.filter(([k]) => !sensitive.has(k.toLowerCase()));
        }
        url = next.href;
        continue;
      }

      const { buffer, size, truncated } = await readLimited(res.body, MAX_BYTES);
      const endAt = clock();
      const decoded = truncated ? buffer : await decode(buffer, res.headers["content-encoding"]);
      return {
        status: res.statusCode,
        url,
        headers: res.headers,
        body: decoded,
        wireSize: size,
        truncated,
        redirects,
        timings: {
          dns: ms(marks.dnsStart, marks.dnsEnd),
          tcp: ms(marks.dnsEnd ?? marks.connectStart, marks.tcpEnd),
          tls: ms(marks.tlsStart, marks.tlsEnd),
          wait: ms(marks.tlsEnd ?? marks.tcpEnd ?? requestStart, headersAt),
          download: ms(headersAt, endAt),
          total: ms(startedAt, endAt),
        },
      };
    } catch (err) {
      if (err instanceof CitrusError) throw err;
      throw friendlyError(err, url, timeout?.aborted, signal?.aborted);
    } finally {
      agent.destroy().catch(() => {});
    }
  }
}
