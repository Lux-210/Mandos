"use strict";
const assert = require("assert");
const path = require("path");
const vm = require("vm");
const { test } = require("./lib");
const { loadScripts } = require("./harness");

// ---------------------------------------------------------------------------
// El <head> no debe bloquear el primer render con una descarga externa.
// ---------------------------------------------------------------------------
test("rendimiento: la fuente de Google Fonts no bloquea el primer render", () => {
  const { html } = loadScripts();
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(!/@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/.test(head), "no debe haber un @import bloqueante a Google Fonts dentro de un <style>");
  assert.ok(/<link[^>]+rel="preconnect"[^>]+fonts\.googleapis\.com/.test(head), "falta preconnect a fonts.googleapis.com");
  assert.ok(/<link[^>]+rel="preconnect"[^>]+fonts\.gstatic\.com/.test(head), "falta preconnect a fonts.gstatic.com (ahí se sirven los archivos de fuente)");
  const stylesheetLink = head.match(/<link[^>]+rel="stylesheet"[^>]+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]*\/>/);
  assert.ok(stylesheetLink, "falta el <link rel=\"stylesheet\"> de la hoja de estilos de Google Fonts (distinto del <link rel=\"preload\">)");
  assert.ok(/media="print"/.test(stylesheetLink[0]) && /onload="this\.media='all'"/.test(stylesheetLink[0]), "el <link> debe cargar sin bloquear (patrón media=print + onload)");
  assert.ok(/<noscript><link[^>]+fonts\.googleapis\.com/.test(head), "falta la reserva en <noscript> para cuando JavaScript está desactivado");
});

test("rendimiento: el acento guardado se aplica antes de pintar (sin parpadeo) y no depende de la red", () => {
  const { html } = loadScripts();
  const head = html.slice(0, html.indexOf("</head>"));
  const firstScript = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(firstScript && /localStorage\.getItem\("mis-dualsense-accent"\)/.test(firstScript[1]), "el primer <script> del <head> debe leer el acento guardado de inmediato");
});

// ---------------------------------------------------------------------------
// El service worker: instala, sirve offline y no deja index.html sin cachear.
// ---------------------------------------------------------------------------
function loadServiceWorker({ network, online = true }) {
  class Req {
    constructor(url, opts = {}) {
      this.url = url;
      this.method = opts.method || "GET";
      this.mode = opts.mode || "same-origin";
    }
    clone() {
      return this;
    }
  }
  class Res {
    constructor(body, opts = {}) {
      this.body = body;
      this.ok = opts.ok !== false;
      this.status = opts.status || 200;
      this.type = opts.type || "basic";
    }
    clone() {
      return this;
    }
  }
  class Cache {
    constructor() {
      this.map = new Map();
    }
    async add(url) {
      const res = await fetchImpl(new Req(url));
      if (!res || !res.ok) throw new Error("no ok: " + url);
      this.map.set(url, res);
    }
    async put(req, res) {
      this.map.set(typeof req === "string" ? req : req.url, res);
    }
    async match(req) {
      const url = typeof req === "string" ? req : req.url;
      return this.map.get(url);
    }
  }
  class Caches {
    constructor() {
      this.stores = new Map();
    }
    async open(name) {
      if (!this.stores.has(name)) this.stores.set(name, new Cache());
      return this.stores.get(name);
    }
    async match(req) {
      for (const c of this.stores.values()) {
        const r = await c.match(req);
        if (r) return r;
      }
      return undefined;
    }
    async keys() {
      return [...this.stores.keys()];
    }
    async delete(name) {
      return this.stores.delete(name);
    }
  }
  async function fetchImpl(reqOrUrl) {
    const url = typeof reqOrUrl === "string" ? reqOrUrl : reqOrUrl.url;
    if (!state.online) throw new Error("offline (red simulada apagada)");
    // Cualquier navegación (con o sin query string) pide la página en sí; en
    // el caché la clave siempre es la ruta relativa "./index.html".
    const key = url.indexOf("api.github.com") === -1 && /^https?:\/\/[^/]+\/[^?]*\/?(\?.*)?$/.test(url) && !network.has(url) ? "./index.html" : url;
    if (!network.has(key)) return new Res("", { ok: false, status: 404 });
    return new Res(network.get(key), { ok: true });
  }
  const state = { online };
  const listeners = {};
  const self = {
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    location: { origin: "https://usuario.github.io" },
  };
  const sandbox = { self, caches: new Caches(), fetch: fetchImpl, Promise, console };
  vm.createContext(sandbox);
  vm.runInContext(require("fs").readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8"), sandbox, {
    filename: "service-worker.js",
  });
  return {
    setOnline: (value) => {
      state.online = value;
    },
    async fire(name, event) {
      let result;
      event.waitUntil = (promise) => {
        result = promise;
      };
      event.respondWith = (promise) => {
        result = promise;
      };
      listeners[name](event);
      return result;
    },
    Req,
  };
}

const OK_NETWORK = () =>
  new Map([
    ["./index.html", "<html>página</html>"],
    ["./manifest.json", "{}"],
    ["./icons/icon-192.png", "PNG-192"],
    ["./icons/icon-512.png", "PNG-512"],
    ["./icons/icon-512-maskable.png", "PNG-512-mask"],
    ["./icons/apple-touch-icon.png", "PNG-apple"],
    [
      "https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap",
      "CSS-fuente",
    ],
  ]);

test("service worker: instala y cachea todo el app shell (icons incluidos)", async () => {
  const network = OK_NETWORK();
  const sw = loadServiceWorker({ network });
  await sw.fire("install", {});
  // No hay forma de inspeccionar el caché desde afuera del sandbox salvo repitiendo
  // los fetch: se comprueba pidiendo cada archivo offline, uno por uno.
  sw.setOnline(false);
  for (const [url] of network) {
    const res = await sw.fire("fetch", { request: new sw.Req(url) });
    assert.ok(res && res.body, "no quedó en caché tras instalar: " + url);
  }
});

test("service worker: si falla la red, una navegación offline muestra la app en vez de una pantalla en blanco", async () => {
  const network = OK_NETWORK();
  const sw = loadServiceWorker({ network });
  await sw.fire("install", {});
  sw.setOnline(false);
  // La URL real de una navegación (con barra final y/o parámetros) nunca es
  // igual, carácter por carácter, a la clave "./index.html" del caché.
  for (const navUrl of [
    "https://usuario.github.io/mis-dualsense/",
    "https://usuario.github.io/mis-dualsense/?ref=inicio",
    "https://usuario.github.io/mis-dualsense/index.html",
  ]) {
    const res = await sw.fire("fetch", { request: new sw.Req(navUrl, { mode: "navigate" }) });
    assert.ok(res && res.body, "la navegación offline a " + navUrl + " no devolvió nada");
    assert.strictEqual(res.body, "<html>página</html>");
  }
});

test("service worker: estando online, una navegación siempre trae la versión más reciente publicada", async () => {
  const network = OK_NETWORK();
  const sw = loadServiceWorker({ network });
  await sw.fire("install", {});
  network.set("./index.html", "<html>versión nueva publicada</html>");
  const res = await sw.fire("fetch", { request: new sw.Req("https://usuario.github.io/mis-dualsense/", { mode: "navigate" }) });
  assert.strictEqual(res.body, "<html>versión nueva publicada</html>");
});

test("service worker: si falla la instalación, no queda un caché a medias sin index.html", async () => {
  const network = OK_NETWORK();
  network.delete("./index.html"); // simula que justo esa descarga falla
  const sw = loadServiceWorker({ network });
  await assert.rejects(sw.fire("install", {}), /no ok: \.\/index\.html/, "la instalación debe fallar de forma explícita, no silenciosa, si no se pudo guardar index.html");
});

test("service worker: las llamadas a la API de GitHub nunca se sirven desde caché", async () => {
  const network = OK_NETWORK();
  const sw = loadServiceWorker({ network });
  await sw.fire("install", {});
  sw.setOnline(false);
  await assert.rejects(sw.fire("fetch", { request: new sw.Req("https://api.github.com/gists/abc") }), /offline/, "debe intentar ir a la red (y fallar), nunca devolver un dato viejo de la nube");
});
