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

/**
 * Convierte la respuesta de un PAC o de Chromium en una URL de proxy.
 * "PROXY 10.0.0.1:8080; DIRECT" da "http://10.0.0.1:8080". "DIRECT" da null. SOCKS no se usa.
 */
export function parseProxyRules(rules) {
  for (const rule of String(rules ?? "").split(";")) {
    const [kind, address] = rule.trim().split(/\s+/);
    if (kind?.toUpperCase() === "DIRECT") return null;
    if (kind?.toUpperCase() === "PROXY" && address) return `http://${address}`;
    if (kind?.toUpperCase() === "HTTPS" && address) return `https://${address}`;
  }
  return null;
}

function bypassedByEnv(hostname, port) {
  const list = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const host = hostname.toLowerCase();
  return list.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === "*") return true;
    const [name, entryPort] = entry.split(":");
    if (entryPort && entryPort !== String(port)) return false;
    const domain = name.replace(/^\*?\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Sin una app que informe el proxy del sistema, se usan HTTPS_PROXY, HTTP_PROXY y NO_PROXY. */
function proxyFromEnv(url) {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return null;
  if (bypassedByEnv(hostname, target.port || (target.protocol === "https:" ? 443 : 80))) return null;
  const { HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy } = process.env;
  return (target.protocol === "https:" ? HTTPS_PROXY || https_proxy : null) || HTTP_PROXY || http_proxy || null;
}

let proxyResolver = proxyFromEnv;
let trustedContext = Promise.resolve(null);

/**
 * Agrega certificados raíz a los de Node, por ejemplo los de Windows. Hace falta en redes
 * donde un antivirus o un proxy inspecciona el HTTPS. Acepta una lista de PEM o una promesa.
 */
export function setTrustedCertificates(list) {
  trustedContext = Promise.resolve(list)
    .then((pems) => (pems?.length ? tls.createSecureContext({ ca: [...tls.rootCertificates, ...pems] }) : null))
    .catch(() => null);
}

/** La app de escritorio instala aquí el proxy del sistema. El resolver recibe la URL y da la del proxy o null. */
export function setProxyResolver(resolver) {
  proxyResolver = resolver ?? proxyFromEnv;
}

function parseProxy(value) {
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new CitrusError("PROXY_INVALID", "La dirección del proxy no es válida.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CitrusError("PROXY_UNSUPPORTED", `Citrus no soporta proxies ${parsed.protocol.replace(":", "")}.`);
  }
  const secure = parsed.protocol === "https:";
  const auth = parsed.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
    : null;
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, ""), port: Number(parsed.port) || (secure ? 443 : 80), secure, auth, host: parsed.host };
}

/** Pide al proxy un túnel hacia el destino. Llama a done(err) cuando el túnel está listo o falla. */
function openTunnel(socket, authority, proxy, done) {
  let received = Buffer.alloc(0);
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("close", onClose);
  };
  const onClose = () => {
    cleanup();
    done(new CitrusError("PROXY_ERROR", `El proxy ${proxy.host} cerró la conexión.`));
  };
  const onData = (chunk) => {
    received = Buffer.concat([received, chunk]);
    const end = received.indexOf("\r\n\r\n");
    if (end === -1) {
      if (received.length > 64 * 1024) {
        cleanup();
        done(new CitrusError("PROXY_ERROR", `El proxy ${proxy.host} dio una respuesta inválida.`));
      }
      return;
    }
    cleanup();
    const status = Number(received.subarray(0, end).toString("latin1").match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
    if (status === 407) return done(new CitrusError("PROXY_AUTH", `El proxy ${proxy.host} pide usuario y contraseña.`));
    if (status < 200 || status >= 300 || !status) {
      return done(new CitrusError("PROXY_ERROR", `El proxy ${proxy.host} rechazó la conexión (${status || "respuesta inválida"}).`));
    }
    const rest = received.subarray(end + 4);
    if (rest.length) socket.unshift(rest);
    done(null);
  };
  socket.on("data", onData);
  socket.once("close", onClose);
  const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.auth) headers.push(`Proxy-Authorization: ${proxy.auth}`);
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
}

/** Conector propio: es la única forma de medir DNS, TCP y TLS por separado. */
function timedConnector(marks, { rejectUnauthorized, proxy, secureContext }) {
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
      host: proxy ? proxy.hostname : hostname,
      port: proxy ? proxy.port : port,
      lookup(host, options, cb) {
        marks.dnsStart = clock();
        dns.lookup(host, options, (err, address, family) => {
          marks.dnsEnd = clock();
          cb(err, address, family);
        });
      },
    });
    let tunneled = !proxy;
    tcp.once("error", (err) => {
      if (tunneled) return finish(err, tcp);
      finish(new CitrusError("PROXY_UNREACHABLE", `No se pudo conectar al proxy ${proxy.host} (${err.code ?? err.message}).`), tcp);
    });

    // Con el camino hasta el destino abierto, solo falta el TLS si la URL es https.
    const reachTarget = (socket) => {
      marks.tcpEnd = clock();
      if (!secure) return finish(null, socket);
      marks.tlsStart = clock();
      const secureSocket = tls.connect({
        socket,
        servername: opts.servername || (net.isIP(hostname) ? undefined : hostname),
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized,
        ...(secureContext ? { secureContext } : {}),
      });
      secureSocket.once("error", (err) => finish(err, secureSocket));
      secureSocket.once("secureConnect", () => {
        marks.tlsEnd = clock();
        finish(null, secureSocket);
      });
    };

    const tunnelThrough = (socket) => {
      const authority = `${net.isIPv6(hostname) ? `[${hostname}]` : hostname}:${port}`;
      openTunnel(socket, authority, proxy, (err) => {
        if (err) return finish(err, socket);
        tunneled = true;
        reachTarget(socket);
      });
    };

    tcp.once("connect", () => {
      if (!proxy) return reachTarget(tcp);
      if (!proxy.secure) return tunnelThrough(tcp);
      // Proxy HTTPS: primero TLS con el proxy y dentro el túnel.
      const toProxy = tls.connect({
        socket: tcp,
        servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname,
        rejectUnauthorized,
        ...(secureContext ? { secureContext } : {}),
      });
      toProxy.once("error", (err) => finish(err, toProxy));
      toProxy.once("secureConnect", () => tunnelThrough(toProxy));
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
    ENOTFOUND: `No se encontró el host ${host}. Si estás en la red de una empresa, configura el proxy: Ctrl+K y Configurar proxy.`,
    EAI_AGAIN: `No se pudo resolver ${host}. Revisa tu conexión o configura el proxy: Ctrl+K y Configurar proxy.`,
    ECONNREFUSED: `${host} rechazó la conexión. ¿Está corriendo el servidor?`,
    ECONNRESET: `${host} cerró la conexión.`,
    ETIMEDOUT: `${host} no respondió a tiempo.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `El certificado de ${host} es autofirmado.`,
    SELF_SIGNED_CERT_IN_CHAIN: `La cadena de certificados de ${host} incluye uno autofirmado.`,
    CERT_HAS_EXPIRED: `El certificado de ${host} venció.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `El certificado no corresponde a ${host}.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `No se pudo verificar el certificado de ${host}.`,
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: `No se reconoce quién emitió el certificado de ${host}. En una red de empresa, pide a TI su certificado raíz e instálalo en Windows.`,
  };
  return new CitrusError(code || "HTTP_ERROR", known[code] ?? `Falló la request: ${err?.message ?? err}`);
}

/** Si no se puede averiguar el proxy, se intenta directo. */
async function resolveProxyFor(url) {
  try {
    return await proxyResolver(url);
  } catch {
    return null;
  }
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
    const proxyUrl = await resolveProxyFor(url);
    const agent = new Agent({
      connect: timedConnector(marks, { rejectUnauthorized, proxy: proxyUrl ? parseProxy(proxyUrl) : null, secureContext: await trustedContext }),
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
