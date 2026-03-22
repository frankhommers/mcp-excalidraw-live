export interface ExcalidrawElementBase {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: {
    type: number;
    value?: number;
  } | null;
  seed?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  locked?: boolean;
  link?: string | null;
  customData?: Record<string, any> | null;
  boundElements?: readonly ExcalidrawBoundElement[] | null;
  updated?: number;
  containerId?: string | null;
}

export interface ExcalidrawTextElement extends ExcalidrawElementBase {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  baseline?: number;
  lineHeight?: number;
}

export interface ExcalidrawRectangleElement extends ExcalidrawElementBase {
  type: 'rectangle';
  width: number;
  height: number;
}

export interface ExcalidrawEllipseElement extends ExcalidrawElementBase {
  type: 'ellipse';
  width: number;
  height: number;
}

export interface ExcalidrawDiamondElement extends ExcalidrawElementBase {
  type: 'diamond';
  width: number;
  height: number;
}

export interface ExcalidrawArrowElement extends ExcalidrawElementBase {
  type: 'arrow';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
}

export interface ExcalidrawLineElement extends ExcalidrawElementBase {
  type: 'line';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
}

export interface ExcalidrawFreedrawElement extends ExcalidrawElementBase {
  type: 'freedraw';
  points: readonly [number, number][];
  pressures?: readonly number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElement =
  | ExcalidrawTextElement
  | ExcalidrawRectangleElement
  | ExcalidrawEllipseElement
  | ExcalidrawDiamondElement
  | ExcalidrawArrowElement
  | ExcalidrawLineElement
  | ExcalidrawFreedrawElement;

export interface ExcalidrawBoundElement {
  id: string;
  type: 'text' | 'arrow';
}

export interface ExcalidrawBinding {
  elementId: string;
  focus: number;
  gap: number;
  fixedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'line' | 'freedraw' | 'label';

// Excalidraw element types
export const EXCALIDRAW_ELEMENT_TYPES: Record<string, ExcalidrawElementType> = {
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  DIAMOND: 'diamond',
  ARROW: 'arrow',
  TEXT: 'text',
  LABEL: 'label',
  FREEDRAW: 'freedraw',
  LINE: 'line'
} as const;

// Server-side element with metadata
export interface ServerElement extends Omit<ExcalidrawElementBase, 'id'> {
  id: string;
  type: ExcalidrawElementType;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ElementsResponse extends ApiResponse {
  elements: ServerElement[];
  count: number;
}

export interface ElementResponse extends ApiResponse {
  element: ServerElement;
}

// WebSocket message types for MCP operations
export type WebSocketMessageType =
  | 'mermaid_convert'
  | 'export_canvas_request'
  | 'save_canvas_request'
  | 'mcp_create_element'
  | 'mcp_update_element'
  | 'mcp_delete_element'
  | 'mcp_query_elements'
  | 'mcp_batch_create'
  | 'mcp_clear_canvas'
  | 'mcp_get_element'
  | 'mcp_set_viewport'
  | 'mcp_align_elements'
  | 'mcp_distribute_elements'
  | 'mcp_group_elements'
  | 'mcp_operation_response'
  | 'active_status'
  | 'pin_status'
  | 'export_to_excalidraw_url'
  | 'client_focus'
  | 'client_pin';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  [key: string]: any;
}

// MCP Operation messages (server -> browser)
export interface McpCreateElementMessage extends WebSocketMessage {
  type: 'mcp_create_element';
  requestId: string;
  element: ServerElement;
}

export interface McpUpdateElementMessage extends WebSocketMessage {
  type: 'mcp_update_element';
  requestId: string;
  elementId: string;
  updates: Partial<ServerElement>;
}

export interface McpDeleteElementMessage extends WebSocketMessage {
  type: 'mcp_delete_element';
  requestId: string;
  elementId: string;
}

export interface McpQueryElementsMessage extends WebSocketMessage {
  type: 'mcp_query_elements';
  requestId: string;
  filter?: {
    type?: ExcalidrawElementType;
    [key: string]: any;
  };
}

export interface McpBatchCreateMessage extends WebSocketMessage {
  type: 'mcp_batch_create';
  requestId: string;
  elements: ServerElement[];
}

// MCP Operation response (browser -> server)
export interface McpOperationResponseMessage extends WebSocketMessage {
  type: 'mcp_operation_response';
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

// Active status message (server -> browser)
export interface ActiveStatusMessage extends WebSocketMessage {
  type: 'active_status';
  isActive: boolean;
}

// Client focus message (browser -> server)
export interface ClientFocusMessage extends WebSocketMessage {
  type: 'client_focus';
  timestamp: string;
}

// Client pin message (browser -> server)
export interface ClientPinMessage extends WebSocketMessage {
  type: 'client_pin';
  pinned: boolean;
}

// Pin status message (server -> browser)
export interface PinStatusMessage extends WebSocketMessage {
  type: 'pin_status';
  isPinned: boolean;
  isActive: boolean;
}

// Mermaid conversion types
export interface MermaidConfig {
  startOnLoad?: boolean;
  flowchart?: {
    curve?: 'linear' | 'basis';
  };
  themeVariables?: {
    fontSize?: string;
  };
  maxEdges?: number;
  maxTextSize?: number;
}

export interface MermaidConvertMessage extends WebSocketMessage {
  type: 'mermaid_convert';
  mermaidDiagram: string;
  config?: MermaidConfig;
  timestamp: string;
}

export interface MermaidConversionRequest {
  mermaidDiagram: string;
  config?: MermaidConfig;
}

export interface MermaidConversionResponse extends ApiResponse {
  elements: ServerElement[];
  files?: any;
  count: number;
}

// Export canvas request message
export interface ExportCanvasRequestMessage extends WebSocketMessage {
  type: 'export_canvas_request';
  requestId: string;
  format: 'png' | 'svg';
}

// Validation function for Excalidraw elements
export function validateElement(element: Partial<ServerElement>): element is ServerElement {
  const requiredFields: (keyof ServerElement)[] = ['type', 'x', 'y'];
  const hasRequiredFields = requiredFields.every(field => field in element);

  if (!hasRequiredFields) {
    throw new Error(`Missing required fields: ${requiredFields.join(', ')}`);
  }

  if (!Object.values(EXCALIDRAW_ELEMENT_TYPES).includes(element.type as ExcalidrawElementType)) {
    throw new Error(`Invalid element type: ${element.type}`);
  }

  return true;
}

// Helper function to generate unique IDs
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
