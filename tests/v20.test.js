"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice } = require("./harness");

// ---------------------------------------------------------------------------
// Optimización v21: el guardado en IndexedDB de "controllers" se agrupa con
// un pequeño debounce (600ms), igual que ya se hacía con la subida a la nube.
// Antes, cada tecla tipeada en un campo de texto (nombre, nota, título de una
// falla, etc.) disparaba una escritura completa del arreglo de mandos en
// IndexedDB: en un mando con muchas fallas eso es trabajo de sobra para cada
// pulsación. El guardado inmediato al ocultar la pestaña / cerrar la app
// sigue sin pasar por este debounce (usa controllersRef directamente), así
// que no hay riesgo de perder el último cambio al salir mientras el
// debounce está esperando.
// ---------------------------------------------------------------------------

// Se cuentan las escrituras reales a IndexedDB parcheando IDBObjectStore.put
// (de fake-indexeddb, el mismo paquete que usa harness.js) durante la prueba,
// y se restaura el original al terminar para no afectar otras pruebas.
function spyOnPuts() {
  const { IDBObjectStore } = require("fake-indexeddb");
  const original = IDBObjectStore.prototype.put;
  const calls = [];
  IDBObjectStore.prototype.put = function (value, key) {
    calls.push(key);
    return original.call(this, value, key);
  };
  return {
    calls,
    restore() {
      IDBObjectStore.prototype.put = original;
    },
  };
}

test("optimización: varios cambios seguidos en los mandos se agrupan en un solo guardado en IndexedDB", async () => {
  const d = await createDevice({});
  const spy = spyOnPuts();
  try {
    await d.addController("Mando de prueba");
    const heading = await d.waitFor(
      () => d.qa("h2, h3, p, span").find((el) => el.children.length === 0 && el.textContent.trim() === "Mando de prueba"),
      { message: "tarjeta del mando nuevo" }
    );
    d.click(heading);
    await d.waitFor(() => d.buttons("Agregar falla").length > 0, { message: "detalle del mando" });

    spy.calls.length = 0; // Solo interesan los guardados disparados DESPUÉS de este punto.

    // Varios cambios rápidos (más rápido que los 600ms del debounce), como
    // tipear varias letras seguidas en un campo.
    await d.addIssue("a");
    await d.addIssue("ab");
    await d.addIssue("abc");

    const writesToControllers = () => spy.calls.filter((k) => k === "controllers").length;
    const countRightAfter = writesToControllers();

    // Antes de que venza el debounce todavía no debería haberse escrito nada
    // nuevo en IndexedDB (más allá de lo que ya hubiera en vuelo).
    await d.wait(650);
    assert.ok(
      writesToControllers() >= 1,
      "después de esperar el debounce debe haberse guardado al menos una vez"
    );
    assert.ok(
      writesToControllers() <= countRightAfter + 2,
      "tres cambios seguidos y rápidos no deberían producir una escritura en IndexedDB por cada uno"
    );

    const saved = await d.readIDB("controllers");
    const titles = saved[0].issues.map((i) => i.titulo).sort();
    assert.deepStrictEqual(titles, ["a", "ab", "abc"], "el último estado guardado en IndexedDB debe tener las tres fallas");
  } finally {
    spy.restore();
    d.close();
  }
});
