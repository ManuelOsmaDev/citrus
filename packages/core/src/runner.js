import path from "node:path";
import { evaluateAssertions, reevaluateDb, runCaptures, summarizeTests } from "./assertions.js";
import { startDbObservation } from "./db.js";
import { describeBody } from "./format.js";
import { CitrusError } from "./errors.js";
import { resolveEnvironment } from "./environments.js";
import { buildEvent } from "./events.js";
import { appendHistory } from "./history.js";
import { sendHttp } from "./http.js";
import { countLogErrors, invokeLocal, invokeRemote } from "./lambda.js";
import { prepareRequest } from "./prepare.js";
import { buildObservation, logGroupOf, waitForObservedLogs } from "./logs.js";
import { buildScope, interpolate, interpolateDeep, maskSecrets } from "./variables.js";
import { listTree, readRequest } from "./workspace.js";

const baseHistory = (model, id, envId) => ({
  ts: new Date().toISOString(),
  id: id ?? null,
  name: model.name,
  method: model.type === "lambda" ? "λ" : String(model.method ?? "GET").toUpperCase(),
  url: model.type === "lambda" ? model.function : model.url,
  env: envId ?? null,
});

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function finishTests(result, model, ctx, scope, captures) {
  result.tests = evaluateAssertions(model.assert, ctx, scope);
  result.testSummary = summarizeTests(result.tests);
  const { captured, missing } = runCaptures(model.capture, ctx);
  result.captured = captured;
  result.captureMissing = missing;
  if (captures) Object.assign(captures, captured);
}

async function runHttp({ root, model, env, confirm, envId, signal, timeoutMs }) {
  const prepared = await prepareRequest(model, env.scope, { root, missingSecrets: env.missingSecrets });
  if (env.protected && prepared.method !== "GET") {
    const approved = confirm ? await confirm({ env: envId, method: prepared.method, url: maskSecrets(prepared.url, env.secretValues) }) : false;
    if (!approved) throw new CitrusError("DENIED_PROTECTED", `El entorno '${envId}' está protegido. No se envió la request.`);
  }
  const startMs = Date.now();
  const res = await sendHttp(prepared, { signal, timeoutMs });
  const endMs = Date.now();
  const contentType = res.headers["content-type"];
  const body = describeBody(res.body, contentType);
  const result = {
    kind: "http",
    status: res.status,
    url: maskSecrets(res.url, env.secretValues),
    headers: Object.entries(res.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => ({ key, value: String(v) }))),
    body,
    contentType: contentType ?? null,
    wireSize: res.wireSize,
    truncated: res.truncated,
    timings: res.timings,
    redirects: res.redirects.map((r) => ({ status: r.status, from: maskSecrets(r.from, env.secretValues), to: maskSecrets(r.to, env.secretValues) })),
    sent: {
      method: prepared.method,
      url: maskSecrets(prepared.url, env.secretValues),
      headers: prepared.headers.map(([key, value]) => ({ key, value: maskSecrets(value, env.secretValues) })),
      bodySize: prepared.body?.length ?? 0,
    },
  };
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v]));
  const observation = buildObservation(model, env.scope, headers, startMs, endMs);
  if (observation) result.observation = observation;
  const ctx = {
    status: res.status,
    time: res.timings.total,
    size: res.wireSize,
    headers,
    body: body.isBinary ? null : parseJson(body.raw),
    observing: Boolean(observation && !observation.error),
  };
  return { result, ctx, rawBody: res.body };
}

async function runLambda({ root, model, env, confirm, trust, envId, signal, timeoutMs }) {
  const missing = new Set();
  const functionName = interpolate(model.function ?? "", env.scope, missing);
  const text = model.eventText?.trim() ? model.eventText : "{}";
  let spec;
  try {
    spec = interpolateDeep(JSON.parse(text), env.scope, missing);
  } catch {
    // {{var}} sin comillas: el texto solo es JSON después de reemplazar.
    try {
      spec = JSON.parse(interpolate(text, env.scope, missing));
    } catch (e) {
      throw new CitrusError("BAD_EVENT", `El evento no es JSON válido: ${e.message}`);
    }
  }
  if (missing.size) {
    const names = [...missing];
    throw new CitrusError("MISSING_VARS", `Faltan variables en el entorno: ${names.join(", ")}.`, { names });
  }
  if (env.protected) {
    const approved = confirm ? await confirm({ env: envId, method: "INVOKE", url: functionName }) : false;
    if (!approved) throw new CitrusError("DENIED_PROTECTED", `El entorno '${envId}' está protegido. No se invocó la función.`);
  }

  const event = buildEvent(spec);
  const startMs = Date.now();
  let out;
  if (model.mode === "remote") {
    if (!functionName) throw new CitrusError("BAD_LAMBDA", "Escribe el nombre o ARN de la función.");
    out = await invokeRemote({ functionName, event, aws: env.aws, signal });
  } else {
    if (!model.handler) throw new CitrusError("BAD_LAMBDA", "Para correr en local, indica el handler. Ejemplo: src/handlers.crear");
    const cwd = path.resolve(root, model.cwd || ".");
    const allowed = trust ? await trust({ cwd, handler: model.handler }) : false;
    if (!allowed) throw new CitrusError("DENIED_TRUST", "No se corrió el handler: la carpeta no está marcada como de confianza.");
    const variables = Object.fromEntries(env.scope);
    out = await invokeLocal({ cwd, handler: model.handler, event, variables, functionName: functionName || "local", signal, timeoutMs: timeoutMs ?? 30_000 });
  }

  const payload = parseJson(out.payload);
  const logs = out.logs.map((l) => ({ ...l, text: maskSecrets(l.text, env.secretValues) }));
  const lambda = {
    duration: out.durationMs,
    billed: out.billedMs,
    memory: out.memoryMb,
    init: out.initMs,
    coldStart: out.coldStart,
    error: out.functionError,
    requestId: out.requestId,
  };
  const result = {
    kind: "lambda",
    mode: out.mode,
    functionName,
    functionError: out.functionError,
    body: describeBody(Buffer.from(maskSecrets(out.payload, env.secretValues)), "application/json"),
    logs,
    lambda,
    timings: { total: out.durationMs },
  };
  // El log que trae Invoke son solo los últimos 4 KB: CloudWatch tiene el resto.
  if (out.mode === "remote" && out.requestId) {
    result.observation = { logGroup: logGroupOf(functionName), ids: [out.requestId], traceRoot: null, sampled: false, startMs, endMs: Date.now(), exact: true, pinned: out.requestId };
  }
  const ctx = { result: payload, body: payload, time: out.durationMs, lambda, logs: { errors: countLogErrors(logs), lines: logs.length } };
  return { result, ctx, rawBody: Buffer.from(out.payload) };
}

/**
 * Corre una request o Lambda con un entorno y devuelve lo que la UI, la CLI o el MCP necesitan.
 * Los secretos salen enmascarados en `sent` y en los logs.
 *
 * @param {object} args
 * @param {string} args.root carpeta del workspace
 * @param {object} args.model modelo (puede tener cambios sin guardar)
 * @param {string} [args.id] id del archivo, para el historial
 * @param {string|null} [args.envId]
 * @param {object} args.store almacén de secretos
 * @param {Record<string,string>} [args.captures] variables capturadas: se leen y se actualizan
 * @param {(info: object) => Promise<boolean>} [args.confirm] requerido por entornos protegidos
 * @param {(info: object) => Promise<boolean>} [args.trust] requerido para ejecutar código local
 */
export async function runRequest({ root, model, id, envId, store, captures, confirm, trust, signal, timeoutMs }) {
  const history = baseHistory(model, id, envId);
  try {
    const env = envId
      ? await resolveEnvironment(root, envId, store, captures)
      : { protected: false, scope: buildScope({ secrets: captures ?? {} }), secretValues: [], missingSecrets: [], aws: {} };
    const run = model.type === "lambda" ? runLambda : runHttp;
    // La foto de "antes" se toma antes de enviar. Si la base falla, la request sale igual.
    const dbWatch = await startDbObservation(model, env);
    let outcome;
    try {
      outcome = await run({ root, model, env, confirm, trust, envId, signal, timeoutMs });
    } catch (err) {
      await dbWatch?.abort();
      throw err;
    }
    const { result, ctx, rawBody } = outcome;
    const dbResult = await dbWatch?.finish();
    if (dbResult) {
      result.db = dbResult.public;
      if (dbResult.ctx) ctx.db = dbResult.ctx;
    }
    finishTests(result, model, ctx, env.scope, captures);
    const refreshDb = dbResult?.refresh
      ? async (tests) => {
          const fresh = await dbResult.refresh();
          const updated = reevaluateDb(tests, { db: fresh.ctx }, env.scope);
          return { db: fresh.public, tests: updated, testSummary: summarizeTests(updated) };
        }
      : null;
    await appendHistory(root, {
      ...history,
      status: result.kind === "http" ? result.status : result.functionError ? 500 : 200,
      durationMs: result.timings.total,
      size: rawBody.length,
      tests: result.testSummary,
    }).catch(() => {});
    return { result, rawBody, refreshDb };
  } catch (err) {
    await appendHistory(root, { ...history, error: err.code ?? "ERROR" }).catch(() => {});
    throw err;
  }
}

function idsIn(nodes, folder) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      if (!folder || node.path === folder || node.path.startsWith(`${folder}/`) || folder.startsWith(`${node.path}/`)) {
        out.push(...idsIn(node.children, folder));
      }
    } else if (node.type !== "invalid" && (!folder || node.id.startsWith(`${folder}/`))) {
      out.push(node.id);
    }
  }
  return out;
}

/**
 * Corre una carpeta en orden alfabético y comparte las capturas: la salida de una es la entrada de la siguiente.
 * Un fallo no detiene el resto.
 */
export async function runFolder({ root, folder = "", envId, store, captures = {}, confirm, trust, signal, logsTimeoutMs = 30_000, fetcher }) {
  const ids = idsIn(await listTree(root), folder);
  const steps = [];
  for (const id of ids) {
    if (signal?.aborted) break;
    const startedAt = performance.now();
    let name = id;
    try {
      const { model } = await readRequest(root, id);
      name = model.name;
      const { result } = await runRequest({ root, model, id, envId, store, captures, confirm, trust, signal });
      // Sin pantalla que espere: si un test depende de los logs, se esperan aquí.
      const needsLogs = result.tests.some((t) => t.status === "pending" && /^(logs|lambda)\b/.test(t.text));
      if (needsLogs && result.observation && !result.observation.error) {
        const logs = await waitForObservedLogs({
          root, observation: result.observation, tests: result.tests, envId, store, captures, signal, timeoutMs: logsTimeoutMs,
          ...(fetcher ? { fetcher } : {}),
        }).catch(() => null);
        if (logs?.tests) {
          result.tests = logs.tests;
          result.testSummary = logs.testSummary;
        }
      }
      const failedStatus = result.kind === "http" ? result.status >= 400 && !model.assert?.length : Boolean(result.functionError);
      steps.push({
        id,
        name,
        kind: result.kind,
        method: model.method ?? "λ",
        status: result.kind === "http" ? result.status : null,
        ms: result.timings.total,
        tests: result.tests,
        summary: result.testSummary,
        captured: result.captured,
        ok: !failedStatus && result.testSummary.fail === 0,
      });
    } catch (err) {
      steps.push({ id, name, ok: false, error: err.message, ms: performance.now() - startedAt, tests: [], summary: { pass: 0, fail: 0, pending: 0 }, captured: {} });
    }
  }
  return { steps, ok: steps.every((s) => s.ok), captures };
}
