# Error-resolution atlas

A curated corpus of common error→fix pairs, loaded into the chronicle as
recallable `domain:'error-fix'` knowledge. It closes a specific gap: the helix
already *detects* failure (`lib/outcome.js` tags `outcome:failure` on
`Traceback` / `SyntaxError` / `TypeError` / `ModuleNotFoundError` /
`AssertionError` / `fatal:` / `Error:`), but until now it could not say *how to
fix* what it detected.

## Shape

The source is JSONL, one object per line:

```json
{"pattern": "ModuleNotFoundError: No module named '*'", "resolution": "Install into the active environment with python -m pip install <module> …"}
```

`pattern` is an error signature (wildcards `*` mark variable spans); `resolution`
is the fix advice. The reference corpus is 147 human-curated entries spanning core
Python exceptions, pip/packaging, virtualenv/interpreter mismatch, CUDA/torch,
pandas/numpy, requests/HTTP, git, docker, shell/make, and JS/node.

## How it is stored (and why)

Each entry becomes one insight, written through the **existing** `record()` path:

| field | value |
|-------|-------|
| `content` | `[error-fix] <pattern>\n\n<resolution>` |
| `domain` | `error-fix` |
| `layer` | `ground_truth` |
| `tags` | `['error-fix', 'source:atlas', 'fp:<12hex>']` |
| `intensity` | `0.8` |

Three settled decisions:

1. **Insights tier, not a parallel `error_atlas` table.** Going through `record()`
   gets `secrets.scrub()` on the write path, the `insights_fts` mirror trigger, and
   visibility to `recall()` + the memory→compass coupling for free. A parallel
   table would skip all three and double the `better-sqlite3` native surface — the
   system's one known silent-failure landmine.

2. **`error-fix` is a non-meta domain.** Methods (`domain:'method'`) are in
   `META_DOMAINS` and surface only via the targeted slug lookup. error-fix is
   reference content meant to surface through **normal `recall()`** when a prompt
   carries matching error tokens, so it is deliberately *not* a meta domain. The
   pattern leads the content so its tokens (`ModuleNotFoundError`, `SyntaxError`, …)
   land in FTS; wildcards are FTS punctuation and drop out of tokenization.

3. **Pre-promoted, no quarantine.** The entries are human-curated and pre-vouched,
   so they load straight into the ground_truth tier in one reviewed batch — the
   human-promotion bottleneck satisfied once instead of 147 times. Machine-distilled
   methods still route through `method_candidates` + `promote_method`, unchanged.

## Loading

```bash
# preview against the real target, write nothing
npm run import-atlas -- --file <atlas.jsonl> \
  --data-dir "$HOME/.claude/plugins/data/t2helix-templetwo-t2helix" --dry-run

# real load (idempotent — safe to re-run)
npm run import-atlas -- --file <atlas.jsonl> \
  --data-dir "$HOME/.claude/plugins/data/t2helix-templetwo-t2helix"
```

The loader refuses a non-dry run without an explicit `--data-dir` /
`T2HELIX_DATA_DIR` / `CLAUDE_PLUGIN_DATA`, so it can't silently load into the empty
`~/.t2helix-data` standalone fallback. It is **idempotent** (re-running skips any
`fp:` already present) and **append-only** (no existing row is rewritten, so no
backup step). After import, `<n> error-fix insight(s)` is reported as a verify.

## Matching

Today: an error-fix entry surfaces when its tokens appear in a prompt — paste a
traceback and `recall()` returns the fix via FTS token overlap. This works the
moment the atlas is loaded, with zero new wiring.

Deferred (additive follow-up): trigger the lookup automatically on PostToolUse
`outcome:failure` and inject the resolution. This stays within the existing
authority model — the hook remains record-only and silent; fixes surface via
`recall()` and `coupling.escalateByMemory()` (OPEN→PAUSE only), never a hook
hard-block. Pattern wildcards may want a normalization/LIKE pass to complement
FTS-token matching for the variable spans.
