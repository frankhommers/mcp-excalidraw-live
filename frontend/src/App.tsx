import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  restoreElements,
  CaptureUpdateAction,
  exportToBlob,
  exportToSvg,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type { AppState } from '@excalidraw/excalidraw/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import pako from 'pako'

async function exportToExcalidrawUrl(serializedScene: string): Promise<string> {
  // Send to server for encryption + upload (crypto.subtle requires HTTPS in browsers)
  const response = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: serializedScene,
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(err || `Share failed: ${response.status}`)
  }
  const { url } = await response.json()
  return url
}

type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

const STORAGE_KEY = 'excalidraw-canvas-state'
const SAVE_DEBOUNCE_MS = 500

// AppState keys worth persisting (exclude transient UI state like cursor, selection, etc.)
const PERSISTED_APP_STATE_KEYS: (keyof AppState)[] = [
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
  'theme',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemRoundness',
  'exportBackground',
  'exportWithDarkMode',
  'exportEmbedScene',
]

interface PersistedState {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
}

function saveToLocalStorage(elements: readonly ExcalidrawElement[], appState: AppState): void {
  try {
    const nonDeletedElements = elements.filter(el => !el.isDeleted)
    const persistedAppState: Partial<AppState> = {}
    for (const key of PERSISTED_APP_STATE_KEYS) {
      if (key in appState) {
        ;(persistedAppState as any)[key] = (appState as any)[key]
      }
    }
    const data: PersistedState = { elements: nonDeletedElements, appState: persistedAppState }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    // localStorage might be full or disabled — fail silently
    console.warn('Failed to save canvas to localStorage:', error)
  }
}

function loadFromLocalStorage(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedState
    if (!data || !Array.isArray(data.elements)) return null
    return data
  } catch (error) {
    console.warn('Failed to load canvas from localStorage:', error)
    return null
  }
}

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: { text: string };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
}

interface SessionInfo {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  purpose: string;
  createdAt: string;
}

interface CanvasInfo {
  canvasId: string;
  name: string;
  createdAt: string;
}

interface GrantInfo {
  sessionId: string;
  canvasId: string;
  grantedAt: string;
  session: SessionInfo;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  updates?: Partial<ServerElement>;
  filter?: { type?: string; [key: string]: any };
  requestId?: string;
  format?: 'png' | 'svg';
  formats?: string[];
  isActive?: boolean;
  isPinned?: boolean;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  zoom?: number;
  ids?: string[];
  alignment?: string;
  direction?: string;
  action?: string;
  // v3 multi-canvas
  canvasId?: string;
  name?: string;
  canvas?: CanvasInfo;
  pendingSessions?: SessionInfo[];
  grants?: GrantInfo[];
  session?: SessionInfo;
  grant?: GrantInfo;
  sessionId?: string;
}

const cleanElementForExcalidraw = (element: ServerElement): ExcalidrawElementSkeleton => {
  const { createdAt, updatedAt, version, ...cleanElement } = element;
  return cleanElement as unknown as ExcalidrawElementSkeleton;
}

const validateAndFixBindings = (elements: ExcalidrawElementSkeleton[]): ExcalidrawElementSkeleton[] => {
  const elementMap = new Map(elements.map(el => [(el as any).id!, el]));
  return elements.map(element => {
    const fixedElement = { ...element } as any;
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          if (!binding?.id || !binding?.type) return false;
          if (!elementMap.get(binding.id)) return false;
          return ['text', 'arrow'].includes(binding.type);
        });
        if (fixedElement.boundElements.length === 0) fixedElement.boundElements = null;
      } else {
        fixedElement.boundElements = null;
      }
    }
    if (fixedElement.containerId && !elementMap.get(fixedElement.containerId)) {
      fixedElement.containerId = null;
    }
    return fixedElement as ExcalidrawElementSkeleton;
  });
}

// Re-center text elements bound to shape containers after convertToExcalidrawElements,
// which sometimes leaves them at the input x/y instead of the container center.
const isShapeContainerType = (type?: string): boolean =>
  type === 'rectangle' || type === 'ellipse' || type === 'diamond'

const recenterBoundShapeTextElements = (elements: any[]): any[] => {
  const elementMap = new Map<string, any>(elements.map(el => [el.id, el]))
  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) return element
    const container = elementMap.get(element.containerId)
    if (!container || !isShapeContainerType(container.type)) return element
    if (element.autoResize === false) return element
    if (
      typeof container.x !== 'number' || typeof container.y !== 'number' ||
      typeof container.width !== 'number' || typeof container.height !== 'number' ||
      typeof element.width !== 'number' || typeof element.height !== 'number'
    ) return element
    return {
      ...element,
      x: container.x + (container.width - element.width) / 2,
      y: container.y + (container.height - element.height) / 2,
    }
  })
}

// convertToExcalidrawElements strips startBinding/endBinding/boundElements props.
// Restore them from original elements after conversion. Required for snapshot restore
// and for arrows created via API with startBinding/endBinding fields.
const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: any[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }
  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;
    const patched = { ...el };
    if (orig.startBinding && !el.startBinding) patched.startBinding = orig.startBinding;
    if (orig.endBinding && !el.endBinding) patched.endBinding = orig.endBinding;
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) patched.elbowed = orig.elbowed;
    return patched;
  });
}

function App(): React.JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [isMcpActive, setIsMcpActive] = useState<boolean>(false)
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false)
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false)
  const [isSharing, setIsSharing] = useState<boolean>(false)
  const [shareSuccess, setShareSuccess] = useState<boolean>(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  // v3 canvas/grant state
  const [canvas, setCanvas] = useState<CanvasInfo | null>(null)
  const [pendingSessions, setPendingSessions] = useState<SessionInfo[]>([])
  const [activeGrants, setActiveGrants] = useState<GrantInfo[]>([])
  const [activityLog, setActivityLog] = useState<{ id: string; sessionId: string; action: string; ts: number }[]>([])
  const [isHeaderExpanded, setIsHeaderExpanded] = useState<boolean>(true)
  const [isEditingName, setIsEditingName] = useState<boolean>(false)
  const [nameDraft, setNameDraft] = useState<string>('')
  const [isFineliner, setIsFineliner] = useState<boolean>(() => {
    try {
      return localStorage.getItem('excalidraw-fineliner-mode') === 'true'
    } catch { return false }
  })
  // Pending scene to load via remount (snapshot restore, scene import).
  // When set, Excalidraw remounts with this as initialData — only reliable way
  // to restore bindings/positions. Cleared after consumption.
  const [pendingScene, setPendingScene] = useState<{ elements: readonly ExcalidrawElement[]; appState?: any; files?: any } | null>(null)
  const [sceneVersion, setSceneVersion] = useState<number>(0)

  // Use ref to always have latest API in callbacks
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  const websocketRef = useRef<WebSocket | null>(null)
  const pendingMessagesRef = useRef<WebSocketMessage[]>([])
  const mcpActivityIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Load persisted state once on mount
  const restoredData = useMemo(() => {
    const saved = loadFromLocalStorage()
    if (saved) {
      console.log(`Restored ${saved.elements.length} elements from localStorage`)
      return {
        elements: saved.elements,
        appState: { theme: 'light' as const, viewBackgroundColor: '#ffffff', ...saved.appState }
      }
    }
    return {
      elements: [] as ExcalidrawElement[],
      appState: { theme: 'light' as const, viewBackgroundColor: '#ffffff' }
    }
  }, [])

  // Flash MCP indicator on activity - stays on for at least 1 second
  const flashMcpActivity = useCallback(() => {
    if (mcpActivityIntervalRef.current) {
      clearTimeout(mcpActivityIntervalRef.current)
    }
    setIsMcpActive(true)
    mcpActivityIntervalRef.current = setTimeout(() => {
      mcpActivityIntervalRef.current = null
      setIsMcpActive(false)
    }, 1000)
  }, [])

  // Keep ref in sync with state
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
    // Process any pending messages when API becomes available
    if (excalidrawAPI && pendingMessagesRef.current.length > 0) {
      console.log(`Processing ${pendingMessagesRef.current.length} pending messages`)
      pendingMessagesRef.current.forEach(msg => handleWebSocketMessage(msg))
      pendingMessagesRef.current = []
    }
  }, [excalidrawAPI])

  const sendMessage = useCallback((message: object) => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify(message))
    }
  }, [])

  const sendMcpResponse = useCallback((requestId: string, success: boolean, data?: any, error?: string) => {
    sendMessage({ type: 'mcp_operation_response', requestId, success, data, error })
  }, [sendMessage])

  // Pin/unpin - removed, using handlePinClick instead

  // Removed claimActiveStatus - only explicit pinning now

  // MCP Handlers - use ref to get latest API
  const handleMcpCreateElement = useCallback((requestId: string, element: ServerElement) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      const currentElements = api.getSceneElements()
      const cleanedElement = cleanElementForExcalidraw(element)
      const convertedElements = convertToExcalidrawElements([cleanedElement], { regenerateIds: false })
      const restoredElements = restoreBindings(convertedElements, [cleanedElement] as any[])
      api.updateScene({
        elements: [...currentElements, ...restoredElements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      sendMcpResponse(requestId, true, restoredElements[0])
      console.log('MCP: Created element', element.id)
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpUpdateElement = useCallback((requestId: string, elementId: string, updates: Partial<ServerElement>) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      const currentElements = api.getSceneElements()
      const elementIndex = currentElements.findIndex(el => el.id === elementId)
      if (elementIndex === -1) {
        sendMcpResponse(requestId, false, undefined, `Element ${elementId} not found`)
        return
      }
      const updatedElement = { ...currentElements[elementIndex], ...updates }
      const updatedElements = [...currentElements]
      updatedElements[elementIndex] = updatedElement as any
      api.updateScene({ elements: updatedElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      sendMcpResponse(requestId, true, updatedElement)
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpDeleteElement = useCallback((requestId: string, elementId: string) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      const currentElements = api.getSceneElements()
      if (!currentElements.some(el => el.id === elementId)) {
        sendMcpResponse(requestId, false, undefined, `Element ${elementId} not found`)
        return
      }
      api.updateScene({
        elements: currentElements.filter(el => el.id !== elementId),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      sendMcpResponse(requestId, true, { id: elementId, deleted: true })
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpQueryElements = useCallback((requestId: string, filter?: { type?: string }) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      let elements = api.getSceneElements().filter(el => !el.isDeleted)
      if (filter?.type) {
        elements = elements.filter(el => el.type === filter.type)
      }
      sendMcpResponse(requestId, true, elements)
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpBatchCreate = useCallback((requestId: string, elements: ServerElement[]) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      const currentElements = api.getSceneElements()
      const cleanedElements = elements.map(cleanElementForExcalidraw)
      const validatedElements = validateAndFixBindings(cleanedElements)
      const convertedElements = convertToExcalidrawElements(validatedElements, { regenerateIds: false })
      const restoredElements = restoreBindings(convertedElements, validatedElements as any[])
      const recentered = recenterBoundShapeTextElements(restoredElements)
      api.updateScene({
        elements: [...currentElements, ...recentered],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      sendMcpResponse(requestId, true, recentered)
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  // Load full scene from .excalidraw JSON (snapshot restore, import).
  // Forces a remount of Excalidraw with the scene as initialData — this is the
  // only reliable way to restore bindings (especially bound arrow positions),
  // because Excalidraw's binding system runs on mount, not on updateScene.
  const handleMcpLoadScene = useCallback((requestId: string, sceneJson: string) => {
    try {
      const parsed = JSON.parse(sceneJson)
      const rawElements = Array.isArray(parsed.elements) ? parsed.elements : []
      const appState = parsed.appState || {}
      const files = parsed.files || {}

      // Convert long-form bindings to short-form so convertToExcalidrawElements
      // re-resolves them and recomputes arrow coordinates.
      const skeletonElements = rawElements.map((el: any) => {
        if (el.type !== 'arrow') return el
        const out: any = { ...el }
        if (out.startBinding?.elementId) {
          out.start = { id: out.startBinding.elementId }
          delete out.startBinding
        }
        if (out.endBinding?.elementId) {
          out.end = { id: out.endBinding.elementId }
          delete out.endBinding
        }
        return out
      })

      const converted = convertToExcalidrawElements(skeletonElements, { regenerateIds: false })
      const restored = restoreBindings(converted, rawElements)
      const recentered = recenterBoundShapeTextElements(restored)

      setPendingScene({
        elements: recentered as readonly ExcalidrawElement[],
        appState: { theme: appState.theme || 'light', viewBackgroundColor: appState.viewBackgroundColor || '#ffffff' },
        files
      })
      setSceneVersion(v => v + 1)
      sendMcpResponse(requestId, true, { loaded: recentered.length })
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpAddFiles = useCallback((requestId: string, files: any[]) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    try {
      api.addFiles(files)
      sendMcpResponse(requestId, true, { added: files.length })
    } catch (error) {
      sendMcpResponse(requestId, false, undefined, (error as Error).message)
    }
  }, [sendMcpResponse])

  const handleMcpDeleteFile = useCallback((requestId: string, _fileId: string) => {
    // Excalidraw API has no public file-delete; element using the file just stops rendering when fileId is gone.
    // We acknowledge the request so server can clean up its own map.
    sendMcpResponse(requestId, true, { ok: true })
  }, [sendMcpResponse])

  const handleMcpClearCanvas = useCallback((requestId: string) => {
    const api = excalidrawAPIRef.current
    if (!api) {
      sendMcpResponse(requestId, false, undefined, 'Excalidraw not initialized')
      return
    }
    api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    sendMcpResponse(requestId, true, { cleared: true })
  }, [sendMcpResponse])

  const handleWebSocketMessage = useCallback(async (data: WebSocketMessage): Promise<void> => {
    const api = excalidrawAPIRef.current

    // Queue messages if API not ready (except status messages)
    if (!api && !['active_status', 'pin_status'].includes(data.type)) {
      console.log('API not ready, queuing message:', data.type)
      pendingMessagesRef.current.push(data)
      return
    }

    switch (data.type) {
      case 'canvas_assigned':
        if (data.canvasId && data.name) {
          setCanvas({ canvasId: data.canvasId, name: data.name, createdAt: new Date().toISOString() })
        }
        break

      case 'canvas_state':
        if (data.canvas) setCanvas(data.canvas)
        if (Array.isArray(data.pendingSessions)) setPendingSessions(data.pendingSessions)
        if (Array.isArray(data.grants)) setActiveGrants(data.grants)
        break

      case 'activity':
        if (data.sessionId && data.action) {
          flashMcpActivity()
          const id = Math.random().toString(36).substring(2)
          setActivityLog(prev => [...prev, { id, sessionId: data.sessionId!, action: data.action!, ts: Date.now() }])
          setTimeout(() => {
            setActivityLog(prev => prev.filter(e => e.id !== id))
          }, 2500)
        }
        break

      case 'mcp_create_element':
        if (data.requestId && data.element) {
          flashMcpActivity()
          handleMcpCreateElement(data.requestId, data.element)
        }
        break

      case 'mcp_update_element':
        if (data.requestId && data.elementId && data.updates) {
          flashMcpActivity()
          handleMcpUpdateElement(data.requestId, data.elementId, data.updates)
        }
        break

      case 'mcp_delete_element':
        if (data.requestId && data.elementId) {
          flashMcpActivity()
          handleMcpDeleteElement(data.requestId, data.elementId)
        }
        break

      case 'mcp_query_elements':
        if (data.requestId) {
          flashMcpActivity()
          handleMcpQueryElements(data.requestId, data.filter)
        }
        break

      case 'mcp_batch_create':
        if (data.requestId && data.elements) {
          flashMcpActivity()
          handleMcpBatchCreate(data.requestId, data.elements)
        }
        break

      case 'mcp_load_scene':
        if (data.requestId && typeof (data as any).scene === 'string') {
          flashMcpActivity()
          handleMcpLoadScene(data.requestId, (data as any).scene)
        }
        break

      case 'mcp_add_files':
        if (data.requestId && Array.isArray((data as any).files)) {
          flashMcpActivity()
          handleMcpAddFiles(data.requestId, (data as any).files)
        }
        break

      case 'mcp_delete_file':
        if (data.requestId && typeof (data as any).fileId === 'string') {
          flashMcpActivity()
          handleMcpDeleteFile(data.requestId, (data as any).fileId)
        }
        break

      case 'mcp_clear_canvas':
        if (data.requestId) {
          flashMcpActivity()
          handleMcpClearCanvas(data.requestId)
        }
        break

      case 'mermaid_convert':
        if (data.mermaidDiagram && data.requestId && api) {
          flashMcpActivity()
          try {
            const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)
            if (!result.error && result.elements?.length) {
              const convertedElements = convertToExcalidrawElements(result.elements as unknown as ExcalidrawElementSkeleton[], { regenerateIds: false })
              api.updateScene({ elements: convertedElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
              if (result.files) api.addFiles(Object.values(result.files))
              sendMcpResponse(data.requestId, true, { elementsCreated: convertedElements.length })
            } else {
              sendMcpResponse(data.requestId, false, undefined, result.error || 'No elements generated from mermaid diagram')
            }
          } catch (error) {
            console.error('Mermaid conversion error:', error)
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'export_canvas_request':
        if (data.requestId && data.format && api) {
          flashMcpActivity()
          try {
            const sceneElements = api.getSceneElements()
            const appState = api.getAppState()
            const files = api.getFiles()

            if (sceneElements.length === 0) {
              sendMcpResponse(data.requestId, false, undefined, 'Canvas is empty')
              return
            }

            let exportData: string
            if (data.format === 'png') {
              const blob = await exportToBlob({
                elements: sceneElements,
                appState: { ...appState, exportWithDarkMode: false, exportBackground: true },
                files
              })
              const arrayBuffer = await blob.arrayBuffer()
              // Use chunked base64 encoding to avoid stack overflow on large canvases
              const bytes = new Uint8Array(arrayBuffer)
              let binary = ''
              const chunkSize = 8192
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
              }
              exportData = btoa(binary)
            } else {
              const svgElement = await exportToSvg({
                elements: sceneElements,
                appState: { ...appState, exportWithDarkMode: false, exportBackground: true },
                files
              })
              exportData = svgElement.outerHTML
            }

            sendMcpResponse(data.requestId, true, { format: data.format, data: exportData })
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'save_canvas_request':
        if (data.requestId && data.formats && api) {
          flashMcpActivity()
          try {
            const sceneElements = api.getSceneElements()
            const appState = api.getAppState()
            const files = api.getFiles()
            const formats = data.formats as string[]
            const result: Record<string, string> = {}

            for (const fmt of formats) {
              if (fmt === 'excalidraw') {
                result.excalidraw = serializeAsJSON(sceneElements, appState, files, 'local')
              } else if (fmt === 'png') {
                const blob = await exportToBlob({
                  elements: sceneElements,
                  appState: { ...appState, exportWithDarkMode: false, exportBackground: true },
                  files
                })
                const arrayBuffer = await blob.arrayBuffer()
                const bytes = new Uint8Array(arrayBuffer)
                let binary = ''
                const chunkSize = 8192
                for (let i = 0; i < bytes.length; i += chunkSize) {
                  binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
                }
                result.png = btoa(binary)
              } else if (fmt === 'svg') {
                const svgElement = await exportToSvg({
                  elements: sceneElements,
                  appState: { ...appState, exportWithDarkMode: false, exportBackground: true },
                  files
                })
                result.svg = svgElement.outerHTML
              }
            }

            sendMcpResponse(data.requestId, true, result)
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'mcp_get_element':
        if (data.requestId && api) {
          flashMcpActivity()
          try {
            const element = api.getSceneElements().find(el => el.id === data.elementId)
            if (element) {
              sendMcpResponse(data.requestId, true, element)
            } else {
              sendMcpResponse(data.requestId, false, undefined, `Element ${data.elementId} not found`)
            }
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'mcp_set_viewport':
        if (data.requestId && api) {
          flashMcpActivity()
          try {
            if (data.scrollToContent) {
              api.scrollToContent()
            }
            if (data.scrollToElementId) {
              const targetEl = api.getSceneElements().find(el => el.id === data.scrollToElementId)
              if (targetEl) {
                api.scrollToContent(targetEl)
              } else {
                sendMcpResponse(data.requestId, false, undefined, `Element ${data.scrollToElementId} not found`)
                return
              }
            }
            if (data.zoom !== undefined) {
              api.updateScene({ appState: { zoom: { value: data.zoom as any } } })
            }
            sendMcpResponse(data.requestId, true, { success: true })
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'mcp_align_elements':
        if (data.requestId && data.ids && data.alignment && api) {
          flashMcpActivity()
          try {
            const allElems = api.getSceneElements()
            const targetIds = data.ids as string[]
            const matchedElems = allElems.filter(el => targetIds.includes(el.id))
            if (matchedElems.length < 2) {
              sendMcpResponse(data.requestId, false, undefined, 'Need at least 2 matching elements to align')
              return
            }

            const alignment = data.alignment as string
            let targetValue: number

            switch (alignment) {
              case 'left':
                targetValue = Math.min(...matchedElems.map(el => el.x))
                break
              case 'right':
                targetValue = Math.max(...matchedElems.map(el => el.x + (el.width || 0)))
                break
              case 'center': {
                const minX = Math.min(...matchedElems.map(el => el.x))
                const maxXRight = Math.max(...matchedElems.map(el => el.x + (el.width || 0)))
                targetValue = (minX + maxXRight) / 2
                break
              }
              case 'top':
                targetValue = Math.min(...matchedElems.map(el => el.y))
                break
              case 'bottom':
                targetValue = Math.max(...matchedElems.map(el => el.y + (el.height || 0)))
                break
              case 'middle': {
                const minY = Math.min(...matchedElems.map(el => el.y))
                const maxYBottom = Math.max(...matchedElems.map(el => el.y + (el.height || 0)))
                targetValue = (minY + maxYBottom) / 2
                break
              }
              default:
                sendMcpResponse(data.requestId, false, undefined, `Unknown alignment: ${alignment}`)
                return
            }

            const matchedIds = new Set(targetIds)
            const updatedElements = allElems.map(el => {
              if (!matchedIds.has(el.id)) return el
              const updated = { ...el }
              switch (alignment) {
                case 'left':
                  (updated as any).x = targetValue
                  break
                case 'right':
                  (updated as any).x = targetValue - (el.width || 0)
                  break
                case 'center':
                  (updated as any).x = targetValue - (el.width || 0) / 2
                  break
                case 'top':
                  (updated as any).y = targetValue
                  break
                case 'bottom':
                  (updated as any).y = targetValue - (el.height || 0)
                  break
                case 'middle':
                  (updated as any).y = targetValue - (el.height || 0) / 2
                  break
              }
              return updated
            })

            api.updateScene({ elements: updatedElements as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
            sendMcpResponse(data.requestId, true, { aligned: matchedElems.length, alignment })
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'mcp_distribute_elements':
        if (data.requestId && data.ids && data.direction && api) {
          flashMcpActivity()
          try {
            const allElems = api.getSceneElements()
            const targetIds = data.ids as string[]
            const matchedElems = allElems.filter(el => targetIds.includes(el.id))
            if (matchedElems.length < 3) {
              sendMcpResponse(data.requestId, false, undefined, 'Need at least 3 matching elements to distribute')
              return
            }

            const direction = data.direction as string
            const isHorizontal = direction === 'horizontal'

            // Sort by position
            const sorted = [...matchedElems].sort((a, b) =>
              isHorizontal ? a.x - b.x : a.y - b.y
            )

            const first = sorted[0]
            const last = sorted[sorted.length - 1]

            if (isHorizontal) {
              const totalSpan = (last.x + (last.width || 0)) - first.x
              const totalElementWidth = sorted.reduce((sum, el) => sum + (el.width || 0), 0)
              const totalGap = totalSpan - totalElementWidth
              const gapBetween = totalGap / (sorted.length - 1)

              let currentX = first.x + (first.width || 0) + gapBetween
              for (let i = 1; i < sorted.length - 1; i++) {
                (sorted[i] as any).x = currentX
                currentX += (sorted[i].width || 0) + gapBetween
              }
            } else {
              const totalSpan = (last.y + (last.height || 0)) - first.y
              const totalElementHeight = sorted.reduce((sum, el) => sum + (el.height || 0), 0)
              const totalGap = totalSpan - totalElementHeight
              const gapBetween = totalGap / (sorted.length - 1)

              let currentY = first.y + (first.height || 0) + gapBetween
              for (let i = 1; i < sorted.length - 1; i++) {
                (sorted[i] as any).y = currentY
                currentY += (sorted[i].height || 0) + gapBetween
              }
            }

            // Build full updated elements array
            const updatedMap = new Map(sorted.map(el => [el.id, el]))
            const updatedElements = allElems.map(el => updatedMap.get(el.id) || el)

            api.updateScene({ elements: updatedElements as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
            sendMcpResponse(data.requestId, true, { distributed: matchedElems.length, direction })
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'export_to_excalidraw_url':
        if (data.requestId && api) {
          flashMcpActivity()
          try {
            const sceneElements = api.getSceneElements()
            const appState = api.getAppState()
            const files = api.getFiles()
            const serialized = serializeAsJSON(sceneElements, appState, files, 'local')
            const url = await exportToExcalidrawUrl(serialized)
            sendMcpResponse(data.requestId, true, { url })
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break

      case 'mcp_group_elements':
        if (data.requestId && data.ids && api) {
          flashMcpActivity()
          try {
            const allElems = api.getSceneElements()
            const targetIds = data.ids as string[]
            const action = (data.action as string) || 'group'
            const matchedIds = new Set(targetIds)

            if (action === 'group') {
              const groupId = Date.now().toString(36) + Math.random().toString(36).substring(2)
              const updatedElements = allElems.map(el => {
                if (!matchedIds.has(el.id)) return el
                const existingGroupIds = (el as any).groupIds || []
                return { ...el, groupIds: [...existingGroupIds, groupId] }
              })
              api.updateScene({ elements: updatedElements as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
              sendMcpResponse(data.requestId, true, { groupId, grouped: targetIds.length })
            } else {
              // ungroup: find common groupIds among matched elements and remove them
              const matchedElems = allElems.filter(el => matchedIds.has(el.id))
              // Find all groupIds that appear in ANY matched element
              const allGroupIds = new Set<string>()
              for (const el of matchedElems) {
                const gids = (el as any).groupIds || []
                for (const gid of gids) allGroupIds.add(gid)
              }
              // Find groupIds common to ALL matched elements
              const commonGroupIds = [...allGroupIds].filter(gid =>
                matchedElems.every(el => ((el as any).groupIds || []).includes(gid))
              )

              const updatedElements = allElems.map(el => {
                if (!matchedIds.has(el.id)) return el
                const existingGroupIds: string[] = (el as any).groupIds || []
                return { ...el, groupIds: existingGroupIds.filter((gid: string) => !commonGroupIds.includes(gid)) }
              })
              api.updateScene({ elements: updatedElements as any, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
              sendMcpResponse(data.requestId, true, { ungrouped: targetIds.length, removedGroupIds: commonGroupIds })
            }
          } catch (error) {
            sendMcpResponse(data.requestId, false, undefined, (error as Error).message)
          }
        }
        break
    }
  }, [flashMcpActivity, handleMcpCreateElement, handleMcpUpdateElement, handleMcpDeleteElement, handleMcpQueryElements, handleMcpBatchCreate, handleMcpLoadScene, handleMcpAddFiles, handleMcpDeleteFile, handleMcpClearCanvas])

  // WebSocket connection
  useEffect(() => {
    const connect = () => {
      if (websocketRef.current?.readyState === WebSocket.OPEN) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      websocketRef.current = new WebSocket(`${protocol}//${window.location.host}`)

      websocketRef.current.onopen = () => {
        setIsConnected(true)
        // Don't auto-claim - user must explicitly pin
      }

      websocketRef.current.onmessage = (event: MessageEvent) => {
        try {
          handleWebSocketMessage(JSON.parse(event.data))
        } catch (error) {
          console.error('WebSocket message error:', error)
        }
      }

      websocketRef.current.onclose = (event: CloseEvent) => {
        setIsConnected(false)
        setIsMcpActive(false)
        if (event.code !== 1000) setTimeout(connect, 3000)
      }

      websocketRef.current.onerror = () => {
        setIsConnected(false)
        setIsMcpActive(false)
      }
    }

    connect()
    return () => {
      websocketRef.current?.close()
      if (mcpActivityIntervalRef.current) {
        clearInterval(mcpActivityIntervalRef.current)
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
    }
  }, [handleWebSocketMessage])

  const clearCanvas = () => {
    excalidrawAPIRef.current?.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  // Listen for fullscreen changes (user can exit with Esc)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Grant a pending session to this canvas
  const handleGrant = useCallback((sessionId: string) => {
    if (!canvas) return
    sendMessage({ type: 'grant_request', sessionId, canvasId: canvas.canvasId })
  }, [canvas, sendMessage])

  // Revoke an existing grant on this canvas
  const handleRevoke = useCallback((sessionId: string) => {
    if (!canvas) return
    sendMessage({ type: 'revoke_grant', sessionId, canvasId: canvas.canvasId })
  }, [canvas, sendMessage])

  // Save canvas rename
  const commitName = useCallback(() => {
    const trimmed = nameDraft.trim().slice(0, 100)
    if (trimmed && canvas && trimmed !== canvas.name) {
      sendMessage({ type: 'canvas_rename', name: trimmed })
    }
    setIsEditingName(false)
  }, [nameDraft, canvas, sendMessage])

  // Fineliner defaults
  const FINELINER_STROKE_WIDTH = 0.5
  const FINELINER_ROUGHNESS = 0
  const DEFAULT_STROKE_WIDTH = 2
  const DEFAULT_ROUGHNESS = 1

  // Toggle fineliner mode
  const toggleFineliner = useCallback(() => {
    const api = excalidrawAPIRef.current
    if (!api) return

    const next = !isFineliner
    setIsFineliner(next)
    try { localStorage.setItem('excalidraw-fineliner-mode', String(next)) } catch {}

    if (next) {
      api.setActiveTool({ type: 'freedraw' })
      api.updateScene({
        appState: {
          currentItemStrokeWidth: FINELINER_STROKE_WIDTH,
          currentItemRoughness: FINELINER_ROUGHNESS,
        },
      })
    } else {
      api.setActiveTool({ type: 'selection' })
      api.updateScene({
        appState: {
          currentItemStrokeWidth: DEFAULT_STROKE_WIDTH,
          currentItemRoughness: DEFAULT_ROUGHNESS,
        },
      })
    }
  }, [isFineliner])

  // Apply fineliner settings on initial load if it was persisted
  useEffect(() => {
    if (isFineliner && excalidrawAPI) {
      excalidrawAPI.setActiveTool({ type: 'freedraw' })
      excalidrawAPI.updateScene({
        appState: {
          currentItemStrokeWidth: FINELINER_STROKE_WIDTH,
          currentItemRoughness: FINELINER_ROUGHNESS,
        },
      })
    }
  }, [excalidrawAPI]) // only on API ready

  // Track which freedraw elements we've already patched
  const patchedFreeDrawIds = useRef<Set<string>>(new Set())

  // Detect when user switches away from freedraw tool — deactivate fineliner
  const handleOnChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState) => {
    setIsDarkMode(appState.theme === 'dark')

    // If fineliner is on but user switched to another tool, turn it off
    if (isFineliner && appState.activeTool?.type !== 'freedraw') {
      setIsFineliner(false)
      try { localStorage.setItem('excalidraw-fineliner-mode', 'false') } catch {}
    }

    // Patch new freedraw elements: disable simulatePressure for round caps
    if (isFineliner) {
      const api = excalidrawAPIRef.current
      if (api) {
        const needsPatch = elements.filter(
          (el) => el.type === 'freedraw'
            && (el as any).simulatePressure === true
            && !patchedFreeDrawIds.current.has(el.id)
        )
        if (needsPatch.length > 0) {
          const updatedElements = elements.map((el) => {
            if (el.type === 'freedraw' && (el as any).simulatePressure === true && !patchedFreeDrawIds.current.has(el.id)) {
              patchedFreeDrawIds.current.add(el.id)
              return { ...el, simulatePressure: false }
            }
            return el
          })
          api.updateScene({ elements: updatedElements as any })
        }
      }
    }

    // Debounced save to localStorage
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveToLocalStorage(elements, appState)
    }, SAVE_DEBOUNCE_MS)
  }, [isFineliner])

  // SVG Icons - fixed size
  const iconSvgStyle: React.CSSProperties = { width: '18px', height: '18px', fill: 'currentColor' }
  const CloudOn = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M6.5 20Q4.22 20 2.61 18.43 1 16.85 1 14.58 1 12.63 2.17 11.1 3.35 9.57 5.25 9.15 5.88 6.85 7.75 5.43 9.63 4 12 4 14.93 4 16.96 6.04 19 8.07 19 11 20.73 11.2 21.86 12.5 23 13.78 23 15.5 23 17.38 21.69 18.69 20.38 20 18.5 20Z" />
    </svg>
  )
  const CloudOff = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M19.8 22.6L17.15 20H6.5Q4.2 20 2.6 18.4T1 14.5Q1 12.58 2.19 11.08 3.38 9.57 5.25 9.15 5.33 8.95 5.4 8.76 5.5 8.57 5.55 8.35L1.4 4.2L2.8 2.8L21.2 21.2M21.6 18.75L8.05 5.23Q8.93 4.63 9.91 4.31 10.9 4 12 4 14.93 4 16.96 6.04 19 8.07 19 11 20.73 11.2 21.86 12.5 23 13.78 23 15.5 23 16.5 22.63 17.31 22.25 18.15 21.6 18.75Z" />
    </svg>
  )
  const McpIcon = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle} fillRule="evenodd">
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  )
  const PinOn = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" />
    </svg>
  )
  const PinOff = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M2,5.27L3.28,4L20,20.72L18.73,22L12.8,16.07V22H11.2V16H6V14L8,12V11.27L2,5.27M16,12L18,14V16H17.82L8,6.18V4H7V2H17V4H16V12Z" />
    </svg>
  )
  const FinelinerIcon = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M20.71 7.04c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z" />
    </svg>
  )
  const ShareIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
  const CheckIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
  const FullscreenEnter = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z" />
    </svg>
  )
  const FullscreenExit = () => (
    <svg viewBox="0 0 24 24" style={iconSvgStyle}>
      <path d="M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z" />
    </svg>
  )

  // Inject MCP animation styles
  useEffect(() => {
    const styleId = 'mcp-pulse-animation'
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
        @keyframes mcpPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
        @keyframes mcpBorderFlash {
          0%, 100% { border-color: rgba(34,197,94,0.9); }
          50% { border-color: rgba(34,197,94,0.1); }
        }
      `
      document.head.appendChild(style)
    }
    return () => {
      const el = document.getElementById(styleId)
      if (el) el.remove()
    }
  }, [])

  // Render function for Excalidraw's top-right UI slot
  const renderTopRightUI = () => {
    const barStyle: React.CSSProperties = {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 10px',
      background: isDarkMode ? 'rgba(30,30,30,0.95)' : 'rgba(255,255,255,0.95)',
      borderRadius: '8px',
      boxShadow: isDarkMode ? '0 1px 4px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.1)',
    }
    const iconStyle: React.CSSProperties = {
      width: '20px',
      height: '20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }
    const inactiveColor = isDarkMode ? '#666' : '#999'
    const getColor = (active: boolean, color: string) => active ? color : inactiveColor

    // MCP indicator: pulsing green background circle when active
    const mcpIndicatorStyle: React.CSSProperties = {
      ...iconStyle,
      color: isMcpActive ? '#fff' : inactiveColor,
      background: isMcpActive ? '#22c55e' : 'transparent',
      borderRadius: '50%',
      width: '28px',
      height: '28px',
      transition: 'all 0.2s ease',
      animation: isMcpActive ? 'mcpPulse 0.25s linear infinite' : 'none',
      cursor: 'default',
    }

    return (
      <div style={barStyle}>
        {/* Canvas identity (always visible, click to copy) */}
        {canvas && (
          <div
            onClick={async () => {
              try { await navigator.clipboard.writeText(canvas.canvasId) } catch {}
            }}
            title={`Click to copy canvasId\n${canvas.canvasId}`}
            style={{
              fontSize: '12px',
              fontFamily: 'monospace',
              padding: '2px 8px',
              borderRadius: '4px',
              background: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
              color: isDarkMode ? '#ddd' : '#333',
              cursor: 'pointer',
              maxWidth: '240px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >{canvas.name} <span style={{ opacity: 0.5 }}>·</span> <span style={{ opacity: 0.7 }}>{canvas.canvasId.substring(0, 8)}</span></div>
        )}
        {/* Server */}
        <div style={{ ...iconStyle, color: getColor(isConnected, '#22c55e') }} title={isConnected ? 'Server Connected' : 'Disconnected'}>
          {isConnected ? <CloudOn /> : <CloudOff />}
        </div>
        {/* MCP activity indicator */}
        <div style={mcpIndicatorStyle} title={isMcpActive ? 'MCP Active' : 'MCP Idle'}>
          <McpIcon />
        </div>
        {/* Grants count + pending badge */}
        <div
          style={{
            ...iconStyle,
            color: activeGrants.length > 0 ? '#22c55e' : (pendingSessions.length > 0 ? '#f59e0b' : inactiveColor),
            cursor: 'pointer',
            position: 'relative',
            width: '28px',
          }}
          title={`${activeGrants.length} agent(s), ${pendingSessions.length} pending`}
          onClick={() => setIsHeaderExpanded(v => !v)}
        >
          {activeGrants.length > 0 ? <PinOn /> : <PinOff />}
          {pendingSessions.length > 0 && (
            <span style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              background: '#f59e0b',
              color: '#fff',
              fontSize: '10px',
              fontWeight: 700,
              borderRadius: '999px',
              minWidth: '14px',
              height: '14px',
              padding: '0 3px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}>{pendingSessions.length}</span>
          )}
        </div>
        {/* Fineliner */}
        <div
          style={{
            ...iconStyle,
            color: isFineliner ? '#3b82f6' : inactiveColor,
            cursor: 'pointer',
            background: isFineliner ? (isDarkMode ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.1)') : 'transparent',
            borderRadius: '4px',
            width: '28px',
            height: '28px',
            transition: 'all 0.15s ease',
          }}
          title={isFineliner ? 'Fineliner active — click to deactivate' : 'Activate fineliner (thin, smooth pen)'}
          onClick={toggleFineliner}
        >
          <FinelinerIcon />
        </div>
        {/* Share */}
        <div
          style={{ ...iconStyle, color: shareSuccess ? '#22c55e' : inactiveColor, cursor: 'pointer' }}
          title="Share to excalidraw.com"
          onClick={async () => {
            if (isSharing) return
            const currentApi = excalidrawAPIRef.current
            if (!currentApi) return
            setIsSharing(true)
            try {
              const sceneElements = currentApi.getSceneElements()
              const appState = currentApi.getAppState()
              const files = currentApi.getFiles()
              const serialized = serializeAsJSON(sceneElements, appState, files, 'local')
              const url = await exportToExcalidrawUrl(serialized)
              // Try clipboard, show URL banner as fallback
              try {
                await navigator.clipboard.writeText(url)
              } catch {
                // clipboard not available (HTTP), show banner instead
              }
              setShareUrl(url)
              setShareSuccess(true)
              setTimeout(() => { setShareSuccess(false); setShareUrl(null) }, 8000)
            } catch (err) {
              console.error('Share failed:', err)
              alert(`Share failed: ${(err as Error).message}`)
            } finally {
              setIsSharing(false)
            }
          }}
        >
          {shareSuccess ? <CheckIcon /> : <ShareIcon />}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* MCP activity border - glowing green border around entire screen */}
      {isMcpActive && (
        <div style={{
          position: 'fixed',
          inset: 0,
          border: '4px solid rgba(34,197,94,0.8)',
          borderRadius: '4px',
          pointerEvents: 'none',
          zIndex: 99999,
          animation: 'mcpBorderFlash 0.25s linear infinite',
        }} />
      )}
      {/* Share URL toast */}
      {shareUrl && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100000,
          background: isDarkMode ? '#1e1e1e' : '#fff',
          color: isDarkMode ? '#fff' : '#1e1e1e',
          borderRadius: '12px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          maxWidth: '90vw',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: '14px',
        }}>
          <span style={{ color: '#22c55e', fontWeight: 700 }}>Shared!</span>
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: '#3b82f6',
              textDecoration: 'underline',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '50vw',
            }}
          >{shareUrl}</a>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl)
              } catch {
                // Select the link text as fallback
              }
            }}
            style={{
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >Copy</button>
          <button
            onClick={() => setShareUrl(null)}
            style={{
              background: 'none',
              border: 'none',
              color: isDarkMode ? '#666' : '#999',
              cursor: 'pointer',
              fontSize: '18px',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >&times;</button>
        </div>
      )}
      {/* Canvas grant header strip */}
      {canvas && isHeaderExpanded && (activeGrants.length > 0 || pendingSessions.length > 0) && (
        <div style={{
          position: 'fixed',
          top: '8px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99998,
          background: isDarkMode ? 'rgba(30,30,30,0.96)' : 'rgba(255,255,255,0.96)',
          color: isDarkMode ? '#eee' : '#1e1e1e',
          borderRadius: '10px',
          boxShadow: isDarkMode ? '0 2px 12px rgba(0,0,0,0.5)' : '0 2px 12px rgba(0,0,0,0.15)',
          padding: '10px 14px',
          minWidth: '320px',
          maxWidth: '90vw',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: '13px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <strong style={{ fontSize: '12px', textTransform: 'uppercase', opacity: 0.65 }}>Canvas:</strong>
            {isEditingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setIsEditingName(false) }}
                style={{
                  flex: 1,
                  padding: '2px 6px',
                  border: '1px solid #3b82f6',
                  borderRadius: '4px',
                  background: isDarkMode ? '#1e1e1e' : '#fff',
                  color: isDarkMode ? '#eee' : '#1e1e1e',
                  fontSize: '13px',
                }}
              />
            ) : (
              <span
                onClick={() => { setNameDraft(canvas.name); setIsEditingName(true) }}
                style={{ cursor: 'pointer', borderBottom: '1px dotted #999' }}
                title="Click to rename"
              >{canvas.name}</span>
            )}
            <span
              onClick={async () => {
                try { await navigator.clipboard.writeText(canvas.canvasId) } catch {}
              }}
              title={`Click to copy full canvasId\n${canvas.canvasId}`}
              style={{
                marginLeft: 'auto',
                fontSize: '11px',
                opacity: 0.7,
                fontFamily: 'monospace',
                cursor: 'pointer',
                padding: '1px 6px',
                borderRadius: '3px',
                background: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
              }}
            >{canvas.canvasId}</span>
            <button
              onClick={() => setIsHeaderExpanded(false)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px', padding: '0 4px', opacity: 0.5 }}
              title="Hide"
            >&times;</button>
          </div>

          {activeGrants.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '3px' }}>Granted to:</div>
              {activeGrants.map(g => (
                <div key={g.sessionId} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e' }} />
                  <span style={{ fontWeight: 600 }}>{g.session.clientName || 'unknown'}</span>
                  <span style={{ opacity: 0.5, fontSize: '11px' }}>({g.session.sessionId.substring(0, 8)})</span>
                  <span style={{ flex: 1, fontStyle: 'italic', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.session.purpose ? `"${g.session.purpose}"` : ''}
                  </span>
                  <button
                    onClick={() => handleRevoke(g.sessionId)}
                    style={{ background: 'none', border: 'none', color: '#e03131', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}
                    title="Revoke"
                  >&times;</button>
                </div>
              ))}
            </div>
          )}

          {pendingSessions.length > 0 && (
            <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: `1px solid ${isDarkMode ? '#333' : '#e5e5e5'}` }}>
              <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '3px' }}>Pending requests:</div>
              {pendingSessions.map(s => (
                <div key={s.sessionId} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', border: '1px solid #f59e0b' }} />
                  <span style={{ fontWeight: 600 }}>{s.clientName || 'unknown'}</span>
                  <span style={{ opacity: 0.5, fontSize: '11px' }}>({s.sessionId.substring(0, 8)})</span>
                  <span style={{ flex: 1, fontStyle: 'italic', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.purpose ? `"${s.purpose}"` : ''}
                  </span>
                  <button
                    onClick={() => handleGrant(s.sessionId)}
                    style={{
                      background: '#22c55e',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '3px 8px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                    title="Grant access to this canvas"
                  >Grant</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activity toasts */}
      {activityLog.length > 0 && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          zIndex: 99997,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          pointerEvents: 'none',
        }}>
          {activityLog.slice(-5).map(e => (
            <div key={e.id} style={{
              background: isDarkMode ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.1)',
              color: isDarkMode ? '#86efac' : '#15803d',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              border: '1px solid rgba(34,197,94,0.3)',
              opacity: 0.9,
            }}>
              <code>{e.sessionId.substring(0, 6)}</code> · {e.action}
            </div>
          ))}
        </div>
      )}

      {/* Canvas - Full Screen */}
      <div className="canvas-container">
        <Excalidraw
          key={sceneVersion}
          excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
          initialData={pendingScene || restoredData}
          renderTopRightUI={renderTopRightUI}
          onChange={handleOnChange}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.Item
              icon={isFullscreen ? <FullscreenExit /> : <FullscreenEnter />}
              onSelect={toggleFullscreen}
            >
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  )
}

export default App
