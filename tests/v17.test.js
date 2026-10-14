"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice } = require("./harness");

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
// Botón/gesto "Atrás" del navegador: clave en una PWA instalada en Android.
// Con un modal abierto, "Atrás" debe cerrarlo en vez de salir de la app.
// ---------------------------------------------------------------------------
test("atajos: el botón Atrás del navegador cierra el modal de nuevo mando en vez de salir de la app", async () => {
  await withDevice({}, async (d) => {
    d.click(d.buttons("Nuevo mando")[0] || d.buttons("Agregar primer mando")[0]);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'), { message: "modal de nuevo mando abierto" });

    d.win.history.back();
    await d.waitFor(() => !d.q('input[placeholder^="Ej: Mando principal"]'), { message: "Atrás debe cerrar el modal" });
  });
});

test("atajos: el botón Atrás también cierra el modal de Configuración", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    assert.ok(d.text().includes("Apariencia"));

    d.win.history.back();
    await d.waitFor(() => !d.text().includes("Apariencia"), { message: "Atrás debe cerrar Configuración" });
  });
});

test("atajos: cerrar un modal con el botón Cerrar retira la entrada de historial agregada al abrirlo", async () => {
  await withDevice({}, async (d) => {
    d.click(d.buttons("Nuevo mando")[0] || d.buttons("Agregar primer mando")[0]);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'));
    d.click(d.byLabel("Cerrar")[0]);
    await d.waitFor(() => !d.q('input[placeholder^="Ej: Mando principal"]'), { message: "se cierra con el botón Cerrar" });
    // Como el modal se cerró "a mano" (no con Atrás), la propia app debió
    // retirar con history.back() la entrada de relleno que había agregado al
    // abrirlo, dejando el historial listo para un siguiente modal sin
    // acumular entradas de más.
    await d.wait(50); // deja un respiro al history.back() asíncrono de jsdom
    d.click(d.buttons("Nuevo mando")[0]);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'), { message: "se puede volver a abrir el modal con normalidad" });
    d.win.history.back();
    await d.waitFor(() => !d.q('input[placeholder^="Ej: Mando principal"]'), { message: "Atrás sigue funcionando después de un ciclo previo de abrir/cerrar" });
  });
});

test("atajos: tras cerrar Configuración con Escape, un «Atrás» de más no saca de la app silenciosamente", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    await d.openSettings();
    await d.closeModals(); // usa Escape internamente
    await d.wait(50);
    assert.ok(!d.text().includes("Apariencia"), "Configuración debe quedar cerrada");
    // No debe quedar ningún modal abierto esperando un segundo "Atrás".
    assert.ok(d.qa('[role="dialog"]').length === 0, "no debe quedar ningún diálogo abierto");
  });
});
