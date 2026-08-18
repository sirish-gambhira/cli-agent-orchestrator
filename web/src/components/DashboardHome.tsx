import { useState, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { api, FleetCachedNode, FleetNodeOverview, TerminalMeta } from '../api'
import { Bot, Package, Monitor, Terminal as TermIcon, Trash2, Mail, FileText, LogOut, Send, ArrowDownUp, FolderOpen } from 'lucide-react'
import { TerminalView } from './TerminalView'
import { ConfirmModal } from './ConfirmModal'
import { InboxPanel } from './InboxPanel'
import { StatusBadge } from './StatusBadge'
import { OutputViewer } from './OutputViewer'
import { CustomSelect } from './CustomSelect'

function fmtRel(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  const diff = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (diff < 60) return 'just now'
  const m = Math.floor(diff / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm ? `${h}h ${rm}m ago` : `${h}h ago`
  const days = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${days}d ${rh}h ago` : `${days}d ago`
}

function fmtAbs(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

interface SessionWithTerminals {
  name: string
  status: string
  node: string | null
  nodeStatus?: 'live' | 'stale' | 'offline' | 'unmonitored'
  terminals: Array<TerminalMeta & { status?: string | null }>
}

interface LocatedTerminal {
  terminal: TerminalMeta
  node: string | null
}

const locationKey = (node: string | null, id: string) => `${node || 'local'}:${id}`
export const terminalHash = (node: string | null, session: string, terminalId: string) =>
  `#terminal/${encodeURIComponent(node || 'local')}/${encodeURIComponent(session)}/${encodeURIComponent(terminalId)}`

type SessionSource = 'local' | 'fleet'

interface SessionDeletionBarrier {
  source: SessionSource
  afterRequest: number
}

export function acknowledgeSessionDeletions(
  sessions: SessionWithTerminals[],
  barriers: Map<string, SessionDeletionBarrier>,
  source: SessionSource,
  requestSequence: number,
): void {
  for (const [key, barrier] of barriers) {
    // A snapshot already in flight when Delete was clicked cannot prove that
    // deletion completed. Only a newer snapshot may release the UI barrier.
    if (
      barrier.source === source
      && requestSequence > barrier.afterRequest
      && !sessions.some(session => locationKey(session.node, session.name) === key)
    ) {
      barriers.delete(key)
    }
  }
}

export function sessionsFromFleet(overview: FleetNodeOverview[]): SessionWithTerminals[] {
  return overview.flatMap(node => node.status === 'reachable'
    ? node.sessions.map(session => ({
        name: session.name,
        status: session.status,
        node: node.name,
        terminals: session.terminals || [],
      }))
    : [])
}

export function mergeFleetSessions(
  previous: Map<string, SessionWithTerminals[]>,
  overview: FleetNodeOverview[],
): Map<string, SessionWithTerminals[]> {
  const next = new Map(previous)
  overview.forEach(node => {
    // An unreachable response is treated as a transient observation. Keep the
    // last successful snapshot until the node can be queried again.
    if (node.status !== 'reachable') return
    next.set(node.name, sessionsFromFleet([node]))
  })
  return next
}

export function sessionsFromCachedFleet(nodes: FleetCachedNode[]): SessionWithTerminals[] {
  return nodes.flatMap(node => node.sessions.map(session => ({
    name: session.name,
    status: session.status,
    node: node.name,
    nodeStatus: node.status,
    terminals: session.terminals || [],
  })))
}

export function DashboardHome({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { terminalStatuses, setTerminalStatus, clearTerminalStatuses, showSnackbar, fetchFleetState } = useStore()
  const [profileCount, setProfileCount] = useState(0)
  const [sessionData, setSessionData] = useState<SessionWithTerminals[]>([])
  const [liveTerminal, setLiveTerminal] = useState<{ id: string; sessionName: string; provider?: string; agentProfile?: string | null; node: string | null } | null>(null)
  const [inboxTerminal, setInboxTerminal] = useState<{ id: string; node: string | null } | null>(null)
  const [outputTerminal, setOutputTerminal] = useState<{ id: string; node: string | null } | null>(null)
  const [pendingExit, setPendingExit] = useState<LocatedTerminal | null>(null)
  const [exitingTerminal, setExitingTerminal] = useState<string | null>(null)
  const [sendInputOpen, setSendInputOpen] = useState<Record<string, boolean>>({})
  const [sendInputValues, setSendInputValues] = useState<Record<string, string>>({})
  const [sendingInput, setSendingInput] = useState<string | null>(null)
  const [executionNodeFilter, setExecutionNodeFilter] = useState('all')
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ name: string; node: string | null } | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [terminalWorkDirs, setTerminalWorkDirs] = useState<Record<string, string | null>>({})
  const workingDirectoryRequestsRef = useRef(new Set<string>())
  const deletedSessionsRef = useRef(new Map<string, SessionDeletionBarrier>())
  const localRequestSequenceRef = useRef(0)
  const fleetRequestSequenceRef = useRef(0)

  const openLiveTerminal = (session: SessionWithTerminals, agent: TerminalMeta) => {
    window.history.replaceState(null, '', terminalHash(session.node, session.name, agent.id))
    setLiveTerminal({
      id: agent.id,
      sessionName: session.name,
      provider: agent.provider,
      agentProfile: agent.agent_profile,
      node: session.node,
    })
  }

  const nonEmptySessionCount = sessionData.filter(session => session.terminals.length > 0).length

  const executionNodes = useMemo(() => {
    const nodes = new Set(sessionData.map(session => session.node || 'local'))
    return [...nodes].sort((a, b) => {
      if (a === 'local') return -1
      if (b === 'local') return 1
      return a.localeCompare(b)
    })
  }, [sessionData])

  const filteredSessions = useMemo(() => {
    const filtered = sessionData.filter(session => {
      const agent = session.terminals[0]
      if (!agent) return false
      return executionNodeFilter === 'all' || (session.node || 'local') === executionNodeFilter
    })
    return filtered.sort((a, b) => {
      const latestA = a.terminals[0]?.last_active ? new Date(a.terminals[0].last_active!).getTime() : 0
      const latestB = b.terminals[0]?.last_active ? new Date(b.terminals[0].last_active!).getTime() : 0
      return sortOrder === 'desc' ? latestB - latestA : latestA - latestB
    })
  }, [sessionData, executionNodeFilter, sortOrder])

  // Fetch laptop-local sessions and all reachable SSH nodes into one dashboard.
  useEffect(() => {
    let stopped = false
    let localData: SessionWithTerminals[] = []
    let fleetData: SessionWithTerminals[] = []
    let localTimer: ReturnType<typeof setTimeout>
    let fleetTimer: ReturnType<typeof setTimeout>

    const publish = () => {
      if (stopped) return
      const sessionDetails = [...localData, ...fleetData].filter(
        session => !deletedSessionsRef.current.has(locationKey(session.node, session.name)),
      )
      setSessionData(sessionDetails)
      sessionDetails.forEach(session => {
        const agent = session.terminals[0]
        if (agent?.status) setTerminalStatus(locationKey(session.node, agent.id), agent.status)
      })
    }

    const fetchLocal = async () => {
      const requestSequence = ++localRequestSequenceRef.current
      try {
        const localSessions = await api.listSessions()
        localData = await Promise.all(localSessions.map(async s => {
          try {
            const detail = await api.getSession(s.name)
            return { name: s.name, status: s.status, node: null, terminals: detail.terminals || [] } as SessionWithTerminals
          } catch {
            return { name: s.name, status: s.status, node: null, terminals: [] } as SessionWithTerminals
          }
        }))
        acknowledgeSessionDeletions(localData, deletedSessionsRef.current, 'local', requestSequence)
        publish()
      } catch {
        // Preserve the last successful local snapshot during transient failures.
      } finally {
        if (!stopped) localTimer = setTimeout(fetchLocal, 5000)
      }
    }

    const fetchFleet = async () => {
      const requestSequence = ++fleetRequestSequenceRef.current
      try {
        fleetData = sessionsFromCachedFleet(await fetchFleetState())
        acknowledgeSessionDeletions(fleetData, deletedSessionsRef.current, 'fleet', requestSequence)
        publish()
      } catch {
        // Preserve the last successful fleet snapshot during transient failures.
      } finally {
        if (!stopped) fleetTimer = setTimeout(fetchFleet, 10000)
      }
    }

    fetchLocal()
    fetchFleet()
    return () => {
      stopped = true
      clearTimeout(localTimer)
      clearTimeout(fleetTimer)
    }
  }, [fetchFleetState])

  useEffect(() => {
    if (liveTerminal || !window.location.hash.startsWith('#terminal/')) return
    const [nodePart, sessionPart, terminalPart] = window.location.hash.slice('#terminal/'.length).split('/')
    if (!nodePart || !sessionPart || !terminalPart) return
    const node = decodeURIComponent(nodePart) === 'local' ? null : decodeURIComponent(nodePart)
    const sessionName = decodeURIComponent(sessionPart)
    const terminalId = decodeURIComponent(terminalPart)
    const session = sessionData.find(item => item.node === node && item.name === sessionName)
    const terminal = session?.terminals.find(item => item.id === terminalId)
    if (session && terminal) openLiveTerminal(session, terminal)
  }, [sessionData, liveTerminal])

  // Poll statuses
  useEffect(() => {
    const allTerminals = sessionData.flatMap(session => session.terminals[0]
      ? [{ id: session.terminals[0].id, node: session.node }]
      : [])
    const allKeys = allTerminals.map(t => locationKey(t.node, t.id))
    if (!allKeys.length) return
    clearTerminalStatuses(allKeys)
    const fetch = () => {
      allTerminals.forEach(({ id, node }) => {
        api.getTerminalStatus(id, node)
          .then(status => { if (status) setTerminalStatus(locationKey(node, id), status) })
          .catch(() => {})
      })
    }
    fetch()
    const interval = setInterval(fetch, 3000)
    return () => clearInterval(interval)
  }, [sessionData.map(s => s.terminals[0] ? locationKey(s.node, s.terminals[0].id) : '').join(',')])

  // Resolve each agent's live pane directory once it appears. The endpoint is
  // node-aware, so this works for laptop and remote fleet cards alike.
  useEffect(() => {
    sessionData.forEach(session => {
      const agent = session.terminals[0]
      if (!agent) return
      const key = locationKey(session.node, agent.id)
      if (Object.prototype.hasOwnProperty.call(terminalWorkDirs, key) || workingDirectoryRequestsRef.current.has(key)) return
      workingDirectoryRequestsRef.current.add(key)
      api.getWorkingDirectory(agent.id, session.node)
        .then(({ working_directory }) => {
          setTerminalWorkDirs(previous => ({ ...previous, [key]: working_directory }))
        })
        .catch(() => {
          // Allow a later dashboard refresh to retry after transient node loss.
        })
        .finally(() => workingDirectoryRequestsRef.current.delete(key))
    })
  }, [sessionData, terminalWorkDirs])

  useEffect(() => {
    api.listProfiles().then(p => setProfileCount(p.length)).catch(() => {})
  }, [])

  const handleExitTerminal = async () => {
    if (!pendingExit) return
    const { terminal, node } = pendingExit
    setExitingTerminal(terminal.id)
    try {
      await api.exitTerminal(terminal.id, node)
      showSnackbar({ type: 'success', message: `Graceful exit sent` })
    } catch {
      showSnackbar({ type: 'error', message: `Failed to send exit` })
    }
    setExitingTerminal(null)
    setPendingExit(null)
  }

  const handleDeleteSession = async () => {
    if (!pendingDeleteSession) return
    const target = pendingDeleteSession
    const deletedSession = sessionData.find(session => session.name === target.name && session.node === target.node)
    const key = locationKey(target.node, target.name)
    const source: SessionSource = target.node ? 'fleet' : 'local'
    deletedSessionsRef.current.set(key, {
      source,
      afterRequest: source === 'fleet' ? fleetRequestSequenceRef.current : localRequestSequenceRef.current,
    })
    setSessionData(prev => prev.filter(session => locationKey(session.node, session.name) !== key))
    setDeletingSession(true)
    try {
      await api.deleteSession(target.name, target.node)
      showSnackbar({ type: 'success', message: `Deleted ${target.name}` })
    } catch {
      deletedSessionsRef.current.delete(key)
      if (deletedSession) {
        setSessionData(prev => prev.some(session => locationKey(session.node, session.name) === key)
          ? prev
          : [...prev, deletedSession])
      }
      showSnackbar({ type: 'error', message: `Failed to delete ${target.name}` })
    }
    setDeletingSession(false)
    setPendingDeleteSession(null)
  }

  const handleSendInput = async (terminalId: string, node: string | null) => {
    const key = locationKey(node, terminalId)
    const message = (sendInputValues[key] || '').trim()
    if (!message) return
    setSendingInput(key)
    try {
      await api.sendInput(terminalId, message, node)
      setSendInputValues(prev => ({ ...prev, [key]: '' }))
      showSnackbar({ type: 'success', message: 'Message sent' })
    } catch {
      showSnackbar({ type: 'error', message: 'Failed to send message' })
    }
    setSendingInput(null)
  }

  return (
    <div className="space-y-6">
      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl p-5 border border-gray-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-900/50 flex items-center justify-center">
              <TermIcon size={20} className="text-cyan-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{nonEmptySessionCount}</div>
              <div className="text-xs text-gray-400 uppercase tracking-wide">Running Agents</div>
            </div>
          </div>
        </div>
        <div className="bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl p-5 border border-gray-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-900/50 flex items-center justify-center">
              <Package size={20} className="text-blue-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{profileCount}</div>
              <div className="text-xs text-gray-400 uppercase tracking-wide">Profiles</div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex gap-3 flex-wrap">
        <button onClick={() => onNavigate('agents')} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors">
          <Bot size={16} /> New Agent Session
        </button>
      </div>

      {/* Header with sort toggle */}
      <div className="mb-1">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Agents</h3>
            <p className="text-xs text-gray-500 mt-1">
              All running agents across the laptop and managed nodes.
            </p>
          </div>
          <button onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors">
            <ArrowDownUp size={12} />
            {sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
      </div>

      {/* The dashboard intentionally has one filter: where the session runs. */}
      <div className="w-full sm:w-72">
        <label className="block text-xs text-gray-500 mb-1">Execution Node</label>
        <CustomSelect
          value={executionNodeFilter}
          onChange={setExecutionNodeFilter}
          options={[
            { value: 'all', label: 'All nodes' },
            ...executionNodes.map(node => ({
              value: node,
              label: node === 'local' ? 'This laptop' : node,
            })),
          ]}
        />
      </div>

      {/* Agent session cards */}
      {filteredSessions.length === 0 ? (
        <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-8 text-center">
          <Bot size={32} className="mx-auto text-gray-600 mb-3" />
          {nonEmptySessionCount === 0 ? (
            <>
              <p className="text-gray-400 text-sm">No agents are running.</p>
              <p className="text-gray-600 text-xs mt-1">Go to the <span className="text-emerald-400 cursor-pointer" onClick={() => onNavigate('agents')}>Agents tab</span> to create your first agent session.</p>
            </>
          ) : (
            <p className="text-gray-400 text-sm">No agents match the current filter.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSessions.map(session => {
            const sessionKey = locationKey(session.node, session.name)
            const agent = session.terminals[0]
            if (!agent) return null
            const agentKey = locationKey(session.node, agent.id)
            const relCreated = fmtRel(agent.created_at)
            const relActive = fmtRel(agent.last_active)
            const showActive = relActive && relActive !== relCreated
            const workingDirectory = terminalWorkDirs[agentKey]
            return (
              <div key={sessionKey} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Bot size={16} className="text-emerald-400 shrink-0" />
                    <span className="text-sm font-semibold text-gray-200 font-mono truncate">{session.name}</span>
                    <StatusBadge status={terminalStatuses[agentKey] || agent.status || null} />
                    <span className="text-[10px] text-gray-500">{agent.provider}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setInboxTerminal({ id: agent.id, node: session.node })} className="p-1.5 text-gray-500 hover:text-white bg-gray-900/60 hover:bg-gray-700 rounded transition-colors" title="Inbox"><Mail size={13} /></button>
                    <button onClick={() => setOutputTerminal({ id: agent.id, node: session.node })} className="p-1.5 text-gray-500 hover:text-white bg-gray-900/60 hover:bg-gray-700 rounded transition-colors" title="Output"><FileText size={13} /></button>
                    <button onClick={() => openLiveTerminal(session, agent)} className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium rounded transition-colors"><Monitor size={12} />Terminal</button>
                    <button onClick={() => setPendingExit({ terminal: agent, node: session.node })} disabled={exitingTerminal === agent.id} className="p-1.5 text-gray-500 hover:text-amber-400 bg-gray-900/60 hover:bg-gray-700 rounded transition-colors" title="Graceful exit"><LogOut size={13} /></button>
                    <button onClick={() => setPendingDeleteSession({ name: session.name, node: session.node })} className="p-1.5 text-gray-500 hover:text-red-400 bg-gray-900/60 hover:bg-gray-700 rounded transition-colors" title="Delete agent session"><Trash2 size={13} /></button>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-[10px] text-gray-600 flex-wrap">
                  <span className="text-emerald-400">{agent.agent_profile || 'default'}</span>
                  <span className={`font-mono bg-gray-700/60 px-1.5 py-0.5 rounded ${session.nodeStatus === 'offline' ? 'text-red-300' : session.nodeStatus === 'stale' ? 'text-amber-300' : 'text-cyan-300'}`}>
                    {session.node || 'laptop'}{session.nodeStatus && session.nodeStatus !== 'live' ? ` · ${session.nodeStatus}` : ''}
                  </span>
                  <span className="font-mono">{agent.id.slice(0, 8)}</span>
                  {relCreated && <span title={fmtAbs(agent.created_at) || ''}>{relCreated}</span>}
                  {showActive && <span title={fmtAbs(agent.last_active) || ''}>↻ {relActive}</span>}
                </div>

                {workingDirectory && (
                  <div className="flex items-center gap-1.5 min-w-0" title={workingDirectory}>
                    <FolderOpen size={12} className="text-gray-600 shrink-0" />
                    <span className="text-xs font-mono text-gray-500 truncate">{workingDirectory}</span>
                  </div>
                )}

                {!sendInputOpen[agentKey] ? (
                  <button onClick={() => setSendInputOpen(prev => ({ ...prev, [agentKey]: true }))} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors">Message agent...</button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input type="text" value={sendInputValues[agentKey] || ''} onChange={e => setSendInputValues(prev => ({ ...prev, [agentKey]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleSendInput(agent.id, session.node) }} placeholder="Type a message..." className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 text-[11px] font-mono rounded px-2 py-1.5 focus:border-emerald-500 focus:outline-none" autoFocus />
                    <button onClick={() => handleSendInput(agent.id, session.node)} disabled={sendingInput === agentKey || !(sendInputValues[agentKey] || '').trim()} className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[10px] font-medium rounded transition-colors"><Send size={10} /></button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modals */}
      {inboxTerminal && <InboxPanel terminalId={inboxTerminal.id} node={inboxTerminal.node} onClose={() => setInboxTerminal(null)} />}
      {liveTerminal && (
        <TerminalView
          terminalId={liveTerminal.id}
          sessionName={liveTerminal.sessionName}
          provider={liveTerminal.provider}
          agentProfile={liveTerminal.agentProfile}
          node={liveTerminal.node}
          onClose={() => {
            setLiveTerminal(null)
            if (window.location.hash.startsWith('#terminal/')) {
              window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
            }
          }}
        />
      )}
      {outputTerminal && <OutputViewer terminalId={outputTerminal.id} node={outputTerminal.node} onClose={() => setOutputTerminal(null)} />}
      <ConfirmModal
        open={!!pendingExit}
        title="Graceful Exit"
        message="This will send the provider-specific exit command (e.g., /exit)."
        details={pendingExit ? [
          { label: 'Terminal', value: `${pendingExit.terminal.agent_profile || 'default'} (${pendingExit.terminal.id})` },
          { label: 'Provider', value: pendingExit.terminal.provider },
          { label: 'Node', value: pendingExit.node || 'laptop' },
        ] : []}
        confirmLabel="Send Exit"
        variant="warning"
        loading={!!exitingTerminal}
        onConfirm={handleExitTerminal}
        onCancel={() => setPendingExit(null)}
      />
      <ConfirmModal
        open={!!pendingDeleteSession}
        title="Delete Agent Session"
        message="This will terminate the agent and remove its session."
        details={pendingDeleteSession ? [
          { label: 'Session', value: pendingDeleteSession.name },
          { label: 'Node', value: pendingDeleteSession.node || 'laptop' },
        ] : []}
        confirmLabel="Delete Agent Session"
        variant="danger"
        loading={deletingSession}
        onConfirm={handleDeleteSession}
        onCancel={() => setPendingDeleteSession(null)}
      />
    </div>
  )
}
