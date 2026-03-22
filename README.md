# MCP Excalidraw

[![CI](https://github.com/yctimlin/mcp_excalidraw/actions/workflows/ci.yml/badge.svg)](https://github.com/yctimlin/mcp_excalidraw/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A real-time Excalidraw canvas with MCP (Model Context Protocol) integration. AI agents like Claude can create and manipulate diagrams directly on a live canvas.

## Features

- **Live Canvas**: Real-time Excalidraw interface in your browser
- **MCP Integration**: AI agents can create, update, and query canvas elements
- **Mermaid Support**: Convert Mermaid diagrams to Excalidraw elements
- **PNG/SVG Export**: Export canvas as images for AI to view
- **Pin System**: Pin a browser tab as the MCP target

## Quick Start

### 1. Start the Server

**Local:**
```bash
git clone https://github.com/yctimlin/mcp_excalidraw.git
cd mcp_excalidraw
npm install
npm run build
npm start
```

**Docker:**
```bash
docker run -d -p 3000:3000 ghcr.io/yctimlin/mcp_excalidraw:latest
```

### 2. Open the Canvas

Open http://localhost:3000 in your browser. Click the pin icon to make this tab the MCP target.

### 3. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "mcp-proxy",
      "args": ["http://localhost:3000/sse"]
    }
  }
}
```

> **Note:** Install mcp-proxy first: `pip install mcp-proxy` or use pipx

### 4. Use with Claude

Ask Claude to:
- "Draw a flowchart showing user authentication"
- "Create a system architecture diagram"
- "Export the canvas as PNG so you can see it"

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_element` | Create rectangle, ellipse, diamond, arrow, text, line |
| `update_element` | Modify existing elements |
| `delete_element` | Remove elements |
| `query_elements` | Get element data (IDs, positions, properties) |
| `batch_create_elements` | Create multiple elements at once |
| `create_from_mermaid` | Convert Mermaid diagram to Excalidraw |
| `export_canvas` | Export as PNG or SVG (use PNG to see the canvas) |
| `clear_canvas` | Clear all elements |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Server (port 3000)                    │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Express    │  │  WebSocket   │  │     MCP      │  │
│  │   (Static)   │  │  (Browser)   │  │  (SSE/HTTP)  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                   │                  │
         ▼                   ▼                  ▼
    ┌─────────┐        ┌─────────┐        ┌─────────┐
    │ Browser │◄──────►│ Canvas  │◄──────►│ Claude  │
    │  (UI)   │        │ (State) │        │  (MCP)  │
    └─────────┘        └─────────┘        └─────────┘
```

The browser is the single source of truth. MCP operations are routed to the pinned browser tab.

## Status Bar Icons

The canvas shows three status icons in the top-right:

- **Cloud** (green): Connected to server
- **MCP** (blue blink): MCP operation in progress
- **Pin** (gold): This tab receives MCP commands (click to toggle)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |

## Development

```bash
# Watch mode (TypeScript + Vite)
npm run dev

# Type check
npm run type-check

# Build
npm run build
```

## Project Structure

```
mcp_excalidraw/
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Main React component
│   │   └── main.tsx          # Entry point
│   └── index.html
├── src/
│   ├── server.ts             # Express + WebSocket + MCP server
│   ├── types.ts              # Type definitions
│   └── utils/logger.ts       # Logging
├── dist/                     # Built output
├── package.json
└── tsconfig.json
```

## Troubleshooting

**Canvas not loading:**
- Run `npm run build` first
- Check if port 3000 is available

**MCP not connecting:**
- Ensure mcp-proxy is installed
- Check the server is running at http://localhost:3000
- Verify the SSE endpoint: http://localhost:3000/sse

**Elements not appearing:**
- Click the pin icon in the browser to make it the MCP target
- Check browser console for errors

## License

MIT License - see [LICENSE](LICENSE)

## Acknowledgments

- [Excalidraw](https://excalidraw.com/) - The drawing library
- [Model Context Protocol](https://modelcontextprotocol.io/) - AI integration standard
