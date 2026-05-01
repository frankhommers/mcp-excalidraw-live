# mcp-excalidraw-live

[![CI](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/ci.yml/badge.svg)](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/ci.yml)
[![Docker](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/docker.yml/badge.svg)](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/docker.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A live Excalidraw canvas controlled by AI agents via MCP Streamable HTTP. **v3.0.0 introduces a multi-agent multi-canvas model with human-in-the-loop access control.**

Fork of [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) with a completely different architecture.

## What's new in v3.0.0

- **N agents × N canvases**: multiple browser tabs = multiple canvases, multiple MCP sessions = multiple agents
- **Human-grant model**: the human operator decides which agent gets access to which canvas via the per-canvas dashboard
- **Multi-grant per canvas**: more than one agent can collaborate on the same canvas
- **Snapshots**: save/restore named canvas states with `snapshot_scene` / `restore_snapshot`
- **Server-side arrow routing**: `startElementId` / `endElementId` produce edge-to-edge arrows that actually render correctly
- **Loopback split-brain guard**: refuses to start a duplicate canvas server on the same loopback port
- **Font normalization**: `fontFamily: "virgil"` / `"helvetica"` / `"excalifont"` etc. now just works

## Quick Start

### 1. Run the server

**Docker (recommended):**

```bash
docker run -d -p 3000:3000 --name mcp-excalidraw-live \
  -v $HOME:/host_home \
  -e HOST_HOME_MOUNT=/host_home \
  -e HOST_HOME_PATH=$HOME \
  ghcr.io/frankhommers/mcp-excalidraw-live:latest
```

**Or with docker compose** (same thing, less typing):

```bash
curl -O https://raw.githubusercontent.com/frankhommers/mcp-excalidraw-live/main/docker-compose.yml
docker compose up -d
```

**Or locally with Bun:**

```bash
git clone https://github.com/frankhommers/mcp-excalidraw-live.git
cd mcp-excalidraw-live
bun install && bun run build && bun dist/server.js
```

### 2. Open one or more canvases in your browser

Go to `http://localhost:3000`. Each tab is a separate canvas. Rename it inline if you like.

### 3. Connect your MCP client

Add to your MCP client config (Claude Desktop, Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "mcp-excalidraw-live": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

No stdio, no spawning processes, just a URL.

### 4. The agent requests access — you grant it

The agent calls `request_canvas(purpose: "draw the auth flow")`. A pending request appears in **every** open canvas tab (badge + name). You click **Grant** in the canvas you want to give it. Done.

The agent can now create elements on that canvas. Multiple agents on one canvas collaborate live. The same agent can be granted to multiple canvases and switch between them with `select_canvas`.

## How It Differs From Upstream

| | **Upstream** | **mcp-excalidraw-live** |
|---|---|---|
| Architecture | 2 processes (canvas + stdio MCP) with REST bridge | Single process, everything-in-one |
| MCP Transport | stdio (client spawns a node process) | **Streamable HTTP** (`POST /mcp`) |
| MCP SDK | Handwritten JSON-RPC | Official `@modelcontextprotocol/sdk` |
| Canvas state | Server-side in-memory | **Browser-side** (localStorage persistence) |
| Multi-tenancy | One canvas, one client | **N agents × N canvases** with human grants |
| Runtime | Node.js + npm | **Bun** |
| Stack | React 18, Express 4, Vite 6, Zod 3 | **React 19, Express 5, Vite 8, Zod 4, TS 6** |

## Access model

Three concepts:

- **Canvas** = browser tab (WebSocket connection). Has a name and an id.
- **Session** = MCP connection (`Mcp-Session-Id` header). Comes and goes with the agent.
- **Grant** = `(sessionId, canvasId)` tuple. Issued by the human operator via the dashboard, removed when revoked or when either side disconnects.

Every canvas tab shows a header strip listing pending requests (with the agent's purpose) and current grants. Click **Grant** to allow access, **×** to revoke. Activity toasts show what each connected agent is doing.

## MCP Tools

### Access (v3 grant model)
| Tool | Purpose |
|---|---|
| `request_canvas` | Ask the human for canvas access (requires `purpose`). Returns granted or pending. |
| `list_my_canvases` | Show all canvases granted to this session. |
| `select_canvas` | Switch active canvas when the session has multiple grants. |
| `release_canvas` | Voluntarily release a grant. |

### Element CRUD
| Tool | Purpose |
|---|---|
| `create_element` | Single element. Arrows: use `startElementId` / `endElementId` for edge-to-edge binding. |
| `batch_create_elements` | Multiple at once with the same arrow binding rules. |
| `update_element`, `delete_element`, `get_element`, `query_elements` | Standard CRUD. |
| `duplicate_elements` | Clone with offset. |

### Layout
| Tool | Purpose |
|---|---|
| `align_elements` | left/center/right/top/middle/bottom. |
| `distribute_elements` | horizontal/vertical even spacing. |
| `group_elements` | Group/ungroup. |
| `lock_elements`, `unlock_elements` | Lock to prevent moves. |
| `set_viewport` | Scroll/zoom programmatically. |

### Canvas state
| Tool | Purpose |
|---|---|
| `clear_canvas` | Wipe all elements. |
| `snapshot_scene` | Save named in-memory snapshot. |
| `restore_snapshot` | Restore from named snapshot. |
| `list_snapshots` | List saved snapshots on the active canvas. |
| `describe_scene` | Text summary of all elements with positions. |

### Export / Import
| Tool | Purpose |
|---|---|
| `export_canvas` | png / svg / excalidraw native JSON. |
| `save_canvas` | Write to disk (host filesystem via volume mount in Docker). |
| `export_to_excalidraw_url` | Encrypted shareable link to excalidraw.com. |
| `import_scene` | Load .excalidraw file from disk. |
| `create_from_mermaid` | Convert Mermaid string to elements. |

### Reference
| Tool | Purpose |
|---|---|
| `read_diagram_guide` | Color palette, sizing rules, layout patterns, anti-patterns. |

## Arrow binding (important)

For arrows, **always** use `startElementId` and `endElementId` referring to shape ids you assign. The server resolves edge-to-edge routing automatically. Do not compute arrow coordinates manually.

```json
{
  "elements": [
    {"type": "rectangle", "id": "auth", "x": 100, "y": 100, "width": 160, "height": 80, "text": "Auth"},
    {"type": "rectangle", "id": "db",   "x": 400, "y": 100, "width": 160, "height": 80, "text": "DB"},
    {"type": "arrow", "x": 0, "y": 0, "startElementId": "auth", "endElementId": "db", "text": "queries"}
  ]
}
```

## Save to Disk (Docker)

When using `docker compose`, your home directory is mounted so `save_canvas` works with normal paths:

```yaml
volumes:
  - ${HOME}:/host_home
environment:
  - HOST_HOME_MOUNT=/host_home
  - HOST_HOME_PATH=${HOME}
```

The agent uses normal paths (e.g. `/Users/frank/Documents/diagram`), the server translates them. Paths outside your home directory are rejected.

Without the volume mount, `save_canvas` won't be exposed as a tool — use `export_canvas` instead (returns data, MCP client writes the file).

## Agent skill pack

`skills/excalidraw-skill/SKILL.md` is a self-contained guide for AI agents: when to call `request_canvas` first, how to bind arrows, color palette, sizing rules, iterative refinement loop. Point your agent at it.

## Development

```bash
git clone https://github.com/frankhommers/mcp-excalidraw-live.git
cd mcp-excalidraw-live
bun install
bun run dev        # concurrent: tsc --watch + vite dev server
bun run type-check # typecheck without emitting
bun run build      # production build
```

## Migration from v2

v3 is a breaking change: the global `pinnedClient` is gone. Update agent workflows to call `request_canvas(purpose)` first, wait for the human to grant, then proceed. The pin button on the canvas is replaced with the grant management header strip.

## License

MIT — see [LICENSE](LICENSE).
