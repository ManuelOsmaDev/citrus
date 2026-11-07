import path from "node:path";
import YAML from "yaml";
import { CitrusError } from "../errors.js";
import { emptyModel } from "../model.js";

// Etiquetas de CloudFormation: solo importa que no rompan la lectura del archivo.
const CFN_TAGS = ["Ref", "Sub", "GetAtt", "Join", "If", "Select", "Split", "ImportValue", "FindInMap", "Equals", "Not", "And", "Or", "Base64", "Cidr", "GetAZs", "Condition", "Transform"].flatMap((name) => [
  { tag: `!${name}`, identify: () => false, resolve: (value) => `<${name} ${value}>` },
  { tag: `!${name}`, collection: "seq", identify: () => false, resolve: () => `<${name}>` },
  { tag: `!${name}`, collection: "map", identify: () => false, resolve: () => `<${name}>` },
]);

const isPlain = (value) => typeof value === "string" && !value.includes("${") && !value.startsWith("<");

function pathToTemplate(route, variables) {
  return String(route).replace(/\{(\w+)\+?\}/g, (_, name) => {
    variables[name] = "1";
    return `{{${name}}}`;
  });
}

function httpRequest({ fn, method, route, service, variables }) {
  const verb = !method || method === "*" || method === "ANY" ? "GET" : method.toUpperCase();
  const clean = String(route ?? "/").startsWith("/") ? route : `/${route}`;
  const model = emptyModel(`${verb} ${clean}`);
  model.method = verb;
  model.url = `{{baseUrl}}${pathToTemplate(clean, variables)}`;
  if (["POST", "PUT", "PATCH"].includes(verb)) model.body = { mode: "json", text: "{}", rows: [], file: "" };
  return { folder: [fn], name: model.name, model, extra: { observe: { logs: true, lambda: `${service}-{{stage}}-${fn}` } } };
}

function lambdaRequest({ fn, label, handler, cwd, service, event }) {
  return {
    folder: [fn],
    name: label,
    model: {
      type: "lambda",
      name: label,
      function: `${service}-{{stage}}-${fn}`,
      mode: "local",
      handler,
      cwd,
      eventText: JSON.stringify(event, null, 2),
      assert: [],
      capture: [],
    },
  };
}

function fromServerless(doc, cwd, warnings) {
  const service = isPlain(doc.service) ? doc.service : (isPlain(doc.service?.name) ? doc.service.name : "servicio");
  const requests = [];
  const variables = {};
  if (typeof doc.functions === "string" || Array.isArray(doc.functions)) {
    warnings.push("`functions` apunta a otros archivos. Citrus aún no los sigue: declara las funciones en este archivo.");
  }
  for (const [fn, def] of Object.entries(typeof doc.functions === "object" && !Array.isArray(doc.functions) ? doc.functions ?? {} : {})) {
    const handler = def?.handler;
    const events = Array.isArray(def?.events) ? def.events : [];
    let firstHttp = null;
    const others = [];
    for (const item of events) {
      const http = item.http ?? item.httpApi;
      if (http !== undefined) {
        let method;
        let route;
        if (typeof http === "string") {
          const parts = http.trim().split(/\s+/);
          method = parts.length > 1 ? parts[0] : "*";
          route = parts.length > 1 ? parts[1] : parts[0] === "*" ? "/" : parts[0];
        } else {
          method = http.method;
          route = http.path;
        }
        requests.push(httpRequest({ fn, method, route, service, variables }));
        firstHttp ??= { method, route };
      } else if (item.sqs !== undefined) others.push(["SQS", { template: "sqs", records: [{ body: {} }] }]);
      else if (item.sns !== undefined) others.push(["SNS", { template: "sns", records: [{ message: {} }] }]);
      else if (item.s3 !== undefined) others.push(["S3", { template: "s3", records: [{ bucket: isPlain(item.s3?.bucket ?? item.s3) ? item.s3?.bucket ?? item.s3 : "mi-bucket", key: "archivo.txt" }] }]);
      else if (item.schedule !== undefined) others.push(["Programado", { template: "schedule" }]);
      else if (item.eventBridge !== undefined) others.push(["EventBridge", { template: "eventbridge", detail: {} }]);
      else if (item.stream !== undefined) others.push(["DynamoDB", { template: "dynamodb", records: [{}] }]);
      else warnings.push(`${fn}: el evento '${Object.keys(item)[0]}' no se importó.`);
    }
    if (!handler) {
      warnings.push(`${fn}: no tiene handler.`);
      continue;
    }
    if (firstHttp) {
      const verb = !firstHttp.method || firstHttp.method === "*" ? "GET" : firstHttp.method.toUpperCase();
      others.unshift(["Lambda directa", { template: "apigw-v2", method: verb, path: firstHttp.route }]);
    }
    if (!others.length) others.push(["Lambda directa", {}]);
    for (const [label, event] of others) requests.push(lambdaRequest({ fn, label: `${fn} · ${label}`, handler, cwd, service, event }));
  }
  const provider = doc.provider ?? {};
  const stage = isPlain(provider.stage) ? provider.stage : "dev";
  const aws = { region: isPlain(provider.region) ? provider.region : "us-east-1", ...(isPlain(provider.profile) ? { profile: provider.profile } : {}) };
  return { kind: "Serverless Framework", name: service, requests, variables, stage, aws };
}

function fromSam(doc, cwd, warnings) {
  const requests = [];
  const variables = {};
  const service = "sam";
  const defaults = doc.Globals?.Function ?? {};
  for (const [fn, resource] of Object.entries(doc.Resources ?? {})) {
    if (resource?.Type !== "AWS::Serverless::Function") continue;
    const props = resource.Properties ?? {};
    const handlerName = props.Handler ?? defaults.Handler;
    const codeUri = isPlain(props.CodeUri ?? defaults.CodeUri) ? props.CodeUri ?? defaults.CodeUri : "";
    const others = [];
    let firstHttp = null;
    for (const [, event] of Object.entries(props.Events ?? {})) {
      const p = event?.Properties ?? {};
      switch (event?.Type) {
        case "Api":
        case "HttpApi":
          requests.push(httpRequest({ fn, method: p.Method, route: p.Path ?? "/", service, variables }));
          firstHttp ??= { method: p.Method, route: p.Path ?? "/", v1: event.Type === "Api" };
          break;
        case "SQS": others.push(["SQS", { template: "sqs", records: [{ body: {} }] }]); break;
        case "SNS": others.push(["SNS", { template: "sns", records: [{ message: {} }] }]); break;
        case "S3": others.push(["S3", { template: "s3", records: [{ key: "archivo.txt" }] }]); break;
        case "Schedule":
        case "ScheduleV2": others.push(["Programado", { template: "schedule" }]); break;
        case "EventBridgeRule":
        case "CloudWatchEvent": others.push(["EventBridge", { template: "eventbridge", detail: {} }]); break;
        case "DynamoDB": others.push(["DynamoDB", { template: "dynamodb", records: [{}] }]); break;
        default: warnings.push(`${fn}: el evento '${event?.Type}' no se importó.`);
      }
    }
    if (!isPlain(handlerName)) {
      warnings.push(`${fn}: no tiene un Handler que se pueda leer.`);
      continue;
    }
    const handler = codeUri ? path.posix.join(codeUri.replace(/\\/g, "/"), handlerName) : handlerName;
    if (firstHttp) {
      const verb = !firstHttp.method || firstHttp.method.toLowerCase() === "any" ? "GET" : firstHttp.method.toUpperCase();
      others.unshift(["Lambda directa", { template: firstHttp.v1 ? "apigw-v1" : "apigw-v2", method: verb, path: firstHttp.route }]);
    }
    if (!others.length) others.push(["Lambda directa", {}]);
    for (const [label, event] of others) requests.push(lambdaRequest({ fn, label: `${fn} · ${label}`, handler, cwd, service, event }));
  }
  return { kind: "AWS SAM", name: "sam", requests, variables, stage: "dev", aws: { region: "us-east-1" } };
}

/**
 * Lee un serverless.yml o un template.yaml de SAM.
 * @param {string} text contenido del archivo
 * @param {string} cwd carpeta del proyecto, relativa al workspace
 */
export function importServerless(text, cwd = ".") {
  const parsed = YAML.parseDocument(text, { customTags: CFN_TAGS, logLevel: "silent" });
  if (parsed.errors.length) throw new CitrusError("BAD_YAML", `El archivo no es YAML válido: ${parsed.errors[0].message}`);
  const doc = parsed.toJS();
  const warnings = [];
  const isSam = doc?.Resources && Object.values(doc.Resources).some((r) => r?.Type === "AWS::Serverless::Function");
  let out;
  if (isSam) out = fromSam(doc, cwd, warnings);
  else if (doc?.functions !== undefined) out = fromServerless(doc, cwd, warnings);
  else throw new CitrusError("NOT_SERVERLESS", "No encontré `functions` de Serverless ni funciones de SAM en ese archivo.");
  if (!out.requests.length) warnings.push("No encontré funciones para importar.");
  const environment = {
    id: out.stage,
    variables: { baseUrl: "http://localhost:3000", stage: out.stage, ...out.variables },
    aws: out.aws,
  };
  return { ...out, environment, warnings };
}
