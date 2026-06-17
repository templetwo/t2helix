Search the T2Helix trusted method store for a specific method by keyword or slug.

The argument $ARGUMENTS is the search query (a slug fragment, keyword, or phrase).

Call `recall` (mcp__t2helix__recall) with `{ "query": "$ARGUMENTS", "topK": 5 }`.

From the results, filter to hits where `domain === "method"` and display them as a numbered list:
- **Shape** (method slug extracted from the `[method] <shape>` prefix)
- **Acceptance criteria** (the `Acceptance:` block)
- **Steps** summary (first two lines)

If no method hits are found, say so and suggest `/audit-queue` to review candidates that haven't been promoted yet.

This is the Reuse step of the Audit→Review→Promote→Reuse loop: find an established method before starting a task that pattern-matches it.
