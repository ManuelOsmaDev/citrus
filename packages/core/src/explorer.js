// Buscar en los logs de una Lambda sin enviar nada: lo que hay en CloudWatch, agrupado por invocación.
import { resolveEnvironment } from "./environments.js";
import { CitrusError } from "./errors.js";
import { awsClientOptions, countLogErrors, logEntry, parseReport } from "./lambda.js";
import { filterAll, friendlyLogsError, logGroupOf } from "./logs.js";
import { interpolate, maskSecrets } from "./variables.js";

const ID_LINE = /(?:START|END|REPORT) RequestId: ([\w-]+)/;
/** El runtime de Node escribe el id de la invocación antes de cada console.log. */
const PREFIX_ID = /^\S+Z\t([\w-]+)\t[A-Z]+\t/;
/** "2026-11-14T10:00:03.000Z <id> Task timed out after 3.00 seconds" */
const TIMEOUT_ID = /^\S+Z ([\w-]{20,}) Task timed out/;
const ERROR_PATTERN = '?ERROR ?Error ?error ?Exception ?"Task timed out"';
const MAX_INVOCATIONS = 50;
const MAX_MINUTES = 7 * 24 * 60;
/** Una invocación encontrada por su REPORT pudo empezar antes del periodo elegido. */
const LOOKBACK_MS = 15 * 60_000;

const idOf = (message) => ID_LINE.exec(message)?.[1] ?? PREFIX_ID.exec(message)?.[1] ?? TIMEOUT_ID.exec(message)?.[1] ?? null;

function quoted(text) {
  const clean = String(text ?? "").replace(/"/g, "").trim();
  return clean ? `"${clean}"` : null;
}

const anyOf = (ids) => (ids.length === 1 ? `"${ids[0]}"` : ids.map((id) => `?"${id}"`).join(" "));

/**
 * Las últimas invocaciones de una Lambda, de la más nueva a la más vieja.
 * Con `text` busca las que escribieron ese texto. Con `onlyErrors`, las que fallaron.
 * Las líneas sin el id de la invocación (un logger que no lo agrega) no aparecen aquí.
 */
export async function searchLambdaLogs({ aws = {}, functionName = "", logGroup = "", sinceMinutes = 60, text = "", onlyErrors = false, limit = 20, now = Date.now() } = {}) {
  const fn = String(functionName ?? "").trim();
  const group = String(logGroup ?? "").trim() || (fn ? logGroupOf(fn) : "");
  if (!group) throw new CitrusError("NO_FUNCTION", "Escribe el nombre de la Lambda o su grupo de logs.");
  const minutes = Math.min(Math.max(Number(sinceMinutes) || 60, 1), MAX_MINUTES);
  const max = Math.min(Math.max(Number(limit) || 20, 1), MAX_INVOCATIONS);
  const startTime = now - minutes * 60_000;

  const [{ CloudWatchLogsClient, FilterLogEventsCommand }, options] = await Promise.all([
    import("@aws-sdk/client-cloudwatch-logs"),
    awsClientOptions(aws),
  ]);
  const client = new CloudWatchLogsClient(options);
  try {
    const term = quoted(text);
    // 1. Qué invocaciones mostrar: cada una deja un REPORT al terminar.
    const hits = await filterAll(client, FilterLogEventsCommand, {
      logGroupName: group,
      filterPattern: term ?? (onlyErrors ? ERROR_PATTERN : '"REPORT RequestId"'),
      startTime,
      endTime: now,
    });
    // Con texto y solo errores, se buscan más para quedarse después con las que fallaron.
    const wanted = term && onlyErrors ? MAX_INVOCATIONS : max;
    const ids = [];
    for (const event of [...hits].reverse()) {
      const id = idOf(event.message);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= wanted) break;
    }
    const region = await client.config.region();
    if (!ids.length) return { logGroup: group, region, invocations: [] };

    // 2. Todas las líneas de esas invocaciones.
    const events = await filterAll(client, FilterLogEventsCommand, {
      logGroupName: group,
      filterPattern: anyOf(ids),
      startTime: startTime - LOOKBACK_MS,
      endTime: now,
    });
    let invocations = ids.map((id) => {
      const own = events.filter((e) => e.message.includes(id));
      const start = own.find((e) => e.message.startsWith(`START RequestId: ${id}`));
      const report = own.find((e) => e.message.startsWith(`REPORT RequestId: ${id}`));
      const m = report ? parseReport(report.message) : null;
      const logs = own.map((e) => logEntry(e.message, "stdout", e.timestamp));
      const timedOut = logs.some((l) => /Task timed out/.test(l.text));
      return {
        requestId: id,
        ts: (start ?? own[0])?.timestamp ?? null,
        finished: Boolean(report),
        duration: m?.durationMs ?? null,
        billed: m?.billedMs ?? null,
        memory: m?.memoryMb ?? null,
        memorySize: m?.memorySizeMb ?? null,
        init: m?.initMs ?? null,
        coldStart: m?.initMs != null,
        errors: countLogErrors(logs) + (timedOut ? 1 : 0),
        timedOut,
        logs,
      };
    });
    if (onlyErrors) invocations = invocations.filter((i) => i.errors > 0);
    return { logGroup: group, region, invocations: invocations.slice(0, max) };
  } catch (err) {
    throw friendlyLogsError(err, group);
  } finally {
    client.destroy();
  }
}

/** Busca en los logs con el AWS del entorno y enmascara los secretos que aparezcan. */
export async function exploreLogs({ root, envId, store, captures, ...search }) {
  const env = envId ? await resolveEnvironment(root, envId, store, captures, { loadAws: false }) : { aws: {}, secretValues: [], scope: new Map() };
  // Observar guarda nombres como orders-{{stage}}-crear: se completan con el entorno.
  const functionName = interpolate(String(search.functionName ?? ""), env.scope);
  const out = await searchLambdaLogs({ ...search, functionName, aws: env.aws });
  for (const invocation of out.invocations) {
    invocation.logs = invocation.logs.map((l) => ({ ...l, text: maskSecrets(l.text, env.secretValues) }));
  }
  return out;
}

/**
 * Los nombres de las Lambdas de la cuenta, para elegir en una lista.
 * Sin el permiso lambda:ListFunctions no falla: devuelve el motivo y se escribe el nombre a mano.
 */
export async function listLambdaFunctions({ aws = {} } = {}) {
  const [{ LambdaClient, ListFunctionsCommand }, options] = await Promise.all([import("@aws-sdk/client-lambda"), awsClientOptions(aws)]);
  const client = new LambdaClient(options);
  try {
    const names = [];
    let Marker;
    for (let page = 0; page < 10; page++) {
      const res = await client.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }));
      for (const f of res.Functions ?? []) if (f.FunctionName) names.push(f.FunctionName);
      Marker = res.NextMarker;
      if (!Marker) break;
    }
    return { functions: names.sort((a, b) => a.localeCompare(b)), error: null };
  } catch (err) {
    const name = err?.name ?? "";
    let message = `AWS respondió: ${err?.message ?? err}`;
    if (["AccessDeniedException", "UnrecognizedClientException"].includes(name)) message = "Tu usuario no tiene el permiso lambda:ListFunctions. Escribe el nombre de la función a mano.";
    if (name === "CredentialsProviderError") message = "No encontré credenciales de AWS. Configura tu perfil en el entorno o con aws configure.";
    return { functions: [], error: message };
  } finally {
    client.destroy();
  }
}
