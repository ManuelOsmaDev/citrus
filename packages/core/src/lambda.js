import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CitrusError } from "./errors.js";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "lambda-host.cjs");
const MAX_LOG_LINES = 5000;
const INHERITED = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "TZ", "LANG"];
const PINO_LEVELS = { 10: "debug", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "error" };

const RUNTIME_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t[\w-]+\t(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\t([\s\S]*)$/;
const PLATFORM = /^(START RequestId|END RequestId|REPORT RequestId|INIT_START|INIT_REPORT|XRAY TraceId)/;

/** Reconoce el nivel de una línea: prefijo del runtime, JSON de pino o Powertools, stderr o texto. */
export function logEntry(raw, stream = "stdout", ts = Date.now()) {
  let text = String(raw).replace(/\s+$/, "");
  if (PLATFORM.test(text)) return { ts, stream, text, level: "system", json: false };
  let level = stream === "stderr" ? "error" : "info";
  let fromPrefix = false;
  const prefixed = RUNTIME_PREFIX.exec(text);
  if (prefixed) {
    level = prefixed[1].toLowerCase();
    text = prefixed[2];
    fromPrefix = true;
  }
  let fields = null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      fields = JSON.parse(trimmed);
      const value = fields.level ?? fields.severity ?? fields.lvl;
      if (value !== undefined) level = PINO_LEVELS[value] ?? String(value).toLowerCase();
    } catch {
      fields = null;
    }
  } else if (!fromPrefix) {
    if (/Task timed out after/.test(text)) level = "error";
    const word = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b/.exec(text)?.[1];
    if (word) level = word.startsWith("WARN") ? "warn" : word.toLowerCase();
  }
  return { ts, stream, text, level, json: fields !== null };
}

export const countLogErrors = (logs) => logs.filter((l) => l.level === "error" || l.level === "fatal" || l.level === "critical").length;

/** Encuentra el archivo de un handler como src/pedidos.crear. */
export function resolveHandler(cwd, handler) {
  const text = String(handler ?? "");
  const at = text.lastIndexOf(".");
  if (at <= 0 || at === text.length - 1) {
    throw new CitrusError("BAD_HANDLER", `Handler inválido: '${text}'. Formato esperado: src/archivo.funcion`);
  }
  const base = path.resolve(cwd, text.slice(0, at));
  // La confianza se da por carpeta: un handler con ../ no puede saltar a otra sin preguntar.
  const inside = path.relative(path.resolve(cwd), base);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new CitrusError("HANDLER_OUTSIDE", "El handler debe estar dentro de la carpeta del proyecto.");
  }
  const exportName = text.slice(at + 1);
  for (const ext of [".mjs", ".cjs", ".js"]) {
    if (fs.existsSync(base + ext)) return { file: base + ext, exportName };
  }
  if (fs.existsSync(`${base}.ts`)) {
    throw new CitrusError("TS_HANDLER", `${path.basename(base)}.ts es TypeScript. Compílalo a JavaScript y apunta el handler al resultado.`);
  }
  throw new CitrusError("NO_HANDLER", `No encontré ${base}.js, .mjs ni .cjs.`);
}

/**
 * Corre el handler en un proceso aparte con solo las variables que necesita.
 * Ejecuta código del proyecto: quien llama debe haber confirmado que confía en él.
 */
export function invokeLocal({ cwd, handler, event, variables = {}, functionName = "local", timeoutMs = 30_000, signal }) {
  const { file, exportName } = resolveHandler(cwd, handler);
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of INHERITED) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, variables, { AWS_LAMBDA_FUNCTION_NAME: functionName, _HANDLER: handler, AWS_EXECUTION_ENV: "citrus-local" });

  return new Promise((resolve, reject) => {
    const logs = [];
    const startedAt = performance.now();
    const child = fork(HOST, [], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let settled = false;
    const collect = (stream) => {
      let rest = "";
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) if (logs.length < MAX_LOG_LINES) logs.push(logEntry(line, stream));
      });
      child[stream].on("end", () => {
        if (rest && logs.length < MAX_LOG_LINES) logs.push(logEntry(rest, stream));
      });
    };
    collect("stdout");
    collect("stderr");

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Deja llegar lo último que escribió el proceso antes de devolver los logs.
      setTimeout(() => {
        result instanceof Error ? reject(result) : resolve({ ...result, logs });
      }, 30);
    };
    const onAbort = () => {
      child.kill();
      finish(new CitrusError("CANCELLED", "Invocación cancelada."));
    };
    const timer = setTimeout(() => {
      child.kill();
      const durationMs = performance.now() - startedAt;
      finish({
        mode: "local",
        functionError: "Timeout",
        payload: JSON.stringify({ errorType: "Timeout", errorMessage: `La función superó ${timeoutMs / 1000} s.` }),
        durationMs,
        billedMs: Math.ceil(durationMs),
        memoryMb: null,
        initMs: null,
        coldStart: true,
        requestId: null,
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort);

    child.once("error", (err) => finish(new CitrusError("LAMBDA_HOST", `No se pudo iniciar el proceso: ${err.message}`)));
    child.once("exit", (code) => finish(new CitrusError("LAMBDA_CRASH", `El proceso terminó antes de responder (código ${code}).`)));
    child.once("message", (msg) => {
      const failed = msg.error != null;
      finish({
        mode: "local",
        functionError: failed ? (msg.phase === "init" ? "Init" : "Unhandled") : null,
        payload: failed ? JSON.stringify(msg.error) : msg.payload,
        durationMs: msg.durationMs ?? 0,
        billedMs: Math.ceil(msg.durationMs ?? 0),
        memoryMb: msg.memoryMb ?? null,
        initMs: msg.initMs ?? null,
        // Cada invocación local es un proceso nuevo: siempre es un arranque en frío.
        coldStart: true,
        requestId: msg.requestId ?? null,
      });
    });
    child.send({ file, exportName, event, functionName, timeoutMs });
  });
}

/** Saca métricas de la línea REPORT que Lambda agrega al final de los logs. */
export function parseReport(text) {
  const number = (pattern) => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    durationMs: number(/\tDuration: ([\d.]+) ms/) ?? number(/\bDuration: ([\d.]+) ms/),
    billedMs: number(/Billed Duration: ([\d.]+) ms/),
    memoryMb: number(/Max Memory Used: ([\d.]+) MB/),
    initMs: number(/Init Duration: ([\d.]+) ms/),
    memorySizeMb: number(/Memory Size: ([\d.]+) MB/),
    traceId: /XRAY TraceId: (\S+)/.exec(text)?.[1] ?? null,
    sampled: /Sampled: true/.test(text),
  };
}

/** Opciones comunes de los clientes de AWS: región, perfil y emuladores locales. */
export async function awsClientOptions(aws = {}) {
  const options = { region: aws.region ?? process.env.AWS_REGION ?? "us-east-1" };
  if (aws.endpoint) {
    // Solo para emuladores locales: un repo clonado no puede desviar las llamadas firmadas a otro host.
    const host = new URL(aws.endpoint).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      throw new CitrusError("BAD_ENDPOINT", "aws.endpoint solo puede apuntar a localhost.");
    }
    options.endpoint = aws.endpoint;
    // Un emulador acepta cualquier firma. Las credenciales reales nunca salen hacia él.
    options.credentials = { accessKeyId: "citrus-local", secretAccessKey: "citrus-local" };
  } else if (aws.profile) {
    const { fromIni } = await import("@aws-sdk/credential-providers");
    options.credentials = fromIni({ profile: aws.profile });
  }
  return options;
}

/** Invoca la función real en AWS con la cadena estándar de credenciales. */
export async function invokeRemote({ functionName, event, aws = {}, signal }) {
  const [{ InvokeCommand, LambdaClient }, options] = await Promise.all([import("@aws-sdk/client-lambda"), awsClientOptions(aws)]);
  const client = new LambdaClient(options);
  const startedAt = performance.now();
  try {
    const res = await client.send(
      new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(event ?? {})), LogType: "Tail" }),
      { abortSignal: signal },
    );
    const tail = res.LogResult ? Buffer.from(res.LogResult, "base64").toString("utf8") : "";
    const report = parseReport(tail);
    return {
      mode: "remote",
      functionError: res.FunctionError ?? null,
      payload: res.Payload ? Buffer.from(res.Payload).toString("utf8") : "null",
      durationMs: report.durationMs ?? performance.now() - startedAt,
      billedMs: report.billedMs,
      memoryMb: report.memoryMb,
      initMs: report.initMs,
      coldStart: report.initMs != null,
      requestId: res.$metadata?.requestId ?? null,
      logs: tail.split(/\r?\n/).filter(Boolean).map((line) => logEntry(line)),
    };
  } catch (err) {
    if (signal?.aborted) throw new CitrusError("CANCELLED", "Invocación cancelada.");
    throw new CitrusError(err.name ?? "AWS_ERROR", `AWS respondió: ${err.message}`);
  } finally {
    client.destroy();
  }
}
