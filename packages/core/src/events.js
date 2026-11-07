import { randomUUID } from "node:crypto";

const REGION = "us-east-1";
const now = () => new Date().toISOString();
const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? {}));

function apiGatewayV2(spec) {
  const method = String(spec.method ?? "GET").toUpperCase();
  const path = spec.path ?? "/";
  const query = spec.query ?? {};
  const rawQueryString = new URLSearchParams(query).toString();
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString,
    headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    queryStringParameters: Object.keys(query).length ? query : undefined,
    pathParameters: spec.pathParameters,
    requestContext: {
      accountId: "123456789012",
      apiId: "local",
      domainName: "local.citrus",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "Citrus" },
      requestId: randomUUID(),
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: now(),
      timeEpoch: Date.now(),
    },
    body: spec.body == null ? undefined : asText(spec.body),
    isBase64Encoded: false,
  };
}

function apiGatewayV1(spec) {
  const method = String(spec.method ?? "GET").toUpperCase();
  const path = spec.path ?? "/";
  return {
    resource: path,
    path,
    httpMethod: method,
    headers: { "Content-Type": "application/json", ...(spec.headers ?? {}) },
    queryStringParameters: spec.query ?? null,
    pathParameters: spec.pathParameters ?? null,
    requestContext: { accountId: "123456789012", apiId: "local", httpMethod: method, path, requestId: randomUUID(), stage: "dev" },
    body: spec.body == null ? null : asText(spec.body),
    isBase64Encoded: false,
  };
}

const sqs = (spec) => ({
  Records: (spec.records ?? [{}]).map((record) => ({
    messageId: randomUUID(),
    receiptHandle: "citrus-local",
    body: asText(record.body),
    attributes: { ApproximateReceiveCount: "1", SentTimestamp: String(Date.now()) },
    messageAttributes: record.messageAttributes ?? {},
    eventSource: "aws:sqs",
    eventSourceARN: `arn:aws:sqs:${REGION}:123456789012:${spec.queue ?? "cola"}`,
    awsRegion: REGION,
  })),
});

const sns = (spec) => ({
  Records: (spec.records ?? [{}]).map((record) => ({
    EventSource: "aws:sns",
    EventVersion: "1.0",
    Sns: {
      MessageId: randomUUID(),
      TopicArn: `arn:aws:sns:${REGION}:123456789012:${spec.topic ?? "tema"}`,
      Subject: record.subject,
      Message: asText(record.message),
      Timestamp: now(),
      MessageAttributes: record.messageAttributes ?? {},
    },
  })),
});

const s3 = (spec) => ({
  Records: (spec.records ?? [{}]).map((record) => ({
    eventVersion: "2.1",
    eventSource: "aws:s3",
    awsRegion: REGION,
    eventTime: now(),
    eventName: record.eventName ?? "ObjectCreated:Put",
    s3: {
      bucket: { name: record.bucket ?? "mi-bucket", arn: `arn:aws:s3:::${record.bucket ?? "mi-bucket"}` },
      object: { key: record.key ?? "archivo.txt", size: record.size ?? 1024 },
    },
  })),
});

const eventBridge = (spec) => ({
  version: "0",
  id: randomUUID(),
  "detail-type": spec.detailType ?? "Evento",
  source: spec.source ?? "mi.app",
  account: "123456789012",
  time: now(),
  region: REGION,
  resources: spec.resources ?? [],
  detail: spec.detail ?? {},
});

const dynamodb = (spec) => ({
  Records: (spec.records ?? [{}]).map((record) => ({
    eventID: randomUUID(),
    eventName: record.eventName ?? "INSERT",
    eventSource: "aws:dynamodb",
    awsRegion: REGION,
    dynamodb: { Keys: record.keys ?? {}, NewImage: record.newImage, OldImage: record.oldImage, StreamViewType: "NEW_AND_OLD_IMAGES" },
  })),
});

const schedule = () => ({
  version: "0",
  id: randomUUID(),
  "detail-type": "Scheduled Event",
  source: "aws.events",
  account: "123456789012",
  time: now(),
  region: REGION,
  resources: [`arn:aws:events:${REGION}:123456789012:rule/citrus`],
  detail: {},
});

const BUILDERS = { "apigw-v2": apiGatewayV2, "apigw-v1": apiGatewayV1, sqs, sns, s3, eventbridge: eventBridge, dynamodb, schedule };

/** Lo que aparece en el selector de plantillas de la UI: formato corto del YAML. */
export const EVENT_TEMPLATES = [
  { id: "apigw-v2", label: "API Gateway HTTP (v2)", example: { template: "apigw-v2", method: "POST", path: "/orders", body: { productId: 42 } } },
  { id: "apigw-v1", label: "API Gateway REST (v1)", example: { template: "apigw-v1", method: "GET", path: "/orders/1", pathParameters: { id: "1" } } },
  { id: "sqs", label: "SQS", example: { template: "sqs", records: [{ body: { orderId: "1001" } }] } },
  { id: "sns", label: "SNS", example: { template: "sns", records: [{ subject: "Aviso", message: { orderId: "1001" } }] } },
  { id: "s3", label: "S3", example: { template: "s3", records: [{ bucket: "mi-bucket", key: "facturas/1001.pdf" }] } },
  { id: "eventbridge", label: "EventBridge", example: { template: "eventbridge", source: "mi.app", detailType: "PedidoCreado", detail: { orderId: "1001" } } },
  { id: "dynamodb", label: "DynamoDB Streams", example: { template: "dynamodb", records: [{ eventName: "INSERT", keys: { id: { S: "1001" } } }] } },
  { id: "schedule", label: "Programado", example: { template: "schedule" } },
];

/** Convierte el formato corto en el evento que recibe el handler. Sin `template`, va tal cual. */
export function buildEvent(spec) {
  if (!spec || typeof spec !== "object" || !spec.template) return spec ?? {};
  const builder = Object.hasOwn(BUILDERS, spec.template) ? BUILDERS[spec.template] : null;
  return builder ? builder(spec) : spec;
}
