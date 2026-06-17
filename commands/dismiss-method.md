Dismiss a T2Helix method candidate — permanently reject it from the review queue.

The argument is the candidate ID (integer). It came from `/audit-queue`.

Steps:
1. Call `list_method_candidates` (mcp__t2helix__list_method_candidates) to show the user what they are about to dismiss.
2. Find the candidate with ID = $ARGUMENTS. If not found, say "Candidate $ARGUMENTS not found in the pending queue" and stop.
3. Show the candidate's shape and acceptance criteria briefly.
4. Ask the user to confirm: "Dismiss this candidate permanently? (yes/no)"
5. If confirmed, call `dismiss_method_candidate` (mcp__t2helix__dismiss_method_candidate) with `{ "id": <N> }`.
6. Confirm dismissal.

Dismissed candidates are removed from the queue and will not be surfaced again. They can be re-generated in a future session if the pattern repeats.
