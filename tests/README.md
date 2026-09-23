# Pruebas de Mis DualSense

Cargan `../index.html` en jsdom con IndexedDB simulado (`fake-indexeddb`) y un
servidor de GitHub falso, así que no necesitan navegador ni internet.

```
cd tests
npm install
npm test                 # todas las pruebas
node run.js sync:        # solo las que contengan ese texto en el nombre
```

- `logic.test.js`: lógica pura (fusión de sincronización, marcas de eliminación,
  lectura y escritura de CSV, almacenamiento persistente) y una revisión de que
  ningún texto de la interfaz use voseo ni regionalismos.
- `ui.test.js`: la interfaz real (crear, eliminar, deshacer, importar CSV/JSON)
  y la sincronización entre dos "dispositivos" que comparten un gist falso.
- `harness.js`: el entorno (`createDevice`, `createFakeGithub`).

`DUALSENSE_HTML=/ruta/a/otro/index.html npm test` prueba otra versión del archivo.
