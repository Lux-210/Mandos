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
// Cada <label> de un formulario debe apuntar a un campo real (htmlFor -> id),
// o, si etiqueta un grupo de botones en vez de un único campo, usar
// aria-labelledby en el contenedor del grupo.
// ---------------------------------------------------------------------------
test("accesibilidad: las etiquetas del formulario de mando están asociadas a su campo (htmlFor/id)", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    d.click(d.byLabel("Editar mando")[0]);
    d.click(await d.waitFor(() => d.buttons("Editar")[0]));
    await d.waitFor(() => d.q('label[for="mando-nombre"]'), { message: "modal de edición de mando" });

    const labels = d.qa("label[for]");
    assert.ok(labels.length >= 10, "deben existir varias etiquetas asociadas en el formulario de mando");
    for (const label of labels) {
      const forId = label.getAttribute("for");
      const target = d.doc.getElementById(forId);
      assert.ok(target, 'la etiqueta "' + label.textContent + '" apunta a un id ("' + forId + '") que no existe');
    }
  });
});

test("accesibilidad: las etiquetas del formulario de falla están asociadas a su campo, y «Estado» usa un grupo con aria-labelledby", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    await d.openController("Blanco");
    d.click(d.buttons("Agregar falla")[0]);
    await d.waitFor(() => d.q('label[for="falla-titulo"]'), { message: "modal de nueva falla" });

    const labels = d.qa("label[for]").filter((l) => l.getAttribute("for").startsWith("falla-"));
    assert.ok(labels.length >= 5);
    for (const label of labels) {
      const target = d.doc.getElementById(label.getAttribute("for"));
      assert.ok(target, 'la etiqueta "' + label.textContent + '" no encontró su campo');
    }

    const estadoGroup = d.q('[role="group"][aria-labelledby="falla-estado-label"]');
    assert.ok(estadoGroup, "el grupo de botones de Estado debe anunciarse con aria-labelledby");
    assert.ok(d.doc.getElementById("falla-estado-label"), "debe existir el elemento que describe al grupo de Estado");
  });
});

test("accesibilidad: el token de GitHub en Sincronización está asociado a su etiqueta", async () => {
  await withDevice({}, async (d) => {
    await d.openSettings();
    d.click(d.buttons("Conectar")[0]);
    const input = await d.waitFor(() => d.q('input[placeholder="ghp_..."]'));
    assert.strictEqual(input.id, "sync-token");
    const label = d.q('label[for="sync-token"]');
    assert.ok(label && label.textContent.includes("Token de GitHub"));
  });
});

// ---------------------------------------------------------------------------
// Los íconos decorativos no deben anunciarse aparte a un lector de pantalla:
// ya van junto a texto visible o dentro de un botón con su propio aria-label.
// ---------------------------------------------------------------------------
test("accesibilidad: los íconos son decorativos (aria-hidden) y no duplican lo que ya dice el texto", async () => {
  await withDevice({}, async (d) => {
    await d.addController("Blanco", "Blanco");
    await d.waitFor(() => d.text().includes("Blanco"));
    const svgs = d.qa("svg");
    assert.ok(svgs.length > 5, "debe haber varios íconos en pantalla para esta prueba");
    const sinMarcar = svgs.filter((svg) => svg.getAttribute("aria-hidden") !== "true");
    assert.deepStrictEqual(sinMarcar, [], "todos los íconos de la app deben llevar aria-hidden=\"true\"");
  });
});

// ---------------------------------------------------------------------------
// Metadatos para compartir el enlace (vista previa en redes/mensajería)
// ---------------------------------------------------------------------------
test("metadatos: el <head> tiene descripción y etiquetas Open Graph/Twitter", () => {
  const { html } = loadScripts();
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(/<meta name="description" content="[^"]+"/.test(head), "falta <meta name=\"description\">");
  assert.ok(/<meta property="og:title"/.test(head), "falta og:title");
  assert.ok(/<meta property="og:description"/.test(head), "falta og:description");
  assert.ok(/<meta property="og:image"/.test(head), "falta og:image");
  assert.ok(/<meta name="twitter:card"/.test(head), "falta twitter:card");
});
