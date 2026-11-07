import { CitrusError } from "./errors.js";
import { interpolate, maskSecrets } from "./variables.js";

const DEFAULT_MAX_ROWS = 5000;
const ROWS_SHOWN = 200;
const CONNECT_TIMEOUT_MS = 5000;
const VALID_NAME = /^[\w$]+$/;
const VAR = /\{\{\s*([\w.$-]+)\s*\}\}/g;
/** Cosas que un SELECT de solo lectura igual podría hacer: escribir archivos, esperar o leer de disco. */
const FORBIDDEN_WHERE = /;|\b(into|outfile|dumpfile|union|sleep|benchmark|load_file|for\s+update|lock\s+in)\b/i;
const BINLOG_QUIET_MS = 400;
const BINLOG_MAX_WAIT_MS = 3000;
const BINLOG_READY_TIMEOUT_MS = 8000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** TLS por defecto fuera de esta máquina: la contraseña no debe viajar en claro. */
export function sslFor(conn) {
  if (conn.ssl === false) return undefined;
  if (conn.ssl && conn.ssl !== true) return conn.ssl;
  if (LOCAL_HOSTS.has(conn.host) && conn.ssl !== true) return undefined;
  if (/\.rds\.amazonaws\.com$/i.test(conn.host)) return "Amazon RDS";
  return { rejectUnauthorized: true };
}

/** Resuelve una conexión del entorno: variables, puerto y contraseña del llavero. */
export function resolveConnection(env, name) {
  const cfg = env.db?.[name];
  if (!cfg) {
    throw new CitrusError("DB_NOT_FOUND", env.db ? `El entorno no tiene la conexión '${name}'.` : "Elige un entorno con el bloque db.");
  }
  const missing = new Set();
  const conn = {
    name,
    host: interpolate(cfg.host ?? "127.0.0.1", env.scope, missing),
    port: Number(cfg.port ?? 3306),
    database: interpolate(cfg.database ?? "", env.scope, missing),
    user: interpolate(cfg.user ?? "", env.scope, missing),
    mode: cfg.mode === "binlog" ? "binlog" : "snapshot",
    maxRows: Number(cfg.maxRows) > 0 ? Number(cfg.maxRows) : DEFAULT_MAX_ROWS,
    ssl: cfg.ssl,
  };
  if (missing.size) throw new CitrusError("MISSING_VARS", `Faltan variables en la conexión: ${[...missing].join(", ")}.`);
  if (!conn.database) throw new CitrusError("BAD_DB", `La conexión '${name}' no indica database.`);
  if (cfg.passwordSecret) {
    if (!env.scope.has(cfg.passwordSecret)) {
      throw new CitrusError("MISSING_VARS", `Falta el valor del secreto '${cfg.passwordSecret}' de la conexión '${name}'.`);
    }
    conn.password = env.scope.get(cfg.passwordSecret);
  }
  return conn;
}

function friendlyDbError(err, conn) {
  if (err instanceof CitrusError) return err;
  const code = err?.code ?? "DB_ERROR";
  const known = {
    ECONNREFUSED: `MySQL rechazó la conexión en ${conn.host}:${conn.port}. ¿Está corriendo, o el túnel abierto?`,
    ENOTFOUND: `No se encontró el host ${conn.host}.`,
    ETIMEDOUT: `${conn.host}:${conn.port} no respondió a tiempo.`,
    ER_ACCESS_DENIED_ERROR: `MySQL rechazó al usuario '${conn.user}'. Revisa el usuario y la contraseña.`,
    ER_BAD_DB_ERROR: `No existe la base '${conn.database}'.`,
    ER_DBACCESS_DENIED_ERROR: `El usuario '${conn.user}' no tiene acceso a '${conn.database}'.`,
    ER_NO_SUCH_TABLE: "La tabla no existe.",
    ER_TABLEACCESS_DENIED_ERROR: `El usuario '${conn.user}' no puede leer esa tabla.`,
    ER_SPECIFIC_ACCESS_DENIED_ERROR: `El usuario '${conn.user}' necesita REPLICATION SLAVE y REPLICATION CLIENT para leer el binlog.`,
    ER_NO_BINARY_LOGGING: "Este MySQL no tiene el binlog activo.",
  };
  return new CitrusError(code, known[code] ?? `MySQL respondió: ${err?.message ?? err}`);
}

async function open(conn) {
  const mysql = await import("mysql2/promise");
  try {
    return await mysql.createConnection({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ssl: sslFor(conn),
    });
  } catch (err) {
    throw friendlyDbError(err, conn);
  }
}

/** Una celda como texto o null: es lo que se compara y lo que se muestra. */
function cell(value, mask) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.length > 64 ? `0x${value.subarray(0, 64).toString("hex")}… (${value.length} bytes)` : `0x${value.toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return mask(text);
}

const normalizeRow = (row, mask) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v, mask)]));

function renderWhere(where, scope, escape) {
  const template = String(where);
  if (FORBIDDEN_WHERE.test(template)) {
    throw new CitrusError("BAD_WHERE", `Este WHERE no se permite: ${template}`);
  }
  return template.replace(VAR, (whole, name) => {
    if (!scope.has(name)) throw new CitrusError("MISSING_VARS", `Falta la variable ${name} en el WHERE.`);
    // Un valor capturado viene de un servidor: siempre va escapado, nunca como SQL.
    return escape(scope.get(name));
  });
}

async function primaryKey(c, database, table) {
  const [rows] = await c.query(
    "SELECT COLUMN_NAME AS col FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
    [database, table],
  );
  return rows.map((r) => r.col);
}

/** Sin `tables` en el YAML se toman las tablas chicas de la base. Las grandes se reportan. */
async function inferTables(c, conn) {
  const [rows] = await c.query(
    "SELECT TABLE_NAME AS name, TABLE_ROWS AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [conn.database],
  );
  const small = rows.filter((r) => Number(r.total ?? 0) <= conn.maxRows).map((r) => ({ name: r.name }));
  const skipped = rows.filter((r) => Number(r.total ?? 0) > conn.maxRows).map((r) => r.name);
  return { tables: small, skipped };
}

export function normalizeTables(list) {
  return (Array.isArray(list) ? list : []).map((t) => {
    const spec = typeof t === "string" ? { name: t } : { name: String(t?.name ?? ""), where: t?.where };
    if (!VALID_NAME.test(spec.name)) throw new CitrusError("BAD_TABLE", `Nombre de tabla inválido: ${spec.name}`);
    return spec;
  });
}

/** Foto de las tablas, en una transacción de solo lectura para que todas sean del mismo instante. */
export async function takeSnapshot(conn, specs, scope, mask) {
  const c = await open(conn);
  try {
    await c.query("START TRANSACTION READ ONLY");
    let tables = specs;
    let skipped = [];
    if (!tables.length) ({ tables, skipped } = await inferTables(c, conn));
    const out = {};
    for (const spec of tables) {
      try {
        const pk = await primaryKey(c, conn.database, spec.name);
        const where = spec.where ? ` WHERE (${renderWhere(spec.where, scope, (v) => c.escape(v))})` : "";
        const order = pk.length ? ` ORDER BY ${pk.map((k) => c.escapeId(k)).join(", ")}` : "";
        const [rows, fields] = await c.query(`SELECT * FROM ${c.escapeId(spec.name)}${where}${order} LIMIT ${conn.maxRows + 1}`);
        if (rows.length > conn.maxRows) {
          throw new CitrusError("TOO_MANY_ROWS", `Tiene más de ${conn.maxRows} filas. Agrega un WHERE o usa el modo binlog.`);
        }
        out[spec.name] = { pk, columns: fields.map((f) => f.name), rows: rows.map((r) => normalizeRow(r, mask)) };
      } catch (err) {
        out[spec.name] = { error: friendlyDbError(err, conn).message };
      }
    }
    await c.query("COMMIT");
    return { tables: out, skipped };
  } catch (err) {
    throw friendlyDbError(err, conn);
  } finally {
    await c.end().catch(() => {});
  }
}

const rowKey = (row, pk) => JSON.stringify(pk.map((k) => row[k]));

/** Con clave primaria detecta cambios por campo. Sin ella, una fila editada es un borrado y un alta. */
export function diffTable(name, before, after) {
  const failed = after?.error ?? before?.error;
  if (failed) return { name, error: failed, inserted: [], updated: [], deleted: [], columns: [], pk: [] };
  const pk = after.pk.length ? after.pk : [];
  const columns = after.columns;
  const inserted = [];
  const updated = [];
  const deleted = [];
  if (pk.length) {
    const old = new Map(before.rows.map((r) => [rowKey(r, pk), r]));
    for (const row of after.rows) {
      const key = rowKey(row, pk);
      const prev = old.get(key);
      if (!prev) inserted.push(row);
      else {
        const changed = columns.filter((col) => prev[col] !== row[col]);
        if (changed.length) updated.push({ before: prev, after: row, changed });
        old.delete(key);
      }
    }
    deleted.push(...old.values());
  } else {
    const counts = new Map();
    for (const row of before.rows) {
      const key = JSON.stringify(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const row of after.rows) {
      const key = JSON.stringify(row);
      if (counts.get(key) > 0) counts.set(key, counts.get(key) - 1);
      else inserted.push(row);
    }
    for (const row of before.rows) {
      const key = JSON.stringify(row);
      if (counts.get(key) > 0) {
        counts.set(key, counts.get(key) - 1);
        deleted.push(row);
      }
    }
  }
  return { name, pk, columns, inserted, updated, deleted };
}

/** Separa lo que ve la UI (con tope de filas) de lo que leen los assert (conteos reales). */
function present(connection, mode, tables, skipped) {
  const limited = tables.map((t) => ({
    ...t,
    inserted: t.inserted.slice(0, ROWS_SHOWN),
    updated: t.updated.slice(0, ROWS_SHOWN),
    deleted: t.deleted.slice(0, ROWS_SHOWN),
    counts: { inserted: t.inserted.length, updated: t.updated.length, deleted: t.deleted.length },
  }));
  const changes = tables.reduce((n, t) => n + t.inserted.length + t.updated.length + t.deleted.length, 0);
  const ctx = {};
  for (const t of tables) {
    if (t.error) continue;
    ctx[t.name] = {
      inserted: t.inserted.length,
      updated: t.updated.length,
      deleted: t.deleted.length,
      changed: t.inserted.length + t.updated.length + t.deleted.length,
      new: [...t.inserted, ...t.updated.map((u) => u.after)],
      removed: t.deleted,
    };
  }
  return { public: { connection, mode, tables: limited, skipped, changes }, ctx };
}

/** Lee el binlog mientras corre la request: ve cada escritura, sin tope de filas. */
async function startBinlog(conn, specs, mask) {
  const control = await open(conn);
  let z;
  try {
    const [[vars]] = await control.query("SELECT @@log_bin AS logBin, @@binlog_format AS format, @@binlog_row_image AS image");
    if (Number(vars.logBin) !== 1) throw new CitrusError("ER_NO_BINARY_LOGGING", "Este MySQL no tiene el binlog activo. En RDS y Aurora se activa con backups y un parameter group.");
    if (vars.format !== "ROW") throw new CitrusError("BINLOG_FORMAT", `El modo binlog necesita binlog_format = ROW, y este MySQL usa ${vars.format}.`);

    const { default: ZongJi } = await import("@vlasky/zongji");
    z = new ZongJi({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, ssl: sslFor(conn), dateStrings: true, connectTimeout: CONNECT_TIMEOUT_MS });
    const events = [];
    let lastEventAt = Date.now();
    let failure = null;
    const names = specs.map((s) => s.name);
    z.on("binlog", (event) => {
      const type = event.getTypeName();
      if (type === "TableMap") return;
      const table = event.tableMap?.[event.tableId];
      if (!table) return;
      lastEventAt = Date.now();
      events.push({ type, table: table.tableName, rows: event.rows });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CitrusError("BINLOG_TIMEOUT", "No se pudo empezar a leer el binlog a tiempo.")), BINLOG_READY_TIMEOUT_MS);
      z.on("error", (err) => {
        failure = err;
        clearTimeout(timer);
        reject(err);
      });
      z.on("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      z.start({
        startAtEnd: true,
        // Al azar y alto: repetir el id de una réplica real la desconectaría.
        serverId: 1_000_000 + Math.floor(Math.random() * 3_000_000_000),
        includeEvents: ["tablemap", "writerows", "updaterows", "deleterows"],
        includeSchema: { [conn.database]: names.length ? names : true },
      });
    });

    return {
      async finish() {
        const deadline = Date.now() + BINLOG_MAX_WAIT_MS;
        await new Promise((resolve) => {
          const check = () => {
            if (Date.now() - lastEventAt >= BINLOG_QUIET_MS || Date.now() >= deadline) resolve();
            else setTimeout(check, 50);
          };
          lastEventAt = Math.max(lastEventAt, Date.now());
          check();
        });
        z.stop();
        if (failure && !events.length) throw failure;
        const byTable = new Map(names.map((n) => [n, { name: n, inserted: [], updated: [], deleted: [] }]));
        for (const e of events) {
          if (!byTable.has(e.table)) byTable.set(e.table, { name: e.table, inserted: [], updated: [], deleted: [] });
          const entry = byTable.get(e.table);
          for (const row of e.rows) {
            if (e.type === "WriteRows") entry.inserted.push(normalizeRow(row, mask));
            else if (e.type === "DeleteRows") entry.deleted.push(normalizeRow(row, mask));
            else {
              const before = normalizeRow(row.before, mask);
              const after = normalizeRow(row.after, mask);
              entry.updated.push({ before, after, changed: Object.keys(after).filter((k) => before[k] !== after[k]) });
            }
          }
        }
        const tables = [];
        for (const entry of byTable.values()) {
          const sample = entry.inserted[0] ?? entry.updated[0]?.after ?? entry.deleted[0];
          entry.columns = sample ? Object.keys(sample) : [];
          entry.pk = await primaryKey(control, conn.database, entry.name).catch(() => []);
          tables.push(entry);
        }
        await control.end().catch(() => {});
        return tables;
      },
      async abort() {
        z.stop();
        await control.end().catch(() => {});
      },
    };
  } catch (err) {
    try {
      z?.stop();
    } catch {
      // Ya estaba detenido.
    }
    await control.end().catch(() => {});
    throw friendlyDbError(err, conn);
  }
}

/**
 * Empieza a observar la base antes de la request. Nunca lanza: si la base falla,
 * la request se envía igual y el error aparece en la pestaña de base de datos.
 */
export async function startDbObservation(model, env) {
  const spec = model.observe?.db;
  if (!spec?.connection) return null;
  const errorResult = (err) => ({ public: { connection: spec.connection, error: { code: err.code ?? "DB_ERROR", message: err.message }, tables: [], changes: 0 } });
  const mask = (text) => maskSecrets(text, env.secretValues ?? []);
  let conn;
  try {
    conn = resolveConnection(env, spec.connection);
    if (spec.mode === "binlog" || spec.mode === "snapshot") conn.mode = spec.mode;
    const specs = normalizeTables(spec.tables);
    if (conn.mode === "binlog") {
      const handle = await startBinlog(conn, specs, mask);
      return {
        async finish() {
          try {
            return present(conn.name, "binlog", await handle.finish(), []);
          } catch (err) {
            return errorResult(friendlyDbError(err, conn));
          }
        },
        abort: () => handle.abort().catch(() => {}),
      };
    }
    const before = await takeSnapshot(conn, specs, env.scope, mask);
    const compare = async () => {
      const after = await takeSnapshot(conn, specs, env.scope, mask);
      const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])];
      const empty = { pk: [], columns: [], rows: [] };
      const tables = names.map((name) => diffTable(name, before.tables[name] ?? empty, after.tables[name] ?? empty));
      return present(conn.name, "snapshot", tables, before.skipped);
    };
    return {
      async finish() {
        try {
          return { ...(await compare()), refresh: compare };
        } catch (err) {
          return errorResult(friendlyDbError(err, conn));
        }
      },
      abort: async () => {},
    };
  } catch (err) {
    const failed = errorResult(conn ? friendlyDbError(err, conn) : err);
    return { finish: async () => failed, abort: async () => {} };
  }
}

/** Prueba una conexión y avisa si el usuario tiene más permisos de los que Citrus necesita. */
export async function testDbConnection(env, name) {
  const conn = resolveConnection(env, name);
  const c = await open(conn);
  try {
    const [[info]] = await c.query("SELECT VERSION() AS version, @@log_bin AS logBin, @@binlog_format AS format");
    const [grants] = await c.query("SHOW GRANTS");
    const text = grants.map((row) => Object.values(row)[0]).join(" ");
    return {
      version: info.version,
      canWrite: /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP)\b/i.test(text),
      binlog: Number(info.logBin) === 1 && info.format === "ROW",
      canReplicate: /\b(ALL PRIVILEGES|REPLICATION SLAVE)\b/i.test(text),
    };
  } catch (err) {
    throw friendlyDbError(err, conn);
  } finally {
    await c.end().catch(() => {});
  }
}
