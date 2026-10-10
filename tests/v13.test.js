"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice, createFakeGithub } = require("./harness");

// Mismo valor que GH_TOKEN_KEY en index.html (no está expuesto en window.__app,
// así que se repite acá; si cambia el nombre de la clave en la app, hay que
// actualizarlo también en este archivo).
const GH_TOKEN_KEY = "mis-dualsense-gh-token";

async function withDevice(spec, fn) {
  const d = await createDevice(spec);
  try {
    await fn(d);
    assert.deepStrictEqual(d.errors, [], "la app registró errores:\n" + d.errors.join("\n"));
  } finally {
    d.close();
  }
}

function pressEscape(d) {
  d.win.dispatchEvent(new d.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function pressKey(d, key) {
  d.win.dispatchEvent(new d.win.KeyboardEvent("keydown", { key, bubbles: true }));
}

// assert.strictEqual, cuando falla comparando nodos del DOM, intenta
// serializarlos para el mensaje de error (document/window completos, con
// referencias circulares) y eso puede colgar el proceso. Para comparar
// nodos del DOM se usa esta variante, que solo imprime el mensaje dado.
function assertSame(a, b, message) {
  assert.ok(a === b, message);
}

// ---------------------------------------------------------------------------
// Atajo de teclado: Escape también cierra Configuración (antes se le
// escapaba: Configuración no estaba en la lista de modales que Escape
// cierra, así que "n" o "/" podían dispararse por debajo mientras estaba
// abierta).
// ---------------------------------------------------------------------------
test("atajos: Escape también cierra el modal de Configuración", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    assert.ok(d.text().includes("Apariencia"), "Configuración está abierta");

    pressEscape(d);
    await d.waitFor(() => !d.text().includes("Apariencia"), { message: "cerrar Configuración con Escape" });
  });
});

test("atajos: con Configuración abierta, el atajo «n» no abre por debajo el modal de nuevo mando", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    pressKey(d, "n");
    await d.wait(50);
    assert.ok(!d.q('input[placeholder^="Ej: Mando principal"]'), "«n» no debe abrir Nuevo mando mientras Configuración está abierta");
    assert.ok(d.text().includes("Apariencia"), "Configuración sigue abierta");
  });
});

// ---------------------------------------------------------------------------
// Accesibilidad: foco dentro del modal al abrirlo, y de vuelta al disparador
// al cerrarlo.
// ---------------------------------------------------------------------------
test("accesibilidad: al abrir un modal el foco queda adentro, y al cerrarlo vuelve al botón que lo abrió", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Uno", "Blanco");
    const trigger = d.buttons("Nuevo mando")[0];
    assert.ok(trigger, "botón «Nuevo mando»");

    // Un clic real (o activar el botón con el teclado) deja el botón
    // enfocado antes de que se abra el modal; el click simulado del harness
    // no lo hace por sí solo, así que se fuerza acá para que la prueba
    // refleje ese punto de partida real.
    trigger.focus();
    d.click(trigger);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'), { message: "modal de nuevo mando" });

    const dialog = d.q('[role="dialog"]');
    assert.ok(dialog, "el modal tiene role=dialog");
    assert.ok(dialog.contains(d.doc.activeElement), "el foco quedó dentro del modal al abrirlo");

    pressEscape(d);
    await d.waitFor(() => !d.q('input[placeholder^="Ej: Mando principal"]'), { message: "cerrar modal" });
    assertSame(d.doc.activeElement, trigger, "el foco vuelve al botón que abrió el modal");
  });
});

test("accesibilidad: el campo con autoFocus (token de GitHub) conserva el foco al abrir Sincronización", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder="ghp_..."]'), { message: "campo del token" });
    assertSame(d.doc.activeElement, input, "el campo del token, que pide foco con autoFocus, no debe perderlo frente al foco por defecto del modal");
  });
});

// ---------------------------------------------------------------------------
// Token de GitHub: opción de no recordarlo en el dispositivo.
// ---------------------------------------------------------------------------
test("sincronización: con «Recordar» marcado (por defecto), el token se guarda en localStorage", async () => {
  const gh = createFakeGithub({ token: "ghp_recordado" });
  await withDevice({ fetch: gh.fetch }, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder="ghp_..."]'), { message: "campo del token" });
    d.type(input, "ghp_recordado");
    const connect = d.buttons("Conectar");
    d.click(connect[connect.length - 1]);
    await d.waitFor(() => d.text().includes("Conectado a GitHub"), { message: "conexión a GitHub" });

    assert.strictEqual(d.win.localStorage.getItem(GH_TOKEN_KEY), "ghp_recordado");
    assert.strictEqual(d.win.sessionStorage.getItem(GH_TOKEN_KEY), null, "no debe quedar también en sessionStorage");
  });
});

test("sincronización: con «Recordar» desmarcado, el token solo queda en sessionStorage (no en localStorage)", async () => {
  const gh = createFakeGithub({ token: "ghp_solo_sesion" });
  await withDevice({ fetch: gh.fetch }, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder="ghp_..."]'), { message: "campo del token" });
    d.type(input, "ghp_solo_sesion");

    const checkbox = d.q('input[type="checkbox"]');
    assert.ok(checkbox, "casilla «Recordar este token»");
    assert.strictEqual(checkbox.checked, true, "por defecto debe estar marcada");
    d.click(checkbox); // un clic real alterna el checked, como haría la persona usuaria
    assert.strictEqual(checkbox.checked, false, "el clic la desmarca");

    const connect = d.buttons("Conectar");
    d.click(connect[connect.length - 1]);
    await d.waitFor(() => d.text().includes("Conectado a GitHub"), { message: "conexión a GitHub" });

    assert.strictEqual(d.win.localStorage.getItem(GH_TOKEN_KEY), null, "no debe quedar guardado en localStorage");
    assert.strictEqual(d.win.sessionStorage.getItem(GH_TOKEN_KEY), "ghp_solo_sesion", "debe quedar en sessionStorage mientras dure la pestaña");

    // Al desconectar, se limpia de los dos lugares.
    await d.closeModals();
    await d.openSettings();
    d.click(d.buttons("Gestionar")[0]);
    await d.waitFor(() => d.buttons("Desconectar")[0], { message: "botón Desconectar" });
    d.click(d.buttons("Desconectar")[0]);
    assert.strictEqual(d.win.sessionStorage.getItem(GH_TOKEN_KEY), null, "al desconectar se limpia también sessionStorage");
    assert.strictEqual(d.win.localStorage.getItem(GH_TOKEN_KEY), null);
  });
});

test("sincronización: al recargar con el token solo en sessionStorage (no recordado), la app arranca igual conectada", async () => {
  // Simula una pestaña que ya tenía el token guardado en sessionStorage (por
  // ejemplo, tras recargar la página sin haberla cerrado) pero nada en
  // localStorage: la app debería arrancar ya conectada igual, y poder
  // sincronizar con normalidad en lo que dure la pestaña.
  const gh = createFakeGithub({ token: "ghp_de_la_sesion" });
  gh.gists.set("gist-existente", {
    id: "gist-existente",
    description: "Mis DualSense",
    files: {
      "mis-dualsense-data.json": JSON.stringify([]),
      "mis-dualsense-deleted.json": JSON.stringify({ controllers: {}, issues: {} }),
    },
  });
  await withDevice(
    {
      fetch: gh.fetch,
      localStorage: { "mis-dualsense-gh-gist-id": "gist-existente" },
      sessionStorage: { [GH_TOKEN_KEY]: "ghp_de_la_sesion" },
    },
    async (d) => {
      await d.openSettings();
      assert.ok(d.text().includes("Conectado"), "arranca conectada usando el token de sessionStorage");
    }
  );
});
