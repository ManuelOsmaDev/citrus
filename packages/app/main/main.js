import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from "electron";
import electronUpdater from "electron-updater";
import { EXAMPLE_FIRST_REQUEST, prepareExample } from "./example.js";
import {
  applyImport,
  buildSnippet,
  CitrusError,
  clearHistory,
  createEnvironment,
  createFolder,
  createRequest,
  deleteSecret,
  describeEnvironment,
  EVENT_TEMPLATES,
  fetchObservedLogs,
  importCurl,
  importPostman,
  importServerless,
  initWorkspace,
  isWorkspace,
  keychainStore,
  listEnvironments,
  listTree,
  moveFindingsToSecrets,
  openWorkspace,
  prettyJson,
  publicFindings,
  readHistory,
  readRequest,
  requestPath,
  resolveEnvironment,
  runFolder,
  runRequest,
  saveEnvironment,
  saveRequest,
  scanModel,
  parseProxyRules,
  setProxyResolver,
  setTrustedCertificates,
  setSecret,
  testDbConnection,
} from "@citrus/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const UI_DIR = path.join(here, "..", "ui", "dist");
const MONACO_DIR = path.dirname(require.resolve("monaco-editor/package.json"));
const FONT_FILES = {
  "geist.woff2": path.join(path.dirname(require.resolve("@fontsource-variable/geist/package.json")), "files", "geist-latin-wght-normal.woff2"),
  "geist-mono.woff2": path.join(path.dirname(require.resolve("@fontsource-variable/geist-mono/package.json")), "files", "geist-mono-latin-wght-normal.woff2"),
};
const DEMO_DIR = path.resolve(here, "..", "..", "..", "examples", "serverless-mysql-demo");
const SCHEME = "citrus-app";
const ORIGIN = `${SCHEME}://app`;
const MAX_RECENTS = 8;
const BODIES_KEPT = 5;
const OBSERVATIONS_KEPT = 30;

if (process.env.CITRUS_USER_DATA) app.setPath("userData", process.env.CITRUS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const store = keychainStore();
let win = null;
let workspace = null;
const runs = new Map();
const bodies = new Map();
// Solo en memoria: una captura puede ser un token de login.
const capturesByRoot = new Map();
// La UI pide logs por runId: no puede elegir qué grupo de logs se lee.
const observations = new Map();
const dbRefreshers = new Map();

function currentCaptures() {
  const root = needWorkspace();
  if (!capturesByRoot.has(root)) capturesByRoot.set(root, {});
  return capturesByRoot.get(root);
}

// ---------- Ajustes locales ----------

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

async function readSettings() {
  try {
    const data = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    const list = (value) => (Array.isArray(value) ? value.filter((r) => typeof r === "string") : []);
    return {
      recents: list(data.recents),
      trusted: list(data.trusted),
      last: data.last ?? null,
      welcomed: data.welcomed === true,
      proxy: typeof data.proxy === "string" ? data.proxy : null,
    };
  } catch {
    return { recents: [], trusted: [], last: null, welcomed: false, proxy: null };
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

async function rememberWorkspace(root) {
  const settings = await readSettings();
  const recents = [root, ...settings.recents.filter((r) => r !== root)].slice(0, MAX_RECENTS);
  await writeSettings({ ...settings, recents, last: root });
}

// ---------- Workspace ----------

const needWorkspace = () => {
  if (!workspace) throw new CitrusError("NO_WORKSPACE", "Abre un workspace primero.");
  return workspace.root;
};

async function snapshot() {
  const root = needWorkspace();
  return { workspace, tree: await listTree(root), envs: await listEnvironments(root) };
}

const exampleDir = () => path.join(app.getPath("userData"), "ejemplo");

async function activate(root) {
  if (path.resolve(root) === exampleDir()) await prepareExample(exampleDir());
  workspace = await openWorkspace(root);
  await rememberWorkspace(workspace.root);
  return snapshot();
}

async function pickFolder(title, buttonLabel) {
  const result = await dialog.showOpenDialog(win, { title, buttonLabel, properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
}

// ---------- Red de empresa: proxy y certificados ----------

let manualProxy = null;

const proxyHost = (url) => (url ? new URL(url).host : null);

function isLoopback(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function loadManualProxy() {
  const { proxy } = await readSettings();
  if (!proxy || !safeStorage.isEncryptionAvailable()) return;
  try {
    manualProxy = safeStorage.decryptString(Buffer.from(proxy, "base64"));
  } catch {
    manualProxy = null;
  }
}

/** Los certificados raíz de Windows: ahí instalan el suyo los antivirus y los proxies de empresa. */
function windowsCertificates() {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::ASCII;" +
    "Get-ChildItem Cert:\\LocalMachine\\Root,Cert:\\CurrentUser\\Root" +
    " | Where-Object { $_.NotAfter -gt (Get-Date) }" +
    " | ForEach-Object { [Convert]::ToBase64String($_.RawData) }";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const pems = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`);
        resolve(pems);
      },
    );
  });
}

// ---------- Actualización automática desde GitHub Releases ----------

const DOWNLOAD_PAGE = "https://manuelosmadev.github.io/citrus/";

// null mientras no haya una versión nueva. Sin internet tampoco se sabe de ninguna, y la app sigue usable.
let updateState = null;

function publishUpdate(state) {
  updateState = state;
  win?.webContents.send("citrus:update", state);
}

function setupUpdates() {
  if (!app.isPackaged || process.env.CITRUS_NO_UPDATE) return;
  const { autoUpdater } = electronUpdater;
  if (process.env.CITRUS_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: process.env.CITRUS_UPDATE_URL });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => {
    console.error("Actualización:", err?.message ?? err);
    if (updateState?.state === "downloading") {
      publishUpdate({ ...updateState, state: "error", message: String(err?.message ?? err).slice(0, 200) });
    }
  });
  autoUpdater.on("update-available", (info) => publishUpdate({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (progress) => {
    if (updateState?.state === "downloading") publishUpdate({ ...updateState, percent: Math.floor(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => publishUpdate({ state: "ready", version: info.version }));
  const check = () => {
    if (!updateState) autoUpdater.checkForUpdates().catch(() => {});
  };
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

// ---------- API para la UI: la UI nunca toca disco, llavero ni red ----------

const api = {
  async boot() {
    const settings = await readSettings();
    const hasDemo = await isWorkspace(DEMO_DIR);
    const start = process.env.CITRUS_WORKSPACE || settings.last;
    let opened = null;
    if (start && (await isWorkspace(start))) {
      opened = await activate(start).catch(() => null);
    }
    const { recents } = await readSettings();
    const firstRun = !opened && !settings.welcomed && settings.recents.length === 0;
    return { opened, recents, hasDemo, firstRun, manualProxy: proxyHost(manualProxy), update: updateState };
  },

  installUpdate() {
    if (updateState?.state !== "ready") throw new CitrusError("NO_UPDATE", "No hay ninguna actualización lista.");
    setImmediate(() => electronUpdater.autoUpdater.quitAndInstall(true, true));
    return true;
  },
  retryUpdate() {
    if (updateState?.state !== "error") return false;
    publishUpdate({ state: "downloading", version: updateState.version, percent: 0 });
    electronUpdater.autoUpdater.checkForUpdates().catch(() => {});
    return true;
  },
  async openDownloadPage() {
    await shell.openExternal(DOWNLOAD_PAGE);
    return true;
  },

  async markWelcomed() {
    await writeSettings({ ...(await readSettings()), welcomed: true });
    return true;
  },
  async openExample() {
    return { ...(await activate(exampleDir())), first: EXAMPLE_FIRST_REQUEST };
  },

  async setProxy({ url }) {
    let parsed;
    try {
      parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    } catch {
      throw new CitrusError("PROXY_INVALID", "Esa dirección de proxy no es válida. Ejemplo: http://proxy.empresa.com:8080");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CitrusError("PROXY_UNSUPPORTED", "Citrus solo soporta proxies http y https.");
    }
    if (!safeStorage.isEncryptionAvailable()) throw new CitrusError("PROXY_STORAGE", "Windows no permite guardar el proxy cifrado.");
    await writeSettings({ ...(await readSettings()), proxy: safeStorage.encryptString(parsed.href).toString("base64") });
    manualProxy = parsed.href;
    return { host: parsed.host };
  },
  async clearProxy() {
    await writeSettings({ ...(await readSettings()), proxy: null });
    manualProxy = null;
    return true;
  },

  async chooseWorkspace() {
    const dir = await pickFolder("Abrir workspace de Citrus", "Abrir");
    if (!dir) return null;
    if (!(await isWorkspace(dir))) {
      throw new CitrusError("NOT_WORKSPACE", "Esa carpeta no tiene citrus.config.yaml. Usa «Crear workspace» para empezar uno.");
    }
    return activate(dir);
  },
  async createWorkspace() {
    const dir = await pickFolder("Elegir carpeta para el workspace", "Crear aquí");
    if (!dir) return null;
    await initWorkspace(dir);
    return activate(dir);
  },
  async openRecent({ root }) {
    // Solo rutas que ya están en la lista: la UI no puede pedir una carpeta cualquiera.
    const { recents } = await readSettings();
    if (!recents.includes(root)) throw new CitrusError("NOT_RECENT", "Ese workspace no está en la lista.");
    return activate(root);
  },
  openDemo: () => activate(DEMO_DIR),
  closeWorkspace: async () => {
    workspace = null;
    return { recents: (await readSettings()).recents };
  },

  tree: () => listTree(needWorkspace()),
  readRequest: ({ id }) => readRequest(needWorkspace(), id),
  // Un .citrus.yaml termina en Git: antes de escribirlo, se buscan credenciales.
  async saveRequest({ id, model, env, decision }) {
    const root = needWorkspace();
    const findings = decision === "force" ? [] : scanModel(model);
    if (findings.length && decision !== "move") return { blocked: true, findings: publicFindings(findings) };
    if (decision === "move") {
      const moved = await moveFindingsToSecrets({ root, envId: env ?? null, model, findings, store });
      const saved = await saveRequest(root, id, moved.model);
      return { ...saved, model: moved.model, moved: moved.names };
    }
    return saveRequest(root, id, model);
  },
  createRequest: ({ folder, name }) => createRequest(needWorkspace(), { folder, name }),
  createFolder: ({ parent, name }) => createFolder(needWorkspace(), { parent, name }),
  async deleteRequest({ id }) {
    // A la papelera, no un borrado definitivo.
    await shell.trashItem(await requestPath(needWorkspace(), id));
  },

  envs: () => listEnvironments(needWorkspace()),
  envDescribe: ({ id }) => describeEnvironment(needWorkspace(), id, store, currentCaptures()),
  eventTemplates: () => EVENT_TEMPLATES,
  snippet: ({ model, env, language }) => buildSnippet({ root: needWorkspace(), model, envId: env ?? null, store, language }),
  runFolder: ({ folder, env }) =>
    runFolder({ root: needWorkspace(), folder, envId: env ?? null, store, captures: currentCaptures(), confirm: askProtected, trust: askTrust }),
  envSave: ({ id, variables, protected: isProtected, extends: parent, db }) =>
    saveEnvironment(needWorkspace(), id, { variables, protected: isProtected, extends: parent, db }),
  envCreate: ({ id }) => createEnvironment(needWorkspace(), id),
  secretSet: ({ env, name, value }) => setSecret(needWorkspace(), env, name, value, store),
  secretDelete: ({ env, name }) => deleteSecret(needWorkspace(), env, name, store),

  async send({ id, model, env, runId }) {
    const controller = new AbortController();
    runs.set(runId, controller);
    try {
      const { result, rawBody, refreshDb } = await runRequest({
        root: needWorkspace(),
        id,
        model,
        envId: env ?? null,
        store,
        captures: currentCaptures(),
        signal: controller.signal,
        confirm: askProtected,
        trust: askTrust,
      });
      bodies.set(runId, rawBody);
      while (bodies.size > BODIES_KEPT) bodies.delete(bodies.keys().next().value);
      if (refreshDb) {
        dbRefreshers.set(runId, { refreshDb, tests: result.tests });
        while (dbRefreshers.size > BODIES_KEPT) dbRefreshers.delete(dbRefreshers.keys().next().value);
      }
      if (result.observation && !result.observation.error) {
        observations.set(runId, { observation: result.observation, tests: result.tests, env: env ?? null, root: needWorkspace() });
        while (observations.size > OBSERVATIONS_KEPT) observations.delete(observations.keys().next().value);
      }
      return { ...result, runId };
    } finally {
      runs.delete(runId);
    }
  },
  async dbRefresh({ runId }) {
    const entry = dbRefreshers.get(runId);
    if (!entry) throw new CitrusError("NO_SNAPSHOT", "La foto de esa ejecución ya no está en memoria. Vuelve a enviar la request.");
    const logs = observations.get(runId);
    const out = await entry.refreshDb(logs?.tests ?? entry.tests);
    entry.tests = out.tests;
    if (logs) logs.tests = out.tests;
    return out;
  },
  async dbTest({ env, name }) {
    return testDbConnection(await resolveEnvironment(needWorkspace(), env, store, currentCaptures()), name);
  },
  async fetchLogs({ runId, pick }) {
    const entry = observations.get(runId);
    if (!entry) throw new CitrusError("NO_OBSERVATION", "Esa ejecución ya no está en memoria. Vuelve a enviar la request.");
    if (typeof pick === "string" && /^[\w-]{6,128}$/.test(pick)) entry.observation = { ...entry.observation, pinned: pick };
    const out = await fetchObservedLogs({
      root: entry.root,
      observation: entry.observation,
      tests: entry.tests,
      envId: entry.env,
      store,
      captures: currentCaptures(),
    });
    if (out.tests) entry.tests = out.tests;
    if (out.traceUrl) entry.traceUrl = out.traceUrl;
    return out;
  },
  async openTrace({ runId }) {
    // Solo la URL que armó el motor con región e id validados, nunca una que mande la página.
    const url = observations.get(runId)?.traceUrl;
    if (!url) throw new CitrusError("NO_TRACE", "Esta ejecución no tiene traza de X-Ray.");
    await shell.openExternal(url);
  },
  cancel({ runId }) {
    runs.get(runId)?.abort();
  },
  async saveResponse({ runId, suggested }) {
    const buffer = bodies.get(runId);
    if (!buffer) throw new CitrusError("NO_BODY", "La respuesta ya no está en memoria. Vuelve a enviar la request.");
    const result = await dialog.showSaveDialog(win, { title: "Guardar respuesta", defaultPath: String(suggested ?? "respuesta").replace(/[\\/:*?"<>|]/g, "-") });
    if (result.canceled) return { saved: false };
    await fs.writeFile(result.filePath, buffer);
    return { saved: true };
  },

  history: () => readHistory(needWorkspace()),
  historyClear: () => clearHistory(needWorkspace()),

  async importCurl({ text, env }) {
    const root = needWorkspace();
    const { model, secrets, warnings } = importCurl(text);
    const report = await applyImport({ root, requests: [{ model, name: model.name }], secrets, envId: env ?? null, store, folder: "importadas" });
    return { created: report.created, storedSecrets: report.storedSecrets, warnings: [...warnings, ...report.warnings] };
  },
  async importPostman({ env }) {
    const root = needWorkspace();
    const result = await dialog.showOpenDialog(win, {
      title: "Importar colección de Postman",
      filters: [{ name: "Colección de Postman", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const parsed = importPostman(await fs.readFile(result.filePaths[0], "utf8"));
    const folder = `importadas/${parsed.name}`.toLowerCase().replace(/[^a-z0-9/]+/g, "-").replace(/-+$/g, "") || "importadas";
    const report = await applyImport({ root, ...parsed, envId: env ?? null, store, folder });
    return { created: report.created, storedSecrets: report.storedSecrets, warnings: [...parsed.warnings, ...report.warnings] };
  },

  async importServerless() {
    const root = needWorkspace();
    const result = await dialog.showOpenDialog(win, {
      title: "Importar serverless.yml o template de SAM",
      filters: [{ name: "Serverless o SAM", extensions: ["yml", "yaml"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    const cwd = path.relative(root, path.dirname(file)).replace(/\\/g, "/") || ".";
    const parsed = importServerless(await fs.readFile(file, "utf8"), cwd);
    const folder = String(parsed.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "serverless";
    const report = await applyImport({ root, requests: parsed.requests, environments: [parsed.environment], store, folder });
    return { kind: parsed.kind, created: report.created, createdEnvs: report.createdEnvs, storedSecrets: [], warnings: parsed.warnings };
  },

  formatJson({ text }) {
    try {
      JSON.parse(text);
    } catch (e) {
      throw new CitrusError("BAD_JSON", `No se puede formatear: ${e.message}`);
    }
    return prettyJson(text);
  },

  setTheme({ theme }) {
    if (!win || process.platform === "darwin") return;
    const dark = theme !== "light";
    win.setTitleBarOverlay({ color: dark ? "#100f0e" : "#efede7", symbolColor: dark ? "#aaa69e" : "#5d5a54" });
  },
};

async function askProtected({ env, method, url }) {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Entorno protegido",
    message: `Vas a enviar ${method} al entorno protegido «${env}».`,
    detail: url,
    buttons: ["Enviar", "Cancelar"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

/** Correr un handler ejecuta código del proyecto: se pregunta una vez por carpeta. */
async function askTrust({ cwd, handler }) {
  const settings = await readSettings();
  if (settings.trusted.includes(cwd)) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Ejecutar código del proyecto",
    message: "Citrus va a ejecutar código de esta carpeta en tu equipo.",
    detail: `Handler: ${handler}\nCarpeta: ${cwd}\n\nHazlo solo si confías en este proyecto. El código puede hacer lo mismo que cualquier programa tuyo.`,
    buttons: ["Confiar y ejecutar", "Cancelar"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  await writeSettings({ ...settings, trusted: [...settings.trusted, cwd] });
  return true;
}

function registerApi() {
  ipcMain.handle("citrus", async (event, method, args) => {
    // Solo responde a la página propia de la app.
    if (!event.senderFrame?.url?.startsWith(`${ORIGIN}/`) || !Object.hasOwn(api, method)) {
      return { ok: false, error: { code: "FORBIDDEN", message: "Llamada no permitida." } };
    }
    try {
      return { ok: true, value: (await api[method](args ?? {})) ?? null };
    } catch (err) {
      if (!(err instanceof CitrusError)) console.error(`[citrus] ${method}:`, err);
      return { ok: false, error: { code: err.code ?? "ERROR", message: err.message ?? String(err) } };
    }
  });
}

// ---------- Archivos de la UI ----------

function serveApp() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const notFound = () => new Response("No encontrado", { status: 404 });
    if (url.host !== "app") return notFound();
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/fonts/")) {
      const font = FONT_FILES[pathname.slice("/fonts/".length)];
      return font ? net.fetch(pathToFileURL(font).href) : notFound();
    }
    const [base, relative] = pathname.startsWith("/monaco/")
      ? [MONACO_DIR, path.join("min", pathname.slice("/monaco/".length))]
      : [UI_DIR, pathname === "/" ? "index.html" : pathname.slice(1)];
    const file = path.resolve(base, relative);
    const inside = path.relative(base, file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return notFound();
    return net.fetch(pathToFileURL(file).href);
  });
}

function createWindow() {
  const titleBar = process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : { titleBarStyle: "hidden", titleBarOverlay: { color: "#100f0e", symbolColor: "#aaa69e", height: 44 } };

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#100f0e",
    title: "Citrus",
    ...titleBar,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // En el .exe instalado ready-to-show no llega y la ventana nunca aparecía (lo cubre test:instalado).
  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  win.webContents.once("did-finish-load", reveal);
  win.on("focus", () => win.webContents.send("citrus:focus"));
  win.on("closed", () => {
    win = null;
  });

  // La ventana nunca sale de la app, aunque una respuesta traiga enlaces.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  win.loadURL(`${ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  // El proxy manual manda; si no hay, el de Windows, incluidos los archivos PAC de las empresas.
  loadManualProxy();
  setTrustedCertificates(windowsCertificates());
  setupUpdates();
  setProxyResolver(async (url) => {
    if (manualProxy) return isLoopback(url) ? null : manualProxy;
    return parseProxyRules(await session.defaultSession.resolveProxy(url));
  });
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  serveApp();
  registerApi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
