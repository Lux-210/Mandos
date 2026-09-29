"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice, loadScripts } = require("./harness");

async function withDevice(spec, fn) {
  const d = await createDevice(spec);
  try {
    await fn(d);
    assert.deepStrictEqual(d.errors, [], "la app registró errores:\n" + d.errors.join("\n"));
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------
// Búsqueda de mandos ampliada (antes solo miraba el nombre)
// ---------------------------------------------------------------------------
test("logic: controllerMatchesQuery ahora también busca por color, serie, notas y a quién se le prestó", async () => {
  const dev = await createDevice({ startApp: false });
  const c = { nombre: "Mando 1", color: "Rojo (Cosmic Red)", numeroSerie: "44205G0123456", notes: "Tiene un rasguño en el gatillo", prestadoA: "Mi hermano" };
  const match = (raw) => dev.app.controllerMatchesQuery(c, dev.app.normalizeText(raw));
  assert.ok(match("mando 1"));
  assert.ok(match("cosmic"));
  assert.ok(match("44205g0123456"));
  assert.ok(match("rasguño"), "debe encontrarlo con o sin tilde, igual que el resto de la app");
  assert.ok(match("rasguno"));
  assert.ok(match("mi hermano"));
  assert.ok(!match("algo que no está en ningún campo"));
  dev.close();
});

test("interfaz: la búsqueda de mandos también encuentra por color, no solo por nombre", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    await d.addController("Negro especial", "Negro (Midnight Black)");
    await d.waitFor(() => d.text().includes("Negro especial"));

    const input = await d.waitFor(() => d.q('input[placeholder^="Buscar por nombre del mando"]'), { message: "campo de búsqueda de mandos" });
    d.type(input, "midnight");
    await d.wait(250); // el buscador tiene un pequeño debounce

    const hasCard = (name) => d.qa("h2, h3, p, span").some((el) => el.children.length === 0 && el.textContent.trim() === name);
    await d.waitFor(() => hasCard("Negro especial"), { message: "buscar por color encuentra el mando" });
    assert.ok(!hasCard("Blanco"), "el mando Blanco no debe aparecer como tarjeta (aunque «Blanco» siga listado en el selector de colores)");
  });
});

// ---------------------------------------------------------------------------
// Aviso de mando duplicado al guardar
// ---------------------------------------------------------------------------
test("interfaz: avisa si el nombre y color ya existen, y se puede guardar igual o revisar", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    d.click(d.buttons("Nuevo mando")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'));
    d.type(input, "Blanco");
    d.type(d.q('input[placeholder^="Ej: Blanco"]'), "Blanco");
    d.click(d.buttons("Guardar")[0]);

    await d.waitFor(() => d.text().includes("Ya existe un mando con el mismo nombre y color"), { message: "aviso de duplicado" });
    assert.strictEqual(d.buttons("Guardar").length, 0, "mientras se muestra el aviso, el botón Guardar normal se oculta");

    // "Revisar datos" vuelve al formulario sin haber guardado.
    d.click(d.buttons("Revisar datos")[0]);
    await d.waitFor(() => d.buttons("Guardar").length === 1, { message: "vuelve a mostrarse el botón Guardar" });
    assert.strictEqual((await d.readIDB("controllers")).length, 1, "todavía no se guardó el segundo mando");

    // Reintentar y esta vez confirmar "Guardar igual".
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => d.text().includes("Guardar igual"));
    d.click(d.buttons("Guardar igual")[0]);
    await d.waitFor(async () => ((await d.readIDB("controllers")) || []).length === 2, { message: "el segundo mando se guarda igual" });
  });
});

test("interfaz: avisa si el número de serie ya existe, aunque el nombre sea distinto", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco");
    d.click(d.byLabel("Editar mando")[0]);
    d.click(await d.waitFor(() => d.buttons("Editar")[0]));
    d.type(await d.waitFor(() => d.q('input[placeholder^="Ej: 44205"]')), "SN-0001");
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => !d.q('input[placeholder^="Ej: 44205"]'));

    d.click(d.buttons("Nuevo mando")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'));
    d.type(input, "Otro nombre");
    d.type(d.q('input[placeholder^="Ej: 44205"]'), "sn-0001"); // mismo, sin importar mayúsculas
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => d.text().includes("Ya existe un mando con el mismo número de serie"), { message: "aviso por número de serie" });
  });
});

test("interfaz: editar el mando propio (sin cambiar nada duplicado) no dispara una advertencia falsa", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    d.click(d.byLabel("Editar mando")[0]);
    d.click(await d.waitFor(() => d.buttons("Editar")[0]));
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'), { message: "modal de edición" });
    d.click(d.buttons("Guardar")[0]);
    await d.wait(80);
    assert.ok(!d.text().includes("Ya existe un mando"), "editar un mando no debe compararse consigo mismo");
  });
});

test("interfaz: cambiar el nombre después del aviso lo hace desaparecer (se vuelve a revisar)", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    d.click(d.buttons("Nuevo mando")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'));
    d.type(input, "Blanco");
    d.type(d.q('input[placeholder^="Ej: Blanco"]'), "Blanco");
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => d.text().includes("Ya existe un mando"));
    d.type(input, "Blanco 2");
    await d.waitFor(() => !d.text().includes("Ya existe un mando"), { message: "el aviso se limpia al seguir editando" });
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(async () => ((await d.readIDB("controllers")) || []).length === 2);
  });
});

// ---------------------------------------------------------------------------
// Aviso sobre el almacenamiento del token
// ---------------------------------------------------------------------------
test("interfaz: el paso de conexión explica que el token queda sin cifrar en el dispositivo", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    await d.waitFor(() => d.q('input[placeholder="ghp_..."]'));
    assert.ok(d.text().includes("guardado sin cifrar en este dispositivo"), d.text());
  });
});

// ---------------------------------------------------------------------------
// Aviso de "hay una versión nueva" del service worker
// ---------------------------------------------------------------------------
test("interfaz: al recibir el aviso del service worker, muestra una barra con «Recargar»", async () => {
  await withDevice({}, async (d) => {
    assert.ok(!d.text().includes("Recargar"), "sin aviso, la barra no debe aparecer");
    d.win.dispatchEvent(new d.win.CustomEvent("mis-dualsense-update-available"));
    await d.waitFor(() => d.text().includes("Hay una versión nueva de la app lista para usar."), { message: "banner de actualización" });
    // jsdom no soporta navegar de verdad (recargar la página): al hacer clic,
    // internamente registra un error esperado de "Not implemented: navigation"
    // que el arnés de pruebas ya filtra (ver harness.js), así que acá solo se
    // confirma que el clic no rompe nada más.
    d.click(d.buttons("Recargar")[0]);
    await d.wait(30);
  });
  const { app } = loadScripts();
  const bannerBlock = app.slice(app.indexOf("Hay una versión nueva de la app lista para usar."));
  assert.ok(bannerBlock.slice(0, 400).includes("window.location.reload()"), "el botón «Recargar» debe llamar a window.location.reload()");
});

test("registro del service worker: pide una actualización a la nueva versión sin perder la instalación anterior", () => {
  const { html } = loadScripts();
  const registerScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("navigator.serviceWorker.register"));
  assert.ok(registerScript, "no se encontró el <script> de registro del service worker");
  assert.ok(/addEventListener\(['"]updatefound['"]/.test(registerScript), "debe escuchar 'updatefound' para detectar una versión nueva");
  assert.ok(/mis-dualsense-update-available/.test(registerScript), "debe avisar a la app mediante el mismo evento que escucha React");
});
