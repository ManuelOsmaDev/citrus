// Corre un handler en un proceso aparte. Recibe el pedido por IPC y devuelve el resultado.
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

function describe(error) {
  return {
    errorType: error?.name ?? "Error",
    errorMessage: error?.message ?? String(error),
    trace: String(error?.stack ?? "").split("\n").slice(1).map((line) => line.trim()),
  };
}

process.once("message", async ({ file, exportName, event, functionName, timeoutMs }) => {
  const finish = (message) => process.send(message, () => process.exit(0));
  const startedAt = performance.now();
  let handler;
  try {
    const mod = await import(pathToFileURL(file).href);
    handler = mod[exportName] ?? mod.default?.[exportName];
    if (typeof handler !== "function") throw new TypeError(`El archivo no exporta la función '${exportName}'.`);
  } catch (error) {
    return finish({ phase: "init", error: describe(error), initMs: performance.now() - startedAt });
  }
  const initMs = performance.now() - startedAt;
  const invokeAt = performance.now();
  const requestId = randomUUID();
  const context = {
    awsRequestId: requestId,
    functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:local:000000000000:function:${functionName}`,
    memoryLimitInMB: "1024",
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => Math.max(0, timeoutMs - (performance.now() - invokeAt)),
  };
  const usage = () => ({
    requestId,
    initMs,
    durationMs: performance.now() - invokeAt,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });
  try {
    const payload = await new Promise((resolve, reject) => {
      const out = handler(event, context, (err, value) => (err ? reject(err) : resolve(value)));
      if (out && typeof out.then === "function") out.then(resolve, reject);
      else if (handler.length < 3) resolve(out);
    });
    finish({ phase: "done", payload: JSON.stringify(payload ?? null), ...usage() });
  } catch (error) {
    finish({ phase: "done", error: describe(error), ...usage() });
  }
});
