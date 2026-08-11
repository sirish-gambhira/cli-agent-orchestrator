import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStore } from '../store'
import { api, Session } from '../api'

describe('Store', () => {
  beforeEach(() => {
    // Reset store state between tests
    useStore.setState({
      sessions: [],
      activeSession: null,
      activeSessionDetail: null,
      terminalStatuses: {},
      snackbar: null,
      selectedNode: null,
      connected: false,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct initial state', () => {
    const state = useStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.activeSession).toBeNull()
    expect(state.activeSessionDetail).toBeNull()
    expect(state.terminalStatuses).toEqual({})
    expect(state.snackbar).toBeNull()
  })

  it('sets terminal status', () => {
    const { setTerminalStatus } = useStore.getState()
    setTerminalStatus('term-1', 'idle')
    expect(useStore.getState().terminalStatuses['term-1']).toBe('IDLE')
  })

  it('sets multiple terminal statuses independently', () => {
    const { setTerminalStatus } = useStore.getState()
    setTerminalStatus('term-1', 'idle')
    setTerminalStatus('term-2', 'processing')
    const statuses = useStore.getState().terminalStatuses
    expect(statuses['term-1']).toBe('IDLE')
    expect(statuses['term-2']).toBe('PROCESSING')
  })

  it('shows and clears snackbar', () => {
    const { showSnackbar } = useStore.getState()
    showSnackbar({ type: 'success', message: 'Test message' })
    expect(useStore.getState().snackbar).toEqual({ type: 'success', message: 'Test message' })

    useStore.setState({ snackbar: null })
    expect(useStore.getState().snackbar).toBeNull()
  })

  it('shows error snackbar', () => {
    const { showSnackbar } = useStore.getState()
    showSnackbar({ type: 'error', message: 'Something failed' })
    expect(useStore.getState().snackbar).toEqual({ type: 'error', message: 'Something failed' })
  })

  it('does not resurrect a deleted session from an older in-flight poll', async () => {
    const zombie: Session = { id: 'tgt-race', name: 'tgt-race', status: 'detached' }
    let resolveStale!: (sessions: Session[]) => void
    const staleResponse = new Promise<Session[]>(resolve => { resolveStale = resolve })
    vi.spyOn(api, 'listSessions')
      .mockImplementationOnce(() => staleResponse)
      .mockResolvedValueOnce([])
    vi.spyOn(api, 'deleteSession').mockResolvedValue({ success: true, deleted: [zombie.name], errors: [] })
    useStore.setState({ selectedNode: 'secure-02', sessions: [zombie], connected: true })

    const stalePoll = useStore.getState().fetchSessions()
    const deletion = useStore.getState().deleteSession(zombie.name)
    expect(useStore.getState().sessions).toEqual([])

    await deletion
    resolveStale([zombie])
    await stalePoll

    expect(useStore.getState().sessions).toEqual([])
  })

  it('restores the authoritative list when deletion fails', async () => {
    const session: Session = { id: 'tgt-failed-delete', name: 'tgt-failed-delete', status: 'detached' }
    vi.spyOn(api, 'deleteSession').mockRejectedValue(new Error('node unavailable'))
    vi.spyOn(api, 'listSessions').mockRejectedValue(new Error('still unavailable'))
    useStore.setState({ selectedNode: 'secure-02', sessions: [session], connected: true })

    await useStore.getState().deleteSession(session.name)

    expect(useStore.getState().sessions).toEqual([session])
    expect(useStore.getState().snackbar).toEqual({ type: 'error', message: 'node unavailable' })
  })
})
