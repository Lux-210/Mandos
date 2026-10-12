"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice, createFakeGithub } = require("./harness");

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
// Mensajes dinámicos (toasts y errores de validación) deben anunciarse a
// lectores de pantalla con role="status"/aria-live o role="alert".
// ---------------------------------------------------------------------------
test("accesibilidad: el contenedor de toasts se anuncia con role=status y aria-live", async () => {
  const gh = createFakeGithub({ token: "ghp_toast" });
  await withDevice({ fetch: gh.fetch }, async (d) => {
    await d.connectSync("ghp_toast");
    await d.waitFor(() => d.text().includes("Sincronización activada"), { message: "toast de confirmación" });
    const toastRegion = d.q('[role="status"][aria-live="polite"]');
    assert.ok(toastRegion, "el contenedor de toasts debe tener role=status y aria-live=polite");
    assert.ok(toastRegion.textContent.includes("Sincronización activada"));
  });
});

test("accesibilidad: el error de guardar un mando sin nombre se anuncia con role=alert", async () => {
  await withDevice({}, async (d) => {
    d.click(d.buttons("Nuevo mando")[0] || d.buttons("Agregar primer mando")[0]);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Mando principal"]'), { message: "modal de nuevo mando" });
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => d.q('[role="alert"]'), { message: "mensaje de error de validación" });
    assert.ok(d.q('[role="alert"]').textContent.includes("Ingresa un apodo"));
  });
});

test("accesibilidad: el error de guardar una falla sin descripción se anuncia con role=alert", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    await d.openController("Blanco");
    d.click(d.buttons("Agregar falla")[0]);
    await d.waitFor(() => d.q('input[placeholder^="Ej: Drift leve"]'), { message: "modal de nueva falla" });
    d.click(d.buttons("Guardar")[0]);
    await d.waitFor(() => d.q('[role="alert"]'), { message: "mensaje de error de validación" });
    assert.ok(d.q('[role="alert"]').textContent.includes("Ingresa una descripción"));
  });
});

test("accesibilidad: un error de sincronización (token inválido) se anuncia con role=alert", async () => {
  await withDevice({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) }) }, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder="ghp_..."]'));
    d.type(input, "ghp_invalido");
    const connect = d.buttons("Conectar");
    d.click(connect[connect.length - 1]);
    await d.waitFor(() => d.q('[role="alert"]'), { message: "mensaje de error de sincronización" });
  });
});
