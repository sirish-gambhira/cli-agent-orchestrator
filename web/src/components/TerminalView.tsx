import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Check, Copy, CopyPlus, X, Terminal as TermIcon } from 'lucide-react'
import { api, Terminal as TerminalRecord } from '../api'

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
}

// Provider TUIs commonly enable DEC mouse tracking. When xterm accepts those
// modes it disables ordinary drag selection and forwards the drag to the
// process instead. The fleet viewer prioritizes reliable text selection, so it
// consumes mouse-only mode changes before xterm applies them.
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1002, 1003, 1005, 1006, 1015, 1016])

export function isMouseTrackingModeSequence(params: (number | number[])[]): boolean {
  return params.length > 0 && params.every(param => typeof param === 'number' && MOUSE_TRACKING_MODES.has(param))
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

export function TerminalView({ terminalId, sessionName, provider, agentProfile, onClose, node, onReplicated, embedded = false, replicationEnabled = true }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const selectedTextRef = useRef('')
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const replicatingRef = useRef(false)
  const replicateHandlerRef = useRef<() => void>(() => {})
  const [hasSelection, setHasSelection] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [replicateStatus, setReplicateStatus] = useState<'idle' | 'creating' | 'created' | 'failed'>('idle')
  const [replicateMessage, setReplicateMessage] = useState('')
  const [replicaTerminal, setReplicaTerminal] = useState<TerminalRecord | null>(null)

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

  const replicateCurrentSession = useCallback(async () => {
    if (replicatingRef.current || replicateStatus === 'created') return
    if (!provider || !agentProfile) {
      setReplicateStatus('failed')
      setReplicateMessage('Provider or profile is unavailable')
      return
    }

    replicatingRef.current = true
    setReplicateStatus('creating')
    setReplicateMessage(`Creating ${sessionName}-copy…`)
    try {
      const { working_directory: workingDirectory } = await api.getWorkingDirectory(terminalId, node)
      const replica = await api.createSession(
        provider,
        agentProfile,
        `${sessionName}-copy`,
        workingDirectory || undefined,
        node,
      )
      setReplicateStatus('created')
      setReplicateMessage(`Created ${replica.session_name}`)
      setReplicaTerminal(replica)
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
      if (!event.metaKey || event.ctrlKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      event.stopPropagation()
      replicateHandlerRef.current()
    }
    window.addEventListener('keydown', handleReplicateShortcut, true)
    return () => window.removeEventListener('keydown', handleReplicateShortcut, true)
  }, [replicationEnabled])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      scrollback: 10000,
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
      selectionDisposable.dispose()
      mouseModeSetDisposable.dispose()
      mouseModeResetDisposable.dispose()
      terminalRef.current = null
      selectedTextRef.current = ''
      setHasSelection(false)
      ws.close()
      term.dispose()
    }
  }, [terminalId, node, showCopyResult])

  useEffect(() => () => clearTimeout(copyFeedbackTimerRef.current), [])

  const pane = (
    <div className="flex flex-col min-w-0 h-full" style={{ background: '#0d1117' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700/50 shrink-0">
        <div className="flex items-center gap-3">
          <TermIcon size={16} className="text-emerald-400" />
          <span className="text-sm font-mono text-gray-300">{sessionName}</span>
          <span className="text-[10px] font-mono text-gray-600">{terminalId}</span>
          {node && <span className="text-xs text-blue-300 bg-blue-900/30 px-2 py-0.5 rounded">{node}</span>}
          {provider && <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{provider}</span>}
          {agentProfile && <span className="text-xs text-emerald-400 bg-emerald-900/30 px-2 py-0.5 rounded">{agentProfile}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] ${copyStatus === 'failed' ? 'text-red-400' : copyStatus === 'copied' ? 'text-emerald-400' : 'text-gray-600'}`}>
            {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : 'Select, then ⌘C / Ctrl+Shift+C'}
          </span>
          {replicationEnabled && replicateStatus !== 'idle' && (
            <span className={`text-[10px] max-w-64 truncate ${replicateStatus === 'failed' ? 'text-red-400' : replicateStatus === 'created' ? 'text-emerald-400' : 'text-blue-300'}`} title={replicateMessage}>
              {replicateMessage}
            </span>
          )}
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={copyCurrentSelection}
            disabled={!hasSelection}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-gray-800 rounded transition-colors"
            title="Copy selected terminal text"
          >
            {copyStatus === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            Copy
          </button>
          {replicationEnabled && (
            <button
              onClick={() => replicateHandlerRef.current()}
              disabled={replicateStatus === 'creating' || replicateStatus === 'created'}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded transition-colors"
              title={`Create ${sessionName}-copy without an initial task (⌘D)`}
            >
              <CopyPlus size={13} />
              {replicateStatus === 'creating' ? 'Replicating…' : 'Replicate ⌘D'}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 text-gray-500 hover:text-white transition-colors rounded"
            title="Close terminal"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      {/* Terminal — absolute positioning gives xterm.js real pixel dimensions to measure */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={containerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      </div>
    </div>
  )

  if (embedded) return pane

  return (
    <div className="fixed inset-0 z-50 flex" style={{ background: '#0d1117' }}>
      <div className={`h-full min-w-0 ${replicaTerminal ? 'w-1/2 border-r border-gray-700' : 'w-full'}`}>
        {pane}
      </div>
      {replicaTerminal && (
        <div className="h-full min-w-0 w-1/2">
          <TerminalView
            terminalId={replicaTerminal.id}
            sessionName={replicaTerminal.session_name}
            provider={replicaTerminal.provider}
            agentProfile={replicaTerminal.agent_profile}
            node={node}
            embedded
            replicationEnabled={false}
            onClose={() => setReplicaTerminal(null)}
          />
        </div>
      )}
    </div>
  )
}
