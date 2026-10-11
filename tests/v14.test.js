"use strict";
const assert = require("assert");
const { test } = require("./lib");
const { createDevice } = require("./harness");

// ---------------------------------------------------------------------------
// Red de seguridad ante errores de render (ErrorBoundary)
// ---------------------------------------------------------------------------
test("errores: si un componente hijo falla al renderizar, se muestra la pantalla de error en vez de quedar en blanco", async () => {
  const d = await createDevice({ startApp: false }); // no monta la app real: solo se necesitan React/ReactDOM y el ErrorBoundary
  try {
    const { win, doc, app } = d;
    assert.ok(app.ErrorBoundary, "ErrorBoundary debe quedar expuesto para poder probarlo");

    function Boom() {
      throw new Error("falla de prueba a propósito");
    }

    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.ReactDOM.createRoot(container).render(
      win.React.createElement(app.ErrorBoundary, null, win.React.createElement(Boom))
    );

    await d.waitFor(() => container.textContent.includes("Ocurrió un error inesperado"), {
      message: "la pantalla de error no apareció tras el fallo del componente hijo",
    });
    assert.ok(
      [...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "Recargar la app"),
      "debe ofrecer un botón para recargar"
    );
  } finally {
    d.close();
  }
});

test("errores: si no hay ningún fallo, el ErrorBoundary es transparente y muestra a su hijo normalmente", async () => {
  const d = await createDevice({ startApp: false });
  try {
    const { win, doc, app } = d;
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.ReactDOM.createRoot(container).render(
      win.React.createElement(app.ErrorBoundary, null, win.React.createElement("p", null, "todo bien"))
    );
    await d.waitFor(() => container.textContent.includes("todo bien"));
    assert.ok(!container.textContent.includes("Ocurrió un error inesperado"));
  } finally {
    d.close();
  }
});
