// Handlers de ejemplo: se pueden invocar desde Citrus en modo local, sin AWS.
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

export const processPayment = async (event) => {
  const failures = [];
  for (const record of event.Records ?? []) {
    const { orderId, amount } = JSON.parse(record.body);
    log("info", "Cobrando pedido", { orderId, amount });
    if (!amount || amount <= 0) {
      log("error", "Monto inválido", { orderId });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

export const createOrder = async (event) => {
  const input = JSON.parse(event.body ?? "{}");
  log("info", "Creando pedido", { productId: input.productId });
  if (!input.productId) {
    log("warn", "Falta productId");
    return { statusCode: 400, body: JSON.stringify({ error: "Falta productId" }) };
  }
  return { statusCode: 201, body: JSON.stringify({ id: 2001, ...input, status: "pending" }) };
};
