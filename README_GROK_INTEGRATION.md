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

## Compass coverage

Grok actions that reach the Bash or edit surface are subject to the same WITNESS / PAUSE / OPEN rules as Claude. Additional Grok-specific guard patterns can be added to `lib/rules/compass-rules.json`.

## Status

Applied locally on 2026-06-27 from heavy-web-seat spec. This is the creative integration layer (no Rings formality required).

See also: `T2_HELIX_GROK_INTEGRATION_SPEC.md`
