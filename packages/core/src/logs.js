import { completePending, summarizeTests } from "./assertions.js";
import { resolveEnvironment } from "./environments.js";
import { CitrusError } from "./errors.js";
import { awsClientOptions, countLogErrors, logEntry, parseReport } from "./lambda.js";
import { interpolate, maskSecrets } from "./variables.js";

const SAFE_ID = /^[\w-]{6,128}$/;
const ID_LINE = /(?:START|REPORT) RequestId: ([\w-]+)/;
/** El runtime de Node escribe el id de la Lambda antes de cada línea de console.log. */
const PREFIX_ID = /^\S+Z\t([\w-]+)\t[A-Z]+\t/;
const MAX_LAMBDA_MS = 15 * 60_000;
const MAX_PAGES = 10;
const WIDE_BEFORE_MS = 5 * 60_000;
const WIDE_AFTER_MS = 10 * 60_000;
/** Margen de la búsqueda por tiempo: los relojes del equipo y de AWS no coinciden exacto. */
const WINDOW_MARGIN_MS = 2_000;
/** Tiempo que se da a CloudWatch para entregar los logs antes de buscar por hora. */
const WINDOW_GRACE_MS = 15_000;

/** Ids de una respuesta HTTP. API Gateway suele dar el suyo, que no es el de la Lambda. */
export function requestIdsFromHeaders(headers = {}) {
  const ids = ["x-amzn-requestid", "x-amzn-request-id", "apigw-requestid", "x-amz-apigw-id", "x-amz-request-id"]
    .map((name) => headers[name])
    .filter((value) => typeof value === "string" && SAFE_ID.test(value));
  const trace = String(headers["x-amzn-trace-id"] ?? "");
  const traceRoot = /Root=([\w-]+)/.exec(trace)?.[1] ?? null;
  return {
    ids: [...new Set(ids)],
    traceRoot: traceRoot && SAFE_ID.test(traceRoot) ? traceRoot : null,
    sampled: /Sampled=1/.test(trace),
  };
}

/** Acepta nombre, nombre:alias o ARN. */
export function functionNameOf(reference) {
  const text = String(reference ?? "");
  const arn = /:function:([^:]+)/.exec(text);
  if (arn) return arn[1];
  return text.split(":")[0];
}

export const logGroupOf = (functionName) => `/aws/lambda/${functionNameOf(functionName)}`;

/** Lee `observe:` de una request HTTP. Devuelve null si no pide logs. */
export function buildObservation(model, scope, headers, startMs, endMs) {
  const spec = model.observe;
  if (!spec || spec.logs !== true) return null;
  const missing = new Set();
  const group = spec.logGroup
    ? interpolate(spec.logGroup, scope, missing)
    : spec.lambda
      ? logGroupOf(interpolate(spec.lambda, scope, missing))
      : null;
  if (!group) return { error: "Indica la función en observe.lambda o el grupo en observe.logGroup." };
  if (missing.size) return { error: `Faltan variables en observe: ${[...missing].join(", ")}.` };
  const { ids, traceRoot, sampled } = requestIdsFromHeaders(headers);
  return { logGroup: group, ids, traceRoot, sampled, startMs, endMs, exact: false, pinned: null };
}

export function traceUrl(region, traceId) {
  if (!/^[a-z0-9-]+$/.test(String(region)) || !/^[\w-]+$/.test(String(traceId))) return null;
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces/${traceId}`;
}

function friendly(err, logGroup) {
  if (err instanceof CitrusError) return err;
  const name = err?.name ?? "";
  if (name === "ResourceNotFoundException") return new CitrusError("LOG_GROUP_NOT_FOUND", `No existe el grupo de logs ${logGroup}. Revisa el nombre de la función, la región y que se haya ejecutado al menos una vez.`);
  if (name === "CredentialsProviderError") return new CitrusError("NO_CREDENTIALS", "No encontré credenciales de AWS. Configura un perfil en ~/.aws o en el bloque aws del entorno.");
  if (["ExpiredTokenException", "ExpiredToken", "TokenRefreshRequired"].includes(name)) return new CitrusError("EXPIRED_CREDENTIALS", "Tus credenciales de AWS vencieron. Vuelve a iniciar sesión.");
  if (["AccessDeniedException", "UnrecognizedClientException"].includes(name)) return new CitrusError("ACCESS_DENIED", "AWS negó el acceso. Tu usuario necesita el permiso logs:FilterLogEvents sobre ese grupo.");
  return new CitrusError(name || "AWS_ERROR", `CloudWatch respondió: ${err?.message ?? err}`);
}

async function filterAll(client, Command, input) {
  const events = [];
  let nextToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.send(new Command({ ...input, nextToken }));
    events.push(...(res.events ?? []));
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

const pattern = (ids) => (ids.length === 1 ? `"${ids[0]}"` : ids.map((id) => `?"${id}"`).join(" "));

/** Encuentra el id real de la Lambda: el de API Gateway o la traza llevan hasta él. */
async function findLambdaId(client, Command, observation) {
  if (observation.pinned) return { id: observation.pinned, approximate: false };
  const { logGroup, ids, traceRoot, startMs, endMs, exact } = observation;
  const wanted = [...ids, ...(traceRoot ? [traceRoot] : [])];
  if (wanted.length) {
    const events = await filterAll(client, Command, {
      logGroupName: logGroup,
      filterPattern: pattern(wanted),
      startTime: startMs - WIDE_BEFORE_MS,
      endTime: endMs + WIDE_AFTER_MS,
    });
    for (const event of events) {
      const found = ID_LINE.exec(event.message)?.[1] ?? PREFIX_ID.exec(event.message)?.[1];
      if (found) return { id: found, approximate: false };
    }
    if (exact && ids.length) return { id: ids[0], approximate: false };
  }
  if (exact) return { id: null };
  // Antes de eso, los logs propios pueden no haber llegado y solo se verían invocaciones anteriores.
  if (Date.now() - endMs < WINDOW_GRACE_MS) return { id: null };
  // Sin id en común: se mira quién corrió en ese momento, y nunca se adivina si fueron varias.
  const starts = await filterAll(client, Command, {
    logGroupName: logGroup,
    filterPattern: '"START RequestId"',
    startTime: startMs - WINDOW_MARGIN_MS,
    endTime: endMs + WINDOW_MARGIN_MS,
  });
  const candidates = starts
    .map((e) => ({ id: ID_LINE.exec(e.message)?.[1], ts: e.timestamp }))
    .filter((c) => c.id);
  if (candidates.length === 1) return { id: candidates[0].id, approximate: true };
  if (candidates.length > 1) return { id: null, candidates };
  return { id: null };
}

/**
 * Trae todo lo que escribió una invocación.
 * Filtrar por id perdería las líneas que no lo llevan, como un pino sin requestId, así que
 * el id solo ubica el stream y los límites. Un stream atiende una invocación a la vez.
 */
async function readInvocation(client, Command, observation, id) {
  const logGroup = observation.logGroup;
  const marks = await filterAll(client, Command, {
    logGroupName: logGroup,
    filterPattern: `"${id}"`,
    startTime: observation.startMs - WIDE_BEFORE_MS,
    endTime: observation.endMs + WIDE_AFTER_MS,
  });
  const start = marks.find((e) => e.message.startsWith(`START RequestId: ${id}`));
  const report = marks.find((e) => e.message.startsWith(`REPORT RequestId: ${id}`));
  if (!start) return { events: marks, report: report ?? null };
  const metrics = report ? parseReport(report.message) : null;
  // INIT_START va antes del START. Con arranque en frío el stream es nuevo: no hay otra invocación antes.
  const before = metrics?.initMs != null ? metrics.initMs + 1_000 : 0;
  const all = await filterAll(client, Command, {
    logGroupName: logGroup,
    logStreamNames: [start.logStreamName],
    startTime: Math.floor(start.timestamp - before),
    // Sin REPORT, el máximo que puede durar una Lambda: no depende del reloj de este equipo.
    endTime: report ? report.timestamp : start.timestamp + MAX_LAMBDA_MS,
  });
  if (!report) return { events: all, report: null };
  const last = all.findIndex((e) => e.message.startsWith(`REPORT RequestId: ${id}`));
  return { events: last >= 0 ? all.slice(0, last + 1) : all, report };
}

/** Una consulta a CloudWatch. `state`: waiting, ready o ambiguous. Quien llama decide si reintenta. */
export async function fetchInvocationLogs({ observation, aws = {} }) {
  const [{ CloudWatchLogsClient, FilterLogEventsCommand }, options] = await Promise.all([
    import("@aws-sdk/client-cloudwatch-logs"),
    awsClientOptions(aws),
  ]);
  const client = new CloudWatchLogsClient(options);
  try {
    const { id, approximate, candidates } = await findLambdaId(client, FilterLogEventsCommand, observation);
    if (candidates) return { state: "ambiguous", candidates, logs: [] };
    if (!id) return { state: "waiting", logs: [] };
    const { events, report } = await readInvocation(client, FilterLogEventsCommand, observation, id);
    const logs = events.map((e) => logEntry(e.message, "stdout", e.timestamp));
    if (!report) return { state: "waiting", requestId: id, approximate, logs };
    const m = parseReport(report.message);
    return {
      state: "ready",
      requestId: id,
      approximate,
      logs,
      lambda: {
        duration: m.durationMs,
        billed: m.billedMs,
        memory: m.memoryMb,
        memorySize: m.memorySizeMb,
        init: m.initMs,
        coldStart: m.initMs != null,
        requestId: id,
        error: null,
      },
      traceId: m.traceId && (m.sampled || observation.sampled) ? m.traceId : null,
      region: await client.config.region(),
    };
  } catch (err) {
    throw friendly(err, observation.logGroup);
  } finally {
    client.destroy();
  }
}

/** Trae los logs de una ejecución, enmascara secretos y completa los tests que los esperaban. */
export async function fetchObservedLogs({ root, observation, tests = [], envId, store, captures, fetcher = fetchInvocationLogs }) {
  const env = envId ? await resolveEnvironment(root, envId, store, captures) : { aws: {}, secretValues: [], scope: new Map() };
  const out = await fetcher({ observation, aws: env.aws });
  const logs = out.logs.map((l) => ({ ...l, text: maskSecrets(l.text, env.secretValues) }));
  const response = { ...out, logs };
  if (out.traceId && out.region) response.traceUrl = traceUrl(out.region, out.traceId);
  if (out.state === "ready") {
    const ctx = { logs: { errors: countLogErrors(logs), lines: logs.length }, lambda: out.lambda };
    response.tests = completePending(tests, ctx, env.scope);
    response.testSummary = summarizeTests(response.tests);
  }
  return response;
}

/** Espera los logs con reintentos, para quien no tiene pantalla: carpetas y, más adelante, la CLI. */
export async function waitForObservedLogs({ timeoutMs = 30_000, intervalMs = 2_000, signal, ...args }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await fetchObservedLogs(args);
    if (out.state !== "waiting" || Date.now() >= deadline || signal?.aborted) return out;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
