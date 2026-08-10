import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { api, FleetCachedNode, FleetNodeOverview, TerminalMeta } from '../api'
import { Bot, Package, Monitor, Terminal as TermIcon, Trash2, Mail, FileText, LogOut, Send, Users, Filter, ArrowDownUp } from 'lucide-react'
import { TerminalView } from './TerminalView'
import { ConfirmModal } from './ConfirmModal'
import { InboxPanel } from './InboxPanel'
import { StatusBadge, STATUS_CONFIG } from './StatusBadge'
import { OutputViewer } from './OutputViewer'

const STATUS_ORDER = ['PROCESSING', 'IDLE', 'WAITING_USER_ANSWER', 'ERROR', 'COMPLETED', 'UNKNOWN']

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

const STATUS_META: Record<string, { label: string; dot: string; text: string; pulse?: boolean }> = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([k, v]) => [k, { label: v.label, dot: v.dotClass, text: v.textClass, pulse: v.pulse }])
)
STATUS_META['UNKNOWN'] = { label: 'Unknown', dot: 'bg-gray-500', text: 'text-gray-500' }

const STATUS_ACTIVE_BG: Record<string, string> = {
  PROCESSING: 'bg-blue-900/40 border-blue-500/50 text-blue-300',
  IDLE: 'bg-emerald-900/40 border-emerald-500/50 text-emerald-300',
  WAITING_USER_ANSWER: 'bg-amber-900/40 border-amber-500/50 text-amber-300',
  ERROR: 'bg-red-900/40 border-red-500/50 text-red-300',
  COMPLETED: 'bg-purple-900/40 border-purple-500/50 text-purple-300',
  UNKNOWN: 'bg-gray-800/40 border-gray-500/50 text-gray-300',
}

interface SessionWithTerminals {
  name: string
  status: string
  node: string | null
  nodeStatus?: 'live' | 'stale' | 'offline'
  terminals: Array<TerminalMeta & { status?: string | null }>
}

interface LocatedTerminal {
  terminal: TerminalMeta
  node: string | null
}

const locationKey = (node: string | null, id: string) => `${node || 'local'}:${id}`

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
  const { terminalStatuses, setTerminalStatus, clearTerminalStatuses, showSnackbar } = useStore()
  const [profileCount, setProfileCount] = useState(0)
  const [sessionData, setSessionData] = useState<SessionWithTerminals[]>([])
  const [liveTerminal, setLiveTerminal] = useState<{ id: string; provider?: string; agentProfile?: string | null; node: string | null } | null>(null)
  const [pendingClose, setPendingClose] = useState<LocatedTerminal | null>(null)
  const [closingTerminal, setClosingTerminal] = useState<string | null>(null)
  const [inboxTerminal, setInboxTerminal] = useState<{ id: string; node: string | null } | null>(null)
  const [outputTerminal, setOutputTerminal] = useState<{ id: string; node: string | null } | null>(null)
  const [pendingExit, setPendingExit] = useState<LocatedTerminal | null>(null)
  const [exitingTerminal, setExitingTerminal] = useState<string | null>(null)
  const [sendInputOpen, setSendInputOpen] = useState<Record<string, boolean>>({})
  const [sendInputValues, setSendInputValues] = useState<Record<string, string>>({})
  const [sendingInput, setSendingInput] = useState<string | null>(null)
  const [agentTypeFilter, setAgentTypeFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ name: string; node: string | null } | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)

  const totalTerminals = sessionData.reduce((sum, s) => sum + s.terminals.length, 0)
  const nonEmptySessionCount = sessionData.filter(session => session.terminals.length > 0).length

  const allAgentTypes = useMemo(() => {
    const types = new Set<string>()
    sessionData.forEach(s => s.terminals.forEach(t => { types.add(t.agent_profile || 'default') }))
    return [...types].sort()
  }, [sessionData])

  const filteredSessions = useMemo(() => {
    const filtered = sessionData.filter(s =>
      s.terminals.some(t => {
        const matchAgent = !agentTypeFilter || (t.agent_profile || 'default') === agentTypeFilter
        const matchStatus = !statusFilter || (terminalStatuses[locationKey(s.node, t.id)] || t.status?.toUpperCase() || 'UNKNOWN') === statusFilter
        return matchAgent && matchStatus
      })
    )
    return filtered.sort((a, b) => {
      const latestA = Math.max(...a.terminals.map(t => t.last_active ? new Date(t.last_active).getTime() : 0))
      const latestB = Math.max(...b.terminals.map(t => t.last_active ? new Date(t.last_active).getTime() : 0))
      return sortOrder === 'desc' ? latestB - latestA : latestA - latestB
    })
  }, [sessionData, agentTypeFilter, statusFilter, sortOrder, terminalStatuses])

  // Fetch laptop-local sessions and all reachable SSH nodes into one dashboard.
  useEffect(() => {
    let stopped = false
    let localData: SessionWithTerminals[] = []
    let fleetData: SessionWithTerminals[] = []
    let localTimer: ReturnType<typeof setTimeout>
    let fleetTimer: ReturnType<typeof setTimeout>

    const publish = () => {
      if (stopped) return
      const sessionDetails = [...localData, ...fleetData]
      setSessionData(sessionDetails)
      sessionDetails.forEach(session => session.terminals.forEach(terminal => {
        if (terminal.status) setTerminalStatus(locationKey(session.node, terminal.id), terminal.status)
      }))
    }

    const fetchLocal = async () => {
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
        publish()
      } catch {
        // Preserve the last successful local snapshot during transient failures.
      } finally {
        if (!stopped) localTimer = setTimeout(fetchLocal, 5000)
      }
    }

    const fetchFleet = async () => {
      try {
        fleetData = sessionsFromCachedFleet(await api.getFleetState())
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
  }, [])

  // Poll statuses
  useEffect(() => {
    const allTerminals = sessionData.flatMap(s => s.terminals.map(t => ({ id: t.id, node: s.node })))
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
  }, [sessionData.flatMap(s => s.terminals.map(t => locationKey(s.node, t.id))).join(',')])

  useEffect(() => {
    api.listProfiles().then(p => setProfileCount(p.length)).catch(() => {})
  }, [])

  const handleDeleteTerminal = async () => {
    if (!pendingClose) return
    const { terminal, node } = pendingClose
    setClosingTerminal(terminal.id)
    try {
      await api.deleteTerminal(terminal.id, node)
      if (liveTerminal?.id === terminal.id && liveTerminal.node === node) setLiveTerminal(null)
      showSnackbar({ type: 'success', message: `Terminal ${terminal.id} closed` })
    } catch {
      showSnackbar({ type: 'error', message: `Failed to close terminal` })
    }
    setClosingTerminal(null)
    setPendingClose(null)
  }

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
    setDeletingSession(true)
    try {
      await api.deleteSession(pendingDeleteSession.name, pendingDeleteSession.node)
      setSessionData(prev => prev.filter(session => !(session.name === pendingDeleteSession.name && session.node === pendingDeleteSession.node)))
      showSnackbar({ type: 'success', message: `Deleted ${pendingDeleteSession.name}` })
    } catch {
      showSnackbar({ type: 'error', message: `Failed to delete ${pendingDeleteSession.name}` })
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl p-5 border border-gray-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-900/50 flex items-center justify-center">
              <Users size={20} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{nonEmptySessionCount}</div>
              <div className="text-xs text-gray-400 uppercase tracking-wide">Sessions</div>
            </div>
          </div>
        </div>
        <div className="bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl p-5 border border-gray-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-900/50 flex items-center justify-center">
              <TermIcon size={20} className="text-cyan-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{totalTerminals}</div>
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

      {/* Agent type filter */}
      {allAgentTypes.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Filter size={12} className="text-gray-500" />
          <button onClick={() => setAgentTypeFilter(null)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${!agentTypeFilter ? 'bg-emerald-900/40 border-emerald-500/50 text-emerald-300' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>All</button>
          {allAgentTypes.map(t => (
            <button key={t} onClick={() => setAgentTypeFilter(agentTypeFilter === t ? null : t)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${agentTypeFilter === t ? 'bg-emerald-900/40 border-emerald-500/50 text-emerald-300' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>{t}</button>
          ))}
        </div>
      )}

      {/* Status filter */}
      <div className="flex items-center gap-2 flex-wrap -mt-3">
        <Filter size={12} className="text-gray-500" />
        <button onClick={() => setStatusFilter(null)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${!statusFilter ? 'bg-gray-700 border-gray-500/50 text-gray-200' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>Any status</button>
        {STATUS_ORDER.map(s => {
          const meta = STATUS_META[s]
          return (
            <button key={s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${statusFilter === s ? STATUS_ACTIVE_BG[s] : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </button>
          )
        })}
      </div>

      {/* Sessions */}
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
            const visibleTerminals = session.terminals.filter(t => {
              const matchAgent = !agentTypeFilter || t.agent_profile === agentTypeFilter
              const matchStatus = !statusFilter || (terminalStatuses[locationKey(session.node, t.id)] || t.status?.toUpperCase() || 'UNKNOWN') === statusFilter
              return matchAgent && matchStatus
            })
            const sortedTerminals = [...visibleTerminals].sort((a, b) => {
              const ta = a.last_active ? new Date(a.last_active).getTime() : 0
              const tb = b.last_active ? new Date(b.last_active).getTime() : 0
              return sortOrder === 'desc' ? tb - ta : ta - tb
            })
            return (
              <div key={sessionKey} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 relative">
                {/* Delete session button */}
                <button
                  onClick={(e) => { e.stopPropagation(); setPendingDeleteSession({ name: session.name, node: session.node }) }}
                  className="absolute top-3 right-3 p-1.5 text-gray-600 hover:text-red-400 bg-gray-800/80 hover:bg-gray-700 rounded-lg transition-colors z-10"
                  title="Delete session"
                >
                  <Trash2 size={12} />
                </button>

                <div className="flex items-center gap-3 pr-8 mb-3">
                  <Users size={14} className="text-emerald-400" />
                  <span className="text-sm font-mono text-gray-200">{session.name}</span>
                  <span className={`text-[10px] font-mono bg-gray-700/60 px-1.5 py-0.5 rounded ${session.nodeStatus === 'offline' ? 'text-red-300' : session.nodeStatus === 'stale' ? 'text-amber-300' : 'text-cyan-300'}`}>
                    {session.node || 'laptop'}{session.nodeStatus && session.nodeStatus !== 'live' ? ` · ${session.nodeStatus}` : ''}
                  </span>
                  <span className="text-xs text-gray-500">{session.terminals.length} agent{session.terminals.length !== 1 ? 's' : ''}</span>
                </div>

                <div className="divide-y divide-gray-700/40">
                  {sortedTerminals.map(t => {
                            const relCreated = fmtRel(t.created_at)
                            const relActive = fmtRel(t.last_active)
                            const showActive = relActive && relActive !== relCreated
                            return (
                              <div key={t.id} className="py-3 first:pt-0 last:pb-0 space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <TermIcon size={12} className="text-gray-500 shrink-0" />
                                    <span className="text-xs font-medium text-gray-300 truncate">{t.agent_profile || 'default'}</span>
                                    <span className="text-[10px] font-mono text-gray-600">{t.id.slice(0, 8)}</span>
                                    <StatusBadge status={terminalStatuses[locationKey(session.node, t.id)] || t.status || null} />
                                    <span className="text-[10px] text-gray-600">{t.provider}</span>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button onClick={() => setInboxTerminal({ id: t.id, node: session.node })} className="p-1 text-gray-500 hover:text-white bg-gray-800 hover:bg-gray-700 rounded transition-colors" title="Inbox"><Mail size={12} /></button>
                                    <button onClick={() => setOutputTerminal({ id: t.id, node: session.node })} className="p-1 text-gray-500 hover:text-white bg-gray-800 hover:bg-gray-700 rounded transition-colors" title="Output"><FileText size={12} /></button>
                                    <button onClick={() => setLiveTerminal({ id: t.id, provider: t.provider, agentProfile: t.agent_profile, node: session.node })} className="flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium rounded transition-colors"><Monitor size={12} />Terminal</button>
                                    <button onClick={() => setPendingExit({ terminal: t, node: session.node })} disabled={exitingTerminal === t.id} className="p-1 text-gray-500 hover:text-amber-400 bg-gray-800 hover:bg-gray-700 rounded transition-colors" title="Graceful Exit"><LogOut size={12} /></button>
                                    <button onClick={() => setPendingClose({ terminal: t, node: session.node })} disabled={closingTerminal === t.id} className="p-1 text-gray-500 hover:text-red-400 bg-gray-800 hover:bg-gray-700 rounded transition-colors" title="Close"><Trash2 size={12} /></button>
                                  </div>
                                </div>
                                {/* Timestamps */}
                                <div className="flex items-center gap-3 text-[10px] text-gray-600">
                                  {relCreated && <span title={fmtAbs(t.created_at) || ''}>{relCreated}</span>}
                                  {showActive && <span title={fmtAbs(t.last_active) || ''}>↻ {relActive}</span>}
                                </div>
                                {/* Quick Send */}
                                {!sendInputOpen[locationKey(session.node, t.id)] ? (
                                  <button onClick={() => setSendInputOpen(prev => ({ ...prev, [locationKey(session.node, t.id)]: true }))} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors">Message agent...</button>
                                ) : (
                                  <div className="flex items-center gap-1.5">
                                    <input type="text" value={sendInputValues[locationKey(session.node, t.id)] || ''} onChange={e => setSendInputValues(prev => ({ ...prev, [locationKey(session.node, t.id)]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleSendInput(t.id, session.node) }} placeholder="Type a message..." className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 text-[11px] font-mono rounded px-2 py-1 focus:border-emerald-500 focus:outline-none" autoFocus />
                                    <button onClick={() => handleSendInput(t.id, session.node)} disabled={sendingInput === locationKey(session.node, t.id) || !(sendInputValues[locationKey(session.node, t.id)] || '').trim()} className="flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[10px] font-medium rounded transition-colors"><Send size={10} /></button>
                                  </div>
                                )}
                              </div>
                            )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Modals */}
      {inboxTerminal && <InboxPanel terminalId={inboxTerminal.id} node={inboxTerminal.node} onClose={() => setInboxTerminal(null)} />}
      {liveTerminal && (
        <TerminalView terminalId={liveTerminal.id} provider={liveTerminal.provider} agentProfile={liveTerminal.agentProfile} node={liveTerminal.node} onClose={() => setLiveTerminal(null)} />
      )}
      {outputTerminal && <OutputViewer terminalId={outputTerminal.id} node={outputTerminal.node} onClose={() => setOutputTerminal(null)} />}
      <ConfirmModal
        open={!!pendingClose}
        title="Close Terminal"
        message="This will kill the tmux window and terminate the agent process."
        details={pendingClose ? [
          { label: 'Terminal', value: `${pendingClose.terminal.agent_profile || 'default'} (${pendingClose.terminal.id})` },
          { label: 'Session', value: pendingClose.terminal.tmux_session },
          { label: 'Node', value: pendingClose.node || 'laptop' },
        ] : []}
        confirmLabel="Close Terminal"
        variant="danger"
        loading={!!closingTerminal}
        onConfirm={handleDeleteTerminal}
        onCancel={() => setPendingClose(null)}
      />
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
        title="Delete Session"
        message="This will terminate all agents in this session and remove it."
        details={pendingDeleteSession ? [
          { label: 'Session', value: pendingDeleteSession.name },
          { label: 'Node', value: pendingDeleteSession.node || 'laptop' },
        ] : []}
        confirmLabel="Delete Session"
        variant="danger"
        loading={deletingSession}
        onConfirm={handleDeleteSession}
        onCancel={() => setPendingDeleteSession(null)}
      />
    </div>
  )
}
