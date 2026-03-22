import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes, createCipheriv } from 'crypto';
import pako from 'pako';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  WebSocketMessage
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
app.use(express.static(path.join(__dirname, '../dist/frontend')));

// ============================================================================
// Active Client Tracking
// ============================================================================

interface ClientInfo {
  ws: WebSocket;
  lastActivity: number;
  isActive: boolean;
  isPinned: boolean;
}

const clients = new Map<WebSocket, ClientInfo>();
let activeClient: WebSocket | null = null;
let pinnedClient: WebSocket | null = null;
let hasAutoPinnedFirst = false; // Only auto-pin the very first client after server boot

// Track the first browser-detected URL for helpful error messages
let detectedCanvasUrl: string | null = null;

function getCanvasUrl(): string {
  // Priority: BASE_URL env > first detected browser URL > default localhost
  const BASE_URL = process.env.BASE_URL;
  const PORT = process.env.PORT || '3000';
  if (BASE_URL) return BASE_URL;
  if (detectedCanvasUrl) return detectedCanvasUrl;
  return `http://localhost:${PORT}`;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  targetClient: WebSocket;
}

const pendingRequests = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT = 30000;

function rejectPendingRequestsForClient(ws: WebSocket): void {
  for (const [requestId, pending] of pendingRequests.entries()) {
    if (pending.targetClient === ws) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);
      pending.reject(new Error('Browser client disconnected while operation was pending'));
    }
  }
}

function sendToClient(ws: WebSocket, message: WebSocketMessage): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function getActiveClient(): WebSocket | null {
  // Only return pinned client - no automatic fallback
  if (pinnedClient && clients.has(pinnedClient) && pinnedClient.readyState === WebSocket.OPEN) {
    return pinnedClient;
  }
  return null;
}

function setActiveClient(ws: WebSocket): void {
  const wasChanged = activeClient !== ws;
  activeClient = ws;
  for (const [clientWs, info] of clients.entries()) {
    const isTarget = pinnedClient ? clientWs === pinnedClient : clientWs === ws;
    info.isActive = isTarget;
    sendToClient(clientWs, { type: 'active_status', isActive: isTarget });
  }
  logger.info('Active client changed', { totalClients: clients.size, hasPinned: !!pinnedClient });
  // Notify MCP clients if not pinned (pinned takes precedence)
  if (wasChanged && !pinnedClient) {
    notifyMcpClientsTargetChanged('switched');
  }
}

function setPinnedClient(ws: WebSocket, pinned: boolean): void {
  const info = clients.get(ws);
  if (!info) return;

  if (pinned) {
    // Unpin previous client if any
    if (pinnedClient && pinnedClient !== ws) {
      const prevInfo = clients.get(pinnedClient);
      if (prevInfo) {
        prevInfo.isPinned = false;
        sendToClient(pinnedClient, { type: 'pin_status', isPinned: false, isActive: false });
      }
    }
    pinnedClient = ws;
    info.isPinned = true;
    // Notify all clients about the new pinned state
    for (const [clientWs, clientInfo] of clients.entries()) {
      const isTarget = clientWs === ws;
      clientInfo.isActive = isTarget;
      sendToClient(clientWs, { type: 'pin_status', isPinned: clientWs === ws, isActive: isTarget });
    }
    logger.info('Client pinned as MCP target', { totalClients: clients.size });
    notifyMcpClientsTargetChanged('pinned');
  } else {
    // Unpin this client
    if (pinnedClient === ws) {
      pinnedClient = null;
    }
    info.isPinned = false;
    // Notify all clients - fall back to active client behavior
    for (const [clientWs, clientInfo] of clients.entries()) {
      const isTarget = clientWs === activeClient;
      clientInfo.isActive = isTarget;
      sendToClient(clientWs, { type: 'pin_status', isPinned: false, isActive: isTarget });
    }
    logger.info('Client unpinned', { totalClients: clients.size });
    notifyMcpClientsTargetChanged('unpinned');
  }
}

async function sendMcpOperation(message: WebSocketMessage): Promise<any> {
  const client = getActiveClient();
  if (!client) {
    throw new Error(`No canvas pinned. Open ${getCanvasUrl()} and click the Pin button.`);
  }

  const requestId = generateId();
  message.requestId = requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Browser did not respond within 30 seconds'));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(requestId, { resolve, reject, timeout, targetClient: client });

    if (!sendToClient(client, message)) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(new Error('Failed to send message to browser'));
    }
  });
}

function handleMcpResponse(requestId: string, success: boolean, data: any, error?: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);

  if (success) {
    pending.resolve(data);
  } else {
    pending.reject(new Error(error || 'Operation failed'));
  }
}

// ============================================================================
// WebSocket Connection Handling
// ============================================================================

wss.on('connection', (ws: WebSocket, req) => {
  clients.set(ws, { ws, lastActivity: Date.now(), isActive: false, isPinned: false });
  logger.info('WebSocket connected', { totalClients: clients.size });

  // Capture the canvas URL from the first browser connection
  if (!detectedCanvasUrl && req.headers.host) {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    detectedCanvasUrl = `${protocol}://${req.headers.host}`;
    logger.info('Detected canvas URL from browser', { url: detectedCanvasUrl });
  }

  if (!hasAutoPinnedFirst) {
    // Auto-pin only the very first client after server boot
    hasAutoPinnedFirst = true;
    setPinnedClient(ws, true);
  } else {
    // Send current status to new client
    const isTarget = pinnedClient ? ws === pinnedClient : ws === activeClient;
    sendToClient(ws, { type: 'pin_status', isPinned: false, isActive: isTarget });
  }

  ws.on('message', (rawData: Buffer) => {
    try {
      const data = JSON.parse(rawData.toString()) as WebSocketMessage;
      const info = clients.get(ws);
      if (info) info.lastActivity = Date.now();

      if (data.type === 'client_focus') {
        // Only change active client if no pinned client
        if (!pinnedClient) {
          setActiveClient(ws);
        }
      } else if (data.type === 'client_pin') {
        setPinnedClient(ws, data.pinned);
      } else if (data.type === 'mcp_operation_response') {
        handleMcpResponse(data.requestId, data.success, data.data, data.error);
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    const wasPinned = pinnedClient === ws;
    const wasActive = activeClient === ws;
    // Reject any pending requests targeted at this client
    rejectPendingRequestsForClient(ws);
    clients.delete(ws);
    if (pinnedClient === ws) {
      pinnedClient = null;
    }
    if (activeClient === ws) {
      activeClient = null;
    }
    // Try to find a new active client
    if (wasPinned || activeClient === null) {
      getActiveClient();
    }
    logger.info('WebSocket closed', { totalClients: clients.size, wasPinned });
    // Notify MCP clients if target was lost
    if (wasPinned || wasActive) {
      notifyMcpClientsTargetChanged('disconnected');
    }
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    // Reject any pending requests targeted at this client
    rejectPendingRequestsForClient(ws);
    if (pinnedClient === ws) {
      pinnedClient = null;
    }
    clients.delete(ws);
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

// Host path translation for Docker: maps host paths to container mount point
// Set HOST_HOME_MOUNT to the container path where the host home is mounted (e.g. /host_home)
// Set HOST_HOME_PATH to the host home path prefix to match (e.g. /Users/frank)
const HOST_HOME_MOUNT = process.env.HOST_HOME_MOUNT || '';
const HOST_HOME_PATH = process.env.HOST_HOME_PATH || '';

function resolveHostPath(hostPath: string): string {
  if (!HOST_HOME_MOUNT || !HOST_HOME_PATH) return hostPath; // local mode, no translation

  if (!hostPath.startsWith(HOST_HOME_PATH)) {
    throw new Error(`Path "${hostPath}" is outside the mounted home directory (${HOST_HOME_PATH}). Cannot write to paths outside the volume mount.`);
  }

  return hostPath.replace(HOST_HOME_PATH, HOST_HOME_MOUNT);
}

function unresolveHostPath(containerPath: string): string {
  if (!HOST_HOME_MOUNT || !HOST_HOME_PATH) return containerPath;
  return containerPath.replace(HOST_HOME_MOUNT, HOST_HOME_PATH);
}

function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text && element.type !== 'text') {
    return { ...rest, label: { text } } as ServerElement;
  }
  return element;
}

const CreateElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({ text: z.string() }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional()
});

// Stub for canvas target change notifications (no longer uses SSE clients)
function notifyMcpClientsTargetChanged(reason: 'pinned' | 'unpinned' | 'switched' | 'disconnected'): void {
  logger.info('Canvas target changed', { reason, connectedBrowsers: clients.size });
}

// ============================================================================
// MCP Server (Official SDK with Streamable HTTP Transport)
// ============================================================================

function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    { name: 'mcp-excalidraw', version: '1.0.3' },
    { capabilities: { tools: {}, logging: {} } }
  );

  // -- create_element --
  mcpServer.registerTool('create_element', {
    description: 'Create a new Excalidraw element on the canvas',
    inputSchema: {
      type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
      x: z.number(),
      y: z.number(),
      id: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      backgroundColor: z.string().optional(),
      strokeColor: z.string().optional(),
      strokeWidth: z.number().optional(),
      roughness: z.number().optional(),
      opacity: z.number().optional(),
      text: z.string().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const { id: providedId, ...rest } = args;
      const element: ServerElement = {
        id: providedId || generateId(),
        ...rest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };
      const result = await sendMcpOperation({ type: 'mcp_create_element', element: convertTextToLabel(element) });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- update_element --
  mcpServer.registerTool('update_element', {
    description: 'Update an existing Excalidraw element',
    inputSchema: {
      id: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      backgroundColor: z.string().optional(),
      strokeColor: z.string().optional(),
      text: z.string().optional(),
    }
  }, async ({ id, ...updates }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_update_element', elementId: id, updates });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- delete_element --
  mcpServer.registerTool('delete_element', {
    description: 'Delete an Excalidraw element',
    inputSchema: {
      id: z.string(),
    }
  }, async ({ id }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_delete_element', elementId: id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- query_elements --
  mcpServer.registerTool('query_elements', {
    description: 'Get raw element data (IDs, coordinates, properties) for programmatic manipulation. Use export_canvas instead if you want to SEE what is on the canvas.',
    inputSchema: {
      type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const filter = args.type ? { type: args.type } : undefined;
      const result = await sendMcpOperation({ type: 'mcp_query_elements', filter });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- batch_create_elements --
  mcpServer.registerTool('batch_create_elements', {
    description: 'Create multiple elements at once',
    inputSchema: {
      elements: z.array(z.object({
        type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
        x: z.number(),
        y: z.number(),
        id: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        backgroundColor: z.string().optional(),
        strokeColor: z.string().optional(),
        text: z.string().optional(),
      })),
    }
  }, async ({ elements }): Promise<CallToolResult> => {
    try {
      const preparedElements = elements.map((el) => {
        return convertTextToLabel({
          id: el.id || generateId(),
          ...el,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        });
      });
      const result = await sendMcpOperation({ type: 'mcp_batch_create', elements: preparedElements });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- create_from_mermaid --
  mcpServer.registerTool('create_from_mermaid', {
    description: 'Convert a Mermaid diagram to Excalidraw elements',
    inputSchema: {
      mermaidDiagram: z.string().describe('Mermaid diagram definition'),
    }
  }, async ({ mermaidDiagram }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mermaid_convert', mermaidDiagram, config: {}, timestamp: new Date().toISOString() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- export_canvas --
  mcpServer.registerTool('export_canvas', {
    description: 'Export the canvas. Use png to SEE what is on the canvas visually. Use excalidraw to get the native .excalidraw JSON (for saving to file).',
    inputSchema: {
      format: z.enum(['png', 'svg', 'excalidraw']).describe('png = visual image, svg = vector, excalidraw = native JSON format'),
    }
  }, async ({ format }): Promise<CallToolResult> => {
    try {
      if (format === 'excalidraw') {
        const result = await sendMcpOperation({ type: 'save_canvas_request', formats: ['excalidraw'] });
        if (result.excalidraw) {
          return { content: [{ type: 'text', text: result.excalidraw }] };
        }
        return { content: [{ type: 'text', text: 'Error: No data returned' }], isError: true };
      }
      const result = await sendMcpOperation({ type: 'export_canvas_request', format });
      if (format === 'png' && result.data) {
        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
      }
      if (format === 'svg' && result.data) {
        return { content: [{ type: 'text', text: result.data }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- clear_canvas --
  mcpServer.registerTool('clear_canvas', {
    description: 'Clear all elements from the canvas',
  }, async (): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_clear_canvas' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- save_canvas -- (only when filesystem is accessible)
  const isContainer = fs.existsSync('/.dockerenv');
  const canSaveToDisk = !isContainer || !!HOST_HOME_MOUNT;

  if (canSaveToDisk) mcpServer.registerTool('save_canvas', {
    description: 'Save the canvas to disk. Supports .excalidraw (native), .png, and .svg formats. Extension is added automatically.',
    inputSchema: {
      filename_without_extension: z.string().describe('Full path without extension, e.g. /Users/frank/Documents/my-diagram'),
      format: z.union([
        z.enum(['excalidraw', 'png', 'svg']),
        z.array(z.enum(['excalidraw', 'png', 'svg']))
      ]).describe('Format or array of formats, e.g. "excalidraw" or ["excalidraw", "png", "svg"]'),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const formats = Array.isArray(args.format) ? args.format : [args.format];
      const basePath = resolveHostPath(args.filename_without_extension);

      // Ensure parent directory exists
      const dir = path.dirname(basePath);
      fs.mkdirSync(dir, { recursive: true });

      // Request the browser to serialize the canvas in all requested formats
      const result = await sendMcpOperation({ type: 'save_canvas_request', formats });

      const saved: { format: string; path: string; size: number }[] = [];

      for (const fmt of formats) {
        const data = result[fmt];
        if (!data) continue;

        const ext = fmt === 'excalidraw' ? '.excalidraw' : `.${fmt}`;
        const filePath = `${basePath}${ext}`;

        if (fmt === 'png') {
          const buffer = Buffer.from(data, 'base64');
          fs.writeFileSync(filePath, buffer);
          saved.push({ format: fmt, path: filePath, size: buffer.length });
        } else {
          fs.writeFileSync(filePath, data, 'utf-8');
          saved.push({ format: fmt, path: filePath, size: Buffer.byteLength(data, 'utf-8') });
        }
      }

      // Report back with the original host paths (not container paths)
      const hostSaved = saved.map(s => ({
        ...s,
        path: unresolveHostPath(s.path)
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ saved: hostSaved }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- get_element --
  mcpServer.registerTool('get_element', {
    description: 'Get a single Excalidraw element by its ID',
    inputSchema: {
      id: z.string(),
    }
  }, async ({ id }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_get_element', elementId: id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- lock_elements --
  mcpServer.registerTool('lock_elements', {
    description: 'Lock elements by their IDs, preventing them from being moved or edited',
    inputSchema: {
      ids: z.array(z.string()),
    }
  }, async ({ ids }): Promise<CallToolResult> => {
    try {
      let lockedCount = 0;
      for (const id of ids) {
        await sendMcpOperation({ type: 'mcp_update_element', elementId: id, updates: { locked: true } });
        lockedCount++;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ locked: lockedCount }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- unlock_elements --
  mcpServer.registerTool('unlock_elements', {
    description: 'Unlock elements by their IDs, allowing them to be moved or edited again',
    inputSchema: {
      ids: z.array(z.string()),
    }
  }, async ({ ids }): Promise<CallToolResult> => {
    try {
      let unlockedCount = 0;
      for (const id of ids) {
        await sendMcpOperation({ type: 'mcp_update_element', elementId: id, updates: { locked: false } });
        unlockedCount++;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ unlocked: unlockedCount }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- duplicate_elements --
  mcpServer.registerTool('duplicate_elements', {
    description: 'Duplicate elements with an optional position offset',
    inputSchema: {
      ids: z.array(z.string()),
      offsetX: z.number().optional().default(20),
      offsetY: z.number().optional().default(20),
    }
  }, async ({ ids, offsetX, offsetY }): Promise<CallToolResult> => {
    try {
      const allElements = await sendMcpOperation({ type: 'mcp_query_elements' });
      const elementsArray = Array.isArray(allElements) ? allElements : [];
      const matched = elementsArray.filter((el: any) => ids.includes(el.id));
      if (matched.length === 0) {
        return { content: [{ type: 'text', text: 'Error: No matching elements found' }], isError: true };
      }
      const clones = matched.map((el: any) => ({
        ...el,
        id: generateId(),
        x: (el.x || 0) + offsetX,
        y: (el.y || 0) + offsetY,
        groupIds: [],
        boundElements: null,
        containerId: null,
      }));
      const result = await sendMcpOperation({ type: 'mcp_batch_create', elements: clones });
      return { content: [{ type: 'text', text: JSON.stringify({ duplicated: clones.length, newIds: clones.map((c: any) => c.id) }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- import_scene --
  mcpServer.registerTool('import_scene', {
    description: 'Import a .excalidraw file from disk onto the canvas',
    inputSchema: {
      filePath: z.string(),
      mode: z.enum(['replace', 'merge']).optional().default('merge'),
    }
  }, async ({ filePath: inputPath, mode }): Promise<CallToolResult> => {
    try {
      const resolvedPath = resolveHostPath(inputPath);
      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      if (!parsed.elements || !Array.isArray(parsed.elements)) {
        return { content: [{ type: 'text', text: 'Error: Invalid .excalidraw file - no elements array found' }], isError: true };
      }
      if (mode === 'replace') {
        await sendMcpOperation({ type: 'mcp_clear_canvas' });
      }
      await sendMcpOperation({ type: 'mcp_batch_create', elements: parsed.elements });
      return { content: [{ type: 'text', text: JSON.stringify({ imported: parsed.elements.length, mode }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- describe_scene --
  mcpServer.registerTool('describe_scene', {
    description: 'Describe the current canvas contents as a structured text summary',
  }, async (): Promise<CallToolResult> => {
    try {
      const allElements = await sendMcpOperation({ type: 'mcp_query_elements' });
      const elements = Array.isArray(allElements) ? allElements : [];
      if (elements.length === 0) {
        return { content: [{ type: 'text', text: 'Canvas is empty.' }] };
      }

      // Count by type
      const typeCounts: Record<string, number> = {};
      for (const el of elements) {
        typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
      }

      // Bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of elements) {
        const x = el.x ?? 0;
        const y = el.y ?? 0;
        const w = el.width ?? 0;
        const h = el.height ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
      }

      // Sort top-to-bottom, left-to-right
      const sorted = [...elements].sort((a, b) => {
        const dy = (a.y ?? 0) - (b.y ?? 0);
        if (Math.abs(dy) > 10) return dy;
        return (a.x ?? 0) - (b.x ?? 0);
      });

      // Build description
      const lines: string[] = [];
      lines.push(`# Scene Description`);
      lines.push(``);
      lines.push(`Total elements: ${elements.length}`);
      lines.push(`Types: ${Object.entries(typeCounts).map(([t, c]) => `${t} (${c})`).join(', ')}`);
      lines.push(`Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)})`);
      lines.push(``);
      lines.push(`## Elements`);
      lines.push(``);
      for (const el of sorted) {
        const id = (el.id || '').substring(0, 8);
        const pos = `(${Math.round(el.x ?? 0)}, ${Math.round(el.y ?? 0)})`;
        const size = `${Math.round(el.width ?? 0)}x${Math.round(el.height ?? 0)}`;
        let label = '';
        if (el.text) label = ` text="${el.text}"`;
        else if (el.label?.text) label = ` label="${el.label.text}"`;
        lines.push(`- ${el.type} [${id}] at ${pos} size ${size}${label}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- read_diagram_guide --
  mcpServer.registerTool('read_diagram_guide', {
    description: 'Return a static design guide with color palettes, sizing rules, and layout best practices for Excalidraw diagrams',
  }, async (): Promise<CallToolResult> => {
    const guide = `# Excalidraw Diagram Design Guide

## Color Palette

### Stroke Colors (use for borders & text)
| Name    | Hex       | Use for                     |
|---------|-----------|-----------------------------|
| Black   | #1e1e1e   | Default text & borders      |
| Red     | #e03131   | Errors, warnings, critical  |
| Green   | #2f9e44   | Success, approved, healthy  |
| Blue    | #1971c2   | Primary actions, links      |
| Purple  | #9c36b5   | Services, middleware        |
| Orange  | #e8590c   | Async, queues, events       |
| Cyan    | #0c8599   | Data stores, databases      |
| Gray    | #868e96   | Annotations, secondary      |

### Fill Colors (use for backgroundColor — pastel fills)
| Name         | Hex       | Pairs with stroke |
|--------------|-----------|-------------------|
| Light Red    | #ffc9c9   | #e03131           |
| Light Green  | #b2f2bb   | #2f9e44           |
| Light Blue   | #a5d8ff   | #1971c2           |
| Light Purple | #eebefa   | #9c36b5           |
| Light Orange | #ffd8a8   | #e8590c           |
| Light Cyan   | #99e9f2   | #0c8599           |
| Light Gray   | #e9ecef   | #868e96           |
| White        | #ffffff   | #1e1e1e           |

## Sizing Rules
- Minimum shape size: width >= 120px, height >= 60px
- Font sizes: body text >= 16, titles/headers >= 20, small labels >= 14
- Padding: leave at least 20px inside shapes for text breathing room
- Arrow length: minimum 80px between connected shapes

## Layout Patterns
- Grid snap: align to 20px grid for clean layouts
- Spacing: 40-80px gap between adjacent shapes
- Flow direction: top-to-bottom or left-to-right
- Grouping: cluster related elements; use background rectangles as zones

## Anti-Patterns to Avoid
1. Overlapping elements - always leave gaps
2. Tiny fonts - never below 14px
3. Too many colors - limit to 3-4 fill colors per diagram
4. No labels - every shape should have text`;

    return { content: [{ type: 'text', text: guide }] };
  });

  // -- set_viewport --
  mcpServer.registerTool('set_viewport', {
    description: 'Control the canvas camera: scroll to content, scroll to a specific element, or set zoom level',
    inputSchema: {
      scrollToContent: z.boolean().optional(),
      scrollToElementId: z.string().optional(),
      zoom: z.number().optional(),
    }
  }, async ({ scrollToContent, scrollToElementId, zoom }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_set_viewport', scrollToContent, scrollToElementId, zoom });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- align_elements --
  mcpServer.registerTool('align_elements', {
    description: 'Align elements along a specified axis (left, center, right, top, middle, bottom)',
    inputSchema: {
      ids: z.array(z.string()).min(2),
      alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
    }
  }, async ({ ids, alignment }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_align_elements', ids, alignment });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- distribute_elements --
  mcpServer.registerTool('distribute_elements', {
    description: 'Distribute elements evenly along the horizontal or vertical axis',
    inputSchema: {
      ids: z.array(z.string()).min(3),
      direction: z.enum(['horizontal', 'vertical']),
    }
  }, async ({ ids, direction }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_distribute_elements', ids, direction });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- group_elements --
  mcpServer.registerTool('group_elements', {
    description: 'Group or ungroup elements by their IDs',
    inputSchema: {
      ids: z.array(z.string()).min(2),
      action: z.enum(['group', 'ungroup']).optional().default('group'),
    }
  }, async ({ ids, action }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'mcp_group_elements', ids, action });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // -- export_to_excalidraw_url --
  mcpServer.registerTool('export_to_excalidraw_url', {
    description: 'Export the canvas to a shareable excalidraw.com URL. The diagram is end-to-end encrypted. Anyone with the URL can view it.',
  }, async (): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation({ type: 'save_canvas_request', formats: ['excalidraw'] });
      if (!result.excalidraw) throw new Error('No scene data returned from browser');
      const url = await encryptAndUpload(result.excalidraw);
      return { content: [{ type: 'text', text: url }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  return mcpServer;
}

// ============================================================================
// Streamable HTTP Transport - Session Management
// ============================================================================

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpPost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && mcpTransports.has(sessionId)) {
      // Reuse existing transport for this session
      const transport = mcpTransports.get(sessionId)!;
      await transport.handleRequest(req, res, body);
    } else if (!sessionId && isInitializeRequest(body)) {
      // New initialization request - create transport and server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          mcpTransports.set(newSessionId, transport);
          logger.info('MCP session initialized', { sessionId: newSessionId });
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          mcpTransports.delete(sid);
          logger.info('MCP session closed', { sessionId: sid });
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      }));
    }
  } catch (error) {
    logger.error('MCP request error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      }));
    }
  }
}

async function handleMcpGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpTransports.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing session ID');
    return;
  }
  const transport = mcpTransports.get(sessionId)!;
  await transport.handleRequest(req, res);
}

async function handleMcpDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpTransports.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing session ID');
    return;
  }
  const transport = mcpTransports.get(sessionId)!;
  await transport.handleRequest(req, res);
}

// Mount MCP Streamable HTTP endpoints on Express
app.post('/mcp', async (req: Request, res: Response) => {
  await handleMcpPost(req as unknown as IncomingMessage, res as unknown as ServerResponse, req.body);
});

app.get('/mcp', async (req: Request, res: Response) => {
  await handleMcpGet(req as unknown as IncomingMessage, res as unknown as ServerResponse);
});

app.delete('/mcp', async (req: Request, res: Response) => {
  await handleMcpDelete(req as unknown as IncomingMessage, res as unknown as ServerResponse);
});

// ============================================================================
// Share to excalidraw.com (encrypt + upload server-side, crypto.subtle needs HTTPS)
// ============================================================================

async function encryptAndUpload(sceneJSON: string): Promise<string> {
  // Compress
  const compressed = pako.deflate(new TextEncoder().encode(sceneJSON));

  // Generate 128-bit AES-GCM key + 12-byte IV
  const key = randomBytes(16);
  const iv = randomBytes(12);

  // Encrypt with AES-128-GCM
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine: IV (12) + ciphertext + authTag (16) — matches Web Crypto AES-GCM output
  const combined = Buffer.concat([iv, encrypted, authTag]);

  // Upload to excalidraw.com
  const response = await fetch('https://json.excalidraw.com/api/v2/post/', {
    method: 'POST',
    body: combined,
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const { id } = await response.json() as { id: string };

  // Key as base64url (no padding)
  const keyB64 = key.toString('base64url');

  return `https://excalidraw.com/#json=${id},${keyB64}`;
}

app.post('/api/share', async (req: Request, res: Response) => {
  try {
    const sceneJSON = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const url = await encryptAndUpload(sceneJSON);
    res.json({ url });
  } catch (error) {
    logger.error('Share failed:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Health & Frontend
// ============================================================================

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocket_clients: clients.size,
    active_client: activeClient ? 'connected' : 'none',
    pinned_client: pinnedClient ? 'connected' : 'none',
    mcp_target: pinnedClient ? 'pinned' : (activeClient ? 'active' : 'none'),
    mcp_endpoint: '/mcp'
  });
});

app.get('/', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Run "bun run build" first.');
    }
  });
});

// Error handling
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info(`Server running on http://${HOST}:${PORT}`);
  logger.info(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
  logger.info(`Canvas UI: http://${HOST}:${PORT}/`);
});

export default app;
