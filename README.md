# mcp-excalidraw-live

[![CI](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/ci.yml/badge.svg)](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/ci.yml)
[![Docker](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/docker.yml/badge.svg)](https://github.com/frankhommers/mcp-excalidraw-live/actions/workflows/docker.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A live Excalidraw canvas controlled by AI agents via MCP Streamable HTTP. Fork of [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) with a completely different architecture.

## How It Differs From Upstream

| | **Upstream** | **mcp-excalidraw-live** |
|---|---|---|
| Architecture | 2 processes (canvas + stdio MCP) with REST bridge | Single process, everything-in-one |
| MCP Transport | stdio (client spawns a node process) | **Streamable HTTP** (`POST /mcp`) |
| MCP SDK | Handwritten JSON-RPC | Official `@modelcontextprotocol/sdk` |
| Canvas state | Server-side in-memory | **Browser-side** (localStorage persistence) |
| Runtime | Node.js + npm | **Bun** |
| Stack | React 18, Express 4, Vite 6, Zod 3 | **React 19, Express 5, Vite 8, Zod 4, TS 5.9** |

## Quick Start

### Local

```bash
bun install
bun run build
bun dist/server.js
```

Open `http://localhost:3000` — that's your canvas.

### Docker

```bash
docker compose up -d
```

Open `http://localhost:3000`.

### Configure Your MCP Client

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

That's it. No stdio, no spawning processes, just a URL.

## MCP Tools (21)

| Category | Tools |
|---|---|
| **Element CRUD** | `create_element`, `get_element`, `update_element`, `delete_element`, `query_elements`, `batch_create_elements`, `duplicate_elements` |
| **Layout** | `align_elements`, `distribute_elements`, `group_elements`, `lock_elements`, `unlock_elements` |
| **Canvas** | `clear_canvas`, `describe_scene`, `set_viewport` |
| **Export** | `export_canvas` (png/svg/excalidraw), `save_canvas` (to disk), `export_to_excalidraw_url` (shareable link) |
| **Import** | `import_scene` (.excalidraw files), `create_from_mermaid` |
| **Reference** | `read_diagram_guide` (color palette, sizing rules, layout patterns) |

## Features

- **Live canvas** with real-time WebSocket sync between AI agent and browser
- **MCP activity indicator** — green flashing border + icon when the agent is working
- **Canvas persistence** — survives page refresh (localStorage)
- **Share button** — upload to excalidraw.com, get a shareable encrypted link
- **Save to disk** — `save_canvas` writes .excalidraw/.png/.svg to your filesystem
- **Docker with host path translation** — `save_canvas` works transparently in Docker via volume mount
- **iPad/tablet support** — works on any device with a browser

## Docker Details

The `docker-compose.yml` mounts your home directory so `save_canvas` can write files:

```yaml
volumes:
  - ${HOME}:/host_home
environment:
  - HOST_HOME_MOUNT=/host_home
  - HOST_HOME_PATH=${HOME}
```

The agent uses normal paths (e.g. `/Users/frank/Documents/diagram`), the server translates them to the container mount. Paths outside your home directory are rejected.

Custom port:

```bash
HOST_PORT=8080 docker compose up -d
```

## Development

```bash
bun install
bun run dev        # concurrent: tsc --watch + vite dev server
bun run type-check # typecheck without emitting
bun run build      # production build
```

## License

MIT — see [LICENSE](LICENSE).
