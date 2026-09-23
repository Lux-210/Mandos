"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice, createFakeGithub } = require("./harness");

const BASE = 1700000000000;

// Ejecuta una prueba con dispositivos que se cierran al terminar y comprueba
// que la app no haya registrado errores.
async function withDevices(specs, fn) {
  const devices = [];
  try {
    for (const spec of specs) devices.push(await createDevice(spec));
    await fn(...devices);
    devices.forEach((d) => assert.deepStrictEqual(d.errors, [], "la app registró errores:\n" + d.errors.join("\n")));
  } finally {
    devices.forEach((d) => d.close());
  }
}

const idbControllers = (d) => d.readIDB("controllers");
const idbTombstones = (d) => d.readIDB("tombstones");

// Espera a que haya al menos "count" mandos guardados en IndexedDB.
const savedControllers = (d, count = 1) =>
  d.waitFor(async () => {
    const saved = await idbControllers(d);
    return saved && saved.length >= count ? saved : false;
  }, { message: "guardado en IndexedDB" });

async function deleteFirstController(d) {
  d.click(d.byLabel("Editar mando")[0]);
  d.click(await d.waitFor(() => d.buttons("Eliminar")[0], { message: "menú del mando" }));
  d.click(await d.waitFor(() => d.buttons("Sí")[0], { message: "confirmación" }));
  await d.waitFor(() => d.text().includes("Mando eliminado"), { message: "aviso de eliminación" });
}

// ---------------------------------------------------------------------------
// Uso normal
// ---------------------------------------------------------------------------
test("interfaz: arranca vacía, crea un mando y una falla, y los guarda con fecha de modificación", async () => {
  await withDevices([{}], async (d) => {
    assert.ok(d.text().includes("Todavía no tienes mandos guardados"));
    await d.addController("Blanco", "Blanco");
    await d.openController("Blanco");
    await d.addIssue("Drift leve");
    assert.ok(d.text().includes("Drift leve"));
    await d.waitFor(async () => {
      const saved = await idbControllers(d);
      return saved && saved.length === 1 && saved[0].issues.length === 1;
    }, { message: "guardado en IndexedDB" });
    const [saved] = await idbControllers(d);
    assert.ok(saved.updatedAt > 0, "el mando nuevo guarda updatedAt");
    assert.ok(saved.issues[0].updatedAt > 0);
  });
});

test("interfaz: eliminar un mando deja una marca y «Deshacer» la quita y lo restaura", async () => {
  await withDevices([{}], async (d) => {
    await d.addController("Blanco");
    const [{ id }] = await savedControllers(d);
    await deleteFirstController(d);
    const tomb = await d.waitFor(async () => {
      const t = await idbTombstones(d);
      return t && t.controllers[id] ? t : false;
    }, { message: "marca de eliminación guardada" });
    assert.ok(d.text().includes("Todavía no tienes mandos guardados"));

    d.click(d.buttons("Deshacer")[0]);
    await d.waitFor(() => d.text().includes("Blanco") && !d.text().includes("Todavía no tienes"), { message: "mando restaurado" });
    const after = await d.waitFor(async () => {
      const t = await idbTombstones(d);
      return t && !t.controllers[id] ? t : false;
    }, { message: "marca eliminada tras deshacer" });
    assert.deepStrictEqual(after.controllers, {});
    const [restored] = await savedControllers(d);
    assert.ok(restored.updatedAt > tomb.controllers[id], "el mando restaurado queda más nuevo que la marca");
  });
});

test("interfaz: eliminar una falla deja una marca y «Deshacer» la restaura", async () => {
  await withDevices([{}], async (d) => {
    await d.addController("Blanco");
    await d.openController("Blanco");
    await d.addIssue("Drift leve");
    const issueId = (await d.waitFor(async () => {
      const s = await idbControllers(d);
      return s && s[0].issues.length ? s : false;
    }))[0].issues[0].id;

    d.click(d.byLabel("Eliminar falla")[0]);
    d.click(await d.waitFor(() => d.buttons("Sí")[0], { message: "confirmación de la falla" }));
    await d.waitFor(() => d.text().includes("Falla eliminada"), { message: "aviso" });
    await d.waitFor(async () => ((await idbTombstones(d)) || { issues: {} }).issues[issueId], { message: "marca de la falla" });

    d.click(d.buttons("Deshacer")[0]);
    await d.waitFor(async () => {
      const s = await idbControllers(d);
      const t = await idbTombstones(d);
      return s[0].issues.length === 1 && !t.issues[issueId];
    }, { message: "falla restaurada y marca anulada" });
  });
});

test("interfaz: muestra si el almacenamiento quedó protegido o no", async () => {
  await withDevices([{ storage: { persisted: async () => false, persist: async () => true } }], async (d) => {
    await d.openSettings();
    await d.waitFor(() => d.text().includes("Almacenamiento protegido"), { message: "estado protegido" });
  });
  await withDevices([{ storage: { persisted: async () => false, persist: async () => false } }], async (d) => {
    await d.openSettings();
    await d.waitFor(() => d.text().includes("Almacenamiento sin protección"), { message: "estado sin protección" });
  });
  await withDevices([{}], async (d) => {
    await d.openSettings();
    assert.ok(!d.text().includes("Almacenamiento"), "sin soporte del navegador no se muestra nada");
  });
});

// ---------------------------------------------------------------------------
// Importar CSV
// ---------------------------------------------------------------------------
async function chooseCSV(d, content, name = "mandos.csv") {
  await d.openSettings();
  d.click(d.buttons("Importar")[0]);
  const csvButton = await d.waitFor(() => d.buttons("Importar CSV")[0], { message: "botón Importar CSV" });
  assert.ok(d.buttons("Importar JSON")[0], "el botón de JSON sigue disponible");
  d.click(csvButton);
  await d.waitFor(() => !d.text().includes("Apariencia"), { message: "cierre de Configuración" });
  await d.chooseFile(d.q('input[aria-label="Archivo CSV para importar"]'), { name, content, type: "text/csv" });
}

test("importar CSV: en una app vacía agrega todo directamente", async () => {
  await withDevices([{}], async (d) => {
    await chooseCSV(d, "Mando,Color,Falla,Tipo de falla\nBlanco,Blanco,Drift leve,Drift joystick derecho\nNegro,Negro (Midnight Black),,\n");
    await d.waitFor(() => d.text().includes("Mandos importados"), { message: "aviso de importación" });
    assert.ok(d.text().includes("Blanco") && d.text().includes("Negro"));
    assert.ok(d.text().includes("2 MANDOS · 1 FALLA"), d.text().slice(0, 300));
  });
});

test("importar CSV: con datos previos pide confirmar, resume y se puede deshacer", async () => {
  await withDevices([{}], async (d) => {
    await d.addController("Blanco", "Blanco");
    await savedControllers(d);
    await chooseCSV(d, "Mando,Color,Falla\nBlanco,Blanco,Gatillo duro\nNegro,Negro (Midnight Black),Botón X\nRojo,Rojo,Batería\n");
    await d.waitFor(() => d.text().includes("Importar mandos"), { message: "diálogo de confirmación" });
    assert.ok(d.text().includes("Se agregarán 2 mandos nuevos"), d.text());
    assert.ok(d.text().includes("Se combinarán las fallas de 1 mando existente"), d.text());
    assert.ok(d.text().includes("Esta acción se puede deshacer."));
    assert.ok(!d.text().includes("Avisos sobre el archivo"), "sin problemas no hay avisos");
    d.click(d.buttons("Importar")[0]);
    await d.waitFor(() => d.text().includes("Mandos importados"), { message: "aviso" });
    assert.ok(d.text().includes("3 MANDOS · 3 FALLAS"), d.text().slice(0, 300));
    await savedControllers(d, 3);

    d.click(d.buttons("Deshacer")[0]);
    await d.waitFor(() => d.text().includes("1 MANDO · 0 FALLAS"), { message: "importación deshecha" });
    const tomb = await d.waitFor(async () => {
      const t = await idbTombstones(d);
      return t && Object.keys(t.controllers).length === 2 ? t : false;
    }, { message: "los mandos quitados quedan marcados como eliminados" });
    assert.strictEqual(Object.keys(tomb.issues).length, 1, "también la falla agregada a un mando existente");
  });
});

test("importar CSV: muestra avisos cuando hay valores que no se entienden", async () => {
  await withDevices([{}], async (d) => {
    await chooseCSV(d, "Mando;Estado;Fin de garantía\nBlanco;roto;31/02/2026\n");
    await d.waitFor(() => d.text().includes("Avisos sobre el archivo"), { message: "avisos" });
    assert.ok(d.text().includes("Estados de mando no reconocidos"), d.text());
    assert.ok(d.text().includes("Fechas no reconocidas"), d.text());
    d.click(d.buttons("Importar")[0]);
    await d.waitFor(() => d.text().includes("Mandos importados"), { message: "importado igualmente" });
  });
});

test("importar CSV: un archivo sin columna «Mando» muestra el motivo", async () => {
  await withDevices([{}], async (d) => {
    await chooseCSV(d, "Color,Estado\nRojo,Activo\n");
    await d.waitFor(() => d.text().includes("No se pudo importar"), { message: "diálogo de error" });
    assert.ok(d.text().includes("No se pudo importar el CSV."), d.text());
    assert.ok(d.text().includes("«Mando»"), d.text());
    d.click(d.buttons("Entendido")[0]);
    await d.waitFor(() => !d.text().includes("No se pudo importar"));
  });
});

test("importar JSON: sigue funcionando y le gana a una marca de eliminación vieja", async () => {
  const removed = { id: "viejo", nombre: "Mando borrado", updatedAt: BASE, issues: [] };
  await withDevices(
    [{ seed: { controllers: [], tombstones: { controllers: { viejo: BASE + 5000 }, issues: {} } } }],
    async (d) => {
      await d.openSettings();
      d.click(d.buttons("Importar")[0]);
      d.click(await d.waitFor(() => d.buttons("Importar JSON")[0]));
      await d.waitFor(() => !d.text().includes("Apariencia"));
      await d.chooseFile(d.q('input[accept=".json"]'), { name: "copia.json", content: JSON.stringify([removed]), type: "application/json" });
      await d.waitFor(() => d.text().includes("Mando borrado"), { message: "mando importado" });
      await d.waitFor(async () => {
        const t = await idbTombstones(d);
        return t && !t.controllers.viejo;
      }, { message: "la marca vieja se anula" });
      const [saved] = await savedControllers(d);
      assert.ok(saved.updatedAt > BASE + 5000, "queda más nuevo que la marca");
    }
  );
});

// ---------------------------------------------------------------------------
// Sincronización entre dispositivos (con un GitHub falso compartido)
// ---------------------------------------------------------------------------
test("sync: al conectar se crea el gist con los dos archivos y otro dispositivo recibe los datos", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco", "Blanco");
    await a.connectSync();
    assert.strictEqual(gh.gists.size, 1);
    const stored = gh.read();
    assert.deepStrictEqual(stored.controllers.map((c) => c.nombre), ["Blanco"]);
    assert.deepStrictEqual(stored.tombstones, { controllers: {}, issues: {} });

    await b.connectSync();
    await b.waitFor(() => b.text().includes("Blanco"), { message: "B recibe el mando de A" });
    assert.strictEqual(gh.gists.size, 1, "B reutiliza el mismo gist");
  });
});

test("sync: los cambios de un dispositivo (favorito y edición) llegan al otro", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco");
    await a.connectSync();
    await b.connectSync();
    await b.waitFor(() => b.text().includes("Blanco"));

    // A marca favorito y cambia el nombre.
    a.click(a.byLabel("Marcar como favorito")[0]);
    a.click(a.byLabel("Editar mando")[0]);
    a.click(await a.waitFor(() => a.buttons("Editar")[0], { message: "menú de A" }));
    const nameInput = await a.waitFor(() => a.q('input[placeholder^="Ej: Mando principal"]'), { message: "edición" });
    a.type(nameInput, "Blanco Pro");
    a.click(a.buttons("Guardar")[0]);
    await a.waitFor(() => a.text().includes("Blanco Pro"));
    await a.syncNow();
    await b.syncNow();

    assert.ok(b.text().includes("Blanco Pro"), "B ve el nombre nuevo");
    assert.strictEqual(b.byLabel("Quitar de favoritos").length, 1, "B ve el favorito");
  });
});

test("sync: eliminar un mando en un dispositivo lo elimina en el otro y no reaparece", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco");
    await a.connectSync();
    await b.connectSync();
    await b.waitFor(() => b.text().includes("Blanco"));

    await deleteFirstController(a);
    await a.syncNow();
    await b.syncNow();
    assert.ok(b.text().includes("Todavía no tienes mandos guardados"), "B ya no tiene el mando");

    // Sincronizaciones posteriores en ambos lados no lo traen de vuelta.
    await a.syncNow();
    await b.syncNow();
    assert.ok(a.text().includes("Todavía no tienes mandos guardados"));
    assert.ok(b.text().includes("Todavía no tienes mandos guardados"));
    const stored = gh.read();
    assert.deepStrictEqual(stored.controllers, []);
    assert.strictEqual(Object.keys(stored.tombstones.controllers).length, 1);
  });
});

test("sync: una eliminación ya sincronizada gana aunque el otro dispositivo no haya estado al tanto", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco");
    await a.connectSync();
    await b.connectSync();
    await b.waitFor(() => b.text().includes("Blanco"));

    // A elimina y sincroniza mientras B "estaba sin conexión" (sin sincronizar).
    await deleteFirstController(a);
    await a.syncNow();

    // Al volver, B todavía tiene el mando (sin cambios): debe desaparecer, no revivir.
    await b.syncNow();
    assert.ok(b.text().includes("Todavía no tienes mandos guardados"));
    assert.deepStrictEqual(gh.read().controllers, []);
  });
});

test("sync: fallas nuevas y eliminadas viajan entre dispositivos", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco");
    await a.openController("Blanco");
    await a.addIssue("Drift leve");
    await a.backToList();
    await a.connectSync();
    await b.connectSync();
    await b.openController("Blanco");
    await b.waitFor(() => b.text().includes("Drift leve"), { message: "B ve la falla de A" });

    // B elimina la falla; A la recibe.
    b.click(b.byLabel("Eliminar falla")[0]);
    b.click(await b.waitFor(() => b.buttons("Sí")[0]));
    await b.waitFor(() => b.text().includes("Falla eliminada"));
    await b.backToList();
    await b.syncNow();
    await a.syncNow();
    await a.openController("Blanco");
    assert.ok(!a.text().includes("Drift leve"), "A ya no tiene la falla");
    assert.strictEqual(Object.keys(gh.read().tombstones.issues).length, 1);
  });
});

test("sync: cambios hechos a la vez en dos dispositivos se combinan sin perder ninguno", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }, { fetch: gh.fetch }], async (a, b) => {
    await a.addController("Blanco");
    await a.connectSync();
    await b.connectSync();
    await b.waitFor(() => b.text().includes("Blanco"));

    // Sin sincronizar entre medio: A marca favorito, B agrega otro mando.
    a.click(a.byLabel("Marcar como favorito")[0]);
    await b.addController("Negro");
    await a.syncNow();
    await b.syncNow(); // antes de este cambio, la subida de B pisaba lo de A
    await a.syncNow();

    assert.ok(a.text().includes("Negro"), "A recibió el mando de B");
    assert.strictEqual(b.byLabel("Quitar de favoritos").length, 1, "B recibió el favorito de A");
    const stored = gh.read();
    assert.deepStrictEqual(stored.controllers.map((c) => c.nombre).sort(), ["Blanco", "Negro"]);
    assert.ok(stored.controllers.find((c) => c.nombre === "Blanco").favorite);
  });
});

test("sync: los cambios se envían solos poco después de hacerlos", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }], async (a) => {
    await a.addController("Blanco");
    await a.connectSync();
    await a.wait(300);
    const before = gh.patchCount();
    a.click(a.byLabel("Marcar como favorito")[0]);
    await a.waitFor(() => gh.patchCount() > before, { timeout: 6000, message: "envío automático" });
    assert.ok(gh.read().controllers[0].favorite);
  });
});

test("sync: si no hay nada nuevo no se sube nada", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }], async (a) => {
    await a.addController("Blanco");
    await a.connectSync();
    await a.wait(2800); // deja pasar el envío automático pendiente
    await a.syncNow();
    const before = gh.patchCount();
    await a.syncNow();
    await a.syncNow();
    assert.strictEqual(gh.patchCount(), before, "sincronizar sin cambios no debe generar subidas");
  });
});

test("sync: un gist creado por una versión anterior (sin marcas) se lee y se completa", async () => {
  const gh = createFakeGithub();
  gh.gists.set("viejo", {
    id: "viejo",
    description: "Mis DualSense — datos (no editar a mano)",
    files: {
      "mis-dualsense-data.json": JSON.stringify([
        { id: "x1", nombre: "Mando antiguo", ps5Model: "PS5", issues: [{ id: "f1", titulo: "Ruido", createdAt: BASE }] },
      ]),
    },
  });
  await withDevices([{ fetch: gh.fetch }], async (a) => {
    await a.connectSync();
    await a.waitFor(() => a.text().includes("Mando antiguo"), { message: "carga del gist antiguo" });
    const stored = gh.read("viejo");
    assert.strictEqual(stored.controllers[0].consolaOrigen, "PS5", "se migra el dato antiguo");
    assert.deepStrictEqual(stored.tombstones, { controllers: {}, issues: {} }, "se crea el archivo de marcas");
  });
});

test("sync: un token inválido muestra el error en español", async () => {
  const gh = createFakeGithub();
  await withDevices([{ fetch: gh.fetch }], async (a) => {
    await a.openSettings();
    a.click(a.buttons("Conectar")[0]);
    a.type(await a.waitFor(() => a.q('input[placeholder="ghp_..."]')), "token-malo");
    const connect = a.buttons("Conectar");
    a.click(connect[connect.length - 1]);
    await a.waitFor(() => a.text().includes("El token no es válido o fue revocado."), { message: "mensaje de error" });
  });
});
