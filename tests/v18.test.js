"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("./lib");
const { createDevice } = require("./harness");

// ---------------------------------------------------------------------------
// Depuración general: dos bugs reales encontrados al revisar todo el código.
// ---------------------------------------------------------------------------

// 1) El efecto que guarda los datos al ocultarse la pestaña ("flush") agregaba
// su listener de "visibilitychange" con una función anónima, y la limpieza
// del efecto solo quitaba "beforeunload"/"pagehide": el de "visibilitychange"
// quedaba vivo en document para siempre. En uso normal esto casi no se nota
// (la app solo se monta una vez por página), pero si el ErrorBoundary llega a
// atrapar un error de render, DualSenseTracker se desmonta igual y ese
// listener fantasma queda guardando datos ya obsoletos cada vez que cambia la
// visibilidad, sin que nada lo detenga.
test("fugas: al desmontar la app no queda un listener de visibilitychange colgado en document", async () => {
  const d = await createDevice({ startApp: false });
  try {
    const { win, doc, app } = d;
    assert.ok(app.DualSenseTracker, "DualSenseTracker debe quedar expuesto para poder probarlo");

    // Se intercepta doc.addEventListener/removeEventListener para llevar la
    // cuenta de qué handlers de "visibilitychange" siguen activos en cada
    // momento, sin perder el comportamiento real (se sigue llamando a la
    // implementación original).
    const live = new Set();
    const origAdd = doc.addEventListener.bind(doc);
    const origRemove = doc.removeEventListener.bind(doc);
    doc.addEventListener = (type, handler, options) => {
      if (type === "visibilitychange") live.add(handler);
      return origAdd(type, handler, options);
    };
    doc.removeEventListener = (type, handler, options) => {
      if (type === "visibilitychange") live.delete(handler);
      return origRemove(type, handler, options);
    };

    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = win.ReactDOM.createRoot(container);
    root.render(win.React.createElement(app.DualSenseTracker));

    await d.waitFor(() => container.querySelector("h1"), { message: "la app de prueba no terminó de cargar" });
    assert.ok(live.size > 0, "la app debería registrar al menos un listener de visibilitychange mientras está montada");

    root.unmount();
    await d.wait(20);

    assert.ok(
      live.size === 0,
      "no debe quedar ningún listener de visibilitychange en document después de desmontar la app (quedaron " + live.size + ")"
    );
    assert.deepStrictEqual(d.errors, [], "no debe haber errores en consola durante el montaje/desmontaje");
  } finally {
    d.close();
  }
});

// 2) La barra de "hay una versión nueva de la app" (se muestra cuando el
// service worker detecta una actualización) usaba cuatro clases de Tailwind
// ("top-0", "inset-x-0", "shadow-lg", "bg-white/15" y "hover:bg-white/25")
// que nunca quedaron incluidas en el CSS purgado embebido: sin ellas, la
// barra no se ubicaba pegada arriba de la pantalla y el botón "Recargar" no
// tenía ningún fondo visible. Se agregaron a mano junto con las demás
// utilidades "de repuesto" que ya vivían en el <style> de la app.
test("estilos: la barra de «hay una versión nueva» usa clases que existen en el CSS embebido", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  [".top-0 {", ".inset-x-0 {", ".shadow-lg {", ".bg-white\\/15 {", ".hover\\:bg-white\\/25:hover {"].forEach((selector) => {
    assert.ok(css.includes(selector), "falta la clase «" + selector + "» en el CSS embebido");
  });
});

// 3) csvCanonicalOption (usada al importar un CSV para reconocer "Consola de
// origen"/"Consola actual" entre las opciones válidas) filtraba las opciones
// con "option &&" y después devolvía "found || null": ambas cosas haciendo
// que la opción vacía ("" = "Sin especificar", una opción legítima en
// CONSOLE_ORIGEN_OPTIONS) nunca pudiera reconocerse como coincidencia, aun
// cuando sí lo era. Hoy ningún llamador llega a ejercitar ese caso (el único
// que la usa corta antes si el valor del CSV viene vacío), pero la función en
// sí quedaba rota para cualquier opción vacía.
test("csvCanonicalOption: reconoce la opción vacía como una coincidencia válida, no como «no encontrado»", async () => {
  const d = await createDevice({ startApp: false });
  try {
    const options = ["", "PS5", "PS5 Slim", "PS5 Pro", "Comprado"];
    assert.strictEqual(d.app.csvCanonicalOption("", options), "", "debe reconocer la opción vacía en vez de devolver null");
    assert.strictEqual(d.app.csvCanonicalOption("ps5 pro", options), "PS5 Pro", "sigue reconociendo una opción normal sin tildes/mayúsculas");
    assert.strictEqual(d.app.csvCanonicalOption("algo inventado", options), null, "un valor que no está entre las opciones sigue devolviendo null");
  } finally {
    d.close();
  }
});
