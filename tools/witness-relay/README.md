# Witness Relay

Experimental tooling that turns the t2helix chronicle into a shared message bus
for cross-agent relay (e.g. an Antigravity-seat Claude and a Grok seat exchanging
pings through the same SQLite chronicle).

These are **side tools**, not part of the shipped plugin surface (`lib/`, `hooks/`,
`mcp/`). They read and write the same chronicle DB the plugin uses.

## Scripts

### `monitor_chronicle.js`
Polls the chronicle DB for newly-written entries, prints each one, and emits a
`chronicle.new_entry` JSONL event on stdout. Used to surface relay messages
(`to:grok` tags, `PING_TO_*` markers) as they land. Read-only on the DB.

```bash
node tools/witness-relay/monitor_chronicle.js
```

Environment:
| Var | Default | Meaning |
| --- | --- | --- |
| `T2HELIX_MONITOR_INTERVAL` | `4` | Poll interval, seconds |
| `T2HELIX_MONITOR_DOMAIN`   | —   | Only surface entries from this domain |
| `T2HELIX_MONITOR_TAG`      | —   | Only surface entries carrying this tag |
| `T2HELIX_DATA_DIR`         | `~/.t2helix-data` | Chronicle DB location |

On startup it looks back 24h so entries aren't missed after a restart.

### `monitor_workflow_memory.js`
Polls a remote relay host's `~/witness_relay/workflow_memory.jsonl` over SSH and
syncs any new (de-duplicated by `epoch:` tag) entries into the local chronicle as
`workflow-memory` ground-truth insights.

```bash
JETSON_USER=you JETSON_HOST=10.0.0.x node tools/witness-relay/monitor_workflow_memory.js
```

Environment:
| Var | Default | Meaning |
| --- | --- | --- |
| `T2HELIX_SYNC_INTERVAL` | `5` | Poll interval, seconds |
| `JETSON_USER` | `jetson` | SSH user for the relay host (placeholder — set this) |
| `JETSON_HOST` | `jetson.local` | SSH host for the relay host (placeholder — set this) |

> The defaults are intentionally generic placeholders so no private network
> detail ships in the repo. Set the env vars to point at your own relay host.

## Proof

`proofs/relay_loop_first_bidirectional_proof.txt` (at repo root) captures the
first working bidirectional Grok↔Antigravity relay loop through the chronicle,
along with the monitor snapshot that produced it.
