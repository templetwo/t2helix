# PAUSE enforcement for non-hook seats

**Date:** 2026-07-14  
**Raised by:** Claude Code (support) during Cosmic↔Helix integration review  
**Builder:** Grok Build on cosmic-cli / t2helix adapter

## Finding

`README_GROK_INTEGRATION.md` previously implied "Compass protects both ✓" for Claude and Grok.

In `lib/grok-adapter.js`, PAUSE was **not** enforced for direct Grok / Cosmic:

- Source comment: "Grok direct calls currently treat PAUSE as OPEN for now."
- Code path: `if (classification !== 'WITNESS')` → record and proceed.

Only WITNESS hard-denied. PAUSE was a badge, not a gate.

Same failure shape as `exec_mode="safe"` stored and never read (cosmic-cli audit C1).

## Why it matters

For Temple/Cosmic, shipping "compass protects both" while PAUSE is log-only trains trust in a half-gate. Receipt-verified systems must not launder that.

## Fix (2026-07-14)

1. **`grok-adapter.js` `grokWitness`**
   - WITNESS → `{ blocked: true }` without success record
   - PAUSE → `createPendingConfirmation`, return `pending_token`, `{ blocked: true }`
   - On retry after `approveConfirmation`, `findApproval` + `consumeApproval` → treat as OPEN
2. **Cosmic CLI**
   - `_run_shell` blocks on WITNESS *and* PAUSE
   - `cosmic-cli helix confirm <token>` + `helix pending`
3. **Docs** state the three-class table honestly (COSMIC.md, PLAN, README)

## Test plan

```bash
# From t2helix with DATA_DIR set:
node -e '
const g=require("./lib/grok-adapter");
// Use a structured action that matches a PAUSE rule when available
g.grokWitness({tool_name:"Bash", tool_input:{command:"echo test"}}, {session_id:"pause-test"})
  .then(r => console.log(JSON.stringify(r,null,2)));
'

# Cosmic:
cosmic-cli helix pending
cosmic-cli helix confirm <token>
```

Credential-shaped PAUSE rules depend on `compass-rules.json` + tool shape (`Bash` + command). String-only `Grok:` notes may classify OPEN — that is rule matching, not gate failure.

## Related

- Cosmic audit C1 (ollama safe mode no-op)
- Cosmic `COSMIC.md` horizon lock
- MCP `confirm_pending` (already on Claude Code hook path)
