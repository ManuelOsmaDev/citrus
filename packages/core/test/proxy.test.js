import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import selfsigned from "selfsigned";
import { parseProxyRules, sendHttp, setProxyResolver, setTrustedCertificates } from "../src/index.js";

const listen = (s) => new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s.address().port)));
const send = (url, options) => sendHttp({ method: "GET", url, headers: [] }, options);

describe("proxy", () => {
  let target, targetPort, secure, securePort, proxy, proxyPort;
  let tunnels = [];
  let auth = null;
  let answer = "200 Connection Established";

  before(async () => {
    target = http.createServer((req, res) => res.end(`hola ${req.url}`));
    targetPort = await listen(target);
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048 });
    secure = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => res.end("seguro"));
    securePort = await listen(secure);
    proxy = http.createServer((req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url);
      auth = req.headers["proxy-authorization"] ?? null;
      if (!answer.startsWith("200")) return client.end(`HTTP/1.1 ${answer}\r\n\r\n`);
      const [, port] = req.url.split(":");
      const upstream = net.connect(Number(port), "127.0.0.1", () => {
        client.write(`HTTP/1.1 ${answer}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    proxyPort = await listen(proxy);
  });

  afterEach(() => {
    tunnels = [];
    auth = null;
    answer = "200 Connection Established";
    setProxyResolver(null);
  });

  after(() => {
    target.close();
    secure.close();
    proxy.close();
  });

  it("entiende lo que informa Windows", () => {
    assert.equal(parseProxyRules("DIRECT"), null);
    assert.equal(parseProxyRules("PROXY 10.0.0.1:8080; DIRECT"), "http://10.0.0.1:8080");
    assert.equal(parseProxyRules("HTTPS p.empresa.com:443"), "https://p.empresa.com:443");
    assert.equal(parseProxyRules("SOCKS5 a:1; PROXY b:2"), "http://b:2");
    assert.equal(parseProxyRules(""), null);
  });

  it("sin proxy va directo", async () => {
    const res = await send(`http://127.0.0.1:${targetPort}/x`);
    assert.equal(res.body.toString(), "hola /x");
    assert.equal(tunnels.length, 0);
  });

  it("http pasa por el túnel", async () => {
    setProxyResolver(() => `http://127.0.0.1:${proxyPort}`);
    const res = await send(`http://interno.empresa:${targetPort}/a`);
    assert.equal(res.body.toString(), "hola /a");
    assert.deepEqual(tunnels, [`interno.empresa:${targetPort}`]);
  });

  it("https pasa por el túnel y el host lo resuelve el proxy", async () => {
    setProxyResolver((url) => parseProxyRules(url.startsWith("https") ? `PROXY 127.0.0.1:${proxyPort}` : "DIRECT"));
    const res = await send(`https://no-existe.invalid:${securePort}/`, { rejectUnauthorized: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "seguro");
  });

  it("el certificado se sigue verificando dentro del túnel", async () => {
    setProxyResolver(() => `http://127.0.0.1:${proxyPort}`);
    await assert.rejects(send(`https://localhost:${securePort}/`), (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("envía el usuario del proxy solo al proxy", async () => {
    setProxyResolver(() => `http://ana:cl%40ve@127.0.0.1:${proxyPort}`);
    await send(`http://x.empresa:${targetPort}/`);
    assert.equal(auth, `Basic ${Buffer.from("ana:cl@ve").toString("base64")}`);
  });

  it("explica cuando el proxy pide contraseña", async () => {
    answer = "407 Proxy Authentication Required";
    setProxyResolver(() => `http://127.0.0.1:${proxyPort}`);
    await assert.rejects(send(`http://x.empresa:${targetPort}/`), (e) => e.code === "PROXY_AUTH" && /pide usuario/.test(e.message));
  });

  it("explica cuando el proxy rechaza", async () => {
    answer = "403 Forbidden";
    setProxyResolver(() => `http://127.0.0.1:${proxyPort}`);
    await assert.rejects(send(`http://x.empresa:${targetPort}/`), (e) => e.code === "PROXY_ERROR" && /403/.test(e.message));
  });

  it("explica cuando no llega al proxy", async () => {
    setProxyResolver(() => "http://127.0.0.1:1");
    await assert.rejects(send(`http://x.empresa:${targetPort}/`), (e) => e.code === "PROXY_UNREACHABLE");
  });

  it("si no se puede averiguar el proxy, va directo", async () => {
    setProxyResolver(() => { throw new Error("sin PAC"); });
    const res = await send(`http://127.0.0.1:${targetPort}/z`);
    assert.equal(res.body.toString(), "hola /z");
  });
});

describe("certificados de Windows", () => {
  let secure, port, cert;
  before(async () => {
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048 });
    cert = pems.cert;
    secure = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => res.end("confiable"));
    port = await listen(secure);
  });
  afterEach(() => setTrustedCertificates(null));
  after(() => secure.close());

  it("sin el certificado, se rechaza", async () => {
    await assert.rejects(send(`https://localhost:${port}/`), (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("con el certificado instalado en el sistema, se confía", async () => {
    setTrustedCertificates(Promise.resolve([cert]));
    const res = await send(`https://localhost:${port}/`);
    assert.equal(res.body.toString(), "confiable");
  });

  it("una lista rota no impide enviar", async () => {
    setTrustedCertificates(Promise.reject(new Error("sin PowerShell")));
    await assert.rejects(send(`https://localhost:${port}/`), (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  });
});
