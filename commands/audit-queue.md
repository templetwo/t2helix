Call the `list_method_candidates` MCP tool (mcp__t2helix__list_method_candidates) with no arguments to retrieve the pending review queue.

Display the results as a numbered list. For each candidate show:
- **ID** and **shape** (the method slug/name)
- **Acceptance criteria** (what "done" looks like for this method)
- **Steps** (condensed — first two lines or ≤120 chars)
- Created timestamp

If the queue is empty, say so clearly.

After displaying the list, remind the user of the next actions:
- To accept a candidate: `/promote-method <id>`
- To reject a candidate: `/dismiss-method <id>`
- To see the compass audit trail: `/recall-audit`
