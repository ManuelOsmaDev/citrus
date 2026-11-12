# Citrus

Cliente de APIs para backends serverless, construido con [Tangerine](https://www.npmjs.com/package/tangerine-lang). Tus colecciones son archivos YAML en Git, sin cuenta y sin nube.

Estado: **fases 0, 1, 3 y 4, y la mayor parte de la 2**. Faltan la CLI y el MCP. Ver [docs/ESPECIFICACION.md](docs/ESPECIFICACION.md).

## Empezar

Instalador para Windows, sin Node:

```bash
npm run dist
```

Genera `packages/app/release/Citrus-Setup-0.2.0.exe`. `npm run test:instalado -w @citrus/app` lo instala de verdad, lo usa contra la demo y lo desinstala. No está firmado: Windows SmartScreen muestra un aviso al abrirlo.

Los instaladores que se publican los compila GitHub Actions con `.github/workflows/compilar.yml` al subir una etiqueta `v*`. Ver la [Code signing policy](docs/FIRMA.md).

Desde el código:

```bash
npm install
npm start
```

Para probar la demo sin internet, levanta la API de ejemplo en otra terminal y elige **Probar la demo** en la app:

```bash
npm run demo:api
```

La request `Crear pedido` necesita el secreto `token`. Defínelo en el icono de entornos, con cualquier valor.

La API de demo levanta además un MySQL temporal, que se descarga la primera vez, y simula CloudWatch y Lambda: logs y diff se ven sin cuenta de AWS. Para usar tu AWS real, quita `aws.endpoint` de `environments/dev.yaml`.

## Qué hace hoy

Lo que otros clientes no traen:

- **Lambda desde la app.** Corre tu handler en local con eventos reales (API Gateway, SQS, SNS, S3, EventBridge, DynamoDB) o invócalo en AWS. Ves payload, logs por nivel, duración, memoria y cold start.
- **Logs junto a la respuesta.** Tras cada envío, Citrus busca la invocación en CloudWatch y muestra sus logs, duración, memoria y cold start. Los `assert` de `logs.*` y `lambda.*` se evalúan cuando llegan.
- **Qué cambió en MySQL.** Muestra las filas nuevas, las borradas y cada campo cambiado por request, por foto antes y después o leyendo el binlog. `db.orders.inserted == 1` y `db.orders.new[status=paid] exists` son tests.
- **Importa tu proyecto.** Lee `serverless.yml` o un template de SAM y crea requests, Lambdas y el entorno.
- **Detector de secretos.** Al guardar, avisa si hay un JWT, una clave de AWS o un token en el archivo, y lo mueve al llavero.
- **Tests en el YAML.** `assert:` y `capture:` se ejecutan, y se generan con un clic desde la respuesta.
- **Cambios entre envíos.** Compara cada respuesta con la anterior.
- **Flujos.** Corre una carpeta completa: lo que una request captura, lo usa la siguiente.
- **Paleta de comandos.** `Ctrl+K` lleva a cualquier request o acción.

La base:

- Requests HTTP: JSON, form, multipart, raw y binario, con Bearer, Basic y API Key.
- Tiempos reales por fase: DNS, TCP, TLS, espera y descarga.
- Entornos con variables, herencia y confirmación en los protegidos.
- Secretos en el llavero del sistema. En el YAML solo queda el nombre.
- Historial local, sin headers ni bodies.
- Importa cURL y Postman v2.x. Copia como cURL, fetch o axios sin revelar secretos.
- Al guardar respeta comentarios y campos que la UI no edita, como `observe`.

Atajos: `Ctrl+Enter` envía, `Ctrl+S` guarda, `Ctrl+K` abre la paleta, `Ctrl+W` cierra la pestaña.

### Cómo encuentra los logs

Citrus usa `FilterLogEvents`, no Logs Insights: no cobra por GB escaneado y trae también las líneas que no llevan el id. Con el id de la respuesta o la traza de X-Ray ubica la invocación, y lee su stream entre `START` y `REPORT`. Si la respuesta no trae ningún id en común y hubo una sola invocación en ese momento, la muestra marcada como aproximada. Si hubo varias, te deja elegir.

Tu usuario necesita el permiso `logs:FilterLogEvents`.

### Sobre la base de datos

Snapshot solo ejecuta `SELECT`, en una transacción `READ ONLY`, y funciona con cualquier MySQL, pero solo con tablas de hasta `maxRows` filas (5000 por defecto) o filtradas con `where`. Binlog necesita `binlog_format = ROW` y un usuario con `REPLICATION SLAVE` y `REPLICATION CLIENT`. Fuera de esta máquina la conexión exige TLS; `ssl: false` lo desactiva. Para un túnel SSH, ábrelo con `ssh -L` y apunta a localhost.

### Sobre correr código local

Invocar un handler en local ejecuta código del proyecto con las variables y secretos del entorno. Citrus pregunta una vez por carpeta antes de hacerlo. Da tu confianza solo a proyectos que conozcas.

## Estructura

```
packages/core/   @citrus/core: motor en Node.js, sin UI
packages/app/    App de escritorio
  main/          Proceso principal de Electron (disco, red, llavero)
  ui/src/        Interfaz en Tangerine (.tng), más bridge.js para IPC y Monaco
packages/site/   Página del proyecto, también en Tangerine
examples/        Workspace de demo y su API local
```

La UI corre aislada (`sandbox`, `contextIsolation` y un CSP con hashes) y solo habla con el proceso principal por una lista cerrada de métodos.

## Página

```bash
npm run site
```

Genera un sitio estático en `packages/site/dist`, listo para subir. Si ya corriste `npm run dist`, incluye el instalador con su tamaño y SHA-256. Pesa más de 80 MB y algunos hostings limitan el tamaño por archivo; en ese caso súbelo aparte y construye con `CITRUS_DOWNLOAD_URL=https://…/Citrus-Setup-0.1.0.exe`. Cuando el código esté publicado, pon su URL en `REPO_URL`, al inicio de `packages/site/src/main.tng`.

## Pruebas

```bash
npm test
```

```bash
npm run test:e2e
```

`npm run test:db` prueba snapshot y binlog contra un MySQL real y temporal. `npm test` prueba el motor, incluido el llavero real. `test:e2e` abre la app de Electron y la usa contra la API de demo.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Qué se firma, quién lo aprueba y qué datos envía Citrus: [docs/FIRMA.md](docs/FIRMA.md).
