# T2 Helix now has equal Grok Heavy co-partnership

- Shared memory chronicle ✓
- One MCP surface for both models ✓
- Compass protects both ✓
- Grok gets foundational local persistence ✓
- Bidirectional: Claude and Grok both read and write the same SQLite chronicle

## Quick start (local seat)

```bash
cd /path/to/t2helix
npm run grok:init
node -e '
  const g = require("./lib/grok-adapter");
  console.log(g.grokBoot({ query: "T2 Helix integration" }));
'
```

Test command from a Grok seat:  
`helix grok witness "summarize entropy v4 frontier"`

Or directly via the live MCP tools (already exposed):
- `t2helix__recall`
- `t2helix__record`
- `t2helix__recall_compass`

The chronicle does not care which model writes or recalls. Equal status by design.

## Architecture notes

- `lib/grok-adapter.js` is a thin, model-aware convenience wrapper.
- All persistence and safety logic remains in `lib/chronicle.js` + `lib/compass.js`.
- No separate database. No forked rules.
- Existing Claude Code hooks continue to work unchanged.

**Important for shared chronicle**: the `grok:*` npm scripts pin `T2HELIX_DATA_DIR` to the live plugin data directory (`~/.claude/plugins/data/t2helix-templetwo-t2helix`). Direct `node -r` or `require` calls will fall back to `~/.t2helix-data` unless the same env var is set.

## Compass coverage (current scope)

`grokWitness` routes through `compass.classify` + `summarizeAction` (same functions used by the hooks).

| Class | Non-hook seats (Cosmic / direct Grok) | Claude Code PreToolUse |
|-------|----------------------------------------|-------------------------|
| **WITNESS** | Hard deny (blocked, not recorded as success) | Hard deny |
| **PAUSE** | Soft deny: mints `pending_confirmations` token; caller must `confirm_pending` then retry (adapter consumes approval) | Soft deny; the hook reason names the request id, and the token is found via `list_pending` |
| **OPEN** | Record + proceed | Proceed |

**History:** Through mid-2026-07, PAUSE was *logged* but treated as OPEN for Grok direct calls (`if (classification !== 'WITNESS') record`). That half-gate is closed so non-hook seats do not inherit a "safe mode that never reads the flag."

Cosmic CLI surfaces approve as: `cosmic-cli helix confirm <token>`.

## Status

Fixed data-dir resolution + compass routing 2026-06-27. PR #9.  
PAUSE token flow for non-hook seats 2026-07-14 (Cosmic runtime partnership).

See also: `T2_HELIX_GROK_INTEGRATION_SPEC.md`
