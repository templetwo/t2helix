# Codex Integration Notes

These are integration-surface findings from adding a non-Claude consumer. They are intentionally direct.

## Awkward or reverse-engineered

1. **Session identity is a Claude hook side channel, not an MCP concept.** The server reads `.current_session`, which `UserPromptSubmit` writes. That works for Claude's MCP calls, but a foreign MCP client has no lifecycle handshake that writes its own session id. Codex can inherit the last Claude session or fall back to the global literal `mcp-session`. The dispatcher accepts `args.session_id`, but schemas do not advertise that field, so ordinary clients cannot intentionally use it.
2. **The live data path has to be known out of band.** The portable resolution logic is good, but a foreign installer still has to know the Claude marketplace-derived directory name (`t2helix-templetwo-t2helix`). There is no `t2helix locate-data` command or machine-readable install manifest.
3. **The client must understand which safety claims are transport properties.** MCP exposes `dry_run_compass`, but the real hard denial is implemented only by Claude's `PreToolUse` hook. Nothing in the MCP capabilities advertises `advisory_only`, so a client or README can easily overstate protection.
4. **The Grok precedent contains a stale contradictory comment.** `grokWitness` says PAUSE is not exposed and is treated as OPEN, while the implementation below it now mints/consumes approvals and blocks the direct wrapper call. That is exactly the kind of drift a foreign integrator cannot safely infer around a security boundary.
5. **The Grok `node -e` scripts drop their first user argument.** Under `node -e`, the first trailing argument is `process.argv[1]`; `grok:boot` reads `[2]` and `grok:witness` slices from `2`, so their documented one-argument forms silently use defaults or omit the first word. The Codex scripts do not copy that bug.
6. **Adapter and MCP paths duplicate surface logic.** The Grok/Codex adapters call `chronicle` and compass libraries directly rather than being clients of the MCP contract. This is convenient locally but creates two integration APIs with different validation, session handling, and result shapes.
7. **Documentation/version/count drift is already visible.** `package.json` is 0.12.0 and the current suite has hundreds of assertions, while parts of README/task material still cite 0.11.0 or 40 tests. The release doctor should cover integration docs and test-surface claims too.

## Claude-specific pieces that should become transport-neutral

- Introduce an MCP `begin_session` (or initialize metadata) contract that returns a client-scoped session id and optionally accepts client name/capabilities. `get_state`, `set_goal`, and writes should use that identity without relying on a Claude-owned file.
- Expose a machine-readable safety-capability object, for example `{ compass: "advisory" | "intercepting", recall: "manual" | "prompt_hook", post_action_recording: boolean }`. Documentation alone is too easy to lose.
- Move the recall surface selection used by `UserPromptSubmit` behind an MCP tool such as `prepare_prompt_context`. Foreign clients could then request the same goal/method/insight selection instead of approximating it with raw `recall` plus `get_state`.
- Expose an explicit `record_outcome` tool. Today the useful action→outcome chain depends on `PostToolUse`; a disciplined foreign client has no first-class transport-neutral equivalent.
- Make PAUSE confirmation semantics explicit for advisory clients. Approving an MCP token cannot cause Codex to retry or intercept a command, so a capability-aware response should distinguish "approval recorded" from "execution authorized/enforced."

## What would make this a one-command install

An official `t2helix install --client codex` command should:

1. locate the active Claude plugin data directory rather than hardcoding a marketplace suffix;
2. discover a compatible Node binary and run a real DB health check, not only an MCP handshake;
3. back up and update Codex configuration through a structured TOML editor or `codex mcp add` when that CLI contract is stable;
4. install/update a marker-owned standing-instructions block;
5. verify `initialize`, `tools/list`, a read-only `get_state`, and advisory capability labels;
6. print exact rollback paths and a truthful statement of the hook gap.

The native addon is the sharpest install failure. In this checkout, the default `node` was Node 22 (ABI 127) while `better-sqlite3` was built for Node 20 (ABI 115). A raw MCP handshake can still succeed because the driver is lazy; the first DB call then fails. Installer health must include a DB operation or `chronicle.health()`, and the configured command should pin the validated Node executable.

## Latent bugs and fragile assumptions

- **False safety by wrapper naming:** `grokWitness` can block only actions routed through that function. It does not intercept arbitrary Grok/Cosmic tools. Documentation saying the compass "protects" a non-hook model should state that bypass explicitly, just as the Codex docs do.
- **Last-writer session file:** `.current_session` is a single shared file. Concurrent Claude sessions—or Claude and Codex—can attach goals/writes to whichever session wrote it last. This is not a stable multi-client session model.
- **Absolute checkout path:** Codex MCP config needs an absolute `mcp/server.js` path. Moving or deleting the checkout breaks startup. A stable installed launcher/shim would decouple config from source location.
- **Non-transactional multi-file init:** config and standing instructions are separate files. Each write is atomic and backed up, but the pair cannot be committed atomically; a failure between writes can leave a registered MCP without discipline instructions or vice versa.
- **Native ABI is checked too late:** lazy driver loading correctly protects hooks, but it also lets connection setup look healthy until the first chronicle operation. Foreign-client doctor/install flows need a mandatory DB health probe.
- **Advisory calls are not automatic audit events:** `dry_run_compass` does not prove the eventual command was identical, was executed, or honored the recommendation. Any compliance claim needs host-level interception or signed action receipts, neither of which Codex MCP supplies.

## Bottom line

The chronicle core is already usefully transport-neutral. The session lifecycle and safety guarantees are not. T2Helix should make capability differences explicit in protocol responses and offer first-class session/context/outcome tools before calling non-hook consumers equal peers. Until then, Codex integration is valuable shared memory with disciplined advisory checks—not hook parity and not enforced safety.
