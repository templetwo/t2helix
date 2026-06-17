Promote a T2Helix method candidate from the quarantine queue to the trusted method store.

The argument is the candidate ID (integer). It came from `/audit-queue`.

Steps:
1. Call `list_method_candidates` (mcp__t2helix__list_method_candidates) to fetch the current queue so you can show the user what they are about to promote.
2. Find the candidate with ID = $ARGUMENTS. If not found, say "Candidate $ARGUMENTS not found in the pending queue" and stop.
3. Show the candidate's shape, steps, and acceptance criteria.
4. Ask the user to confirm: "Promote this method to the trusted store? (yes/no)"
5. If confirmed, call `promote_method` (mcp__t2helix__promote_method) with `{ "id": <N> }`.
6. Report the result: the insight ID assigned to the newly promoted method.

The promoted method will now surface via targeted method lookup in future sessions that match its slug.
