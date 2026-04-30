import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes, createCipheriv } from 'crypto';
import pako from 'pako';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  generateId,
  normalizeFontFamily,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  WebSocketMessage,
  SessionInfo,
  CanvasInfo,
  GrantInfo
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

// Track the first browser-detected URL for helpful error messages
let detectedCanvasUrl: string | null = null;

function getCanvasUrl(): string {
  const BASE_URL = process.env.BASE_URL;
  const PORT = process.env.PORT || '3000';
  if (BASE_URL) return BASE_URL;
  if (detectedCanvasUrl) return detectedCanvasUrl;
  return `http://localhost:${PORT}`;
}

// ============================================================================
// v3.0.0 Registries: canvases, sessions, grants
// ============================================================================

interface SnapshotEntry {
  name: string;
  scene: string;       // serialized .excalidraw JSON
  elementCount: number;
  createdAt: string;
}

interface CanvasEntry {
  canvasId: string;
  name: string;
  ws: WebSocket;
  createdAt: string;
  snapshots: Map<string, SnapshotEntry>;  // name -> snapshot
}

interface SessionEntry {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  purpose: string;
  createdAt: string;
  activeCanvasId: string | null;  // when session has multiple grants, which is active
}

interface GrantEntry {
  sessionId: string;
  canvasId: string;
  grantedAt: string;
}

interface PendingEntry {
  session: SessionEntry;
  resolver: (result: { canvasId: string; name: string } | null) => void;
  timeoutHandle: NodeJS.Timeout;
}

const canvases = new Map<string, CanvasEntry>();           // canvasId -> entry
const sessions = new Map<string, SessionEntry>();          // sessionId -> entry
const grants: GrantEntry[] = [];                            // (sessionId, canvasId) tuples
const pending = new Map<string, PendingEntry>();           // sessionId -> long-poll resolver
const wsToCanvas = new Map<WebSocket, string>();           // reverse: ws -> canvasId

const LONG_POLL_MS = 5000;
const PENDING_MAX_LIFETIME_MS = 5 * 60 * 1000;  // session abandons after 5min unanswered

function toCanvasInfo(c: CanvasEntry): CanvasInfo {
  return { canvasId: c.canvasId, name: c.name, createdAt: c.createdAt };
}

function toSessionInfo(s: SessionEntry): SessionInfo {
  return {
    sessionId: s.sessionId,
    clientName: s.clientName,
    clientVersion: s.clientVersion,
    purpose: s.purpose,
    createdAt: s.createdAt
  };
}

function toGrantInfo(g: GrantEntry): GrantInfo {
  return { sessionId: g.sessionId, canvasId: g.canvasId, grantedAt: g.grantedAt };
}

function getGrantsForCanvas(canvasId: string): GrantEntry[] {
  return grants.filter(g => g.canvasId === canvasId);
}

function getGrantsForSession(sessionId: string): GrantEntry[] {
  return grants.filter(g => g.sessionId === sessionId);
}

function getPendingSessions(): SessionEntry[] {
  return [...pending.values()].map(p => p.session);
}

function sendToWs(ws: WebSocket, message: WebSocketMessage): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      logger.warn('Failed to send to ws', { err });
      return false;
    }
  }
  return false;
}

function broadcastCanvasState(canvasId: string): void {
  const c = canvases.get(canvasId);
  if (!c) return;
  const grantedHere = getGrantsForCanvas(canvasId)
    .map(g => ({ ...toGrantInfo(g), session: toSessionInfo(sessions.get(g.sessionId)!) }))
    .filter(x => !!x.session);
  sendToWs(c.ws, {
    type: 'canvas_state',
    canvas: toCanvasInfo(c),
    pendingSessions: getPendingSessions().map(toSessionInfo),
    grants: grantedHere
  });
}

function broadcastPendingToAll(): void {
  // Pending pool is global; any canvas tab can grant. Push fresh state to everyone.
  for (const c of canvases.values()) {
    broadcastCanvasState(c.canvasId);
  }
}

function broadcastActivity(canvasId: string, sessionId: string, action: string): void {
  const c = canvases.get(canvasId);
  if (!c) return;
  sendToWs(c.ws, { type: 'activity', sessionId, action });
}

// ============================================================================
// MCP operation request/response correlation
// ============================================================================

interface PendingMcpRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  targetCanvasId: string;
}

const pendingMcpRequests = new Map<string, PendingMcpRequest>();
const REQUEST_TIMEOUT = 30000;

function rejectPendingMcpRequestsForCanvas(canvasId: string): void {
  for (const [requestId, p] of pendingMcpRequests.entries()) {
    if (p.targetCanvasId === canvasId) {
      clearTimeout(p.timeout);
      pendingMcpRequests.delete(requestId);
      p.reject(new Error('Canvas closed while operation was pending'));
    }
  }
}

async function sendMcpOperation(sessionId: string, message: WebSocketMessage): Promise<any> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not registered. Reconnect MCP transport.`);
  }
  const sessionGrants = getGrantsForSession(sessionId);
  if (sessionGrants.length === 0) {
    throw new Error(`No canvas granted to this session. Call request_canvas(purpose: "...") and have a human operator grant access at ${getCanvasUrl()}.`);
  }
  let canvasId: string | null = session.activeCanvasId;
  if (!canvasId) {
    if (sessionGrants.length === 1) {
      canvasId = sessionGrants[0]!.canvasId;
      session.activeCanvasId = canvasId;
    } else {
      const ids = sessionGrants.map(g => g.canvasId);
      throw new Error(`Ambiguous: session has grants on multiple canvases [${ids.join(', ')}]. Call select_canvas(canvasId) to choose one.`);
    }
  }
  const canvas = canvases.get(canvasId);
  if (!canvas) {
    // Stale grant — clean up
    const idx = grants.findIndex(g => g.sessionId === sessionId && g.canvasId === canvasId);
    if (idx >= 0) grants.splice(idx, 1);
    session.activeCanvasId = null;
    throw new Error(`Canvas ${canvasId} closed. Call request_canvas again.`);
  }

  const requestId = generateId();
  message.requestId = requestId;

  // Notify the canvas tab of activity (best-effort, non-blocking)
  broadcastActivity(canvasId, sessionId, message.type as string);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingMcpRequests.delete(requestId);
      reject(new Error('Browser did not respond within 30 seconds'));
    }, REQUEST_TIMEOUT);

    pendingMcpRequests.set(requestId, { resolve, reject, timeout, targetCanvasId: canvasId! });

    if (!sendToWs(canvas.ws, message)) {
      clearTimeout(timeout);
      pendingMcpRequests.delete(requestId);
      reject(new Error('Failed to send message to browser'));
    }
  });
}

function handleMcpResponse(requestId: string, success: boolean, data: any, error?: string): void {
  const p = pendingMcpRequests.get(requestId);
  if (!p) return;
  clearTimeout(p.timeout);
  pendingMcpRequests.delete(requestId);
  if (success) p.resolve(data);
  else p.reject(new Error(error || 'Operation failed'));
}

// ============================================================================
// Grant management
// ============================================================================

function grantSessionToCanvas(sessionId: string, canvasId: string): boolean {
  const session = sessions.get(sessionId);
  const canvas = canvases.get(canvasId);
  if (!session || !canvas) return false;

  // Avoid duplicate grant
  const existing = grants.find(g => g.sessionId === sessionId && g.canvasId === canvasId);
  if (!existing) {
    grants.push({ sessionId, canvasId, grantedAt: new Date().toISOString() });
  }
  // Set as active if session has no active canvas yet
  if (!session.activeCanvasId) {
    session.activeCanvasId = canvasId;
  }

  // Resolve pending request if any
  const pendingEntry = pending.get(sessionId);
  if (pendingEntry) {
    clearTimeout(pendingEntry.timeoutHandle);
    pending.delete(sessionId);
    pendingEntry.resolver({ canvasId, name: canvas.name });
  }

  // Notify all canvas tabs (pending pool changed)
  broadcastPendingToAll();
  return true;
}

function revokeGrant(sessionId: string, canvasId: string): boolean {
  const idx = grants.findIndex(g => g.sessionId === sessionId && g.canvasId === canvasId);
  if (idx < 0) return false;
  grants.splice(idx, 1);

  const session = sessions.get(sessionId);
  if (session && session.activeCanvasId === canvasId) {
    const remaining = getGrantsForSession(sessionId);
    session.activeCanvasId = remaining.length > 0 ? remaining[0]!.canvasId : null;
  }

  broadcastPendingToAll();
  return true;
}

function removeAllGrantsForSession(sessionId: string): void {
  for (let i = grants.length - 1; i >= 0; i--) {
    if (grants[i]!.sessionId === sessionId) grants.splice(i, 1);
  }
  broadcastPendingToAll();
}

function removeAllGrantsForCanvas(canvasId: string): void {
  const removed: string[] = [];
  for (let i = grants.length - 1; i >= 0; i--) {
    if (grants[i]!.canvasId === canvasId) {
      removed.push(grants[i]!.sessionId);
      grants.splice(i, 1);
    }
  }
  // Clear activeCanvasId for affected sessions
  for (const sid of removed) {
    const s = sessions.get(sid);
    if (s && s.activeCanvasId === canvasId) {
      const remaining = getGrantsForSession(sid);
      s.activeCanvasId = remaining.length > 0 ? remaining[0]!.canvasId : null;
    }
  }
  broadcastPendingToAll();
}

// ============================================================================
// WebSocket Connection Handling — each WS = one canvas
// ============================================================================

function shortId(): string {
  return Math.random().toString(36).substring(2, 8);
}

wss.on('connection', (ws: WebSocket, req) => {
  const canvasId = generateId();
  const canvas: CanvasEntry = {
    canvasId,
    name: `canvas-${shortId()}`,
    ws,
    createdAt: new Date().toISOString(),
    snapshots: new Map()
  };
  canvases.set(canvasId, canvas);
  wsToCanvas.set(ws, canvasId);

  if (!detectedCanvasUrl && req.headers.host) {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    detectedCanvasUrl = `${protocol}://${req.headers.host}`;
    logger.info('Detected canvas URL from browser', { url: detectedCanvasUrl });
  }

  logger.info('Canvas opened', { canvasId, name: canvas.name, totalCanvases: canvases.size });

  // Tell the browser its canvas identity, then full state
  sendToWs(ws, { type: 'canvas_assigned', canvasId, name: canvas.name });
  broadcastCanvasState(canvasId);

  ws.on('message', (rawData: Buffer) => {
    try {
      const data = JSON.parse(rawData.toString()) as WebSocketMessage;

      if (data.type === 'mcp_operation_response') {
        handleMcpResponse(data.requestId, data.success, data.data, data.error);
        return;
      }

      if (data.type === 'canvas_rename') {
        const newName = String(data.name || '').trim().slice(0, 100);
        if (newName) {
          canvas.name = newName;
          broadcastCanvasState(canvasId);
        }
        return;
      }

      if (data.type === 'grant_request') {
        // Validate canvasId matches this ws (security: tab can only grant to itself)
        if (data.canvasId !== canvasId) {
          logger.warn('Tab tried to grant for different canvas', { expected: canvasId, got: data.canvasId });
          return;
        }
        const granted = grantSessionToCanvas(String(data.sessionId), canvasId);
        if (granted) {
          logger.info('Session granted', { sessionId: data.sessionId, canvasId });
        }
        return;
      }

      if (data.type === 'revoke_grant') {
        if (data.canvasId !== canvasId) return;
        revokeGrant(String(data.sessionId), canvasId);
        logger.info('Grant revoked', { sessionId: data.sessionId, canvasId });
        return;
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    canvases.delete(canvasId);
    wsToCanvas.delete(ws);
    rejectPendingMcpRequestsForCanvas(canvasId);
    removeAllGrantsForCanvas(canvasId);
    logger.info('Canvas closed', { canvasId, totalCanvases: canvases.size });
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

const HOST_HOME_MOUNT = process.env.HOST_HOME_MOUNT || '';
const HOST_HOME_PATH = process.env.HOST_HOME_PATH || '';

function resolveHostPath(hostPath: string): string {
  if (!HOST_HOME_MOUNT || !HOST_HOME_PATH) return hostPath;
  if (!hostPath.startsWith(HOST_HOME_PATH)) {
    throw new Error(`Path "${hostPath}" is outside the mounted home directory (${HOST_HOME_PATH}).`);
  }
  return hostPath.replace(HOST_HOME_PATH, HOST_HOME_MOUNT);
}

function unresolveHostPath(containerPath: string): string {
  if (!HOST_HOME_MOUNT || !HOST_HOME_PATH) return containerPath;
  return containerPath.replace(HOST_HOME_MOUNT, HOST_HOME_PATH);
}

function convertTextToLabel(element: ServerElement): ServerElement {
  // Normalize fontFamily first (string names -> numeric) so Excalidraw doesn't crash on text rendering
  const e: any = { ...element };
  if (e.fontFamily !== undefined) {
    const norm = normalizeFontFamily(e.fontFamily);
    if (norm === undefined) delete e.fontFamily;
    else e.fontFamily = norm;
  }
  const { text, ...rest } = e;
  if (text && e.type !== 'text') {
    return { ...rest, label: { text } } as ServerElement;
  }
  return e as ServerElement;
}

// Compute edge intersection point for an element given a direction toward target.
// Used to route arrows from shape edge to shape edge instead of center to center.
function computeEdgePoint(
  el: any,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = (el.x || 0) + (el.width || 0) / 2;
  const cy = (el.y || 0) + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;

  if (el.type === 'diamond') {
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const denom = absDx / hw + absDy / hh;
    const scale = denom > 0 ? 1 / denom : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const angle = Math.atan2(dy, dx);
    return { x: cx + hw * Math.cos(angle), y: cy + hh * Math.sin(angle) };
  }

  // Rectangle (default)
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  if (Math.abs(tanA * hw) <= hh) {
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Resolve arrow bindings: compute x/y/points so arrows route edge-to-edge.
// Sets startBinding/endBinding/boundElements so Excalidraw treats them as bound.
// `start: {id}` and `end: {id}` shortform are read but kept untouched (for ref).
// `existingElements` allows arrows to reference shapes already on canvas.
function resolveArrowBindings(batchElements: any[], existingElements: Map<string, any> = new Map()): void {
  const elementMap = new Map<string, any>(existingElements);
  for (const el of batchElements) elementMap.set(el.id, el);

  const GAP = 8;

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = el.start as { id: string } | undefined;
    const endRef = el.end as { id: string } | undefined;
    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    const startCenter = startEl
      ? { x: (startEl.x || 0) + (startEl.width || 0) / 2, y: (startEl.y || 0) + (startEl.height || 0) / 2 }
      : { x: el.x || 0, y: el.y || 0 };
    const endCenter = endEl
      ? { x: (endEl.x || 0) + (endEl.width || 0) / 2, y: (endEl.y || 0) + (endEl.height || 0) / 2 }
      : { x: (el.x || 0) + 100, y: el.y || 0 };

    const startPt = startEl ? computeEdgePoint(startEl, endCenter.x, endCenter.y) : startCenter;
    const endPt = endEl ? computeEdgePoint(endEl, startCenter.x, startCenter.y) : endCenter;

    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const finalStart = { x: startPt.x + (dx / dist) * GAP, y: startPt.y + (dy / dist) * GAP };
    const finalEnd = { x: endPt.x - (dx / dist) * GAP, y: endPt.y - (dy / dist) * GAP };

    el.x = finalStart.x;
    el.y = finalStart.y;
    el.width = Math.abs(finalEnd.x - finalStart.x);
    el.height = Math.abs(finalEnd.y - finalStart.y);
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Set bindings — frontend convertToExcalidrawElements ALSO honors `start`/`end` shortform
    // but we set explicit bindings as belt-and-braces.
    if (startEl) {
      el.startBinding = { elementId: startEl.id, focus: 0, gap: GAP };
      // Mark the source shape as having this arrow bound to it
      if (!Array.isArray(startEl.boundElements)) startEl.boundElements = [];
      if (!startEl.boundElements.find((b: any) => b?.id === el.id)) {
        startEl.boundElements.push({ id: el.id, type: 'arrow' });
      }
    }
    if (endEl) {
      el.endBinding = { elementId: endEl.id, focus: 0, gap: GAP };
      if (!Array.isArray(endEl.boundElements)) endEl.boundElements = [];
      if (!endEl.boundElements.find((b: any) => b?.id === el.id)) {
        endEl.boundElements.push({ id: el.id, type: 'arrow' });
      }
    }
  }
}

// ============================================================================
// MCP Server (per-session)
// ============================================================================

interface McpServerHandle {
  server: McpServer;
  setSessionId: (sid: string) => void;
}

function createMcpServer(): McpServerHandle {
  const mcpServer = new McpServer(
    { name: 'mcp-excalidraw-live', version: '3.0.0' },
    { capabilities: { tools: {}, logging: {} } }
  );
  // Sessionid filled in after MCP transport assigns it (see onsessioninitialized).
  // Tool handlers close over this variable; they're only invoked after init completes.
  let sessionId = '';
  const setSessionId = (sid: string) => { sessionId = sid; };

  // === v3 multi-canvas tools ===

  mcpServer.registerTool('request_canvas', {
    description: 'Request access to a canvas. A human operator must grant access via the canvas dashboard. Blocks for up to 5 seconds; returns either {status: "granted", canvasId, name} or {status: "pending"} — call again later if pending.',
    inputSchema: {
      purpose: z.string().min(1).describe('Short description of why you need a canvas (e.g. "draw auth flow"). Required so the human can decide which canvas to grant.'),
    }
  }, async ({ purpose }): Promise<CallToolResult> => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: 'text', text: 'Error: session not initialized' }], isError: true };
      }
      session.purpose = purpose;

      // If session already has a grant, just return the active one
      const existing = getGrantsForSession(sessionId);
      if (existing.length > 0) {
        const active = existing.find(g => g.canvasId === session.activeCanvasId) || existing[0]!;
        const c = canvases.get(active.canvasId);
        if (c) {
          session.activeCanvasId = active.canvasId;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'granted', canvasId: c.canvasId, name: c.name, note: 'Already granted; reusing active canvas.' }, null, 2)
            }]
          };
        }
      }

      // If no canvases exist, tell the agent
      if (canvases.size === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'pending',
              reason: 'no canvases open',
              hint: `Have a human open ${getCanvasUrl()} in a browser, then call request_canvas again.`
            }, null, 2)
          }]
        };
      }

      // Register pending request
      const result = await new Promise<{ canvasId: string; name: string } | null>((resolve) => {
        const timeoutHandle = setTimeout(() => {
          // Long-poll expired but keep pending entry alive for late grant
          const entry = pending.get(sessionId);
          if (entry && entry.resolver === resolve) {
            // Replace resolver with no-op so future grant doesn't double-resolve
            entry.resolver = () => { /* late grant */ };
            // Schedule final cleanup
            entry.timeoutHandle = setTimeout(() => {
              if (pending.get(sessionId) === entry) pending.delete(sessionId);
              broadcastPendingToAll();
            }, PENDING_MAX_LIFETIME_MS - LONG_POLL_MS);
          }
          resolve(null);
        }, LONG_POLL_MS);

        pending.set(sessionId, { session: session!, resolver: resolve, timeoutHandle });
        broadcastPendingToAll();
      });

      if (result) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'granted', canvasId: result.canvasId, name: result.name }, null, 2)
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'pending',
            hint: `Waiting for human to grant access at ${getCanvasUrl()}. Call request_canvas again to keep waiting, or proceed with other work.`
          }, null, 2)
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('list_my_canvases', {
    description: 'List canvases this session has been granted access to.',
  }, async (): Promise<CallToolResult> => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: 'text', text: 'Error: session not initialized' }], isError: true };
      }
      const myGrants = getGrantsForSession(sessionId)
        .map(g => {
          const c = canvases.get(g.canvasId);
          if (!c) return null;
          return {
            canvasId: c.canvasId,
            name: c.name,
            isActive: c.canvasId === session.activeCanvasId,
            grantedAt: g.grantedAt
          };
        })
        .filter(x => x !== null);
      return { content: [{ type: 'text', text: JSON.stringify({ canvases: myGrants }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('select_canvas', {
    description: 'Select which granted canvas is active for subsequent tool calls (when this session has multiple grants).',
    inputSchema: {
      canvasId: z.string().describe('canvasId returned from request_canvas or list_my_canvases'),
    }
  }, async ({ canvasId }): Promise<CallToolResult> => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: 'text', text: 'Error: session not initialized' }], isError: true };
      }
      const has = getGrantsForSession(sessionId).find(g => g.canvasId === canvasId);
      if (!has) {
        return { content: [{ type: 'text', text: `Error: no grant for canvas ${canvasId}` }], isError: true };
      }
      session.activeCanvasId = canvasId;
      const c = canvases.get(canvasId);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, active: { canvasId, name: c?.name } }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('release_canvas', {
    description: 'Voluntarily release a grant on a canvas. Lets the human reassign it without revoking manually.',
    inputSchema: {
      canvasId: z.string(),
    }
  }, async ({ canvasId }): Promise<CallToolResult> => {
    try {
      const removed = revokeGrant(sessionId, canvasId);
      return { content: [{ type: 'text', text: JSON.stringify({ released: removed }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // === Snapshot tools ===

  function getActiveCanvas(): CanvasEntry | null {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const sessionGrants = getGrantsForSession(sessionId);
    if (sessionGrants.length === 0) return null;
    const canvasId = session.activeCanvasId || sessionGrants[0]!.canvasId;
    return canvases.get(canvasId) || null;
  }

  mcpServer.registerTool('snapshot_scene', {
    description: 'Save a named snapshot of the current canvas state (serialized .excalidraw JSON). Restore with restore_snapshot.',
    inputSchema: {
      name: z.string().min(1).describe('Snapshot name (used as key for restore)'),
    }
  }, async ({ name }): Promise<CallToolResult> => {
    try {
      const canvas = getActiveCanvas();
      if (!canvas) {
        return { content: [{ type: 'text', text: 'Error: no active canvas; call request_canvas first' }], isError: true };
      }
      // Get full .excalidraw scene serialization (preserves all bindings, files, appState)
      const result = await sendMcpOperation(sessionId, { type: 'save_canvas_request', formats: ['excalidraw'] });
      if (!result.excalidraw) {
        return { content: [{ type: 'text', text: 'Error: failed to serialize scene' }], isError: true };
      }
      const parsed = JSON.parse(result.excalidraw);
      const elementCount = Array.isArray(parsed.elements) ? parsed.elements.length : 0;
      canvas.snapshots.set(name, {
        name,
        scene: result.excalidraw,
        elementCount,
        createdAt: new Date().toISOString()
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ saved: true, name, elementCount }, null, 2)
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('restore_snapshot', {
    description: 'Restore canvas from a previously saved snapshot. Replaces all current elements.',
    inputSchema: {
      name: z.string().min(1).describe('Snapshot name to restore'),
    }
  }, async ({ name }): Promise<CallToolResult> => {
    try {
      const canvas = getActiveCanvas();
      if (!canvas) {
        return { content: [{ type: 'text', text: 'Error: no active canvas; call request_canvas first' }], isError: true };
      }
      const snapshot = canvas.snapshots.get(name);
      if (!snapshot) {
        return { content: [{ type: 'text', text: `Error: snapshot "${name}" not found` }], isError: true };
      }
      // Send full scene JSON to frontend, which uses Excalidraw's restore() to load it
      // properly (rebinds arrows, restores containers, etc.)
      await sendMcpOperation(sessionId, { type: 'mcp_load_scene', scene: snapshot.scene });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ restored: true, name, elementCount: snapshot.elementCount }, null, 2)
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('list_snapshots', {
    description: 'List all named snapshots saved on the active canvas.',
  }, async (): Promise<CallToolResult> => {
    try {
      const canvas = getActiveCanvas();
      if (!canvas) {
        return { content: [{ type: 'text', text: 'Error: no active canvas; call request_canvas first' }], isError: true };
      }
      const list = [...canvas.snapshots.values()].map(s => ({
        name: s.name,
        elementCount: s.elementCount,
        createdAt: s.createdAt
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ snapshots: list }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  // === Existing tools (now route via session->canvas) ===

  mcpServer.registerTool('create_element', {
    description: 'Create a new Excalidraw element. For arrows, use startElementId/endElementId to bind arrows to shapes — Excalidraw auto-routes from edge to edge. Assign custom id to shapes so arrows can reference them.',
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
      strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
      roughness: z.number().optional(),
      opacity: z.number().optional(),
      text: z.string().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      points: z.array(z.array(z.number()).length(2)).optional().describe('For arrows/lines: [[x1,y1],[x2,y2],...]'),
      startElementId: z.string().optional().describe('For arrows: id of element to bind arrow start to. Auto-routes to element edge.'),
      endElementId: z.string().optional().describe('For arrows: id of element to bind arrow end to. Auto-routes to element edge.'),
      startArrowhead: z.string().optional().describe('Arrowhead at start: arrow|bar|dot|triangle|null'),
      endArrowhead: z.string().optional().describe('Arrowhead at end: arrow|bar|dot|triangle|null'),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const { id: providedId, startElementId, endElementId, points, ...rest } = args;
      const elementBase: any = {
        id: providedId || generateId(),
        ...rest,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };
      if (startElementId) elementBase.start = { id: startElementId };
      if (endElementId) elementBase.end = { id: endElementId };
      if (points) elementBase.points = points;

      // For arrows: query existing canvas elements + resolve binding positions
      if (elementBase.type === 'arrow' && (startElementId || endElementId)) {
        const existing = await sendMcpOperation(sessionId, { type: 'mcp_query_elements' });
        const existingMap = new Map<string, any>();
        if (Array.isArray(existing)) {
          for (const e of existing) existingMap.set(e.id, e);
        }
        resolveArrowBindings([elementBase], existingMap);
        // Push updates back to source/target shapes (boundElements changed)
        const touchedShapes: any[] = [];
        if (startElementId && existingMap.get(startElementId)) touchedShapes.push(existingMap.get(startElementId));
        if (endElementId && existingMap.get(endElementId)) touchedShapes.push(existingMap.get(endElementId));
        for (const s of touchedShapes) {
          await sendMcpOperation(sessionId, {
            type: 'mcp_update_element',
            elementId: s.id,
            updates: { boundElements: s.boundElements }
          });
        }
      }

      const result = await sendMcpOperation(sessionId, { type: 'mcp_create_element', element: convertTextToLabel(elementBase as ServerElement) });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

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
      strokeWidth: z.number().optional(),
      strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
      text: z.string().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
    }
  }, async ({ id, ...updates }): Promise<CallToolResult> => {
    try {
      const u: any = { ...updates };
      if (u.fontFamily !== undefined) {
        const norm = normalizeFontFamily(u.fontFamily);
        if (norm === undefined) delete u.fontFamily;
        else u.fontFamily = norm;
      }
      const result = await sendMcpOperation(sessionId, { type: 'mcp_update_element', elementId: id, updates: u });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('delete_element', {
    description: 'Delete an Excalidraw element',
    inputSchema: { id: z.string() }
  }, async ({ id }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_delete_element', elementId: id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('query_elements', {
    description: 'Get raw element data (IDs, coordinates, properties) for programmatic manipulation. Use export_canvas instead if you want to SEE what is on the canvas.',
    inputSchema: {
      type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const filter = args.type ? { type: args.type } : undefined;
      const result = await sendMcpOperation(sessionId, { type: 'mcp_query_elements', filter });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('batch_create_elements', {
    description: 'Create multiple elements at once. For arrows, use startElementId/endElementId to bind arrows to shapes — auto-routes edge to edge. Assign custom id to shapes so arrows can reference them.',
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
        strokeWidth: z.number().optional(),
        strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
        text: z.string().optional(),
        fontSize: z.number().optional(),
        fontFamily: z.string().optional(),
        points: z.array(z.array(z.number()).length(2)).optional(),
        startElementId: z.string().optional(),
        endElementId: z.string().optional(),
        startArrowhead: z.string().optional(),
        endArrowhead: z.string().optional(),
      })),
    }
  }, async ({ elements }): Promise<CallToolResult> => {
    try {
      // Phase 1: build raw elements with start/end refs
      const prepared: any[] = elements.map((el) => {
        const { startElementId, endElementId, points, ...rest } = el as any;
        const base: any = {
          id: el.id || generateId(),
          ...rest,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };
        if (startElementId) base.start = { id: startElementId };
        if (endElementId) base.end = { id: endElementId };
        if (points) base.points = points;
        return base;
      });

      // Phase 2: query existing canvas to support cross-batch arrow refs
      let existingMap = new Map<string, any>();
      const hasArrows = prepared.some(e => e.type === 'arrow' && (e.start || e.end));
      if (hasArrows) {
        const existing = await sendMcpOperation(sessionId, { type: 'mcp_query_elements' });
        if (Array.isArray(existing)) {
          for (const e of existing) existingMap.set(e.id, e);
        }
      }

      // Phase 3: resolve arrow binding positions (mutates prepared + boundElements on shapes in batch)
      resolveArrowBindings(prepared, existingMap);

      // Phase 4: convert text to label format for shape elements
      const finalElements = prepared.map((el) => convertTextToLabel(el as ServerElement));

      // Phase 5: batch create on canvas
      const result = await sendMcpOperation(sessionId, { type: 'mcp_batch_create', elements: finalElements });

      // Phase 6: update boundElements on existing shapes that arrows now reference
      const inBatchIds = new Set(prepared.map(e => e.id));
      for (const el of prepared) {
        if (el.type !== 'arrow') continue;
        for (const ref of [el.start, el.end]) {
          if (!ref?.id) continue;
          if (inBatchIds.has(ref.id)) continue; // already handled in batch
          const shape = existingMap.get(ref.id);
          if (!shape) continue;
          await sendMcpOperation(sessionId, {
            type: 'mcp_update_element',
            elementId: shape.id,
            updates: { boundElements: shape.boundElements }
          });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('create_from_mermaid', {
    description: 'Convert a Mermaid diagram to Excalidraw elements',
    inputSchema: { mermaidDiagram: z.string().describe('Mermaid diagram definition') }
  }, async ({ mermaidDiagram }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mermaid_convert', mermaidDiagram, config: {}, timestamp: new Date().toISOString() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('export_canvas', {
    description: 'Export the canvas. Use png to SEE what is on the canvas visually. Use excalidraw to get the native .excalidraw JSON.',
    inputSchema: {
      format: z.enum(['png', 'svg', 'excalidraw']).describe('png = visual image, svg = vector, excalidraw = native JSON format'),
    }
  }, async ({ format }): Promise<CallToolResult> => {
    try {
      if (format === 'excalidraw') {
        const result = await sendMcpOperation(sessionId, { type: 'save_canvas_request', formats: ['excalidraw'] });
        if (result.excalidraw) {
          return { content: [{ type: 'text', text: result.excalidraw }] };
        }
        return { content: [{ type: 'text', text: 'Error: No data returned' }], isError: true };
      }
      const result = await sendMcpOperation(sessionId, { type: 'export_canvas_request', format });
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

  mcpServer.registerTool('clear_canvas', {
    description: 'Clear all elements from the canvas',
  }, async (): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_clear_canvas' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  const isContainer = fs.existsSync('/.dockerenv');
  const canSaveToDisk = !isContainer || !!HOST_HOME_MOUNT;

  if (canSaveToDisk) mcpServer.registerTool('save_canvas', {
    description: 'Save the canvas to disk. Supports .excalidraw, .png, .svg. Extension added automatically.',
    inputSchema: {
      filename_without_extension: z.string().describe('Full path without extension'),
      format: z.union([
        z.enum(['excalidraw', 'png', 'svg']),
        z.array(z.enum(['excalidraw', 'png', 'svg']))
      ]),
    }
  }, async (args): Promise<CallToolResult> => {
    try {
      const formats = Array.isArray(args.format) ? args.format : [args.format];
      const basePath = resolveHostPath(args.filename_without_extension);
      const dir = path.dirname(basePath);
      fs.mkdirSync(dir, { recursive: true });
      const result = await sendMcpOperation(sessionId, { type: 'save_canvas_request', formats });
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
      const hostSaved = saved.map(s => ({ ...s, path: unresolveHostPath(s.path) }));
      return { content: [{ type: 'text', text: JSON.stringify({ saved: hostSaved }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('get_element', {
    description: 'Get a single Excalidraw element by its ID',
    inputSchema: { id: z.string() }
  }, async ({ id }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_get_element', elementId: id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('lock_elements', {
    description: 'Lock elements by their IDs',
    inputSchema: { ids: z.array(z.string()) }
  }, async ({ ids }): Promise<CallToolResult> => {
    try {
      let lockedCount = 0;
      for (const id of ids) {
        await sendMcpOperation(sessionId, { type: 'mcp_update_element', elementId: id, updates: { locked: true } });
        lockedCount++;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ locked: lockedCount }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('unlock_elements', {
    description: 'Unlock elements by their IDs',
    inputSchema: { ids: z.array(z.string()) }
  }, async ({ ids }): Promise<CallToolResult> => {
    try {
      let unlockedCount = 0;
      for (const id of ids) {
        await sendMcpOperation(sessionId, { type: 'mcp_update_element', elementId: id, updates: { locked: false } });
        unlockedCount++;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ unlocked: unlockedCount }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('duplicate_elements', {
    description: 'Duplicate elements with an optional position offset',
    inputSchema: {
      ids: z.array(z.string()),
      offsetX: z.number().optional().default(20),
      offsetY: z.number().optional().default(20),
    }
  }, async ({ ids, offsetX, offsetY }): Promise<CallToolResult> => {
    try {
      const allElements = await sendMcpOperation(sessionId, { type: 'mcp_query_elements' });
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
      await sendMcpOperation(sessionId, { type: 'mcp_batch_create', elements: clones });
      return { content: [{ type: 'text', text: JSON.stringify({ duplicated: clones.length, newIds: clones.map((c: any) => c.id) }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

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
        return { content: [{ type: 'text', text: 'Error: Invalid .excalidraw file' }], isError: true };
      }
      if (mode === 'replace') {
        await sendMcpOperation(sessionId, { type: 'mcp_clear_canvas' });
      }
      await sendMcpOperation(sessionId, { type: 'mcp_batch_create', elements: parsed.elements });
      return { content: [{ type: 'text', text: JSON.stringify({ imported: parsed.elements.length, mode }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('describe_scene', {
    description: 'Describe the current canvas contents as a structured text summary',
  }, async (): Promise<CallToolResult> => {
    try {
      const allElements = await sendMcpOperation(sessionId, { type: 'mcp_query_elements' });
      const elements = Array.isArray(allElements) ? allElements : [];
      if (elements.length === 0) {
        return { content: [{ type: 'text', text: 'Canvas is empty.' }] };
      }
      const typeCounts: Record<string, number> = {};
      for (const el of elements) typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of elements) {
        const x = el.x ?? 0, y = el.y ?? 0, w = el.width ?? 0, h = el.height ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
      }
      const sorted = [...elements].sort((a, b) => {
        const dy = (a.y ?? 0) - (b.y ?? 0);
        if (Math.abs(dy) > 10) return dy;
        return (a.x ?? 0) - (b.x ?? 0);
      });
      const lines: string[] = [];
      lines.push(`# Scene Description`, ``);
      lines.push(`Total elements: ${elements.length}`);
      lines.push(`Types: ${Object.entries(typeCounts).map(([t, c]) => `${t} (${c})`).join(', ')}`);
      lines.push(`Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)})`);
      lines.push(``, `## Elements`, ``);
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

  mcpServer.registerTool('set_viewport', {
    description: 'Control the canvas camera: scroll to content, scroll to a specific element, or set zoom level',
    inputSchema: {
      scrollToContent: z.boolean().optional(),
      scrollToElementId: z.string().optional(),
      zoom: z.number().optional(),
    }
  }, async ({ scrollToContent, scrollToElementId, zoom }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_set_viewport', scrollToContent, scrollToElementId, zoom });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('align_elements', {
    description: 'Align elements along a specified axis (left, center, right, top, middle, bottom)',
    inputSchema: {
      ids: z.array(z.string()).min(2),
      alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
    }
  }, async ({ ids, alignment }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_align_elements', ids, alignment });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('distribute_elements', {
    description: 'Distribute elements evenly along the horizontal or vertical axis',
    inputSchema: {
      ids: z.array(z.string()).min(3),
      direction: z.enum(['horizontal', 'vertical']),
    }
  }, async ({ ids, direction }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_distribute_elements', ids, direction });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('group_elements', {
    description: 'Group or ungroup elements by their IDs',
    inputSchema: {
      ids: z.array(z.string()).min(2),
      action: z.enum(['group', 'ungroup']).optional().default('group'),
    }
  }, async ({ ids, action }): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'mcp_group_elements', ids, action });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  mcpServer.registerTool('export_to_excalidraw_url', {
    description: 'Export the canvas to a shareable excalidraw.com URL. End-to-end encrypted.',
  }, async (): Promise<CallToolResult> => {
    try {
      const result = await sendMcpOperation(sessionId, { type: 'save_canvas_request', formats: ['excalidraw'] });
      if (!result.excalidraw) throw new Error('No scene data returned from browser');
      const url = await encryptAndUpload(result.excalidraw);
      return { content: [{ type: 'text', text: url }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  return { server: mcpServer, setSessionId };
}

// ============================================================================
// Streamable HTTP Transport - Session Management
// ============================================================================

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

function cleanupSession(sid: string): void {
  // Cancel pending grant request, if any
  const p = pending.get(sid);
  if (p) {
    clearTimeout(p.timeoutHandle);
    pending.delete(sid);
    p.resolver(null);  // unblock any in-flight long-poll
  }
  // Remove all grants
  removeAllGrantsForSession(sid);
  sessions.delete(sid);
  mcpTransports.delete(sid);
  logger.info('MCP session cleaned up', { sessionId: sid });
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && mcpTransports.has(sessionId)) {
      const transport = mcpTransports.get(sessionId)!;
      await transport.handleRequest(req, res, body);
    } else if (!sessionId && isInitializeRequest(body)) {
      const initBody = body as { params?: { clientInfo?: { name?: string; version?: string } } };
      const clientInfo = initBody?.params?.clientInfo;

      const handle = createMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          mcpTransports.set(newSessionId, transport);
          sessions.set(newSessionId, {
            sessionId: newSessionId,
            clientName: clientInfo?.name,
            clientVersion: clientInfo?.version,
            purpose: '',
            createdAt: new Date().toISOString(),
            activeCanvasId: null
          });
          handle.setSessionId(newSessionId);
          logger.info('MCP session initialized', {
            sessionId: newSessionId,
            client: clientInfo?.name,
            version: clientInfo?.version
          });
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) cleanupSession(sid);
      };

      await handle.server.connect(transport);
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
  await mcpTransports.get(sessionId)!.handleRequest(req, res);
}

async function handleMcpDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpTransports.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing session ID');
    return;
  }
  await mcpTransports.get(sessionId)!.handleRequest(req, res);
}

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
// Share to excalidraw.com
// ============================================================================

async function encryptAndUpload(sceneJSON: string): Promise<string> {
  const compressed = pako.deflate(new TextEncoder().encode(sceneJSON));
  const key = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  const response = await fetch('https://json.excalidraw.com/api/v2/post/', {
    method: 'POST',
    body: combined,
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const { id } = await response.json() as { id: string };
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
    canvases: canvases.size,
    sessions: sessions.size,
    grants: grants.length,
    pending: pending.size,
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

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================================================
// Start Server (with loopback split-brain guard)
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Hosts that listen on loopback. Two servers on different loopback hosts
// (e.g. 127.0.0.1 + ::1) split state — browsers picking IPv4 see different
// canvases than browsers on IPv6. Refuse to start if another loopback
// listener already exists.
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) return host;
  }
  return null;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`);
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    logger.error('Failed to start canvas server:', error);
  }
  process.exit(1);
});

async function startServer(): Promise<void> {
  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
      process.exit(1);
    }
  }

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    logger.info(`Server running on http://${hostForUrl}:${PORT}`);
    logger.info(`MCP endpoint: http://${hostForUrl}:${PORT}/mcp`);
    logger.info(`Canvas UI: http://${hostForUrl}:${PORT}/`);
  });
}

void startServer();

export default app;
