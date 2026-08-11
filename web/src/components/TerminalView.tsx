import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Check, ChevronDown, ChevronUp, Copy, CopyPlus, X, Terminal as TermIcon } from 'lucide-react'
import { api, ProviderInfo, Terminal as TerminalRecord } from '../api'

interface TerminalViewProps {
  terminalId: string
  sessionName: string
  provider?: string
  agentProfile?: string | null
  onClose: () => void
  node?: string | null
  onReplicated?: (terminal: TerminalRecord) => void
  embedded?: boolean
  replicationEnabled?: boolean
  active?: boolean
  onActivate?: () => void
}

// Provider TUIs commonly enable DEC mouse tracking. When xterm accepts those
// modes it disables ordinary drag selection and forwards the drag to the
// process instead. The fleet viewer prioritizes reliable text selection, so it
// consumes mouse-only mode changes before xterm applies them.
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1002, 1003, 1005, 1006, 1015, 1016])

export function isMouseTrackingModeSequence(params: (number | number[])[]): boolean {
  return params.length > 0 && params.every(param => typeof param === 'number' && MOUSE_TRACKING_MODES.has(param))
}

export function isReplicateShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key' | 'code'>): boolean {
  return event.metaKey && !event.ctrlKey && (event.code === 'KeyD' || event.key.toLowerCase() === 'd')
}

export function resolveReplicationTarget(
  provider: string | undefined,
  agentProfile: string | null | undefined,
  providers: ProviderInfo[],
): { provider: string; agentProfile?: string; fellBackToTerminal: boolean } {
  if (provider === 'none') return { provider: 'none', fellBackToTerminal: false }
  const providerAvailable = Boolean(
    provider && providers.some(item => item.name === provider && item.installed),
  )
  if (provider && providerAvailable && agentProfile) {
    return { provider, agentProfile, fellBackToTerminal: false }
  }
  return { provider: 'none', fellBackToTerminal: true }
}

async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Clipboard permissions vary across browsers and non-secure origins. Fall
    // through to the synchronous, user-gesture-compatible copy path below.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

async function copyTerminalSelection(term: Terminal, text: string): Promise<boolean> {
  if (!text) return false

  // xterm owns a synchronous `copy` event handler which writes its selection
  // directly to ClipboardEvent.clipboardData. Focusing xterm before invoking
  // copy avoids the permissions and secure-origin restrictions of the async
  // Clipboard API in most browsers.
  term.focus()
  try {
    if (document.execCommand('copy')) return true
  } catch {
    // Fall through for browsers that disable execCommand.
  }
  return copyTerminalText(text)
}

export function TerminalView({ terminalId, sessionName, provider, agentProfile, onClose, node, onReplicated, embedded = false, replicationEnabled = true, active = true, onActivate }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const terminalRef = useRef<Terminal | null>(null)
  const selectedTextRef = useRef('')
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const replicatingRef = useRef(false)
  const replicateHandlerRef = useRef<() => void>(() => {})
  const scrollHandlerRef = useRef<(pages: number) => boolean>(() => false)
  const [hasSelection, setHasSelection] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [replicateStatus, setReplicateStatus] = useState<'idle' | 'creating' | 'created' | 'failed'>('idle')
  const [replicateMessage, setReplicateMessage] = useState('')
  const [replicaTerminal, setReplicaTerminal] = useState<TerminalRecord | null>(null)
  const [activePane, setActivePane] = useState<'primary' | 'replica'>('primary')
  const [splitPercent, setSplitPercent] = useState(50)

  const showCopyResult = useCallback((copied: boolean) => {
    setCopyStatus(copied ? 'copied' : 'failed')
    clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => setCopyStatus('idle'), 1800)
  }, [])

  const copyCurrentSelection = useCallback(() => {
    const term = terminalRef.current
    const selection = term?.getSelection() || selectedTextRef.current
    if (!term || !selection) return
    void copyTerminalSelection(term, selection).then(showCopyResult)
  }, [showCopyResult])

  const scrollTerminal = useCallback((pages: number) => {
    const term = terminalRef.current
    if (!term) return
    if (!scrollHandlerRef.current(pages)) term.scrollPages(pages)
    term.focus()
  }, [])

  const replicateCurrentSession = useCallback(async () => {
    if (replicatingRef.current || replicateStatus === 'created') return

    replicatingRef.current = true
    setReplicateStatus('creating')
    setReplicateMessage(`Creating ${sessionName}-copy…`)
    try {
      const { working_directory: workingDirectory } = await api.getWorkingDirectory(terminalId, node)
      if (!workingDirectory) throw new Error('Working directory is unavailable')
      let availableProviders: ProviderInfo[] = []
      try {
        availableProviders = await api.listProviders(node)
      } catch {
        // Provider discovery should not prevent a useful duplicate. Without a
        // verified provider, create a plain terminal in the same directory.
      }
      const target = resolveReplicationTarget(provider, agentProfile, availableProviders)
      const replica = await api.createSession(
        target.provider,
        target.agentProfile,
        `${sessionName}-copy`,
        workingDirectory,
        node,
        undefined,
        false,
        undefined,
        target.provider !== 'none',
      )
      setReplicateStatus('created')
      setReplicateMessage(
        target.fellBackToTerminal
          ? `Created ${replica.session_name} as a plain terminal`
          : `Created ${replica.session_name}`,
      )
      setReplicaTerminal(replica)
      setActivePane('replica')
      onReplicated?.(replica)
    } catch (error) {
      setReplicateStatus('failed')
      setReplicateMessage(error instanceof Error ? error.message : 'Failed to replicate agent')
    } finally {
      replicatingRef.current = false
    }
  }, [terminalId, sessionName, provider, agentProfile, node, onReplicated, replicateStatus])

  replicateHandlerRef.current = () => { void replicateCurrentSession() }

  useEffect(() => {
    if (!replicationEnabled) return
    const handleReplicateShortcut = (event: KeyboardEvent) => {
      if (!isReplicateShortcut(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.type === 'keydown' && !event.repeat) replicateHandlerRef.current()
    }
    window.addEventListener('keydown', handleReplicateShortcut, { capture: true })
    window.addEventListener('keyup', handleReplicateShortcut, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleReplicateShortcut, { capture: true })
      window.removeEventListener('keyup', handleReplicateShortcut, { capture: true })
    }
  }, [replicationEnabled])

  // A terminal is a full-screen modal. Prevent wheel gestures at the edge of
  // its scrollback from chaining into the dashboard underneath it.
  useEffect(() => {
    if (embedded) return
    const bodyOverflow = document.body.style.overflow
    const rootOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = rootOverflow
    }
  }, [embedded])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      scrollback: 10000,
      scrollSensitivity: 2,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
      macOptionClickForcesSelection: true,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#c9d1d9',
        scrollbarSliderBackground: '#4b5563aa',
        scrollbarSliderHoverBackground: '#6b7280dd',
        scrollbarSliderActiveBackground: '#60a5faff',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    terminalRef.current = term

    const mouseModeSetDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      isMouseTrackingModeSequence,
    )
    const mouseModeResetDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      isMouseTrackingModeSequence,
    )

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = node
      ? `/fleet/nodes/${encodeURIComponent(node)}/terminals/${terminalId}/ws`
      : `/terminals/${terminalId}/ws`
    const ws = new WebSocket(`${protocol}//${location.host}${path}`)
    ws.binaryType = 'arraybuffer'

    // CAO suppresses application mouse-tracking modes so ordinary drag
    // selection remains available. Ask the node backend to scroll its native
    // history instead of relying on xterm's incomplete attach-time buffer.
    const sendWheel = (direction: 'up' | 'down', lines: number) => {
      if (ws.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ type: 'scroll', direction, lines: Math.min(100, Math.max(1, lines)) }))
      return true
    }

    scrollHandlerRef.current = pages => sendWheel(
      pages < 0 ? 'up' : 'down',
      Math.max(1, Math.round(Math.abs(pages) * 8)),
    )

    let wheelRemainder = 0
    const handleTerminalWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (!event.deltaY) return

      const units = event.deltaMode === 1
        ? event.deltaY
        : event.deltaMode === 2
          ? event.deltaY * 8
          : event.deltaY / 24
      wheelRemainder += units
      const steps = Math.trunc(wheelRemainder)
      if (steps === 0) return
      const sentSteps = Math.min(8, Math.abs(steps))
      if (sendWheel(steps < 0 ? 'up' : 'down', sentSteps * 3)) {
        wheelRemainder -= Math.sign(steps) * sentSteps
      }
    }
    el.addEventListener('wheel', handleTerminalWheel, { capture: true, passive: false })

    ws.onopen = () => {
      // Fit once the connection is live so we send correct dimensions
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      }
    }

    ws.onclose = () => {
      term.write('\r\n\x1b[33m[Connection closed]\x1b[0m\r\n')
    }

    // Keep the latest selection outside xterm so the header Copy button and
    // mouse-up handler use the same text.
    const selectionDisposable = term.onSelectionChange(() => {
      const selection = term.getSelection()
      selectedTextRef.current = selection
      setHasSelection(Boolean(selection))
    })

    // Match native terminal conventions on Linux/Windows and macOS.
    term.attachCustomKeyEventHandler((e) => {
      const copyShortcut = (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c')
        || (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'c')
      if (copyShortcut) {
        const selection = term.getSelection() || selectedTextRef.current
        if (selection && e.type === 'keydown') {
          void copyTerminalSelection(term, selection).then(showCopyResult)
        }
        return false
      }
      return true
    })

    // onData handles ALL input including paste — xterm.js
    // receives pasted text through the browser's input system
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    // Handle resize — debounce to avoid flooding
    let resizeTimer: ReturnType<typeof setTimeout>
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        fitAddon.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
        }
      }, 50)
    })
    resizeObserver.observe(el)

    // Initial fit after layout settles
    const initialFit = requestAnimationFrame(() => {
      fitAddon.fit()
    })

    term.focus()

    return () => {
      cancelAnimationFrame(initialFit)
      clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      el.removeEventListener('wheel', handleTerminalWheel, { capture: true })
      selectionDisposable.dispose()
      mouseModeSetDisposable.dispose()
      mouseModeResetDisposable.dispose()
      scrollHandlerRef.current = () => false
      terminalRef.current = null
      selectedTextRef.current = ''
      setHasSelection(false)
      ws.close()
      term.dispose()
    }
  }, [terminalId, node, showCopyResult])

  useEffect(() => () => clearTimeout(copyFeedbackTimerRef.current), [])

  const paneIsActive = embedded ? active : !replicaTerminal || activePane === 'primary'
  const activateThisPane = embedded ? onActivate : () => setActivePane('primary')

  const resizeSplit = (clientX: number) => {
    const rect = splitContainerRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const percent = ((clientX - rect.left) / rect.width) * 100
    setSplitPercent(Math.min(80, Math.max(20, percent)))
  }

  const pane = (
    <div
      className={`flex flex-col min-w-0 h-full ${paneIsActive ? 'bg-[#0d1117]' : 'bg-[#0b0f14]'}`}
      onMouseDown={activateThisPane}
    >
      {/* Compact iTerm-style pane title bar */}
      <div className={`h-9 flex items-center justify-between px-2 border-b shrink-0 ${paneIsActive ? 'bg-gray-800 border-blue-500/70' : 'bg-gray-900 border-gray-700/60'}`}>
        <div className="flex items-center gap-2 min-w-0 flex-1" title={`${sessionName} · ${terminalId} · ${provider || ''} · ${agentProfile || ''}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${paneIsActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
          <TermIcon size={13} className={paneIsActive ? 'text-blue-300 shrink-0' : 'text-gray-500 shrink-0'} />
          <span className="text-xs font-mono text-gray-200 truncate">{sessionName}</span>
          {node && <span className="text-[10px] text-blue-300 truncate max-w-24">{node}</span>}
          {agentProfile && <span className="text-[10px] text-emerald-400 truncate max-w-20">{agentProfile}</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {copyStatus !== 'idle' && (
            <span className={`text-[10px] max-w-24 truncate ${copyStatus === 'failed' ? 'text-red-400' : 'text-emerald-400'}`}>
              {copyStatus === 'copied' ? 'Copied' : 'Copy failed'}
            </span>
          )}
          {replicationEnabled && replicateStatus !== 'idle' && (
            <span className={`text-[10px] max-w-32 truncate ${replicateStatus === 'failed' ? 'text-red-400' : replicateStatus === 'created' ? 'text-emerald-400' : 'text-blue-300'}`} title={replicateMessage}>
              {replicateMessage}
            </span>
          )}
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => scrollTerminal(-1)}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Scroll terminal up one page"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => scrollTerminal(1)}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Scroll terminal down one page"
          >
            <ChevronDown size={13} />
          </button>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={copyCurrentSelection}
            disabled={!hasSelection}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-25 rounded transition-colors"
            title="Copy selected terminal text"
          >
            {copyStatus === 'copied' ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {replicationEnabled && (
            <button
              onClick={() => replicateHandlerRef.current()}
              disabled={replicateStatus === 'creating' || replicateStatus === 'created'}
              className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 rounded transition-colors"
              title={`Create ${sessionName}-copy without an initial task (⌘D)`}
            >
              <CopyPlus size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 transition-colors rounded"
            title={embedded ? 'Close split pane' : 'Close terminal view'}
          >
            <X size={18} />
          </button>
        </div>
      </div>
      {/* Terminal — absolute positioning gives xterm.js real pixel dimensions to measure */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={containerRef} className="terminal-scrollback" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      </div>
    </div>
  )

  if (embedded) return pane

  return (
    <div ref={splitContainerRef} className="fixed inset-0 z-50 flex overscroll-none" style={{ background: '#0d1117' }}>
      <div className="h-full min-w-0 shrink-0" style={{ flexBasis: replicaTerminal ? `${splitPercent}%` : '100%' }}>
        {pane}
      </div>
      {replicaTerminal && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize terminal panes"
            className="h-full w-1 shrink-0 cursor-col-resize bg-gray-700 hover:bg-blue-500 active:bg-blue-400 transition-colors z-10"
            onPointerDown={event => {
              resizingRef.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeSplit(event.clientX)
              event.preventDefault()
            }}
            onPointerMove={event => { if (resizingRef.current) resizeSplit(event.clientX) }}
            onPointerUp={event => {
              resizingRef.current = false
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => { resizingRef.current = false }}
            onDoubleClick={() => setSplitPercent(50)}
          />
          <div className="h-full min-w-0 flex-1">
            <TerminalView
              terminalId={replicaTerminal.id}
              sessionName={replicaTerminal.session_name}
              provider={replicaTerminal.provider}
              agentProfile={replicaTerminal.agent_profile}
              node={node}
              embedded
              replicationEnabled={false}
              active={activePane === 'replica'}
              onActivate={() => setActivePane('replica')}
              onClose={() => {
                setReplicaTerminal(null)
                setActivePane('primary')
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
