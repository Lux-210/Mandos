"use strict";
// Mini ejecutor de pruebas: sin dependencias, solo Node.
const registry = [];

function test(name, fn) {
  registry.push({ name, fn });
}

async function runAll(filter) {
  let passed = 0;
  const failures = [];
  const selected = filter ? registry.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())) : registry;
  for (const t of selected) {
    const started = Date.now();
    try {
      await Promise.race([
        t.fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Tiempo de espera agotado (20 s)")), 20000)),
      ]);
      passed += 1;
      console.log("  ✓ " + t.name + " (" + (Date.now() - started) + " ms)");
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log("  ✗ " + t.name + "\n      " + String(err && err.stack ? err.stack : err).split("\n").slice(0, 6).join("\n      "));
    }
  }
  console.log("\n" + passed + " de " + selected.length + " pruebas pasaron" + (failures.length ? " — " + failures.length + " fallaron" : "") + ".");
  return failures.length === 0;
}

module.exports = { test, runAll };
