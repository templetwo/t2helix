Show the recent T2Helix compass audit trail — the history of PAUSE and WITNESS classifications.

Call `recall_compass` (mcp__t2helix__recall_compass) with `{ "limit": 20 }`.

Display the results as a table or list. For each entry show:
- **Classification** (PAUSE or WITNESS) — highlight WITNESS in bold
- **Tool** and truncated action summary (≤80 chars)
- **Rule matched** and reason
- Timestamp (human-readable)

If the argument $ARGUMENTS is a classification filter (e.g. "WITNESS" or "PAUSE"), pass it as `{ "classification": "$ARGUMENTS", "limit": 20 }` instead.

After the list, summarize:
- N WITNESS fires (hard denials)
- N PAUSE fires (soft denials, may have been overridden)

This is the audit surface for understanding what the compass has been protecting against. Use it before making policy changes, to verify the compass is working as expected, or to spot patterns that warrant a new method.
