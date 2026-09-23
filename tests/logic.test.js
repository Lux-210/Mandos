"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice, loadScripts } = require("./harness");

// Los objetos que devuelve la app vienen de otro "mundo" (la ventana de
// jsdom): se pasan por JSON para poder compararlos con deepStrictEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

const BASE = 1700000000000; // una fecha fija cualquiera
const DAY = 86400000;

let sharedDevice = null;
async function App() {
  if (!sharedDevice) sharedDevice = await createDevice({ startApp: false });
  return sharedDevice.app;
}

// Arma mandos "de laboratorio" pasándolos por la normalización real de la app.
async function build(list) {
  const app = await App();
  return plain(app.normalizeImportedControllers(list));
}

const controllerOf = (id, extra = {}, issues = []) => ({ id, nombre: id, updatedAt: 0, ...extra, issues });
const issueOf = (id, updatedAt, extra = {}) => ({ id, titulo: id, createdAt: updatedAt, updatedAt, ...extra });
const NO_TOMBSTONES = () => ({ controllers: {}, issues: {} });

// ---------------------------------------------------------------------------
// Datos guardados por versiones anteriores
// ---------------------------------------------------------------------------
test("normalizar: migra datos antiguos y completa los campos nuevos", async () => {
  const [c] = await build([
    { id: "a", nombre: "Viejo", ps5Model: "Comprado por separado", issues: [{ id: "i1", titulo: "Drift", status: "estado-raro" }] },
  ]);
  assert.strictEqual(c.consolaOrigen, "Comprado");
  assert.strictEqual(c.updatedAt, 0, "un mando sin updatedAt vale 0");
  assert.strictEqual(c.issues[0].status, "detectado");
  assert.strictEqual(c.issues[0].statusHistory.length, 1);
  const [d] = await build([{ id: "b", updatedAt: 1234, issues: [] }]);
  assert.strictEqual(d.updatedAt, 1234, "conserva el updatedAt cuando existe");
});

test("importar archivo: solo agrega, nunca pisa lo que ya existe", async () => {
  const app = await App();
  const current = await build([controllerOf("c1", { nombre: "Blanco" }, [issueOf("i1", 10, { titulo: "Drift" })])]);
  const imported = await build([
    controllerOf("c1", { nombre: "Otro nombre" }, [issueOf("i1", 20, { titulo: "Drift" }), issueOf("i2", 20, { titulo: "Drift" }), issueOf("i3", 20, { titulo: "Gatillo" })]),
    controllerOf("c2", { nombre: "Negro" }),
  ]);
  const result = plain(app.mergeImportedControllers(current, imported));
  assert.strictEqual(result.newCount, 1);
  assert.strictEqual(result.mergedCount, 1);
  assert.strictEqual(result.skippedIssuesCount, 1, "i1 ya estaba");
  assert.strictEqual(result.renamedIssuesCount, 1, "i2 repite la descripción de i1");
  assert.strictEqual(result.controllers[0].nombre, "Blanco", "no se pisan los datos del mando existente");
  assert.deepStrictEqual(result.controllers[0].issues.map((i) => i.titulo), ["Drift", "Drift (2)", "Gatillo"]);
  assert.deepStrictEqual(result.addedControllerIds, ["c2"]);
});

// ---------------------------------------------------------------------------
// Sincronización: fusión por fecha de modificación
// ---------------------------------------------------------------------------
test("sync: agrega lo que solo existe en un lado y conserva lo local", async () => {
  const app = await App();
  const local = await build([controllerOf("solo-local"), controllerOf("ambos", { updatedAt: BASE })]);
  const remote = await build([controllerOf("ambos", { updatedAt: BASE }), controllerOf("solo-remoto")]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), remote, NO_TOMBSTONES(), BASE + 1000));
  assert.deepStrictEqual(merged.controllers.map((c) => c.id), ["solo-local", "ambos", "solo-remoto"], "el orden local se respeta");
});

test("sync: en los datos del mando gana la modificación más reciente (y en empate, la local)", async () => {
  const app = await App();
  const mk = async (nombre, updatedAt) => (await build([controllerOf("c", { nombre, updatedAt })]))[0];
  const check = async (localAt, remoteAt) => {
    const local = [await mk("Local", localAt)];
    const remote = [await mk("Remota", remoteAt)];
    return plain(app.mergeForSync(local, NO_TOMBSTONES(), remote, NO_TOMBSTONES(), BASE + 1000)).controllers[0].nombre;
  };
  assert.strictEqual(await check(BASE + 100, BASE + 200), "Remota");
  assert.strictEqual(await check(BASE + 300, BASE + 200), "Local");
  assert.strictEqual(await check(BASE + 200, BASE + 200), "Local");
  assert.strictEqual(await check(0, 0), "Local", "los mandos antiguos (updatedAt 0) empatan y se queda el local");
});

test("sync: cada falla se resuelve por separado y no se pierde ninguna", async () => {
  const app = await App();
  const local = await build([controllerOf("c", {}, [issueOf("i1", BASE + 10, { titulo: "A" }), issueOf("i2", BASE + 50, { titulo: "B local" })])]);
  const remote = await build([controllerOf("c", {}, [issueOf("i2", BASE + 60, { titulo: "B remota" }), issueOf("i3", BASE + 5, { titulo: "C" })])]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), remote, NO_TOMBSTONES(), BASE + 1000));
  assert.deepStrictEqual(merged.controllers[0].issues.map((i) => i.titulo), ["A", "B remota", "C"]);
});

test("sync: una eliminación hecha en otro dispositivo se propaga", async () => {
  const app = await App();
  const local = await build([controllerOf("c", { updatedAt: BASE + 100 }, [issueOf("i", BASE + 50)])]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), [], { controllers: { c: BASE + 200 }, issues: {} }, BASE + 1000));
  assert.deepStrictEqual(merged.controllers, []);
  assert.deepStrictEqual(merged.tombstones.controllers, { c: BASE + 200 }, "la marca se conserva para otros dispositivos");
});

test("sync: si se editó después de eliminarlo, gana la edición y el mando vuelve", async () => {
  const app = await App();
  const local = await build([controllerOf("c", { updatedAt: BASE + 300 })]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), [], { controllers: { c: BASE + 200 }, issues: {} }, BASE + 1000));
  assert.strictEqual(merged.controllers.length, 1);
  assert.deepStrictEqual(merged.tombstones.controllers, {}, "la marca queda anulada");
});

test("sync: una falla modificada después de eliminar el mando lo mantiene vivo", async () => {
  const app = await App();
  const local = await build([controllerOf("c", { updatedAt: BASE + 100 }, [issueOf("i", BASE + 500)])]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), [], { controllers: { c: BASE + 300 }, issues: {} }, BASE + 1000));
  assert.strictEqual(merged.controllers.length, 1);
});

test("sync: eliminar una falla no toca las demás ni las que se editaron después", async () => {
  const app = await App();
  const local = await build([controllerOf("c", {}, [issueOf("i1", BASE + 100), issueOf("i2", BASE + 400), issueOf("i3", BASE + 100)])]);
  const merged = plain(app.mergeForSync(local, NO_TOMBSTONES(), [], { controllers: {}, issues: { i1: BASE + 200, i2: BASE + 200 } }, BASE + 1000));
  assert.deepStrictEqual(merged.controllers[0].issues.map((i) => i.id), ["i2", "i3"]);
  assert.deepStrictEqual(merged.tombstones.issues, { i1: BASE + 200 });
});

test("sync: las marcas de eliminación se descartan a los 180 días", async () => {
  const app = await App();
  const maxAge = app.TOMBSTONE_MAX_AGE_MS;
  assert.strictEqual(maxAge, 180 * DAY);
  const kept = plain(app.pruneTombstones({ controllers: { a: BASE }, issues: {} }, BASE + maxAge - 1));
  const dropped = plain(app.pruneTombstones({ controllers: { a: BASE }, issues: { b: BASE } }, BASE + maxAge + 1));
  assert.deepStrictEqual(kept.controllers, { a: BASE });
  assert.deepStrictEqual(dropped, { controllers: {}, issues: {} });
});

test("sync: repetir la fusión no cambia nada (es estable)", async () => {
  const app = await App();
  const local = await build([controllerOf("a", { nombre: "L", updatedAt: BASE + 5 }, [issueOf("i1", BASE + 9)]), controllerOf("z", { updatedAt: BASE })]);
  const remote = await build([controllerOf("a", { nombre: "R", updatedAt: BASE + 3 }, [issueOf("i2", BASE + 2)]), controllerOf("b", { updatedAt: BASE })]);
  const tombstones = { controllers: { z: BASE + 1 }, issues: {} };
  const once = plain(app.mergeForSync(local, NO_TOMBSTONES(), remote, tombstones, BASE + 1000));
  const twice = plain(app.mergeForSync(once.controllers, once.tombstones, remote, tombstones, BASE + 1000));
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(app.stableStringify(twice), app.stableStringify(once));
});

test("sync: la huella no depende del orden ni de cómo se crearon las propiedades", async () => {
  const app = await App();
  const a = await build([controllerOf("a", {}, [issueOf("i1", BASE), issueOf("i2", BASE)]), controllerOf("b")]);
  const shuffled = plain(a).reverse().map((c) => ({ ...Object.fromEntries(Object.entries(c).reverse()), issues: [...c.issues].reverse() }));
  assert.strictEqual(app.syncSignature(a, NO_TOMBSTONES()), app.syncSignature(shuffled, NO_TOMBSTONES()));
  const changed = plain(a);
  changed[0].nombre = "otro";
  assert.notStrictEqual(app.syncSignature(a, NO_TOMBSTONES()), app.syncSignature(changed, NO_TOMBSTONES()));
  assert.notStrictEqual(app.syncSignature(a, NO_TOMBSTONES()), app.syncSignature(a, { controllers: { x: 1 }, issues: {} }));
});

test("importar: lo importado le gana a una marca de eliminación vieja", async () => {
  const app = await App();
  const imported = await build([controllerOf("c", { updatedAt: BASE + 100 }, [issueOf("i", BASE + 50)])]);

  // Marca solo del mando: se le sube la fecha para que quede por encima.
  const onlyController = { controllers: { c: BASE + 500 }, issues: {} };
  const revivedController = plain(app.reviveFromTombstones(imported, onlyController));
  assert.strictEqual(revivedController.controllers[0].updatedAt, BASE + 501);
  assert.deepStrictEqual(revivedController.tombstones, { controllers: {}, issues: {} });
  const mergedController = plain(app.mergeForSync(revivedController.controllers, revivedController.tombstones, [], onlyController, BASE + 1000));
  assert.strictEqual(mergedController.controllers.length, 1, "sobrevive a una sincronización que aún trae la marca vieja");

  // Marca de una falla (y del mando): la falla vuelve a ser más nueva que ambas marcas.
  const both = { controllers: { c: BASE + 500 }, issues: { i: BASE + 600 } };
  const revivedBoth = plain(app.reviveFromTombstones(imported, both));
  assert.strictEqual(revivedBoth.controllers[0].issues[0].updatedAt, BASE + 601);
  assert.deepStrictEqual(revivedBoth.tombstones, { controllers: {}, issues: {} });
  const mergedBoth = plain(app.mergeForSync(revivedBoth.controllers, revivedBoth.tombstones, [], both, BASE + 1000));
  assert.strictEqual(mergedBoth.controllers.length, 1);
  assert.strictEqual(mergedBoth.controllers[0].issues.length, 1);

  // Lo que no tiene marcas no se toca (ni se cambia su identidad).
  const untouched = plain(app.reviveFromTombstones(imported, { controllers: {}, issues: {} }));
  assert.deepStrictEqual(untouched.controllers, imported);
});

// ---------------------------------------------------------------------------
// CSV: lectura básica
// ---------------------------------------------------------------------------
test("CSV: lee comillas, comas, saltos de línea y comillas dobles", async () => {
  const app = await App();
  const text = 'a,b,c\r\n"x, y","dijo ""hola""","línea 1\nlínea 2"\r\n1,2,3\r\n';
  assert.deepStrictEqual(plain(app.parseCSVRows(text, ",")), [
    ["a", "b", "c"],
    ["x, y", 'dijo "hola"', "línea 1\nlínea 2"],
    ["1", "2", "3"],
  ]);
});

test("CSV: detecta coma, punto y coma y tabulador (ignorando lo que está entre comillas)", async () => {
  const app = await App();
  assert.strictEqual(app.detectCSVDelimiter("Mando,Color\nx,y"), ",");
  assert.strictEqual(app.detectCSVDelimiter("Mando;Color;Estado\nx;y;z"), ";");
  assert.strictEqual(app.detectCSVDelimiter('"a,b,c";d'), ";");
  assert.strictEqual(app.detectCSVDelimiter("Mando\tColor\nx\ty"), "\t");
  assert.strictEqual(app.detectCSVDelimiter("solo una columna"), ",");
});

test("CSV: importes con distintos formatos", async () => {
  const app = await App();
  const cases = [
    ["59990", 59990], ["59.990", 59990], ["59,990", 59990], ["$ 59.990", 59990], ["59.990,50", 59990.5],
    ["1,234.5", 1234.5], ["12,5", 12.5], ["12.5", 12.5], ["0.500", 0.5], ["0", 0],
    ["abc", null], ["", null], ["-5", null],
  ];
  cases.forEach(([input, expected]) => assert.strictEqual(app.parseCSVNumber(input), expected, "importe " + JSON.stringify(input)));
});

test("CSV: fechas en día/mes/año y en ISO; rechaza las imposibles", async () => {
  const app = await App();
  const d = (y, m, day) => new Date(y, m - 1, day).getTime();
  assert.strictEqual(app.parseCSVDate("19/09/2026"), d(2026, 9, 19));
  assert.strictEqual(app.parseCSVDate("19-09-2026"), d(2026, 9, 19));
  assert.strictEqual(app.parseCSVDate("2026-09-19"), d(2026, 9, 19));
  assert.strictEqual(app.parseCSVDate("5/3/26"), d(2026, 3, 5));
  assert.strictEqual(app.parseCSVDate("19/09/2026 10:30"), d(2026, 9, 19));
  assert.strictEqual(app.parseCSVDate("31/02/2026"), null);
  assert.strictEqual(app.parseCSVDate("ayer"), null);
  assert.strictEqual(app.parseCSVDate(""), null);
});

test("CSV: entiende archivos guardados en Windows-1252 además de UTF-8", async () => {
  const dev = await createDevice({ startApp: false });
  const toBuffer = (bytes) => dev.win.Uint8Array.from(bytes).buffer;
  assert.strictEqual(dev.app.decodeCSVBuffer(toBuffer(Buffer.from("Batería ñ", "utf8"))), "Batería ñ");
  assert.strictEqual(dev.app.decodeCSVBuffer(toBuffer(Buffer.from("Batería ñ", "latin1"))), "Batería ñ");
  dev.close();
});

// ---------------------------------------------------------------------------
// CSV: exportar y volver a importar
// ---------------------------------------------------------------------------
const midnight = (y, m, d) => new Date(y, m - 1, d).getTime();

async function richData() {
  return build([
    {
      id: "m1", nombre: "Mando, principal", color: "Rojo (Cosmic Red)", colorHex: "#7d1d1d",
      consolaOrigen: "PS5 Slim", consolaActual: "PS5 Pro", edicionTipo: "limitada", edicionNombre: "God of War Ragnarök",
      precioCompra: 65000, fechaCompra: midnight(2025, 3, 5), finGarantia: midnight(2027, 3, 5), numeroSerie: "44205G0123456",
      notes: "Se lo presté\ndos veces", favorite: true, estado: "prestado", prestadoA: "Mi hermano", prestadoDesde: midnight(2026, 8, 1), updatedAt: BASE,
      issues: [
        { id: "f1", titulo: "Drift leve, hacia la derecha", tipo: "Drift joystick derecho", status: "en_reparacion", notes: 'Dice "raro"', costo: 8000, urgente: true, createdAt: midnight(2026, 1, 10), updatedAt: midnight(2026, 2, 1), tags: ["garantía", "service"], reminder: midnight(2026, 10, 1) },
        { id: "f2", titulo: "Gatillo L2 duro", tipo: "Gatillo L2", status: "resuelto", createdAt: midnight(2026, 4, 2), updatedAt: midnight(2026, 4, 2) },
      ],
    },
    { id: "m2", nombre: "Blanco", color: "Blanco", estado: "guardado", updatedAt: BASE, issues: [] },
  ]);
}

function toCSVText(app, controllers) {
  return app.buildControllersCSVRows(controllers).map((row) => row.map(app.csvEscape).join(",")).join("\r\n");
}

test("CSV: exportar e importar conserva todos los datos (y los ID)", async () => {
  const app = await App();
  const original = await richData();
  const result = app.buildCSVImport("\uFEFF" + toCSVText(app, original), []);
  assert.deepStrictEqual(plain(result.warnings), []);
  const imported = plain(result.controllers);
  assert.strictEqual(imported.length, 2);
  const [m1, m2] = imported;
  const o = original[0];
  ["id", "nombre", "color", "colorHex", "consolaOrigen", "consolaActual", "edicionTipo", "edicionNombre", "precioCompra", "fechaCompra",
    "finGarantia", "numeroSerie", "notes", "favorite", "estado", "prestadoA", "prestadoDesde"].forEach((field) =>
    assert.deepStrictEqual(m1[field], o[field], "campo del mando: " + field)
  );
  assert.strictEqual(m1.issues.length, 2);
  o.issues.forEach((issue, i) => {
    ["id", "titulo", "tipo", "status", "notes", "costo", "urgente", "tags", "reminder", "createdAt", "updatedAt"].forEach((field) =>
      assert.deepStrictEqual(m1.issues[i][field], issue[field], "campo de la falla " + issue.id + ": " + field)
    );
  });
  assert.strictEqual(m2.id, "m2");
  assert.strictEqual(m2.issues.length, 0, "un mando sin fallas también se conserva");
  assert.strictEqual(m2.estado, "guardado");
});

test("CSV: volver a importar el mismo archivo no duplica ni cambia nada", async () => {
  const app = await App();
  const original = await richData();
  const { controllers } = app.buildCSVImport(toCSVText(app, original), original);
  const merge = plain(app.mergeImportedControllers(original, controllers));
  assert.strictEqual(merge.newCount, 0);
  assert.strictEqual(merge.skippedIssuesCount, 2);
  assert.strictEqual(merge.renamedIssuesCount, 0);
  assert.deepStrictEqual(merge.addedControllerIds, []);
  assert.deepStrictEqual(merge.addedIssueIdsByController, {});
});

test("CSV: sin ID reconoce mandos por número de serie o nombre + color y fallas por descripción", async () => {
  const app = await App();
  const current = await build([
    controllerOf("c1", { nombre: "Blanco", color: "Blanco" }, [issueOf("i1", BASE, { titulo: "Drift leve" })]),
    controllerOf("c2", { nombre: "Otro nombre", numeroSerie: "SN-123" }),
  ]);
  const csv = [
    "Mando,Color,Número de serie,Falla,Tipo de falla",
    "Blanco,Blanco,,drift LEVE,Gatillo L2",
    "Blanco,Blanco,,Gatillo pegado,Gatillo R2",
    "Negro,Negro (Midnight Black),sn-123,,",
    "Verde,Verde,,,",
  ].join("\n");
  const { controllers } = app.buildCSVImport(csv, current);
  const imported = plain(controllers);
  assert.strictEqual(imported[0].id, "c1", "Blanco + Blanco coincide con un mando existente");
  assert.strictEqual(imported[0].issues[0].id, "i1", "la falla se reconoce aunque cambien mayúsculas");
  assert.notStrictEqual(imported[0].issues[1].id, "i1");
  assert.strictEqual(imported[1].id, "c2", "el número de serie manda sobre el nombre");
  assert.notStrictEqual(imported[2].id, "c1");
  const merge = plain(app.mergeImportedControllers(current, controllers));
  assert.strictEqual(merge.newCount, 1, "solo Verde es nuevo");
  assert.strictEqual(merge.skippedIssuesCount, 1);
  assert.strictEqual(merge.controllers.find((c) => c.id === "c1").issues.length, 2);
});

test("CSV hecho a mano: punto y coma, tildes, filas de continuación y avisos", async () => {
  const app = await App();
  const csv = [
    "\uFEFFMando;Color;Estado;Consola actual;Fin de garantía;Falla;Tipo de falla;Estado de la falla;Urgente;Costo de la falla;Etiquetas de la falla",
    "Rojo;Rojo (Cosmic Red);en reparación;ps5 slim;31/12/2027;Drift;drift joystick izquierdo;En reparación;sí;$ 59.990;garantía, service",
    ";;;;;Gatillo suelto;Otro raro;resuelto;no;;",
    "Verde;;roto;PS9;fecha mala;;;;;;",
  ].join("\r\n");
  const { controllers, warnings } = app.buildCSVImport(csv, []);
  const [rojo, verde] = plain(controllers);
  assert.strictEqual(controllers.length, 2);
  assert.strictEqual(rojo.colorHex, "#7d1d1d", "el color conocido aporta su tono");
  assert.strictEqual(rojo.estado, "reparacion");
  assert.strictEqual(rojo.consolaActual, "PS5 Slim");
  assert.strictEqual(rojo.finGarantia, midnight(2027, 12, 31));
  assert.strictEqual(rojo.issues.length, 2, "la fila sin nombre es otra falla del mismo mando");
  assert.deepStrictEqual(
    [rojo.issues[0].tipo, rojo.issues[0].status, rojo.issues[0].urgente, rojo.issues[0].costo, rojo.issues[0].tags],
    ["Drift joystick izquierdo", "en_reparacion", true, 59990, ["garantía", "service"]]
  );
  assert.strictEqual(rojo.issues[1].titulo, "Gatillo suelto");
  assert.strictEqual(rojo.issues[1].status, "resuelto");
  assert.strictEqual(rojo.issues[1].tipo, "Otro", "un tipo desconocido pasa a «Otro»...");
  assert.ok(rojo.issues[1].notes.includes("Tipo indicado en el CSV: Otro raro"), "...pero no se pierde el dato");
  assert.strictEqual(verde.estado, "activo");
  assert.strictEqual(verde.consolaActual, "");
  assert.strictEqual(verde.finGarantia, null);
  const text = plain(warnings).join(" | ");
  assert.ok(/Estados de mando no reconocidos[^|]*: 1/.test(text), text);
  assert.ok(/Consolas no reconocidas[^|]*: 1/.test(text), text);
  assert.ok(/Fechas no reconocidas[^|]*: 1/.test(text), text);
  assert.ok(/Tipos de falla no reconocidos[^|]*: 1/.test(text), text);
});

test("CSV: avisa de filas sin nombre y rechaza archivos que no sirven", async () => {
  const app = await App();
  const { controllers, warnings } = app.buildCSVImport("Mando,Falla\nBlanco,Drift\n,\n,,\nxx,\n", []);
  assert.strictEqual(controllers.length, 2);
  assert.deepStrictEqual(plain(warnings), []);
  const orphan = app.buildCSVImport("Mando,Color,Falla\n,Rojo,\n", []);
  assert.strictEqual(orphan.controllers.length, 0);
  assert.ok(plain(orphan.warnings).join("").includes("Filas sin nombre de mando"));
  assert.throws(() => app.buildCSVImport("", []), /vacío/);
  assert.throws(() => app.buildCSVImport("Color,Estado\nRojo,Activo", []), /«Mando»/);
});

// ---------------------------------------------------------------------------
// Almacenamiento persistente
// ---------------------------------------------------------------------------
test("almacenamiento persistente: pide protección y reporta el resultado", async () => {
  const run = async (storage) => {
    const dev = await createDevice({ startApp: false, storage });
    const status = await dev.app.requestPersistentStorage();
    dev.close();
    return status;
  };
  assert.strictEqual(await run(undefined), "unsupported");
  assert.strictEqual(await run({ persisted: async () => true, persist: async () => assert.fail("no debía volver a pedirlo") }), "granted");
  assert.strictEqual(await run({ persisted: async () => false, persist: async () => true }), "granted");
  assert.strictEqual(await run({ persisted: async () => false, persist: async () => false }), "denied");
  assert.strictEqual(await run({ persist: async () => { throw new Error("no permitido"); } }), "unsupported");
});

// ---------------------------------------------------------------------------
// Español neutro (sin voseo ni regionalismos) en todos los textos de la interfaz
// ---------------------------------------------------------------------------
test("textos de la interfaz: sin voseo ni regionalismos", async () => {
  const { app } = loadScripts();
  const literals = [...app.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]);
  const allowed = new Set(["qué", "está", "esté", "así", "ahí", "allí", "aquí", "sí", "dé", "sé", "té"]);
  const banned = /(^|[^\p{L}])(vos|tenés|podés|querés|sabés|sos|acá|che|notebook|copialo|pegalo|dejalo|guardalo|ponelo|borralo|dale)(?![\p{L}])/iu;
  const problems = [];
  literals.forEach((text) => {
    if (banned.test(text)) problems.push(text);
    (text.match(/(?<![\p{L}])\p{L}+[áéí](?![\p{L}])/gu) || []).forEach((word) => {
      const lower = word.toLowerCase();
      if (allowed.has(lower) || /(ar|er|ir)á$/.test(lower)) return; // futuro: "guardará"
      problems.push(word + "  ←  «" + text.slice(0, 70) + "»");
    });
  });
  assert.deepStrictEqual(problems, [], "Se encontraron formas de voseo o regionalismos:\n  " + problems.join("\n  "));
});
