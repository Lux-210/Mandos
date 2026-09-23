"use strict";
// Entorno de pruebas: carga index.html en jsdom con IndexedDB simulado y
// permite simular "dispositivos" que comparten un servidor de GitHub falso.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const HTML_PATH = process.env.DUALSENSE_HTML || path.join(__dirname, "..", "index.html");

// Nombres que se exponen en window.__app para probar la lógica directamente
// (los const del script no quedan accesibles desde afuera de otro modo).
const EXPOSED = [
  "mergeForSync", "mergeControllerForSync", "reviveFromTombstones", "pruneTombstones", "normalizeTombstones",
  "emptyTombstones", "syncSignature", "stableStringify", "controllerLastActivity", "normalizeImportedControllers",
  "mergeImportedControllers", "buildControllersCSVRows", "buildCSVImport", "parseCSVRows", "detectCSVDelimiter",
  "parseCSVNumber", "parseCSVDate", "decodeCSVBuffer", "requestPersistentStorage", "emptyController", "emptyIssue",
  "csvEscape", "formatDate", "ISSUE_TYPES", "TOMBSTONE_MAX_AGE_MS", "CONTROLLER_STATUS_META", "STATUS_META",
];

let cachedScripts = null;
function loadScripts() {
  if (cachedScripts) return cachedScripts;
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const find = (needle) => {
    const found = scripts.find((s) => s.includes(needle));
    if (!found) throw new Error("No se encontró el bloque <script> que contiene: " + needle);
    return found;
  };
  cachedScripts = {
    html,
    react: find(" * react.production.min.js"),
    reactDom: find(" * react-dom.production.min.js"),
    app: find("function DualSenseTracker"),
  };
  return cachedScripts;
}

function idbCall(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Deja datos ya guardados en IndexedDB antes de arrancar la app.
async function seedIDB(factory, { controllers, tombstones }) {
  const open = factory.open("mis-dualsense-db", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  const db = await idbCall(open);
  const tx = db.transaction("kv", "readwrite");
  if (controllers) tx.objectStore("kv").put(controllers, "controllers");
  if (tombstones) tx.objectStore("kv").put(tombstones, "tombstones");
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readIDB(factory, key) {
  const open = factory.open("mis-dualsense-db", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  const db = await idbCall(open);
  const value = await idbCall(db.transaction("kv", "readonly").objectStore("kv").get(key));
  db.close();
  return value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, { timeout = 4000, interval = 20, message = "condición" } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await condition();
    } catch (e) {
      value = false;
    }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("Tiempo agotado esperando: " + message);
    await wait(interval);
  }
}

// Crea un "dispositivo": una ventana con la app cargada.
//   indexedDB    reutiliza el almacenamiento de un dispositivo anterior (simula recargar)
//   localStorage claves iniciales (por ejemplo el token de sincronización)
//   fetch        implementación de fetch (servidor de GitHub falso)
//   storage      simula navigator.storage ({ persist, persisted })
//   seed         { controllers, tombstones } guardados de antemano
//   startApp     false para cargar solo el código sin montar la interfaz
async function createDevice(options = {}) {
  const scripts = loadScripts();
  const errors = [];
  const downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => {
    if (!/Not implemented/.test(e.message)) errors.push("jsdomError: " + e.message);
  });
  virtualConsole.on("error", (...args) => errors.push("console.error: " + args.map(String).join(" ")));

  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div id="root"></div><div id="print-report"></div></body></html>',
    { url: "https://dualsense.test/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole }
  );
  const win = dom.window;
  const factory = options.indexedDB || new IDBFactory();
  win.indexedDB = factory;
  win.IDBKeyRange = IDBKeyRange;
  if (options.seed) await seedIDB(factory, options.seed);
  Object.entries(options.localStorage || {}).forEach(([k, v]) => win.localStorage.setItem(k, v));
  const fetchStats = { calls: 0, inflight: 0 };
  if (options.fetch) {
    win.fetch = async (...args) => {
      fetchStats.calls += 1;
      fetchStats.inflight += 1;
      try {
        return await options.fetch(...args);
      } finally {
        fetchStats.inflight -= 1;
      }
    };
  }
  if (options.storage) Object.defineProperty(win.navigator, "storage", { value: options.storage, configurable: true });

  win.URL.createObjectURL = () => "blob:mock";
  win.URL.revokeObjectURL = () => {};
  win.print = () => {};
  win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // jsdom no implementa las descargas: se registran en vez de navegar.
  win.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ filename: this.download, href: this.href });
  };
  win.addEventListener("error", (e) => errors.push("error: " + (e.error ? e.error.stack : e.message)));

  const appSource = scripts.app + "\n;window.__app = {};\n" + EXPOSED.map((n) => "try { window.__app." + n + " = " + n + "; } catch (e) {}").join("\n");
  win.eval(scripts.react);
  win.eval(scripts.reactDom);
  if (options.startApp === false) {
    // Solo se define el código: se evita montar la interfaz.
    win.eval(appSource.replace(/ReactDOM\.createRoot\([^\n]*\n/, "\n"));
  } else {
    win.eval(appSource);
  }

  const doc = win.document;
  const device = {
    win, doc, errors, downloads, fetchStats, idb: factory, app: win.__app,
    q: (selector) => doc.querySelector(selector),
    qa: (selector) => [...doc.querySelectorAll(selector)],
    text: () => doc.body.textContent.replace(/\s+/g, " "),
    // Botones cuyo texto (sin espacios sobrantes) coincide exactamente.
    buttons: (label) => [...doc.querySelectorAll("button")].filter((b) => b.textContent.replace(/\s+/g, " ").trim() === label),
    byLabel: (label) => [...doc.querySelectorAll("[aria-label]")].filter((el) => el.getAttribute("aria-label") === label),
    click(el) {
      if (!el) throw new Error("click sobre un elemento que no existe");
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    type(el, value) {
      if (!el) throw new Error("escribir en un elemento que no existe");
      const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new win.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    },
    async chooseFile(input, { name, content, type = "text/plain" }) {
      const file = new win.File([content], name, { type });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    waitFor: (condition, opts) => waitFor(condition, opts),
    wait,
    async readIDB(key) {
      return readIDB(factory, key);
    },
    // ---- acciones de interfaz de uso frecuente
    async openSettings() {
      device.click(device.byLabel("Abrir configuración")[0]);
      await waitFor(() => device.text().includes("Apariencia"), { message: "abrir Configuración" });
    },
    async closeModals() {
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(30);
      if (device.buttons("Cerrar")[0]) device.click(device.buttons("Cerrar")[0]);
      await wait(30);
    },
    async addController(name, color) {
      device.click(device.buttons("Nuevo mando")[0] || device.buttons("Agregar primer mando")[0]);
      const input = await waitFor(() => device.q('input[placeholder^="Ej: Mando principal"]'), { message: "modal de nuevo mando" });
      device.type(input, name);
      if (color) device.type(device.q('input[placeholder^="Ej: Blanco"]'), color);
      device.click(device.buttons("Guardar")[0]);
      await waitFor(() => !device.q('input[placeholder^="Ej: Mando principal"]'), { message: "cerrar modal de mando" });
    },
    async openController(name) {
      const heading = await waitFor(
        () => device.qa("h2, h3, p, span").find((el) => el.children.length === 0 && el.textContent.trim() === name),
        { message: "tarjeta de " + name }
      );
      device.click(heading);
      await waitFor(() => device.buttons("Agregar falla").length > 0, { message: "detalle de " + name });
    },
    async addIssue(title) {
      device.click(device.buttons("Agregar falla")[0]);
      const input = await waitFor(() => device.q('input[placeholder^="Ej: Drift leve"]'), { message: "modal de nueva falla" });
      device.type(input, title);
      device.click(device.buttons("Guardar")[0]);
      await waitFor(() => !device.q('input[placeholder^="Ej: Drift leve"]'), { message: "cerrar modal de falla" });
    },
    async backToList() {
      device.click(device.buttons("Volver")[0]);
      await waitFor(() => device.buttons("Agregar falla").length === 0, { message: "volver a la lista" });
    },
    // Conecta la sincronización con el token indicado.
    async connectSync(token = "ghp_test") {
      await device.openSettings();
      device.click(device.buttons("Conectar")[0]);
      const input = await waitFor(() => device.q('input[placeholder="ghp_..."]'), { message: "campo del token" });
      device.type(input, token);
      const connect = device.buttons("Conectar");
      device.click(connect[connect.length - 1]);
      await waitFor(() => device.text().includes("Conectado a GitHub"), { message: "conexión a GitHub" });
      await device.closeModals();
    },
    // Fuerza un ciclo de sincronización desde Configuración → Gestionar.
    async syncNow() {
      await device.openSettings();
      device.click(device.buttons("Gestionar")[0]);
      const button = await waitFor(() => device.buttons("Sincronizar ahora")[0], { message: "botón Sincronizar ahora" });
      const before = fetchStats.calls;
      device.click(button);
      await waitFor(() => fetchStats.calls > before, { message: "inicio de la sincronización" });
      await waitFor(() => fetchStats.inflight === 0 && !device.text().includes("Sincronizando..."), { message: "fin de la sincronización", timeout: 6000 });
      await wait(60);
      await device.closeModals();
    },
    close() {
      win.close();
    },
  };
  if (options.startApp !== false) {
    await waitFor(() => doc.querySelector("h1"), { message: "carga inicial de la app" });
  }
  return device;
}

// Servidor de GitHub falso (solo lo que usa la app: gists).
function createFakeGithub({ token = "ghp_test" } = {}) {
  const gists = new Map();
  let counter = 0;
  const log = [];
  const respond = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const view = (g) => ({
    id: g.id,
    description: g.description,
    files: Object.fromEntries(Object.entries(g.files).map(([name, content]) => [name, { content, truncated: false }])),
  });
  async function fetchImpl(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(url);
    log.push({ method, path: u.pathname });
    const auth = opts.headers && (opts.headers.Authorization || opts.headers.authorization);
    if (auth !== "Bearer " + token) return respond(401, { message: "Bad credentials" });
    if (u.pathname === "/gists" && method === "GET") return respond(200, [...gists.values()].map(view));
    if (u.pathname === "/gists" && method === "POST") {
      const body = JSON.parse(opts.body);
      const id = "gist" + ++counter;
      const files = {};
      Object.entries(body.files).forEach(([name, file]) => (files[name] = file.content));
      gists.set(id, { id, description: body.description, files });
      return respond(201, { id });
    }
    const m = u.pathname.match(/^\/gists\/([^/]+)$/);
    if (m) {
      const gist = gists.get(m[1]);
      if (!gist) return respond(404, { message: "Not Found" });
      if (method === "GET") return respond(200, view(gist));
      if (method === "PATCH") {
        Object.entries(JSON.parse(opts.body).files).forEach(([name, file]) => (gist.files[name] = file.content));
        return respond(200, view(gist));
      }
    }
    return respond(404, { message: "Not Found" });
  }
  return {
    fetch: fetchImpl,
    gists,
    log,
    patchCount: () => log.filter((entry) => entry.method === "PATCH").length,
    // Contenido del gist ya interpretado.
    read(id) {
      const gist = id ? gists.get(id) : [...gists.values()][0];
      return {
        controllers: JSON.parse(gist.files["mis-dualsense-data.json"]),
        tombstones: gist.files["mis-dualsense-deleted.json"] ? JSON.parse(gist.files["mis-dualsense-deleted.json"]) : null,
      };
    },
    write(id, controllers, tombstones) {
      const gist = gists.get(id);
      gist.files["mis-dualsense-data.json"] = JSON.stringify(controllers);
      if (tombstones) gist.files["mis-dualsense-deleted.json"] = JSON.stringify(tombstones);
    },
  };
}

module.exports = { createDevice, createFakeGithub, loadScripts, seedIDB, readIDB, waitFor, wait };
