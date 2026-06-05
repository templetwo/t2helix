'use strict';

// Test preload: make require('better-sqlite3') throw an ABI-style failure, the
// way a NODE_MODULE_VERSION mismatch or a missing/uncompiled binding does in
// the field. Used via `node --require .../break-sqlite.js hooks/<hook>.js` to
// prove the hooks fail-open (exit 0, no host breakage) when the native binding
// is unavailable, instead of crashing at module-load before main()'s try/catch.

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') {
    const e = new Error('simulated ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch');
    e.code = 'ERR_DLOPEN_FAILED';
    throw e;
  }
  return origLoad.call(this, request, parent, isMain);
};
