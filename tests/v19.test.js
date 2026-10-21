"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("./lib");
const { createDevice } = require("./harness");

// ---------------------------------------------------------------------------
// Mejora v20: mostrar en Configuración en qué versión de la app se está, para
// poder confirmar de un vistazo si ya se actualizó (sobre todo útil después de
// que aparece la barra de "hay una versión nueva, Recargar").
// ---------------------------------------------------------------------------

test("configuración: muestra la versión de la app", async () => {
  const d = await createDevice({});
  try {
    await d.openSettings();
    assert.ok(
      d.text().includes("Mis DualSense " + d.app.APP_VERSION),
      "Configuración debe mostrar el texto de versión (Mis DualSense " + d.app.APP_VERSION + ")"
    );
  } finally {
    d.close();
  }
});

// La versión que se le muestra a la persona (APP_VERSION, en index.html) y la
// que usa el navegador para invalidar el caché (CACHE_NAME, en
// service-worker.js) son cosas distintas, pero deben quedar siempre con el
// mismo número: si alguna vez se bumpea una sin la otra, esta prueba lo avisa
// en vez de dejar que la app muestre una versión que no coincide con lo que
// realmente está cacheado.
test("versión: APP_VERSION (index.html) y CACHE_NAME (service-worker.js) coinciden", async () => {
  const d = await createDevice({ startApp: false });
  try {
    const sw = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
    const match = sw.match(/CACHE_NAME = 'mis-dualsense-(v\d+)'/);
    assert.ok(match, "no se encontró CACHE_NAME en service-worker.js con el formato esperado");
    assert.strictEqual(
      d.app.APP_VERSION,
      match[1],
      "APP_VERSION (" + d.app.APP_VERSION + ") debe coincidir con la versión de CACHE_NAME (" + match[1] + ")"
    );
  } finally {
    d.close();
  }
});
