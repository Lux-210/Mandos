"use strict";
// Uso:  node tests/run.js [texto]   (opcional: solo las pruebas cuyo nombre contenga "texto")
require("./logic.test.js");
require("./ui.test.js");
require("./perf.test.js");
const { runAll } = require("./lib");
runAll(process.argv[2]).then((ok) => process.exit(ok ? 0 : 1));
