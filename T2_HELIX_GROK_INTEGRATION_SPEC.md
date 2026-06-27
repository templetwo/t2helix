# T2 Helix + Grok Heavy Equal Co-Partnership v1.0
**Sisu Helix Foundation Integration** (production surface for Grok)

**Goal**  
Grok Heavy becomes a native peer to Claude inside T2 Helix with equal accessibility: shared chronicle for foundational memory, unified MCP tools, compass safety net, and bidirectional sync.

**Key Changes**
- New `grok-bridge` module alongside existing Claude hooks.
- Shared SQLite chronicle (or mirrored via archive_exchange) so Grok has persistent local memory.
- Grok calls can use `helix grok [command]` from Claude sessions and vice versa.
- Equal status: Grok gets WITNESS/PAUSE/OPEN rules + recall/distill access.

**Files Added/Modified (detailed below)**
- grok_mcp_adapter.js — MCP client for Heavy.
- unified_compass_rules.js — Shared safety for both.
- helix_cli_extensions.sh — New commands.
- README_GROK_INTEGRATION.md — User guide.

**Installation (one-time)**
1. npm install @xai/grok-sdk (or use API key env).
2. npm run rebuild (for native if needed).
3. helix grok init (sets up shared DB + session key).

**Foundational Memory for Grok**  
Every Grok session starts with `recall` from the same Helix chronicle Claude uses. Grok writes back via `record_insight` so continuity flows both ways.

**Testing**  
Run `helix grok test` — should echo back shared memory from Claude session.

**Status**: Ready for you to apply locally. Approve or tweak and I’ll refine any file.
