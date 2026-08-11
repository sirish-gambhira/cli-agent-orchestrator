import { create } from 'zustand'
import { api, FleetNode, PermissionMode, Session, SessionDetail } from './api'

// Only trigger React re-renders when data actually changed
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const nodeKey = (node: string | null) => node || 'local'
let sessionRequestSequence = 0
const latestAppliedRequest = new Map<string, number>()
const deletedSessionBarriers = new Map<string, Map<string, number>>()

function deletionBarriers(node: string | null): Map<string, number> {
  const key = nodeKey(node)
  let barriers = deletedSessionBarriers.get(key)
  if (!barriers) {
    barriers = new Map()
    deletedSessionBarriers.set(key, barriers)
  }
  return barriers
}

interface Snackbar {
  type: 'success' | 'error' | 'info'
  message: string
}

interface Store {
  sessions: Session[]
  activeSession: string | null
  activeSessionDetail: SessionDetail | null
  connected: boolean
  snackbar: Snackbar | null
  terminalStatuses: Record<string, string>
  fleetNodes: FleetNode[]
  selectedNode: string | null

  fetchSessions: () => Promise<void>
  selectSession: (name: string | null) => Promise<void>
  createSession: (provider: string, agentProfile: string, workingDirectory?: string, sessionName?: string, initialMessage?: string, useWorktree?: boolean, model?: string, permissionMode?: PermissionMode) => Promise<void>
  deleteSession: (name: string) => Promise<void>
  showSnackbar: (snackbar: Snackbar) => void
  hideSnackbar: () => void
  setConnected: (connected: boolean) => void
  setTerminalStatus: (id: string, status: string) => void
  clearTerminalStatuses: (ids: string[]) => void
  fetchFleetNodes: () => Promise<void>
  selectNode: (node: string | null) => Promise<void>
}

export const useStore = create<Store>((set, get) => ({
  sessions: [],
  activeSession: null,
  activeSessionDetail: null,
  connected: false,
  snackbar: null,
  terminalStatuses: {},
  fleetNodes: [],
  selectedNode: null,

  fetchSessions: async () => {
    const requestedNode = get().selectedNode
    const requestedNodeKey = nodeKey(requestedNode)
    const requestSequence = ++sessionRequestSequence
    try {
      const sessions = await api.listSessions(requestedNode)
      if (get().selectedNode !== requestedNode) return
      if (requestSequence < (latestAppliedRequest.get(requestedNodeKey) || 0)) return

      const barriers = deletionBarriers(requestedNode)
      for (const [name, barrier] of barriers) {
        // Only a request begun after the delete may acknowledge absence. An
        // older in-flight response is never allowed to clear the barrier.
        if (requestSequence > barrier && !sessions.some(session => session.name === name)) {
          barriers.delete(name)
        }
      }
      const visibleSessions = sessions.filter(session => !barriers.has(session.name))
      latestAppliedRequest.set(requestedNodeKey, requestSequence)
      const prev = get()
      // Only skip empty responses when reconnecting (connected was false),
      // not after intentional deletions.
      if (visibleSessions.length === 0 && prev.sessions.length > 0 && !prev.connected) {
        set({ connected: true })
        return
      }
      if (!prev.connected || !jsonEqual(prev.sessions, visibleSessions)) {
        set({ sessions: visibleSessions, connected: true })
      }
    } catch {
      if (get().connected) set({ connected: false })
    }
  },

  selectSession: async (name) => {
    if (!name) {
      set({ activeSession: null, activeSessionDetail: null })
      return
    }
    set({ activeSession: name })
    try {
      const detail = await api.getSession(name, get().selectedNode)
      if (!jsonEqual(get().activeSessionDetail, detail)) {
        set({ activeSessionDetail: detail })
      }
    } catch {
      set({ activeSessionDetail: null })
    }
  },

  createSession: async (provider, agentProfile, workingDirectory, sessionName, initialMessage, useWorktree, model, permissionMode) => {
    try {
      await api.createSession(provider, agentProfile, sessionName, workingDirectory, get().selectedNode, initialMessage, useWorktree, model, false, permissionMode)
      if (sessionName) deletionBarriers(get().selectedNode).delete(sessionName)
      get().showSnackbar({ type: 'success', message: 'Session created' })
      await get().fetchSessions()
    } catch (e: any) {
      get().showSnackbar({ type: 'error', message: e.message || 'Failed to create session' })
    }
  },

  deleteSession: async (name) => {
    const requestedNode = get().selectedNode
    const deletedSession = get().sessions.find(session => session.name === name)
    const barriers = deletionBarriers(requestedNode)
    barriers.set(name, sessionRequestSequence)
    set(state => ({
      sessions: state.sessions.filter(session => session.name !== name),
      ...(state.activeSession === name ? { activeSession: null, activeSessionDetail: null } : {}),
    }))
    try {
      await api.deleteSession(name, requestedNode)
      get().showSnackbar({ type: 'success', message: `Deleted ${name}` })
      if (get().selectedNode === requestedNode) await get().fetchSessions()
    } catch (e: any) {
      barriers.delete(name)
      if (get().selectedNode === requestedNode && deletedSession) {
        set(state => ({
          sessions: state.sessions.some(session => session.name === name)
            ? state.sessions
            : [...state.sessions, deletedSession],
        }))
      }
      get().showSnackbar({ type: 'error', message: e.message || 'Failed to delete session' })
      if (get().selectedNode === requestedNode) await get().fetchSessions()
    }
  },

  showSnackbar: (snackbar) => set({ snackbar }),
  hideSnackbar: () => set({ snackbar: null }),
  setConnected: (connected) => set({ connected }),
  setTerminalStatus: (id, status) =>
    set(state => {
      const normalized = status ? status.toUpperCase() : status
      if (state.terminalStatuses[id] === normalized) return state
      return { terminalStatuses: { ...state.terminalStatuses, [id]: normalized } }
    }),
  clearTerminalStatuses: (ids) =>
    set(state => {
      const next: Record<string, string> = {}
      for (const id of ids) {
        if (state.terminalStatuses[id]) next[id] = state.terminalStatuses[id]
      }
      if (Object.keys(next).length === Object.keys(state.terminalStatuses).length) return state
      return { terminalStatuses: next }
    }),
  fetchFleetNodes: async () => {
    try {
      set({ fleetNodes: await api.listFleetNodes() })
    } catch {
      set({ fleetNodes: [] })
    }
  },
  selectNode: async (node) => {
    set({
      selectedNode: node,
      sessions: [],
      activeSession: null,
      activeSessionDetail: null,
      terminalStatuses: {},
      connected: false,
    })
    await get().fetchSessions()
  },
}))
