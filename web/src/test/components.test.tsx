import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../components/StatusBadge'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ConfirmModal } from '../components/ConfirmModal'
import { FALLBACK_PROVIDERS } from '../components/AgentPanel'
import { mergeFleetSessions, sessionsFromCachedFleet, sessionsFromFleet } from '../components/DashboardHome'
import { isMouseTrackingModeSequence } from '../components/TerminalView'

describe('terminal text selection', () => {
  it('blocks provider mouse-tracking modes that disable xterm selection', () => {
    expect(isMouseTrackingModeSequence([1000])).toBe(true)
    expect(isMouseTrackingModeSequence([1002, 1006])).toBe(true)
  })

  it('does not consume unrelated or mixed private terminal modes', () => {
    expect(isMouseTrackingModeSequence([25])).toBe(false)
    expect(isMouseTrackingModeSequence([25, 1000])).toBe(false)
  })
})

describe('StatusBadge', () => {
  it('renders idle status', () => {
    render(<StatusBadge status="idle" />)
    expect(screen.getByText('Idle')).toBeInTheDocument()
  })

  it('renders processing status', () => {
    render(<StatusBadge status="processing" />)
    expect(screen.getByText('Processing')).toBeInTheDocument()
  })

  it('renders completed status', () => {
    render(<StatusBadge status="completed" />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('renders error status', () => {
    render(<StatusBadge status="error" />)
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('renders waiting_user_answer status', () => {
    render(<StatusBadge status="waiting_user_answer" />)
    expect(screen.getByText('Awaiting Input')).toBeInTheDocument()
  })

  it('renders null status as unknown', () => {
    render(<StatusBadge status={null} />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })
})

describe('ErrorBoundary', () => {
  // Suppress console.error for intentional error throws
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  afterAll(() => consoleSpy.mockRestore())

  function ThrowingComponent(): JSX.Element {
    throw new Error('Test error')
  }

  it('catches errors and shows fallback', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    )
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
  })

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })
})

describe('ConfirmModal', () => {
  it('renders when open', () => {
    render(
      <ConfirmModal
        open={true}
        title="Delete Item"
        message="Are you sure?"
        details={[]}
        confirmLabel="Delete"
        variant="danger"
        loading={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText('Delete Item')).toBeInTheDocument()
    expect(screen.getByText('Are you sure?')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(
      <ConfirmModal
        open={false}
        title="Delete Item"
        message="Are you sure?"
        details={[]}
        confirmLabel="Delete"
        variant="danger"
        loading={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.queryByText('Delete Item')).not.toBeInTheDocument()
  })

  it('shows details when provided', () => {
    render(
      <ConfirmModal
        open={true}
        title="Confirm"
        message="Check details"
        details={[{ label: 'Name', value: 'test-flow' }, { label: 'Schedule', value: '0 9 * * *' }]}
        confirmLabel="OK"
        variant="danger"
        loading={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('test-flow')).toBeInTheDocument()
    expect(screen.getByText('Schedule')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    render(
      <ConfirmModal
        open={true}
        title="Deleting"
        message="Please wait"
        details={[]}
        confirmLabel="Delete"
        variant="danger"
        loading={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    const button = screen.getByText('Closing...').closest('button')
    expect(button).toBeDisabled()
  })
})

describe('FALLBACK_PROVIDERS', () => {
  it('contains only the fleet MVP providers', () => {
    expect(FALLBACK_PROVIDERS).toEqual(['cursor_cli', 'claude_code', 'codex'])
  })

  it('maps to enabled select options with default underscore label', () => {
    // Simulates the fallback option construction used in AgentPanel
    const options = FALLBACK_PROVIDERS.map(n => ({
      value: n,
      label: n.replace(/_/g, ' '),
      disabled: false,
    }))
    const cursorOption = options.find(o => o.value === 'cursor_cli')
    expect(cursorOption).toBeDefined()
    expect(cursorOption!.label).toBe('cursor cli')
    expect(cursorOption!.disabled).toBe(false)
  })

  it('provides the supported options on an empty provider response', () => {
    // Simulates: when providers.length === 0, fallback is used
    const noProviders: any[] = []
    const effective = noProviders.length > 0 ? noProviders : FALLBACK_PROVIDERS.map(n => ({ name: n, binary: '', installed: true }))
    const names = effective.map(p => p.name)
    expect(names).toEqual(['cursor_cli', 'claude_code', 'codex'])
  })
})

describe('fleet dashboard aggregation', () => {
  it('includes terminals from reachable nodes and preserves their node', () => {
    const sessions = sessionsFromFleet([
      {
        name: 'secure-02',
        status: 'reachable',
        detail: null,
        sessions: [{
          id: 'cao-1',
          name: 'cao-1',
          status: 'detached',
          terminals: [{
            id: 'agent-1',
            tmux_session: 'cao-1',
            tmux_window: 'developer',
            provider: 'claude_code',
            agent_profile: 'developer',
            created_at: null,
            last_active: null,
            status: 'completed',
          }],
        }],
      },
      { name: 'secure-03', status: 'unreachable', detail: 'offline', sessions: [] },
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0].node).toBe('secure-02')
    expect(sessions[0].terminals).toHaveLength(1)
    expect(sessions[0].terminals[0].status).toBe('completed')
  })

  it('preserves the last successful snapshot when a node is temporarily unreachable', () => {
    const previous = new Map([['secure-02', [{
      name: 'cao-1',
      status: 'detached',
      node: 'secure-02',
      terminals: [{ id: 'agent-1' } as any],
    }]]])

    const merged = mergeFleetSessions(previous, [
      { name: 'secure-02', status: 'unreachable', detail: 'SSH timeout', sessions: [] },
    ])

    expect(merged.get('secure-02')).toEqual(previous.get('secure-02'))
  })

  it('removes stale sessions after a reachable node reports an empty list', () => {
    const previous = new Map([['secure-02', [{
      name: 'cao-1', status: 'detached', node: 'secure-02', terminals: [],
    }]]])

    const merged = mergeFleetSessions(previous, [
      { name: 'secure-02', status: 'reachable', detail: null, sessions: [] },
    ])

    expect(merged.get('secure-02')).toEqual([])
  })

  it('keeps cached sessions visible and labels stale nodes', () => {
    const sessions = sessionsFromCachedFleet([{
      name: 'secure-02',
      status: 'stale',
      sessions: [{ id: 'cao-1', name: 'cao-1', status: 'detached', terminals: [] }],
      sequence: 5,
      last_seen: '2026-08-10T00:00:00Z',
      detail: 'reconnecting',
    }])

    expect(sessions).toHaveLength(1)
    expect(sessions[0].nodeStatus).toBe('stale')
  })
})
