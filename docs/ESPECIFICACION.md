# Citrus — Especificación del producto

**Versión:** 0.1 · **Fecha:** 2026-11-06 · **Framework:** Tangarine

> **Citrus** es un cliente de APIs para backends serverless, construido con **Tangarine**. No solo manda requests HTTP: invoca Lambdas, muestra los logs de CloudWatch de cada invocación y enseña qué cambió en MySQL. Todo se guarda como archivos en Git, sin cuenta obligatoria.

---

## 1. Visión

Postman, Insomnia, Bruno y Hoppscotch responden bien "¿qué respondió el endpoint?". Ninguno responde "¿qué pasó adentro?": qué Lambda corrió, cuánto tardó, si hubo cold start, qué logueó y qué filas tocó en la base de datos.

Citrus junta en una sola pantalla request, respuesta, logs y cambios en la DB. Objetivo: que un developer serverless nunca tenga que abrir la consola de AWS ni un cliente MySQL para depurar un endpoint.

## 2. Problema

Hoy, para depurar un endpoint, un developer serverless:

1. Manda el request en Postman o Insomnia.
2. Abre la consola de AWS, busca el log group y filtra por hora hasta encontrar la invocación.
3. Abre un cliente MySQL y revisa a mano qué filas cambiaron.
4. Para eventos no HTTP (SQS, S3, EventBridge), arma el JSON del evento a mano y lo invoca desde la AWS CLI.

Son cuatro herramientas y mucho copiar y pegar. Además, Postman se volvió dependiente de la nube y exige cuenta.

## 3. Usuario objetivo

- **Principal:** developers backend con Node.js + AWS Lambda (Serverless Framework, SAM o CDK) + MySQL/Aurora.
- **Secundario:** equipos de 2 a 15 devs que quieren colecciones versionadas en Git y revisadas en PRs.
- **Terciario:** developers que trabajan con agentes de IA y quieren que el agente pruebe sus APIs vía MCP.

## 4. Diferenciadores

| Capacidad | Postman | Insomnia | Bruno | Hoppscotch | **Citrus** |
|---|---|---|---|---|---|
| Cliente HTTP / REST / GraphQL | Sí | Sí | Sí | Sí | **Sí** |
| Colecciones como archivos en Git | No | Parcial | Sí | No | **Sí** |
| Funciona sin cuenta ni internet | No | Parcial | Sí | Parcial | **Sí** |
| Invocar Lambda directo con eventos (SQS, S3, EventBridge) | No | No | No | No | **Sí** |
| Logs de CloudWatch junto a la respuesta | No | No | No | No | **Sí** |
| Cold start, duración y memoria por request | No | No | No | No | **Sí** |
| Diff de filas MySQL antes/después del request | No | No | No | No | **Sí** |
| Import desde `serverless.yml` / SAM / CDK | No | No | No | No | **Sí** |
| Servidor MCP para agentes de IA | Parcial | No | No | No | **Sí** |

Las primeras tres filas son la base que el mercado espera. Las seis siguientes son la propuesta de valor.

## 5. Funcionalidades

### 5.1 Base (paridad con el mercado)

- Requests HTTP: métodos, headers, query params, body (JSON, form, multipart, raw, binario).
- Auth: Bearer, Basic, API Key, AWS SigV4, OAuth 2.0.
- Entornos (`local`, `dev`, `staging`, `prod`) con variables y herencia.
- Variables secretas que nunca se guardan en el repo (ver sección 8).
- Scripts pre-request y post-response en JavaScript, en sandbox.
- Assertions sobre status, headers, body (JSONPath) y tiempo de respuesta.
- Historial local de requests.
- Import: Postman, Insomnia, OpenAPI 3.x, cURL. Export: cURL, `fetch`, `axios`.
- GraphQL con introspección y autocompletado.
- Timings detallados: DNS, TCP, TLS, TTFB, descarga.

### 5.2 Invocación directa de Lambda

- Invoca una función por nombre o ARN, sin pasar por API Gateway.
- Plantillas de eventos: API Gateway v1 y v2, SQS, SNS, S3, EventBridge, DynamoDB Streams, eventos programados.
- Dos modos:
  - **local:** corre el handler en un proceso Node con el evento y variables del entorno.
  - **remoto:** usa `Invoke` del AWS SDK.
- Muestra: payload devuelto, `FunctionError` si hubo, duración, duración facturada, memoria usada y cold start (`Init Duration`).

### 5.3 Logs junto a la respuesta

- Cada request a API Gateway o Lambda captura el `requestId` (headers de respuesta o resultado de `Invoke`).
- Citrus consulta CloudWatch Logs Insights filtrando por ese `requestId`.
- Los logs aparecen en una pestaña al lado de la respuesta.
- Logs JSON (pino, Powertools) se muestran con niveles, colores y campos expandibles.
- Si X-Ray está activo, enlaza a la traza.
- Indicador de "esperando logs" con polling, porque CloudWatch puede tardar unos segundos.

### 5.4 Diff de MySQL

- Una conexión de DB por entorno: local, túnel SSH o RDS Proxy.
- Por request, el usuario elige qué tablas observar, o Citrus las infiere.
- **Modo snapshot:** foto de las filas relevantes antes y después del request, y comparación. Funciona en cualquier DB, pero solo con tablas chicas o filtradas por `WHERE`.
- **Modo binlog (avanzado):** lee el binlog (`binlog_format = ROW`) durante el request y muestra exactamente los `INSERT`, `UPDATE` y `DELETE`. Requiere permisos de replicación.
- Vista de diff por tabla: filas nuevas en verde, borradas en rojo, campos cambiados resaltados.
- Conexión de solo lectura por defecto.

### 5.5 Import automático del proyecto

- Lee `serverless.yml`, `template.yaml` (SAM) o el output de `cdk synth`.
- Genera una carpeta por función y un request por cada evento `http` / `httpApi`, con método, path y path params.
- Convierte los stages en entornos.
- Si hay OpenAPI, completa bodies de ejemplo y valida respuestas contra el schema.
- Modo watch: detecta cambios en el archivo y propone agregar endpoints nuevos.

### 5.6 Flujos y tests

- Requests encadenados: la salida de uno pasa como variable al siguiente (ej.: login y luego crear pedido).
- Assertions de DB: ej. existe una fila en `orders` con `status = 'paid'`.
- Assertions de logs: ej. el request no loguea ningún `ERROR`.
- Assertions de rendimiento: ej. duración de Lambda < 500 ms, sin cold start después del primer request.

### 5.7 CLI

- `citrus run ./collections/orders --env staging` corre una colección o carpeta.
- Reportes: consola, JSON, JUnit XML (GitHub Actions, GitLab CI).
- Exit code distinto de 0 si falla alguna assertion.
- Distribución por npm: `npx citrus run ...`.

### 5.8 Servidor MCP

- `citrus mcp` levanta un servidor MCP que expone las colecciones.
- Herramientas: `list_requests`, `run_request`, `run_collection`, `get_logs`, `get_db_diff`.
- Un agente (Claude Code, Cursor, etc.) prueba el endpoint que acaba de modificar y valida su cambio con logs y diff.
- Mismos permisos que la app: el agente no puede usar entornos `protected` salvo activación explícita.

## 6. Formato de archivos

Cada request es un YAML legible, pensado para revisarse en PRs.

```
citrus/
  citrus.config.yaml
  environments/
    dev.yaml
    staging.yaml
  collections/
    orders/
      create-order.citrus.yaml
      get-order.citrus.yaml
    workers/
      process-payment.sqs.citrus.yaml
```

### Request HTTP con observación de logs y DB

```yaml
name: Crear pedido
method: POST
url: "{{baseUrl}}/orders"
headers:
  Authorization: "Bearer {{token}}"
body:
  json:
    productId: 42
    quantity: 2
observe:
  logs: true
  lambda: orders-service-{{stage}}-createOrder
  db:
    connection: main
    tables: [orders, order_items]
assert:
  - status == 201
  - body.id exists
  - db.orders.inserted == 1
  - logs.errors == 0
  - lambda.duration < 500
capture:
  lastOrderId: body.id
```

### Evento SQS invocado directo

```yaml
name: Procesar pago
type: lambda
function: payments-{{stage}}-processPayment
mode: remote
event:
  template: sqs
  records:
    - body:
        orderId: "{{lastOrderId}}"
        amount: 120000
assert:
  - result.batchItemFailures.length == 0
```

### Entorno

```yaml
name: staging
protected: false
variables:
  baseUrl: https://api-staging.example.com
  stage: staging
secrets:
  - token
aws:
  profile: mi-perfil
  region: us-east-1
db:
  main:
    host: staging-proxy.xxxx.rds.amazonaws.com
    database: app
    user: citrus_readonly
    passwordSecret: dbPassword
    mode: snapshot
```

## 7. Arquitectura

Citrus está construido con **Tangarine**, que es la base de la aplicación.

### Capas

- **Shell de escritorio:** Electron (todo en Node.js).
- **App (Tangarine):** UI, estado, pestañas, colecciones, plugins.
- **Motor `@citrus/core`:** paquete Node.js sin UI, compartido por app, CLI y MCP.
  - `http`: requests con `undici` y timings.
  - `lambda`: invocación local y remota con `@aws-sdk/client-lambda`.
  - `logs`: consultas con `@aws-sdk/client-cloudwatch-logs`.
  - `db`: snapshots con `mysql2`; binlog con `@vlasky/zongji` o similar.
  - `importers`: Serverless Framework, SAM, CDK, OpenAPI, Postman, Insomnia, cURL.
  - `runner`: flujos, variables, captures, assertions.
  - `sandbox`: scripts del usuario en `isolated-vm`, nunca en el proceso principal.
- **Editor:** Monaco (bodies, scripts, YAML).
- **CLI `citrus`:** usa `@citrus/core` sin UI.
- **MCP `citrus mcp`:** `@citrus/core` + `@modelcontextprotocol/sdk`.

### Estructura del monorepo

```
citrus/
  packages/
    core/        # @citrus/core
    cli/         # citrus (bin)
    mcp/         # servidor MCP
    app/         # app de escritorio (Tangarine + Electron)
  examples/
    serverless-mysql-demo/
  docs/
```

### Credenciales AWS

Cadena estándar del SDK: perfiles de `~/.aws`, SSO, variables de entorno. Citrus nunca guarda llaves AWS propias.

## 8. Seguridad

- **Secretos:** las variables `secret` se guardan en el llavero del sistema (Keychain, Credential Manager, libsecret). En el YAML solo queda el nombre, nunca el valor.
- **`.gitignore` automático** para secretos locales e historial.
- **DB de solo lectura por defecto.** Snapshot solo ejecuta `SELECT`. Para binlog se recomienda un usuario con `REPLICATION SLAVE` y `REPLICATION CLIENT`, sin permisos de escritura.
- **Entornos `protected`:** piden confirmación antes de requests que no sean `GET`. El MCP no puede usarlos salvo activación explícita.
- **Sandbox de scripts:** sin acceso a sistema de archivos ni red, salvo por la API de Citrus.
- **Sin telemetría por defecto.** Si se agrega, es opt-in y anónima.

## 9. Roadmap

| Fase | Alcance | Resultado |
|---|---|---|
| **0. Fundación** | Monorepo, Tangarine + Electron, `@citrus/core`, formato YAML | La app abre y lee una colección |
| **1. Cliente base** | HTTP, entornos, variables, secretos, historial, import cURL y Postman | Reemplazo de Postman para lo básico |
| **2. Serverless** | Import `serverless.yml` / SAM, Lambda local y remota, plantillas de eventos | Primer diferenciador |
| **3. Observabilidad** | Logs CloudWatch por `requestId`, duración, cold start | El momento "wow" |
| **4. Base de datos** | Diff MySQL (snapshot, luego binlog), assertions de DB | Diferenciador único |
| **5. Automatización** | CLI, JUnit, flujos encadenados | Entra a CI |
| **6. Agentes** | Servidor MCP | Listo para flujos con IA |

Lanzamiento público recomendado al cerrar la fase 3, con una demo corta: un request y, en la misma pantalla, respuesta, logs y cold start.

## 10. Modelo de negocio

- **Gratis y open source (MIT):** app completa para uso individual, CLI y MCP.
- **Pro (individual):** sync cifrado entre máquinas, historial ilimitado, binlog avanzado.
- **Team:** entornos compartidos con secretos gestionados, workspace de equipo, roles, auditoría.
- Referencia de mercado: Bruno Pro ~6 USD/usuario/mes; Insomnia ~12 USD/usuario/mes.

## 11. Métricas de éxito

- Estrellas en GitHub y descargas semanales de npm.
- Usuarios activos semanales (solo con opt-in).
- % de usuarios que conectan AWS y % que conectan MySQL.
- Tiempo desde instalación hasta el primer request con logs visibles: objetivo < 5 minutos.

## 12. Riesgos

- **Mercado saturado de clientes HTTP.** Mitigación: posicionarse como "el cliente para serverless", no como "otro Postman".
- **Latencia de CloudWatch Logs.** Mitigación: polling con indicador y Live Tail cuando esté disponible.
- **Binlog complejo en RDS/Aurora.** Mitigación: lanzar primero snapshot y documentar la configuración de binlog.
- **Alcance grande para una persona.** Mitigación: respetar el orden del roadmap.
- **Dependencia de AWS.** Mitigación: `lambda` y `logs` como adaptadores, para sumar después Vercel, Cloudflare Workers o GCP.

## 13. Fuera de alcance (v1)

- PostgreSQL y otras bases de datos.
- Proveedores cloud distintos de AWS.
- Mock servers.
- Extensión de VS Code.
