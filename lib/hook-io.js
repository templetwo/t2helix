'use strict';

/**
 * Read all data from stdin to a string. Resolves on stream end or error
 * with whatever was collected so far. Used by Claude Code hooks to ingest
 * the JSON payload Claude Code writes on hook invocation.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

module.exports = { readStdin };
