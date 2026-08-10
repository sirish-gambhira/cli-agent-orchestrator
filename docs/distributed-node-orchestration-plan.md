# Remote Node Fleet MVP Plan

Status: Reliable fleet-state transport implementation in progress on `feature/remote-node-fleet-mvp`
Created: 2026-08-10
Scope: One laptop-hosted UI controlling independent CAO deployments on explicit SSH hosts

## 1. Goal

Extend CLI Agent Orchestrator (CAO) with a laptop-hosted fleet view that can:

- discover configured SSH hosts;
- show agents and tasks from all connected hosts in one Web UI;
- create a task on an explicitly selected host;
- browse and select the agent's directory on that host;
- optionally create an isolated Git worktree there;
- launch Cursor, Claude, Codex, or another existing CAO provider;
- display and control the live remote terminal;
- notify the operator when an agent needs input;
- rediscover surviving remote sessions after the laptop reconnects or restarts.

The laptop orchestrator always chooses the host. CAO does not schedule a task,
recommend another host, or silently move a task.

## 2. MVP Architecture

Reuse the existing `cao-server` as the runtime on every execution node.

```text
Browser
  |
  v
Laptop CAO fleet controller and Web UI
  |
  +-- SSH tunnel --> cao-server on jbom-02 --> tmux agents + worktrees
  |
  +-- SSH tunnel --> cao-server on jbom-03 --> tmux agents + worktrees
  |
  +-- SSH tunnel --> cao-server on secure-* --> tmux agents + worktrees
```

The laptop controller is an aggregator and proxy. It does not replace the
node-local CAO server, terminal backend, provider adapters, or worktree service.

Fleet state uses a persistent WebSocket per explicitly managed node over its
long-lived SSH tunnel. Node streams send a full authoritative snapshot on
connect and whenever state changes, plus sequenced heartbeats. The controller
atomically persists the last successful snapshot and presents it as `live`,
`stale`, or `offline`; a transport failure never means an agent was deleted.
Periodic full snapshots provide reconciliation after dropped messages, node
server restarts, or laptop controller restarts.

Each node owns:

- its agent processes and provider credentials;
- its tmux sessions;
- its repositories and worktrees;
- its CAO terminal/session database and logs.

The laptop owns:

- the SSH host inventory;
- connections/tunnels to node CAO servers;
- the combined fleet view;
- task submission routing to the explicitly selected node;
- operator notification state and recent-directory preferences.

This architecture preserves CAO's current local behavior and minimizes changes
to its provider and terminal code.

## 3. Explicit Non-Goals for the MVP

The MVP does not include:

- automatic node selection or scheduling;
- a supervisor on one node delegating workers to another node;
- cross-node `handoff`, `assign`, or agent inbox routing;
- a new custom node daemon;
- a custom mTLS node protocol;
- Kubernetes or cloud-instance provisioning;
- automatic movement of a running agent between nodes;
- multi-controller high availability;
- automatic provider credential distribution;
- automatic repository cloning from a central catalog;
- guaranteed notifications while the laptop is asleep.

An agent supervisor and its delegated workers remain on the same selected node.
The laptop orchestrator can independently submit separate tasks to other nodes.

## 4. Host Inventory and Connectivity

### 4.1 Source of truth

Read concrete host aliases from the operator's OpenSSH configuration. Preserve
the alias and let the system `ssh` client resolve hostname, user, port, identity,
jump-host, and host-key behavior.

Do not copy private keys or authentication secrets into CAO configuration.
Never disable host-key verification to make a host appear reachable.

An SSH pattern supplies configuration defaults but does not enumerate hosts.
Only concrete aliases appear in the fleet list.

### 4.2 Discovered aliases

The SSH configuration inspected on 2026-08-10 explicitly defines:

- `jbom-02`, `jbom-03`;
- `5c-01`, `5c-02`, `5c-03`;
- `h200-01`, `h200-02`;
- `secure-hn`, `secure-01` through `secure-32`;
- `b200-hn`.

### 4.3 Initial reachability snapshot

A non-interactive five-second SSH probe with strict host-key verification found:

- reachable: `jbom-02`, `jbom-03`, `5c-01`, `secure-hn`, `secure-02`,
  `secure-03`, `secure-04`, `secure-05`, `secure-06`, `secure-08`, `secure-09`,
  `secure-14`, `secure-16`, `secure-19`, `secure-22`, `secure-25`, `secure-30`,
  `secure-32`;
- DNS resolved but host key not yet trusted: `secure-07`, `secure-10`,
  `secure-11`, `secure-12`, `secure-13`, `secure-17`, `secure-18`, `secure-20`,
  `secure-21`, `secure-23`, `secure-24`, `secure-26`, `secure-27`, `secure-29`,
  `secure-31`;
- connection closed remotely: `5c-02`, `h200-01`, `h200-02`, `secure-15`;
- timed out: `secure-01`, `secure-28`;
- DNS resolution failed: `5c-03`, `b200-hn`.

This is a transient observation, not a permanent allow/deny list. The UI shows
the current reason and supports rechecking a host.

### 4.4 Provider assumption

Assume Claude and Codex are available on all nodes. Validate the selected
provider at launch and return a clear error if its binary or login is not ready.
Never redirect the task to another node.

## 5. Fleet Web UI

The laptop controller serves one standard Web UI for the fleet.

### 5.1 Fleet dashboard

Show all known remote sessions and agents with:

- task/session name;
- host;
- provider and profile;
- working directory or worktree path;
- status;
- attention-required indicator;
- last activity;
- actions for open terminal, send input, stop, and refresh.

Support filters for host, provider, status, and attention-required state. A host
summary shows reachable, unavailable, and unchecked counts.

### 5.2 New Task form

The form contains:

1. Host selector.
2. Agent Directory field with a **Browse** button.
3. **Create isolated worktree** toggle.
4. Provider selector.
5. Agent profile selector.
6. Base revision and branch fields when worktree mode is enabled.
7. Task prompt.
8. Create/Cancel actions.

Changing the host clears all selected remote paths and reloads provider/profile
availability from the newly selected node.

The form validates the chosen host, directory, provider, and worktree request
before launch. Errors stay attached to their fields and do not trigger fallback
placement.

### 5.3 Standard remote directory picker

Browse opens a modal folder picker for the selected host. It provides:

- host name and connection status;
- breadcrumb navigation with clickable segments;
- parent-directory, home, refresh, and recent-directory actions;
- a scrollable list of child directories;
- optional hidden-directory visibility;
- manual absolute-path entry;
- **Cancel** and **Select Folder** actions;
- loading, permission-denied, disconnected, and missing-path states.

Directory rows may show bounded metadata such as:

- Git repository indicator;
- current branch;
- existing managed-worktree indicator.

Browsing is lazy and read-only. It lists one level at a time and does not read
file contents or build a full remote filesystem index. The node canonicalizes
the selected path and applies CAO's existing safe-path validation.

For a direct task, the selected folder becomes `working_directory`.

For worktree mode:

- the selected folder becomes `repository_path`;
- the UI shows a second picker/path field for `worktree_path`;
- the UI may suggest a unique destination;
- the operator/laptop orchestrator confirms the exact path before launch.

Immediately before creating the task, revalidate the path on the selected host
to reduce time-of-check/time-of-use errors.

## 6. Task Request and Lifecycle

### 6.1 Direct-directory task

```json
{
  "node_id": "jbom-02",
  "working_directory": "/data/projects/example",
  "provider": "cursor_cli",
  "profile": "developer",
  "prompt": "Fix the authentication race and add a regression test"
}
```

### 6.2 Worktree task

```json
{
  "node_id": "jbom-03",
  "repository_path": "/mnt/projects/example",
  "worktree_path": "/mnt/cao-worktrees/auth-race",
  "base_revision": "origin/main",
  "branch": "cao/auth-race",
  "provider": "codex",
  "profile": "developer",
  "prompt": "Fix the authentication race and add a regression test"
}
```

The laptop routes the request to that node's existing CAO API through its SSH
tunnel. The node creates the local session/terminal and launches the provider.

The laptop records only enough routing metadata to rediscover the task:

```text
node_id
remote_session_name
remote_terminal_id
working_directory or worktree_path
created_at
last_seen_status
```

The node remains authoritative for terminal and session state.

### 6.3 Lifecycle

1. Validate SSH/node API connectivity.
2. Validate the remote path and provider.
3. Create or select the worktree when requested.
4. Create the node-local CAO session and terminal.
5. Launch the provider in the selected directory.
6. Stream status and terminal output to the laptop UI.
7. Accept operator input through the terminal proxy.
8. Preserve results before worktree cleanup.
9. Rediscover the session after tunnel/controller reconnection.

## 7. Worktree Behavior

Use CAO's existing node-local worktree service rather than implementing Git
operations on the laptop.

For each writing task:

1. Validate that `repository_path` is inside a Git repository.
2. Validate and canonicalize `worktree_path`.
3. Create the requested branch from `base_revision`.
4. Create the worktree at the explicitly confirmed path.
5. Start the agent inside that worktree.
6. Show branch, dirty state, and commits in the fleet UI.
7. Require a recorded outcome before cleanup: pushed, merged, exported patch,
   or explicitly discarded.
8. Refuse ordinary cleanup when uncommitted or unpreserved work remains.

Writing tasks do not share worktrees.

## 8. Terminal Access

The browser connects only to the laptop controller:

```text
Browser WebSocket
  <-> laptop controller
  <-> SSH tunnel
  <-> node cao-server PTY WebSocket
  <-> node-local tmux terminal
```

The controller proxies terminal output, input, resize, and special keys. The
browser does not require direct network access to execution nodes.

Closing the browser or losing the laptop connection does not terminate the
node-local tmux session or agent.

## 9. Attention-Required Notifications

CAO already models `WAITING_USER_ANSWER`. The laptop fleet controller watches
status from every connected node and creates an attention event when a terminal
enters that state.

Examples include:

- an agent question;
- command or permission approval;
- workspace trust;
- plan/diff approval;
- an interactive provider prompt.

The MVP notification contains:

- task/session name;
- host;
- provider;
- bounded, redacted prompt preview when available;
- action to open the terminal.

MVP surfaces:

- persistent attention badge and queue in the fleet Web UI;
- laptop desktop notification where supported.

Notifications are edge-triggered and deduplicated for one waiting episode. They
clear when acknowledged or when the terminal leaves the waiting state.

If the laptop sleeps, remote agents continue running, but laptop notifications
cannot arrive until it reconnects. The UI shows unresolved attention events
after reconnection.

## 10. Connection and Recovery

Use the system OpenSSH client so existing host aliases, keys, and jump-host
configuration continue to work.

For each active or viewed node:

1. Establish or reuse an SSH control connection.
2. Start or discover its node-local `cao-server`.
3. Forward the node API to a controller-managed local endpoint.
4. Query its sessions and terminals.
5. Mark the node unavailable when the tunnel fails.
6. Reconnect with bounded backoff.
7. Re-query the node and match surviving sessions by node plus remote ID.

A lost tunnel is not proof that an agent stopped. The controller must not delete
remote sessions or worktrees during reconnection.

Set `CAO_FLEET_NODES` on the laptop controller to the explicit comma-separated
managed inventory (for example `jbom-03,secure-02`). Normal dashboard reads use
the durable controller cache and never scan every alias in SSH config.

## 11. Security Boundaries

- Preserve normal OpenSSH host-key verification.
- Do not read or copy private-key contents.
- Keep provider credentials on each node.
- Bind node `cao-server` to loopback and reach it through SSH forwarding.
- Authenticate and authorize the laptop-facing fleet UI.
- Validate and canonicalize every remote path.
- Use CAO's existing blocked-system-path rules.
- Do not read remote file contents for directory browsing.
- Redact secrets and personal identity from logs and notifications.
- Treat repository content, agent output, and prompt previews as untrusted.
- Require explicit confirmation before destructive worktree cleanup.

## 12. Implementation Plan

### Running the current implementation

The controller expects a CAO server on loopback port `9889` on each execution
node. Start or otherwise supervise it on every node you want to use:

```bash
ssh jbom-02 'cao-server'
ssh jbom-03 'cao-server'
```

Then build and start this branch on the laptop:

```bash
cd ~/Documents/cli-agent-orchestrator/web
npm ci
npm run build
cd ..
CAO_API_PORT=9890 uv run cao-server
```

Open `http://127.0.0.1:9890`, choose **Agents**, and select an execution node.
The laptop controller opens loopback-only SSH forwards lazily. **Refresh all
nodes** provides the combined session/agent overview and starts polling the
reachable subset for attention status. **Spawn Agent** provides host, provider,
profile, task prompt, remote folder picker, and optional worktree controls.

Remote folder browsing requires `python3` on the execution node. Remote agent
launches also require the selected CAO provider and its credentials there. The
controller never copies credentials and never starts a task on a fallback node.
Direct tasks work against the existing node API; the new-session worktree toggle
requires this branch's CAO version to be installed on that execution node too.

Readiness check on 2026-08-10: `jbom-02` and `jbom-03` have `python3` and
Codex on `PATH`, but neither exposed Claude on `PATH`. The obsolete global Loom
forward on laptop port `8766` was removed from the operator's SSH config.
This branch is deployed at `~/cli-agent-orchestrator-fleet` on `jbom-03`, where
`cao-server` runs in tmux session `fleet-node-server` on loopback port `9889`.
The laptop controller uses port `9890` because Cursor already owns laptop port
`9889`; the two services remain independent.
The node health endpoint, provider discovery through the laptop SSH tunnel, and
remote home-directory browsing have all passed end-to-end smoke tests.

### Phase 0: Verify the existing node runtime

- [x] Read concrete hosts from OpenSSH configuration.
- [x] Record an initial strict-host-key reachability snapshot.
- [x] Install and verify this CAO branch on `jbom-03`.
- [ ] Install or verify CAO on `jbom-02`.
- [ ] Verify Claude and Codex launch on those nodes.
- [ ] Verify node-local `cao-server`, tmux persistence, and worktree creation.
- [ ] Decide how the controller starts/reuses `cao-server` without conflicting
      with another instance on the same node.

Exit criterion: unmodified CAO works independently on two nodes.

### Phase 1: Fleet connections and combined dashboard

- [x] Add SSH-host discovery and host status models.
- [x] Add bounded reachability checks and manual refresh.
- [x] Establish controller-managed SSH API tunnels.
- [x] Query sessions and terminals from multiple node servers.
- [x] Add an on-demand combined fleet overview and explicit host selector.
- [x] Preserve existing single-host behavior when no remote node is selected.
- [ ] Add fleet-wide provider/status/attention filters.

Exit criterion: one laptop page shows independent CAO sessions from two nodes.

### Phase 2: Remote directory picker and New Task form

- [x] Add bounded, directory-only browse and validation API operations.
- [x] Add breadcrumbs, folder navigation, manual entry, hidden-folder toggle,
      home/refresh actions, and error states.
- [x] Clear paths when the selected host changes.
- [x] Add Git and managed-worktree metadata.
- [x] Add provider/profile discovery for the selected node.
- [x] Build and validate the New Task form.
- [ ] Persist recent-directory shortcuts.

Exit criterion: the operator selects a host and remote folder using a standard
picker and can submit a direct-directory task.

### Phase 3: Remote task and terminal control

- [x] Route task creation and its initial prompt to the selected node.
- [ ] Persist node plus remote session/terminal routing metadata.
- [x] Proxy the remote terminal WebSocket.
- [x] Support send input, special keys, resize, stop, and refresh.
- [x] Handle tunnel failure without killing the remote session.

Exit criterion: a laptop-created task runs on either explicitly selected node
and remains controllable through the fleet UI.

### Phase 4: Remote worktrees

- [x] Add worktree mode to the New Task form.
- [ ] Accept explicit repository, destination, base, and branch values.
- [x] Invoke the node-local CAO worktree service using its current generated
      `.cao/worktrees/<terminal-id>` path and `cao/<terminal-id>` branch.
- [ ] Display dirty state and commits.
- [ ] Protect preservation and cleanup flows.

Exit criterion: concurrent writing tasks use isolated worktrees and cannot lose
unpreserved changes through ordinary cleanup.

### Phase 5: Notifications and reconnect polish

- [x] Aggregate `WAITING_USER_ANSWER` across nodes included by fleet refresh.
- [x] Add attention text, in-app snackbar, and browser desktop notification.
- [x] Deduplicate one waiting episode.
- [x] Rediscover sessions after controller restart or tunnel reconnect.
- [x] Surface accumulated waiting agents after reconnect and refresh.
- [ ] Add a durable attention queue and explicit acknowledgement action.

Exit criterion: the operator is notified when any connected remote agent needs
input and can open its terminal directly.

## 13. MVP Test Matrix

### Host and connection tests

- reachable, timed-out, DNS-failed, connection-closed, and untrusted-host-key;
- existing SSH aliases and future jump-host configuration;
- tunnel disconnect and reconnect;
- laptop controller restart while agents remain in remote tmux.

### Directory-picker tests

- normal navigation and breadcrumbs;
- manual absolute path;
- hidden directories;
- permission denial and missing paths;
- symlink canonicalization and blocked-path escape;
- large directories and bounded responses;
- Git/worktree badges;
- changing hosts after selecting a directory;
- final path revalidation before launch.

### Task and terminal tests

- direct task on `jbom-02` and `jbom-03`;
- provider unavailable on the explicitly selected node;
- input, resize, special keys, and stop;
- browser disconnect without agent termination;
- session rediscovery after tunnel/controller restart.

### Worktree tests

- branch and worktree creation at selected paths;
- two concurrent writing tasks with separate worktrees;
- dirty/unpreserved cleanup refusal;
- preserved branch cleanup.

### Notification tests

- transition into and out of `WAITING_USER_ANSWER`;
- no duplicate notification while status is unchanged;
- direct open-terminal action;
- unresolved attention shown after reconnect.

## 14. Future Work

These are deliberately deferred until the MVP proves useful:

- cross-node `assign`, `handoff`, callbacks, and supervisor/worker routing;
- controller-owned global agent inbox;
- automatic node scheduling or capacity-based placement;
- a dedicated CAO node daemon or custom persistent node protocol;
- mTLS outside SSH tunnels;
- exactly-once input delivery (state delivery is sequenced and reconciled;
  mutations remain ordinary request/response operations);
- dynamic inventory from a CMDB, cloud provider, Slurm, or Kubernetes;
- automatic repository cloning and caching;
- Slack, Discord, Telegram, email, or server-side notifications while the
  laptop sleeps;
- cloud instance and Kubernetes pod provisioning;
- multi-controller high availability;
- live task migration between nodes;
- fleet-wide shared memory and analytics.

## 15. Remaining MVP Decisions

- [ ] Where should laptop fleet metadata be stored under CAO's home directory?
- [ ] Should the controller start `cao-server` remotely on demand, require it to
      be pre-running, or support both?
- [ ] What remote port-selection rule avoids conflicts between CAO instances?
- [ ] What default path should the UI suggest for new worktrees?
- [ ] Should desktop notifications use browser notifications, a macOS helper,
      or both?
- [ ] Will this remain a private fork initially or target an upstream PR?

## 16. Progress Log

| Date | Phase | Update |
|---|---|---|
| 2026-08-10 | Planning | Created the initial broad distributed-node plan. |
| 2026-08-10 | Discovery | Read 41 aliases from SSH config and recorded reachability. |
| 2026-08-10 | Scope | Made host and remote-path selection explicit. |
| 2026-08-10 | Scope | Added the fleet UI, standard folder picker, and waiting-input notifications. |
| 2026-08-10 | Scope | Trimmed the design to federating existing per-node CAO servers over SSH; deferred cross-node agent delegation. |
| 2026-08-10 | Implementation | Added SSH discovery, safe remote folder browsing, controller-owned tunnels, HTTP/WebSocket proxying, and fleet API tests. |
| 2026-08-10 | Implementation | Added explicit node selection, on-demand combined overview, remote task prompt, folder picker, worktree toggle, and waiting-input notifications to the Web UI. |
| 2026-08-10 | Deployment | Removed the obsolete global SSH forward, deployed the branch to `jbom-03`, and passed health, provider-tunnel, and remote-folder smoke tests. |

## 17. Definition of Done

The MVP is complete when the operator can use one laptop Web UI to:

1. see CAO agents and sessions across multiple configured SSH hosts;
2. explicitly select a host for every new task;
3. browse and select the remote agent directory with a standard folder picker;
4. choose an existing CAO provider/profile and submit a task;
5. optionally create and monitor an isolated remote worktree;
6. view and control the remote terminal;
7. receive and acknowledge a notification when any connected agent needs input;
8. disconnect or restart the laptop controller without terminating remote
   agents; and
9. reconnect and rediscover the surviving sessions.
