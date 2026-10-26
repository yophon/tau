# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

## [Unreleased]

### Removed (P62: the parked parts are archived)
- `tau gateway` and the packages `@yophon/tau-gateway`, `@yophon/tau-channel-weixin`,
  `@yophon/tau-channel-feishu` and `@yophon/tau-ext-feishu`, with the mini-program, React Native and
  Flutter demo apps, moved to `archive/2026-10-25/` (archive/README.md says how to get them back).
  `tau gateway` now says it was archived. `host-weapp` and `host-rn` stay; `smoke:weapp` bundles
  the kernel with host-weapp directly and `smoke:quickjs:mcp` uses a small MCP server in
  `test-fixtures/`. The secret guard still protects the files a gateway left under `~/.tau/gateway/`,
  and `tau audit` still reads the records it wrote.
- `session_search` no longer reads the gateway's sessions (`~/.tau/gateway/sessions`).
- The CLI's gateway-only switches (hooks as before P44, settings as before P40, chat approvals in the
  audit, a guest's memory) are gone; the terminal, editor and phone hosts behave as before.

### Changed (P62)
- `scripts/baseline.mjs` times startup, a `-p` turn, the resident server, long sessions and the test
  suite (docs/baseline.md); `scripts/wsl-copy.sh` keeps the WSL copy smoke-tui runs in from importing
  packages over `/mnt` (2.3 s → 0.3 s for `tau --version` there).

### Fixed (P62: found reviewing the resident server and adding tests)
- Two ways anyone who could reach the remote port could stop the resident server, before pairing:
  a WebSocket upgrade it refused (wrong path or `Origin`) whose client then reset the connection, and
  a frame that is valid JSON but not an object (`5`, `null`). Both now leave the server running; a
  message that is not a JSON-RPC object is dropped, on every transport.
- `turn/start`, `turn/steer` and `turn/followUp` with an `input` that is not text or text and image
  blocks answer `-32602`; such a turn used to fail where no request could report it, which ended the
  server and left the session's turn open.
- A remote device can no longer stop the resident server (`server/shutdown` is for this machine's
  clients, as pairing and devices are).
- Two clients opening the same saved session at the same moment (one resuming it, one moving to it
  from another session) get the one session; it used to open twice, two threads writing one file.
- A client that leaves a session right after joining it no longer gets the approvals that were
  waiting there.
- `tau serve stop` with a server of another version that cannot answer the protocol sends it SIGTERM
  and waits the grace period before killing it, instead of killing it at once.
- `tau mcp login` and other links opened on Windows are no longer cut at the first `&` (OAuth sign-in
  addresses were).
- A form dialog request without its `form` no longer breaks `--mode rpc` and the TUI (they show an
  empty form, as ACP did).
- On Windows, paths that differ only in case or in an 8.3 short name count as the same directory
  where tau compares them (worktrees, git paths, ACP sessions).

### Fixed (P61: three debts of daily use)
- On the resident server, whether `read` may send an image follows the session's own model (its
  models.json `input`) after a model switch, not the model the server started with.
- Extension markdown transformers apply while text streams (pi), and finished text drawn at a new
  width is transformed at that width. Sessions without transformers send no extra requests.
- Lines piped into `tau --repl` at once run one after another and the REPL exits when they are done
  (they used to be lost before the REPL listened); lines that arrive while a turn runs still steer it.
  The exit code is 1 when the last line's turn fails (an error or a cut-off reply; Ctrl+C is not a failure).
- A stopping resident server waits (up to a second) for its connections to close, so the last
  notifications it wrote (the final `turn/completed`) reach the clients before the process exits.

### Changed (P60: editors on the resident session)
- `tau --mode acp` is a client of tau's session hub: it uses the resident server as the TUI does
  (starting it when settings `daemon.autoStart` allow; `--no-daemon` runs in-process), so an editor
  such as Zed, the terminals and the phone share sessions. `session/list` shows the sessions held now
  (the terminal's) first, `session/load` joins and replays, `session/resume` joins, `session/close`
  leaves. Prompts, replies, tool calls and setting changes from other clients reach the editor; an
  approval goes to every client and is withdrawn from the editor (`$/cancel_request`) when another
  answers first; `session/cancel` stops the current turn, whoever sent it.
- ACP: Session Config Options for permission mode, model and reasoning effort (the session modes still
  work); extension dialogs and forms as `elicitation/create` forms when the editor supports them;
  `notice` and `compaction_update` when it declares them; the editor's MCP servers start for the
  session in the hub.
- ACP no longer reads and writes files through the editor (`fs/*`): tools use the disk, as the Codex
  and Claude adapters do; edits still reach the editor as diffs.
- `tau/1`: `thread/start` and `thread/resume` take `mcpServers` (stdio or http) from the machine's own
  clients; a remote device bringing them is refused.

### Fixed
- A session that stops no longer leaves its automatic title request running (a hub in the process
  closing kept the connection open).

### Added (P59: tau on a phone)
- `@yophon/tau-web`: a web client the resident server serves — pair once from a QR code, then the
  sessions the server holds (the terminal's among them) and recent ones; the conversation as it
  streams, approval cards and extension dialogs, send / steer / stop, photos, model and permission
  mode, new sessions; reconnects and catches up by itself; installable to the home screen.
- `tau serve remote on [--listen ws://HOST:PORT] | off` (settings `daemon.remote.listen`, port 7700),
  `tau serve pair` (one-time code, addresses, QR code), `tau serve devices`, `tau serve revoke`.
  Every WebSocket connection needs a paired device's token; no TLS of its own (use a tunnel such as
  Tailscale beyond the home network).
- `tau/1`: `initialize.auth`, `capabilities.stateEvents`, `thread/list.allDirectories`, `server/pair`,
  `server/devices`, `server/revoke`; `createWebSocketTransport` in `@yophon/tau-protocol`.
- The TUI reconnects to the resident server after a drop (a restart) and rejoins its session.
- Dependencies: `ws` 8.22.0, `qrcode-generator` 2.0.4 (CLI); `preact` 10.29.8 (bundled into the web client).

### Added (P58: the resident server)
- `tau serve start|stop|restart|status`: a tau in the background on a local socket (`~/.tau/daemon/serve.sock`
  in a user-only directory; a named pipe on Windows), after Codex's `app-server daemon` — start returns
  once the server answers, stop lets running turns finish (settings `daemon.shutdownGraceSeconds`, 60 s),
  each prints one JSON object. `tau serve --listen unix://[PATH]` runs it in the foreground.
- The TUI connects to the resident server and, when none runs, starts one first (settings
  `daemon.autoStart`, on by default; `--no-daemon` runs in-process). Two terminals share one session;
  closing a terminal leaves the session running; `/resume` lists what the server holds in every
  directory, with how many terminals are on each. Options that configure what the server fixed at its
  start (`--extension`, `--no-mcp`, `--tools`, `--base-url`, permission rules, `--worktree`, …) run
  in-process, with a line saying why.
- `tau/1`: `cwd` on `thread/start`, `thread/resume`, `thread/list` and the others (one server for
  every directory), `ephemeral` sessions, `model`/`permissionMode` when `thread/resume` opens a
  session, `thread/loaded/list` with `clients` and `waiting`, `server/shutdown`, `projectTrusted` and
  `workingDirectories` in the session state. See docs/protocol.md.
- Kernel: `Agent.setSessionName` (pi's `AgentSession.setSessionName`).

### Fixed (P58)
- In `tau serve`, a model switch in one session no longer moves the process's endpoint (another
  session's `/reload` would have picked it up); each client's later sessions start from what it switched to.
- The automatic session title could fork the session log when the next prompt arrived as it was
  written, ending that run with "Model context diverged from the session log" (seen on CI in
  `--mode rpc`); session names are written in turn with the agent's writes.
- Joining a running session that has no session file from `/resume` works.

### Changed (P57: the TUI and `--mode rpc` over tau's protocol)
- The TUI is a client of a session hub in its own process (as Codex's TUI is of its app-server):
  it no longer holds the agent, the extensions or the session file, and everything it does goes
  through `tau/1`. Behavior is unchanged; two TUIs can now be on one session (P58 makes the hub
  resident).
- `--mode rpc` is an adapter over the protocol; its commands and records are unchanged (docs/rpc.md).
- A reload the session does by itself after moving into or out of a worktree is reported in the TUI.

### Added (P57)
- `tau/1`: native data for full clients (kernel messages, events and the session state), pi's
  JSON-mode records for clients that ask, session control (model and reasoning with their hooks,
  permission mode, names, labels, tools, entries, queues, import, fork, delete, checkpoints, background
  tasks), jobs one at a time (compaction, moves in the tree, `!` commands, reload, handoff) with
  `thread/task/started|ended`, the extensions' side of the screen as data (renderers, widgets, status
  items, diagnostics, commands, shortcuts, completion, markdown transformers), forms, timeouts and
  sign-in pages in dialogs, moving between sessions with the extensions handed over, `thread/closed`.
  Light clients now get the prompt of a turn as a `userMessage` item. See docs/protocol.md.

### Added (P56: one session, many clients — the first step)
- `@yophon/tau-protocol`: tau's client protocol `tau/1` (after Codex's app-server protocol: threads,
  turns, items; approvals and dialogs as requests to the clients, `serverRequest/resolved`), a
  JSON-RPC 2.0 peer, an in-process transport pair, line framing, and a typed `TauClient`.
- CLI: `tau serve [--listen stdio]` — the session hub: several clients on one session, replay after a
  `seq`, approvals to every client with the first answer counting (waiting while nobody is
  connected), queued and steered turns, interrupt. See docs/protocol.md.

### Added (P55: apply_patch, loop detection, checkpoints)
- Kernel: `apply_patch`, Codex's patch format (ported from codex-rs/apply-patch, Apache-2.0; Codex's
  scenarios pass), provided by `createCodingTools` but not active by default (`--tools +apply_patch`).
  Permissions, Edit rules and accept-edits check every file the patch names. `parsePatch`,
  `applyPatch`, `patchTargets` and friends are exported.
- `@yophon/tau-ext-loop-detection`: Gemini CLI's check (the same call five times in a row, or a short
  cycle repeated five times) stops the run, after one reminder. CLI setting `loopDetection` (default
  false), `/loop-detection on|off|status`.
- `@yophon/tau-ext-checkpoint`: files kept before write, edit or apply_patch first change them in a
  prompt, behind a `CheckpointBackend` interface (file backups now). CLI setting `checkpoints`
  (default true), `~/.tau/checkpoints/<session>` cleaned after 30 days; the TUI's `/rewind` restores
  the code, the conversation, or both.
- CREDITS.md lists the third-party code tau ports.

### Added (P54: protocols, fallback, prompt shim)
- `@yophon/tau-ext-provider-openai-responses`: a pure-Platform OpenAI Responses transport
  (reasoning effort per thinking level, `store: false` with encrypted reasoning replayed on the
  same model, message ids kept for replay). models.json `api: "openai-responses"`,
  `--provider openai-responses`. Not yet tested against the real endpoint.
- `@yophon/tau-ext-provider-google`: a pure-Platform Gemini API transport (thought summaries,
  thought signatures replayed, thinking levels on Gemini 3 and budgets on 2.5). models.json
  `api: "google-generative-ai"`, `--provider google` with `GEMINI_API_KEY`. Not yet tested
  against the real endpoint.
- Model fallback: `AgentOptions.fallback` and the kernel's `createFallbackChain`; once retries
  are spent, a run nothing has answered yet moves to the next model. CLI `--fallback-model`
  (repeatable), settings `fallbackModels`, `fallback.on` (rate_limit, overloaded, network,
  auth, billing) and `fallback.enabled`.
- Prompt shim: `withPromptToolShim(transport)` for models without native tool calling; models.json
  `toolCalling: "prompt"`, `TAU_TOOL_SHIM=1` for an ad-hoc endpoint.
- Kernel: `TextContent.textSignature` and `ToolCall.thoughtSignature` (pi), dropped for another
  model; `shortHash` exported.

### Added (P53: from yo-agent)
- CLI: `-r`/`--resume` opens the session picker when the TUI starts (command-line prompts go to
  the session picked); other modes refuse it. `--session` takes a file path, or an id or name of
  this directory's sessions.
- `/tasks`: a running background subagent shows its latest activity (tool calls, the end of each
  reply); ext-subagents reports it on the `subagents:task` channel (`BackgroundTask.recent`).
- `/cwd`.
- Kernel `continueAfterLength`: a reply cut off by the output cap (no tool calls) is continued
  with a hidden `continue_after_length` custom message; the CLI turns it on (`continueOnMaxTokens`,
  default true, 3 in a row). The kernel default stays 0 (pi).
- Kernel `summaryModel`: compaction, turn prefixes and branch summaries on another transport and
  model; the CLI reads `compaction.model` (a models.json model).
- Permission mode `ci`: what accept-edits allows runs, what would ask is denied without asking
  (yo-agent's ci, Claude Code's `dontAsk`, accepted in `defaultMode`).

### Changed (P53)
- Kernel: the pending message queue moved to `pending-queue.ts` (`QueueMode` still exported).

### Fixed (P53)
- The tui-p38 `/resume` rename test raced: it waited for text the rename prompt already showed.

### Added (P49: Claude Code)
- ext-subagents: agent frontmatter `effort`, `autoCompactWindow`,
  `disallowedTools`, `maxTurns`, `background` (`AgentDefinition.warnings`
  lists ignored values, `AGENT_EFFORTS`, `AUTO_COMPACT_WINDOW_RANGE`); the
  subagent tool's `effort` parameter; resumed runs keep their effort.
- kernel: `AgentSpawnOptions.contextWindow` (a narrower window for a child);
  `read` takes `allow_large` (up to the room left in the context, 256 KB
  when the window is unknown); `getContextUsage()` carries `reserveTokens`.
- CLI hooks: exec form (`args`), `shell: "powershell"` (and PowerShell on
  Windows without Git Bash), `onFailure: "block"`, `type: "http"` hooks with
  `headers` and `allowedEnvVars`. host-node: `NodeShell.exec({ argv })`,
  `bashAvailable()`.
- CLI: the TUI and REPL report their state over OSC 7501 (with `tui.title`);
  `TAU_DISABLE_FILE_MENTIONS=1` sends `@file` arguments as paths.

### Changed (P49)
- CLI TUI: Ctrl+C keeps the cleared draft aside instead of adding it to the
  history; ↑ in the empty input brings it back first.

### Changed (P48: pi 1.3 / 1.4)
- Reference re-pinned to pi v1.4.0 (D51). The extension surface is the same
  91 members; the ported MCP and OAuth code did not change in pi.
- kernel: summary requests (compaction, split-turn prefix, branch summaries)
  use the model's output limit when the host knows it
  (`OpenAICompatConfig.maxOutputTokens`, `SetModelOptions.maxOutputTokens`);
  unknown keeps the `reserveTokens` shares. `runCompaction` takes it as a
  6th argument, `generateBranchSummary` as `maxTokens`. CLI: models.json
  `maxTokens`, else on Anthropic the turns' default.
- kernel: thinking of another model is dropped instead of replayed as text
  (also in ext-provider-anthropic).
- kernel: the retry table follows pi 1.4 (status codes only as codes, gateway
  and transport failures); HTTP 413 counts as a context overflow.
- ext-provider-anthropic: thinking level `none` sends
  `thinking: {type: "disabled"}` on Claude Opus 5 and Haiku 5.5
  (`acceptsDisabledThinking`); `anthropicThinkingForLevel` takes the model.
- ext-codemode: `@earendil-works/pi-codemode` 1.4.0. Node workers are capped
  across sessions (2, `TAU_CODEMODE_MAX_WORKERS`); scripts wait up to 60 s for
  one (`CodemodeSandboxFactory.reserve`, `CodemodeSlot`,
  `CODEMODE_WORKER_WAIT_MS`).

### Added (P48)
- kernel: `ToolCall.argumentsError` and `parseToolCallArguments`: arguments
  that are not a JSON object fail before hooks and approval, with the text
  the model sent. `applyToolModifiers`.
- kernel: `Agent.setDefaultTools(names, modifiers)`: a resumed session's tools
  win over the host's default selection, with `+name`/`-name` applied to
  them; extension tools the session never added or removed are active.
- ext-mcp: `signInMcpServer` takes the server's `challenge` or probes it
  (`probeOAuthChallenge`); a 403 `insufficient_scope` reaches the auth
  provider like a 401 and the scope it asks for is added at the next sign-in
  (`McpOAuthState.requiredScope`); `McpOAuthAuthorizationRequiredError.challenge`.
  The official 2026-07-28 conformance suite passes all 32 scored client
  scenarios.
- host-node: `locatePowerShell`, `shellPathExists`.
- `scripts/smoke-tui-wsl.sh`: smoke-tui in WSL's own filesystem.

### Fixed (P48)
- kernel: `\u` not followed by four hex digits (`\usepackage`) lost the field.
- kernel: whitespace-only tool output went out as is; some endpoints reject it.
- kernel: reasoning and content in one delta put the thinking after the text.
- kernel: `/compact` instructions did not reach a split turn's prefix summary.
- ext-provider-anthropic: images in an error tool result were rejected; they
  now follow the turn's tool results with a caption.
- CLI: resuming with `--tools +name` (or `defaultTools` in settings) dropped
  the tools the session had enabled.
- CLI TUI: a second picker or prompt replaced the first, whose promise never
  settled; dialogs now stack.
- ext-resources: prompt templates dropped empty quoted arguments.
- host-node: PowerShell outside PATH and Microsoft Store aliases were not found.
- CLI TUI: `read` line ranges given as numeric strings were not shown.
- CLI: `--mode rpc` hung, then exited, when the project trust question came up
  at startup: stdin was only read once the loop ran.

### Added (P47)
- ext-mcp-http, ext-mcp: MCP 2026-07-28 next to the initialize handshake.
  `protocolNegotiation: "auto"` (the official SDK's versionNegotiation; the
  default stays `"legacy"`) sends `server/discover` first and falls back to
  `initialize` on anything that is not modern evidence; on stdio a silent
  server is legacy and one that exits on the probe is started again
  (`McpProbeExitedError`); the era is remembered per server for the run.
  Modern requests carry the `_meta` envelope; over HTTP they add
  `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (Base64 sentinel) and the
  `Mcp-Param-*` headers of `x-mcp-header` parameters, have no session, are
  cancelled by closing their stream and are reissued once when the stream
  breaks. `input_required` results are answered through the elicitation and
  roots handlers and retried with `inputResponses` and the `requestState`
  (10 rounds at most). `McpClient.listen()` opens `subscriptions/listen`;
  servers keep one open for list changes and reopen it when it drops. Tools
  with invalid `x-mcp-header` marks are left out and reported; `-32020`
  re-lists the tools before one retry. `MCP_ERROR_CODES`, `MCP_META` and the
  header helpers are exported.
- ext-mcp OAuth: client credentials are keyed by the authorization server
  that issued them (SEP-2352); a different one drops the client and its
  tokens and registers again, and a 401 challenge or a sign-in discovers the
  authorization server again.
- CLI: sessions, ACP and `tau mcp list --check` ask MCP servers for
  2026-07-28 first (Claude Code); `TAU_MCP_PROTOCOL_NEGOTIATION=legacy`
  keeps the handshake. `/mcp` and `tau mcp list --check` show the protocol
  version. The gateway keeps the handshake.

### Fixed (P47)
- ext-mcp-http: an SSE reply's reader cancel could reject unhandled once the
  request was aborted, ending `tau -p` with an unhandled rejection.
- ext-mcp-http: the first prompt's wait for connecting MCP servers left its
  10 s timer running, so `tau -p` with MCP servers stayed up to 10 s after
  finishing.

### Added (P46)
- ext-subagents: every subagent (foreground, background, each parallel or
  chain step) gets an agent ID `sub-N`, written at the end of its result,
  and an optional `name`. The `send_message {to, message, summary?}` tool
  (Claude Code's SendMessage) resumes a finished subagent in the background
  with its whole history, steers one running in the background, and refuses
  one you stopped in `/tasks`. Subagents are saved next to the session
  (`<session>/subagents/<id>.jsonl` and `.meta.json`) and can be continued
  after `--resume`. `isolation: "worktree"` (a step, or agent frontmatter)
  runs a subagent in a git worktree of its own through the host's
  `isolate(agentId, kept?)`: removed when it changed nothing, kept and
  named in the result otherwise, reopened when the subagent is resumed.
  `SUBAGENT_STOP_CHANNEL` lets the host stop one by ID or name.
- CLI: `enter_worktree {name?, path?}` and `exit_worktree {action,
  discard_changes?}` (Claude Code's EnterWorktree / ExitWorktree) move the
  session into a new or listed git worktree and back mid-conversation: file
  tools, shells, background commands, permissions, hooks and language servers
  at once; settings, AGENTS.md and extensions when the TUI's turn ends. A
  resumed session goes back to its worktree. `task_stop` also stops a
  background subagent by ID or name. `push_notification {message, status}`
  (Claude Code's PushNotification) sends a desktop notification from the TUI
  or REPL, unless you are at the terminal (focused, or a key in the last
  60 s; `TAU_DISABLE_NOTIFICATION_PRESENCE_CHECK=1` skips the check) or
  `tui.notify` is off.
- ext-mcp-http, ext-mcp: `wait_for_mcp_servers {servers?, timeout_seconds?}`
  waits for servers still connecting in the background (default 60 s, at
  most 300 s); registered while a server with directly exposed tools is
  connecting.
- kernel: `AgentSpawnOptions.onSpawn(handle)` (`steer`, `messages`),
  `capabilities` and `toolOverrides`, for a child with its own file system
  and tools. host-node: `moveTo(cwd)` on `NodeFileSystem`, `NodeShell` and
  `NodeBackgroundShell`.

### Changed (P46)
- kernel: the tool batch reads the working directory from the current file
  system, so accept-edits follows a session that moved.

### Fixed (P46)
- CLI REPL: the input ending at a prompt (Ctrl+D, Ctrl+C when idle, a closed
  pipe) quits cleanly instead of exiting with code 13 and an unsettled
  top-level await warning.

### Added (P45)
- New package `@yophon/tau-ext-lsp`: language servers per Claude Code's code
  intelligence. Servers come from Claude Code's `.lsp.json` format (strict,
  all or nothing per file); edits and writes reach the file's server, and
  the errors and warnings it reports since the edit go to the model as one
  `lsp_diagnostics` message at the end of the turn (waiting up to 5 s for a
  fresh publish, as opencode does) or with the next prompt; the read-only
  `lsp` tool (Claude Code's definition: goToDefinition, findReferences,
  hover, documentSymbol, workspaceSymbol, goToImplementation,
  prepareCallHierarchy, incomingCalls, outgoingCalls) exists while a server
  is configured; `/lsp` lists servers and their state. The entry is pure ES;
  `./node` starts servers (`.cmd` shims on Windows, PATH lookup that skips
  the working directory, tree kill).
- CLI: `~/.tau/lsp.json` and a trusted project's `.tau/lsp.json`, expanded
  like `mcp.json`; the TUI shows "Found N new diagnostic issues in M files"
  (Ctrl+O or a click opens it) and offers an installed but unconfigured
  server from Claude Code's twelve official language plugins once per session
  (Claude Code's recommendation dialog).
- kernel: `UiCapability.select` takes pi's dialog options (`signal`,
  `timeout`); the TUI closes the picker.

### Changed (P45)
- kernel: custom messages appended at boundaries (`turn_end`,
  `agent_before_settle`) are announced as `user_message` events. `Read(...)`
  permission rules apply to the `lsp` tool, and `filePath` counts as a path
  argument.

### Added (P44)
- ext-mcp-http, ext-mcp: MCP prompts become `/mcp__<server>__<prompt>`
  commands (Claude Code), re-listed on `prompts/list_changed`; `@server:uri`
  mentions are completed next to files and read and attached when a message is
  sent; elicitation (MCP 2025-11-25) in form and URL mode through the host's
  `elicit` handler (`elicitWithUi` is the dialog flow), including
  `notifications/elicitation/complete` and URLElicitationRequiredError; tool
  calls report progress through `onUpdate` and send `notifications/cancelled`
  when aborted. McpClient: `capabilities`, `setRequestHandler`,
  `onProgress`, `listPrompts`, `getPrompt`.
- kernel: `UiCapability.form` and `askFormStepByStep` (forms with validation);
  `UiCapability.addAutocompleteProvider` (pi); events `command_prompt`,
  `subagent_start`, `subagent_stop`; command results may carry images
  (`commandPromptContent`); `RegisteredCommand.source`.
- CLI: session-scoped scheduled tasks per Claude Code — tools `cron_create`,
  `cron_list`, `cron_delete`, `/loop` on an interval or self-paced with
  `schedule_wakeup`, `loop.md`, kept in the session for `--resume`,
  `TAU_DISABLE_CRON=1`; the `monitor` tool streams a background command's
  stdout lines to the model; `/tasks` lists both. Hook events
  `PostToolUseFailure`, `PostToolBatch`, `UserPromptExpansion`,
  `SubagentStart`, `SubagentStop`, `StopFailure`, `PostCompact`,
  `PreModelSwitch`, `PostModelSwitch`, `DirectoryAdded`,
  `InstructionsLoaded`, `Elicitation`, `ElicitationResult`; the TUI form
  dialog. host-node: `NodeBackgroundShell.start` option `onStdout`.

### Changed (P44)
- CLI: hook matchers apply to every event that has them (Claude Code), not only
  the tool events; `PostToolUse` fires after successful calls only (failures go
  to `PostToolUseFailure`); `SessionEnd` reasons are `clear`, `resume`,
  `prompt_input_exit` and `other`, and `SessionStart` sources `startup`,
  `resume`, `clear` and `compact`. Bash permission rules also apply to
  `monitor`. The gateway keeps its previous hook behavior.
- kernel: an extension registering a command name again replaces its own
  command (pi) instead of adding a `:2` copy.

### Fixed (P44)
- CLI: `PermissionRequest` hooks with a matcher never ran.

### Added (P43)
- ext-mcp-http, ext-mcp: MCP resource tools `list_mcp_resources`,
  `list_mcp_resource_templates` and `read_mcp_resource` (pi 1.2; the names
  Codex and opencode use), registered once a server offers resources, read
  only (low risk). `/mcp` and `tau mcp list --check` mark servers with
  resources.
- ext-mcp-http: MCP protocol 2025-11-25, also accepting 2025-06-18,
  2025-03-26 and 2024-11-05 (pi); a server choosing another version is
  disconnected. SSE streams that drop before their response arrives are resumed
  with `Last-Event-ID`, after the server's `retry` delay (pi). Option
  `roots`, answered to `roots/list`; the CLI gives the working directory.
- kernel: `AgentOptions.imageProcessor`: images tools return are converted
  and shrunk before they are logged (pi `normalizeToolResultImages`, also
  exported); the CLI passes its image processor. `decodeBase64`;
  `SseParser` options `onId`/`onRetry`; `Agent.provider`;
  `sendUserMessage(content, { expandPromptTemplates })` (pi 0.84.2) runs the
  extension command, skill or prompt template the text names.
- CLI: commands the bash and PowerShell tools run get `TAU_SESSION_ID`,
  `TAU_SESSION_FILE`, `TAU_SESSION_PROVIDER`, `TAU_SESSION_MODEL` and
  `TAU_SESSION_REASONING_LEVEL` (pi's `PI_*`; `TAU_PROVIDER` and
  `TAU_MODEL` already configure tau), and tau sets `AI_AGENT=tau` and
  `TAU_CODING_AGENT=true` for its child processes. host-node:
  `NodeShell`/`NodeBackgroundShell` option `commandEnv`.

### Changed (P43)
- ext-mcp-http: MCP images reach the model as images instead of placeholder
  text (pi); binary resources are saved to temp files where the host can (the
  Node extension does) and named by path; embedded text resources and resource
  links read as pi writes them; `structuredContent` may be any JSON value.
  Servers without the `tools` capability are no longer asked for
  `tools/list`. `toolOutput` is replaced by `convertMcpResult` and
  `limitMcpContent`.

### Changed (P42)
- kernel: long sessions stay fast. A write that extends the current branch
  extends the projection, path and usage in place instead of rebuilding them;
  the per-request transcript check compares messages by identity instead of
  serializing the whole log (30,000 entries: a ten-tool turn 831 → 37 ms).
- kernel: `JsonlSessionRepo.list()` reads each file line by line for its list
  entry, ten files at a time (pi), instead of loading every session (30,000
  entries: 131 → 37 ms a file). The entries are the same.
- CLI: the full-screen view renders the conversation and builds the search
  corpus in short slices while idle, so scrolling to the top and the first
  Ctrl+F of a resumed 30,000-entry session take about 40 ms (2.1 s and 1.5 s
  before). Wrapping is faster (same rows as wrap-ansi), and `/tree` caches its
  rows and filters (a keystroke in its search: about 30 → 11 ms).

### Added (P41)
- CLI: skills and prompt templates are built in (pi): `~/.tau/skills`,
  `~/.agents/skills` and `~/.tau/prompts` work without an import file; a
  trusted project's `.tau/skills`, `.pi/skills` and every `.agents/skills`
  from the working directory up to the repository root (the Agent Skills
  locations), and its `.tau/prompts`, `.pi/prompts`. If you wrote a
  `~/.tau/extensions` file importing `@yophon/tau-ext-resources`, you can
  delete it (it now does nothing); paths you passed to
  `createResourcesExtension(...)` belong in settings `skills` / `prompts`.
- CLI: settings `enableSkillCommands` (pi): `false` keeps `/skill:name` out of
  the menu and `/help`; typing it still works. kernel:
  `RegisteredCommand.hidden`.
- CLI: pi's resource flags: `-e`/`--extension`, `-ne`/`--no-extensions`,
  `--no-mcp`, `--skill`, `-ns`/`--no-skills`, `--prompt-template`,
  `-np`/`--no-prompt-templates`, `--append-system-prompt` (repeatable),
  `--system-prompt` (`-s`/`--system` stay), both taking text or a file, and
  `-v`/`--version`.
- CLI: `SYSTEM.md` replaces the system prompt and `APPEND_SYSTEM.md` adds to
  it, from `~/.tau/` or a trusted project's `.tau/` (the project's wins); the
  flags override them (pi).

### Changed (P41)
- ext-resources: skills load as in pi 1.2: a directory with `SKILL.md` is one
  skill and the search stops there; dot directories and `node_modules` are
  skipped; a standalone `.md` file is a skill only at the top of a skills
  directory; when two skills share a name the first one found is kept and the
  later one reported (it used to replace the first); prompt templates likewise.
  Explicit paths may be a single `.md` file; missing ones are reported.
  Options `defaultSkillPaths`, `configuredSkillPaths`, `noSkills`,
  `skillCommands` (and the prompt counterparts) let a host choose; a second
  copy in one registry does nothing.
- CLI: a project's `.agents/skills` (also in parent directories, except your
  own `~/.agents/skills`) and its `.tau/SYSTEM.md` / `.tau/APPEND_SYSTEM.md`
  need project trust; a project already trusted that has them is asked again.

### Added (P40)
- CLI: `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (either case) and
  settings.json `httpProxy` now apply to every request: model calls,
  `web_fetch`, `web_search`, MCP and OAuth (pi's undici dispatcher; Claude Code
  and Codex read the same variables). `httpIdleTimeoutMs` (default 5 minutes,
  0 = none) bounds the wait for headers and body chunks. New dependency
  `undici` 8.10.2 (pi's version). The gateway is unchanged.
- CLI/kernel: a `powershell` tool on Windows, on by default when PowerShell is
  installed (Claude Code; pi's tool): `pwsh.exe`, else `powershell.exe`, with
  pi's arguments and UTF-8 output; timeouts, `run_in_background`, Ctrl+B and
  `/tasks` as for bash. Turn it off with `--tools -powershell` or
  `"defaultTools": ["-powershell"]`. Permission rules `PowerShell(...)` follow
  Claude Code: bash's pattern shape, aliases resolved to cmdlets (`gci` →
  `Get-ChildItem`), case ignored, compound commands split at `|` `;` `&&`
  `||`; a command with `$(...)`, a script block or `&` is never allowed by a
  rule. A Bash deny rule turns the tool off unless some rule names PowerShell.
  kernel: `createCodingTools({ powershell })`, `parsePowerShellCommand`,
  `canonicalPowerShellCommand`, `powerShellPatternMatches`; host-node:
  `NodeShell` options `interpreter`, `shellPath`, `commandPrefix`,
  `findPowerShell`, `shellInvocation`, `NodeBackgroundShell.forPowerShell()`
  and `setShellOptions`.
- CLI: settings.json `shellPath` (the bash to use) and `shellCommandPrefix`
  (put before every bash and `!` command), as in pi.
- CLI: more of pi's settings keys: `defaultTools` (`--tools` changes it),
  `compaction.*`, `branchSummary.reserveTokens`, `branchSummary.skipPrompt`,
  `retry.*`, `steeringMode`, `followUpMode`, `treeFilterMode`,
  `externalEditor`, `sessionDir` (and `--session-dir`), `extensions`,
  `skills`, `prompts`, `images.autoResize`, `images.blockImages`. Every key
  is listed in docs/settings.md. kernel: `AgentOptions.branchSummary`;
  host-node: `NodeImageProcessor({ autoResize })`.
- kernel: pi's `before_provider_request` (may replace the request body),
  `after_provider_response` and `provider_stream_event` on every provider call
  (`TransportRequest.onPayload` / `onResponse` / `onStreamEvent`, declared by
  `supportsProviderEvents`; the OpenAI-compatible and Anthropic transports
  have them), `ui_prompt_start` / `ui_prompt_end` around an extension's
  prompts, and `registerMarkdownTransformer` (applied by the TUI).
- kernel: overflow recovery (pi): a request that fails because the context
  overflowed is left out, the session is compacted with reason `overflow` and
  the turn runs again, once until a request goes through; a second overflow
  ends with pi's message. Compaction events carry `willRetry`; the
  `compaction` event carries its reason.
- kernel: `session_before_tree`'s preparation carries `userWantsSummary`,
  `replaceInstructions` and `label`; handlers may change the last two, and
  `Agent.navigateTo` takes them. The label goes on the branch summary entry.

### Changed (P40)
- CLI: a trusted project's `.tau/settings.json` applies on top of the user's
  for every key except those read before the trust question (network, TUI,
  startup model, worktree) and the user's own (search key, `shell.envAllow`,
  `audit.details`), as in pi. `session.autoTitle`, `session.dirtyRepoGuard`,
  `askUser.wait` and `maxTurnsPerPrompt` follow the layers too.

### Fixed (P40)
- host-node: on Windows, background commands that run Git Bash builtins or
  MSYS programs (`echo`, `ls`, `grep`) exited 1 with no output: their output
  file was opened for appending only.
- CLI tests: the P39 session tree test no longer depends on today's date.

### Added (P39)
- CLI TUI: `/diff` shows the uncommitted changes (against HEAD, staged ones
  too) and every untracked file, in the transcript and never to the model
  (Codex's /diff).
- CLI TUI: `/btw <question>` asks a side question about the conversation, also
  while the agent works: no tools, not added to the conversation or the
  session log, answered in an overlay above the input (Space/Enter/Esc close,
  ↑↓ scroll, Shift+←→ or `[` `]` step between answers, `c` copies, `x` clears
  the earlier ones; `/btw` alone reopens it). The newest 20 earlier exchanges
  go along (Claude Code). kernel: `Agent.askAside` sends it with the same
  prefix as the next request; its usage is logged as a `usage` entry.
- CLI TUI: Ctrl+B moves the bash command the model is running in the
  foreground to the background; a command that reaches its timeout moves
  there too instead of being stopped (a `sleep` is still stopped). Either way
  it becomes a background task with an output file that starts with what it
  printed so far, and its end is reported as before (Claude Code). kernel:
  `BackgroundShell.run`/`moveToBackground` (optional), `ForegroundOutcome`,
  `backgroundMovedText`; host-node: `NodeBackgroundShell.run`,
  `moveToBackground`, `foregroundCount`, `moveOnTimeout`. The gateway keeps
  stopping commands at their timeout.
- CLI TUI: `~/.tau/keybindings.json` changes keys, in pi's format and action
  names (`{ "tui.editor.cursorLineStart": ["home", "ctrl+a"] }`; tau's own
  actions are `app.permissionMode.cycle`, `app.history.search`, `app.redraw`,
  `app.task.background`). A user entry replaces that action's defaults; a key
  given two actions and mistakes are reported; read at start and on
  `/reload`. `/keybindings` creates the file with every action and opens it
  in your editor; `/hotkeys`, the `?` panel and the hint line show the keys in
  force.
- kernel: `Agent.setLabel(entryId, label)`.

### Changed (P39)
- CLI TUI: `/tree` (and Esc twice) is pi's tree selector: every entry with its
  branches drawn, the current branch first and marked •, tool results as one
  line (`[read: path]`), five filters (Ctrl+D/T/U/L/A, Ctrl+O cycles),
  folding (Ctrl+←/→), typing to search, Shift+L to label an entry, Shift+T for
  label times, Ctrl+X to copy one. It opens at the current leaf. Extension
  entry renderers no longer apply inside it (pi shows `[type]: text`).
- CLI: memory writes have no size limit any more; the prompt loads the first
  200 lines or 25 KB of USER.md and MEMORY.md, and a write that nears or passes
  that reminds the model to tidy up (Claude Code's auto memory).
  `memory_read` and `/memory` show lines and size.

### Fixed (P38 review)
- kernel: the edit diff drops CRLF files' carriage returns (full screen showed
  their rows blank) and treats a final newline as diffLines does (no phantom
  `-3 ` or `+4 ` line).
- CLI TUI: text written before a streamed tool call shows once; reads in
  separate responses join one group again; a reasoning run split into
  paragraphs opens, shuts and is timed as one, and inline Ctrl+T rewrites the
  history with it. The caret mark is an OSC 8 link (zero-width characters
  took a cell each and pushed the input box's right border out); rows with a
  link whose URL has `+ , '` or CJK in it measure right (our own escape
  stripper), and a bare URL ends at CJK punctuation. Kitty key flags are pushed
  after entering the alternate screen (one flag stack per screen), so
  Shift+Enter works in full screen in kitty-protocol terminals; Ctrl+J under
  kitty keys is a newline. A paste Windows Terminal sends as key events
  survives being cut across reads. Word keys move by CJK word and over a paste
  marker whole (pi's segmenter); sending clears the undo stack. Prompts take
  the task slot before anything is awaited (a queued `/init` then `/follow`
  ran two turns at once); a follow-up queued after a waiting command runs
  after it; ↑ takes waiting commands back one at a time; extension commands
  run at once as in pi (`/tasks` mid-turn); `/follow` waits during a
  compaction; Tab in an open question answers it. Extensions' `ui.editor`
  hands the terminal over as Ctrl+G does. Full-screen Ctrl+L and coming back
  from an editor repaint even when the frame is unchanged; inline, clearing the
  screen (`/clear`, `/resume`, `/tree`) empties Ink's copy of the old history.
  `/tree` keeps a draft typed meanwhile after the message it puts back;
  restored sessions word provider errors as the live view does; `/resume `
  completions are fetched again after a send.

### Changed (P38d)
- CLI TUI: grapheme widths are measured once (Ctrl+F over 7,500 Chinese rows:
  2.5 s → 0.14 s; input layout of 2,000 CJK characters 5.6 → 0.3 ms). Full
  screen writes only the rows that changed (pi's alt-screen renderer; a spinner
  tick 5,168 → 67 bytes), repainting all after a resize, a hand-over or Ctrl+L.
  Text still streaming is highlighted once it finishes (a 1,000-line open code
  block 107 → 7 ms a frame); a running command's preview takes its tail from
  the end (100k lines 8 → 2 ms); the completion is computed once per input.
  Inline, Ink's copy of the history is emptied before a redraw and the live
  area stays shorter than the screen.

### Changed (P38c)
- kernel: `navigateTo` to a user or custom message moves the leaf to its
  parent and returns the message as `editorText` (pi navigateTree; before,
  tau moved to the message itself).
- CLI TUI: `/tree` (and Esc twice) opens at the newest message, asks pi's
  "Summarize branch?" (no summary first) and puts the message back in the input
  box to edit and send again. `/resume` marks the current session, tells same
  titles apart, renames with Ctrl+R and deletes with Ctrl+D (pi). `/clear` (also
  `/reset`) starts a new session as in Claude Code; Ctrl+L redraws. One Esc
  denies an approval; Ctrl+O shows its whole diff or command; an extension's
  question numbers its options. Slash commands typed while a turn works wait for
  it ("after this turn"), except the ones that only show something. `?` on an
  empty input lists the shortcuts. The REPL's `/tree` shows a message's text
  after going back before it.
- smoke-tui passes `CI` on to tau (the tmux server's environment lacked it, so
  an Ink-loads-too-early bug only showed on CI).

### Added (P38b)
- kernel: the edit tool's result carries pi's `details.diff` (numbered lines,
  context, `...`) and `firstChangedLine` (`editDiff`). Transports stream a
  call's arguments as `tool_call_delta` (OpenAI-compatible and Anthropic); the
  agent passes it on as an AgentEvent and to `message_update` (pi
  toolcall_delta).

### Changed (P38b)
- CLI TUI: an edit shows its diff without expanding (file line numbers, the
  changed words highlighted); a write shows its first ten lines, highlighted
  (highlight.js 10.7.3, pi's languages); a call shows while the model writes
  its arguments. Reasoning folds into "Thought for Ns" (click or Ctrl+T to
  read; `tui.showReasoning`). Consecutive read/grep/find/ls calls show as one
  line ("Read 3 files, searched for 2 patterns"). Wrapped markdown keeps its
  code bar, quote bar and list indent; code blocks are highlighted; table cells
  keep inline styles. Retries update the activity line instead of adding
  lines; errors show their message, not the JSON body. Expanded tool output is
  whole; an interrupted command keeps what it printed. Selecting copies the
  source text (no bars or bullets, soft wraps joined); `/copy [N]` can copy one
  code block. Links are OSC 8 hyperlinks where the terminal supports them and
  open on a click; right-click pastes in full screen on Windows. The activity
  line counts tokens and says when it waits for an approval; a turn ends with
  "Worked for 12s · ↑… ↓…". Toggles flash on the hint line. Fixed: full screen
  lost the boxes' right border; PgDn stopped one row short. A scrollbar shows
  while scrolled. The header no longer repeats the status line; the full-screen
  tip shows on the first three starts; exiting prints how to resume.

### Changed (P38a)
- CLI TUI: tau reads keys itself (pi's StdinBuffer splitting and parseKey);
  Ink only keeps the terminal in raw mode. Several keys in one read all count
  (tech debt #21). Windows Terminal: Home/End, Delete (forward), Ctrl+←/→,
  Ctrl+Backspace, Alt+Backspace, Alt+D work; win32-input-mode is turned on
  (Claude Code) so Shift+Enter is a newline; elsewhere kitty keyboard flags
  are requested (pi). `TAU_KEYBOARD=legacy` turns both off.
- CLI TUI: while working, Tab queues a follow-up (Codex; Windows Terminal
  takes Alt+Enter for full screen); idle, Tab completes a path. Ctrl+C on a
  draft clears it into history (Claude Code); Ctrl+D on an empty input exits.
  Enter on a highlighted command or argument runs it in one step.
- CLI TUI: undo (Ctrl+Z on Windows, Ctrl+- elsewhere) and a kill ring
  (Ctrl+Y, Alt+Y) after pi; Ctrl+Z suspends outside Windows. ↑ keeps the draft
  for the way back and moves inside a wrapped prompt first; a prompt in the
  input box puts the draft aside. Ctrl+R searches the prompt history; pickers
  filter as you type. Long one-line pastes fold; paste markers delete whole;
  Ctrl+G (also while working) gets the pasted text. `@` lists files again
  for each completion, offers directories and quotes paths with spaces. In
  full screen the terminal cursor sits at the caret (input methods).

### Added (P37)
- kernel: Claude Code permission rules (`parsePermissionRule`,
  `matchPermissionRules`, `parseShellCommand`, `canonicalPath`):
  bash patterns over compound and nested commands, gitignore-style paths
  (Windows spellings folded), `domain:`, MCP names, parameter rules.
  `createDefaultPolicy` takes `rules`, `workingDirectories` and `home`;
  `PolicyDecision.rule`/`protectedPath`; `ToolPolicy.deniesTool` takes a
  wholly denied tool off the wire; `ToolPolicyCall.toolCallId`.
- kernel: `SessionRepo.create({ parentSession })` (pi newSession);
  `loadProjectContextFiles` takes `skip`.
- CLI: `permissions.allow/ask/deny/additionalDirectories/defaultMode` in
  ~/.tau/settings.json, .tau/settings.json (allow after trust) and the new
  .tau/settings.local.json; `--allowed-tools`, `--disallowed-tools`,
  `--add-dir`, `/add-dir`, `/permissions`. "Always allow" saves a project
  rule (`Bash(npm test *)`, `WebFetch(domain:…)`, MCP names) or, for edits,
  switches the session to accept-edits. Audit sources `rule_allow`,
  `rule_deny`. See docs/permissions.md.
- CLI: `/handoff <goal>` (pi): a prompt carrying what matters into a new
  session, left in the input box; `/session` shows the parent.
- CLI TUI: Esc twice on an empty input opens `/tree`
  (`tui.doubleEscapeAction`: tree, fork, none); Esc on a draft keeps it in
  history; optional uncommitted-changes question before switching sessions
  (`session.dirtyRepoGuard`, pi's dirty-repo-guard).
- CLI TUI: custom status line (Claude Code `statusLine`), `/statusline`.
  See docs/statusline.md.
- CLI: `tau --worktree [name]` (Claude Code): worktree and branch under
  .tau/worktrees, `worktree.baseRef`, `.worktreeinclude`,
  `worktree.symlinkDirectories`, cleanup on exit. See docs/worktrees.md.

### Changed (P37)
- CLI: `~/.tau/permissions.json` is migrated to permission rules on first
  start (`bash` entries become `allow: ["Bash"]`) and renamed
  `permissions.json.migrated`; "always allow" no longer writes it.
- kernel: a hook's `permissionDecision: "allow"` no longer skips an ask
  rule (Claude Code).
- kernel: accept-edits no longer lets `..` in an absolute path leave the
  working directory; Git Bash, WSL and Cygwin spellings of the working
  directory count as inside it.
- CLI: `.tau/mcp.json` now goes through the project trust gate (it was
  silently ignored); trusted projects that have one are asked once more.
- CLI: `.tau/settings.json` and `.tau/settings.local.json` are protected
  paths (writes always ask).
- CLI TUI: the branch shows in linked worktrees and repository
  subdirectories; two Escs arriving in one chunk count as two.
- CLI: project memory is shared by all worktrees of a repository.

### Added (P36)
- kernel: `bash` takes `run_in_background` (and `description`) when the
  host provides a `BackgroundShell`: it returns at once with a task ID and
  an output file the model reads with `read`. New `task_stop` tool.
  `createCodingTools` takes `background` and `images` capabilities and a
  `supportsImages` option.
- kernel: `read` sends images through the host's `ImageProcessor` (pi's
  limits: 2000x2000, 4.5 MB of base64; BMP becomes PNG), says when the
  current model takes no images (pi's note), and forgives a leading `@` and
  quotes around the path.
- kernel: `api.events` — pi's event bus between extensions.
- host-node: `NodeBackgroundShell` (output straight to a file, whole
  process tree stopped, everything stopped when the process exits) and
  `NodeImageProcessor` (pi's photon pipeline in a worker;
  `@silvia-odwyer/photon-node` 0.3.4).
- CLI: when a background command ends on its own, the model gets a message
  with its exit code and the last lines of output. `/tasks` lists
  background commands and subagents, shows output and stops commands; a line
  above the input box counts running commands. Background commands end when
  tau exits. Gateway: a conversation with running commands is not unloaded
  while idle; owners have `/tasks` in chat (also while a run is going).
- CLI: `@file` arguments and messages on the command line (pi):
  `tau @shot.png "what is wrong here?"`, `tau -p "why?" @log.txt`. Text files
  go into the first message, images are attached to it.
- CLI TUI: Alt+V (or Ctrl+V where the terminal passes it on) pastes from the
  clipboard as pi does: copied files as their paths, an image saved to a
  temporary file as its path (the model reads it), else the text.
- RPC: `list_background_tasks`, `stop_background_task`.
- ext-subagents: background subagents are reported on the
  `subagents:task` event channel; `tasksCommand: false` leaves `/tasks` to
  the host.
- gateway: `Conversation.busy()`; the `tasks` conversation command.

### Changed (P36)
- kernel: on OpenAI-compatible endpoints, images in tool results go in a
  user message right after the results (pi) instead of becoming
  "[image omitted]".
- CLI: a model from models.json without `input` is treated as text-only on
  the wire, as in pi (its images become a placeholder); add
  `"input": ["text", "image"]` for models that take images. Before, only the
  gateway read `input`.
- CLI: words on the command line that are not options are messages to send
  (pi); before they were rejected as unexpected arguments.

### Added (P35)
- CLI: `ask_user` tool — the model asks one or more questions, each with
  options (single or multiple choice), and the user can always answer in
  their own words. By default the model does not wait: the tool returns at
  once, the question stays open, and the answer arrives later as a
  "[Answer qN]" message (steered into a running turn, or starting a new
  one). settings.json `askUser.wait: true` makes it wait. TUI: a picker
  (multi-select lists check with Space or a click); Esc puts a question
  aside, a line above the input box shows it, Ctrl+Q or a click reopens it.
  Gateway: a numbered chat message; reply with numbers or text. RPC: the new
  `multiselect` UI request. ACP: the editor's permission buttons. Not
  offered where nobody can answer (`-p`, json mode, gateway schedules).
- CLI: user hooks — shell commands in settings.json `hooks` in Claude
  Code's format (PreToolUse, PermissionRequest, PostToolUse,
  UserPromptSubmit, Stop, SessionStart, SessionEnd, PreCompact,
  Notification): event JSON on stdin, exit 2 blocks, stdout JSON can approve
  (`permissionDecision`), rewrite arguments (`updatedInput`) or add context;
  `async` hooks run in the background. The trusted project's
  `.tau/settings.json` counts too. `/hooks` lists them. See docs/hooks.md.
- kernel: `ToolCallEventResult.permission` (`"allow"` skips the approval
  where the policy would ask, `"ask"` asks where it would allow; the
  policy's own denials stand); `UiCapability.selectMany`;
  `RegisteredWidget.onClick`.
- gateway: `ChatQuestions` (a conversation's UI in chat),
  `ConversationHooks.ui`, `GatewayOptions.questions`.
- host-node: `NodeShell.exec` takes `input` for the command's stdin.

### Fixed (P35)
- host-node: commands routed to cmd.exe on Windows lost their quotes (Node
  escaped them as \" which cmd does not read): `node "C:/x.mjs"` failed.

### Added (P34)
- CLI TUI, full screen: Ctrl+F (or `/search`) searches the whole
  conversation (pi's matching: case-insensitive, across wrapped rows),
  Enter/↓ and ↑ step through matches; drag, double-click and triple-click
  select text, a word or a line and copy it on release (OSC 52 when no
  clipboard tool); a click on a tool's title row opens or shuts just that
  block; Ctrl+↑/Ctrl+↓ jump between the messages you sent; clicks choose in
  the completion menu, pickers and the approval panel.
- CLI TUI: the terminal title spins while a run works and Windows Terminal
  shows tab progress; with the window in the background a finished run or a
  waiting approval sends a desktop notification (Windows toast under
  Windows Terminal, OSC 99 for Kitty, OSC 777 elsewhere). `tui.notify`
  (`"auto"`/`"off"`) and `tui.title` in settings.json.
- CLI: sessions get a title from the model after their first turn (TUI and
  REPL; `session.autoTitle`, `TAU_AUTO_TITLE=0`); `/resume` lists
  sessions by title (else their first message), how long ago and how many
  messages, and `/resume <text>` matches titles.
- kernel: `SessionMetadata.firstMessage` and `messageCount` (pi's
  SessionInfo fields); `Agent.completeText()` for a one-off request with the
  current model that is not recorded in the session.

### Changed (P34)
- kernel: `maxTurnsPerPrompt` has no default cap (was 50: a long task ended
  with "Prompt exceeded 50 turns without completing"); pi, Claude Code and
  Codex do not cap a prompt either. The CLI applies `maxTurnsPerPrompt`
  from settings.json when set.
- kernel: a bash command stopped by its timeout returns what it printed
  (the end of it) and says to run it again with a larger `timeoutSeconds`;
  the tool description mentions `timeoutSeconds` for long builds and tests.
- ext-provider-anthropic: without a configured `maxTokens` the output cap
  is 32k for Claude 3.7 and Claude 4 or later (was 8192 for every model, so
  writing a large file in one tool call got cut off); other models keep 8192.
- CLI TUI: the completion menu and pickers list every item and scroll
  (PgUp/PgDn, Home/End, the wheel) instead of stopping at eight.
- CLI TUI: mouse and focus reports are taken from stdin before Ink parses
  keys (both views).

### Fixed (P34)
- CLI TUI: tool output with tabs (read's numbered lines) lost its last
  character on every line; tabs are expanded to spaces.

### Changed (P33)
- CLI: the TUI runs full screen by default: the alternate screen with
  auto-wrap off (narrowing the window clips, then redraws at the new width,
  so no ghost copies of the input box), its own scrollable transcript (mouse
  wheel, PgUp/PgDn, Ctrl+Home/Ctrl+End; follows the end, "N more lines below"
  when scrolled up; Shift+drag for the terminal's own selection), every frame
  one synchronized write, and the conversation written back to the main
  screen on exit (also on SIGTERM/SIGHUP). `--inline`/`--fullscreen`,
  `TAU_TUI_MODE`, `tui.mode` in `~/.tau/settings.json` and `/settings` →
  Screen choose; inline is the P25 view.
- CLI: blocks render as terminal rows (`render/lines.ts`) in both views, the
  same rows Ink drew, with a port of wrap-ansi for Ink's mode
  (`render/wrap.ts`, byte-identical, over 20× faster).

### Fixed (P33)
- CLI: full screen no longer flashes a blank screen now and then while the
  window is resized. Every frame paints the whole screen from the corner in
  one synchronized write (nothing is cleared first), a resize draws its
  frame at once instead of after Ink's render throttle, and the view takes
  its height from the same layout pass as the bottom area.
- CLI: Ink's cursor show/hide writes to stderr no longer show up as warning
  notices in the TUI.
- CLI: leaving the TUI no longer ends the process with exit code 13 (an
  unsettled top-level await since P25: Ink's `waitUntilExit()` was taken
  after `unmount()` and never settled), which also skipped turning
  bracketed paste off and restoring the console.

### Added (P32c)
- CLI: an audit ledger in `~/.tau/audit/YYYY-MM-DD.jsonl` (kept 30 days),
  written by every mode and the gateway: each run's start and end (host,
  trigger, model, tokens, cost from models.json prices, status, session
  file), each tool call (risk, masked argument summary, who decided:
  mode, user_once/user_session/user_reject, chat_owner with the owner,
  chat_reject, timeout, non_owner, policy_deny, hook, no_approver) and each
  gateway message. `tau audit` with filters and `--json`; `/runs` in chat;
  today's totals in `tau gateway status`, `/status` and `/schedules`.
  `audit.details: "none"` in settings drops the argument summaries.
- gateway: `ConversationInput.runId`/`trigger`, `ConversationHooks.decidedBy`,
  `GatewayOptions.onOutbound`/`audit`; `OutboundReply` text may carry
  `notice` (the gateway's own messages).

### Added (P32b)
- CLI: `tau credentials set|list|remove|audit` and `${cred:<name>}` references
  in `~/.tau/models.json`, `~/.tau/mcp.json` and the gateway's channel
  sections (`~/.tau/credentials.json`, 0600).
- CLI: connectors from `~/.tau/mcp.json` and a trusted project's
  `.tau/mcp.json` (pi's format) in every mode; the gateway loads them in the
  owner's conversations only, ACP merges them with the editor's servers.
  `toolRisk` (user file only) declares risk by tool name pattern. A project
  file cannot reference credentials or secret-looking variables. `tau mcp
  list [--check]`.
- OAuth for MCP servers (`"auth": "oauth"`): `tau mcp login|logout <server>`,
  tokens in `~/.tau/mcp-auth.json`, refreshed on expiry or a 401. The flow is
  ported from pi-mcp 1.2 into ext-mcp; ext-mcp-http's HTTP transport takes an
  `auth` token provider.
- Secrets stay away from the model (not a security boundary): the bash tool
  and stdio MCP servers get the environment without secret-looking variables
  (`shell.envAllow` in settings keeps some), a built-in guard blocks reads of
  tau's credential files, and known secrets are masked in tool results.

### Fixed
- TUI: changing the terminal width left copies of the input box (and other
  pieces of the last frame) on screen, because the terminal re-wraps what is
  shown and Ink erases by line count. The TUI now takes over Ink's resize
  handling (pi-tui's approach): on a width change it clears and writes the
  conversation again at the new width in one synchronized-output frame (DEC
  2026), so neither the leftover pieces nor a blank screen show; height
  changes still go to Ink. New smoke-tui scenario `resize`.

### Fixed (P32a)
- gateway: a non-owner's conversation carried the owner's project memory in
  its prompt. Each guest now has only their own memory file.

### Changed (P32a)
- CLI memory is layered: `~/.tau/memory/USER.md` (about you, every project),
  the project's `MEMORY.md` (now an index) plus topic files in
  `memory/<topic>.md`, and a gateway guest's own `USER.md`. Files have size
  limits (2000 / 4000 / 20 000 characters); a full file makes the model merge
  entries. The memory in the prompt is taken when a session starts and stays
  the same for that session. `memory_write` takes `target` (`user` or
  `project`) and an optional `topic`, and is low risk now (no approval). New
  tools `memory_edit`, `memory_read`, `session_search` and `session_read`
  (keyword search over your own earlier sessions), so exact tool lists grow by
  four. `/remember !fact` and `#!fact` save memory about you; `/memory` shows
  all layers, `/memory edit|clear [user|project|<topic>]`.

### Added (P31)
- gateway: schedules and goals. In the owner's chat the model gets
  `schedule_create`/`schedule_list`/`schedule_cancel` and
  `goal_create`/`goal_update`/`goal_list`: one-off reminders (`at` or `in`),
  recurring tasks (5-field cron, at least 5 minutes apart) and goals whose
  schedules end when the goal is done. The gateway confirms each new schedule
  with the stored time, fires due ones into their conversation as a message,
  sends a missed one-off late with a note and skips a missed recurring firing,
  drops a recurring task's bare `[静默]` reply, and sends no tool progress for
  a scheduled run. `/schedules`, `/goals`, `tau gateway schedules [cancel <id>]`,
  `tau gateway goals`; `config.json` `timeZone`; a schedules line in
  `tau gateway status`. Every gateway turn starts with the current time.
- CLI: `openWorkspace` takes host `extensions` (added after the built-ins,
  kept across `/reload`).

### ⚠ Breaking
- CLI (P28): when `~/.tau/models.json` has a usable model, it decides the
  endpoint, key and model; `TAU_BASE_URL`, `TAU_MODEL`, `TAU_API_KEY` and the
  `OPENAI_*`/`ANTHROPIC_*` variables only apply without one. `-b`/`-k`/
  `--provider` still run an ad-hoc endpoint. The CLI also declares `web_fetch`
  by default (a new built-in extension), so exact tool lists grow by one.
- ext-subagents (P26b): the tool is `subagent` (was `task`) with pi's
  parameters — `{agent, task}`, `{tasks: [...]}` or `{chain: [...]}`, plus
  `background` — instead of `{description, prompt}`. The CLI now loads it by
  default. Old sessions keep their `task` calls as history.
- Kernel (P26a): `createCodingTools` also registers grep, find and ls (read-only
  mode keeps them), and edit's schema is pi's `edits: [{oldText, newText}]`
  (the single oldText/newText pair is still accepted). Hosts or tests that
  expected exactly read/write/edit/bash see the new tools.
- Kernel (P26d): `PermissionMode` gains `accept-edits`; exhaustive switches over
  it need the new case.
- CLI (P25): a new TUI, now the interactive default. On a terminal, `tau` without
  `-p` starts it; `--repl` keeps the line-based REPL, and piped stdio still gets the
  REPL. `--tui` still works (and still refuses non-TTY stdio). The TUI is rebuilt on
  Ink after yo-agent's design: finished output goes to the terminal scrollback once,
  only the live part and the input area redraw, and tool calls show as `● name(arg)`
  with a `⎿` result line, collapsed by default (Ctrl+O shows details for new output).
  The `@earendil-works/pi-tui` dependency is gone (the CLI now depends on `ink`,
  `react` and `string-width`).
- CLI keys (P25): Esc interrupts (and clears the input when idle); Ctrl+C interrupts,
  and when idle exits on a second press; Ctrl+T shows/hides reasoning (was Ctrl+R);
  Ctrl+O expands/collapses tool details (was Ctrl+T); Alt+Enter queues a follow-up
  while a turn runs (`/follow` still works); ↑ on an empty input takes queued
  messages back. Ctrl+G opens the external editor, so an extension shortcut on
  Ctrl+G (or any other key the TUI binds) is ignored and reported. `/tools` only
  takes `expand`/`collapse` (output already in the scrollback cannot change).
- Extension UI (P25): a component returned by a message, entry, tool or widget
  renderer only renders in the TUI; its `handleInput` is no longer called.
- ext-mcp / ext-mcp-http (P24d, pi 0.99.2): servers connect in the background at
  `session_start` instead of blocking it; the first prompt waits up to 10 s for
  servers with direct tools. An unavailable server is reported through
  `ctx.ui.notify` (ext-mcp writes to stderr without a UI) instead of failing
  `session_start`. Hosts that read tools right after `session_start` should await
  `connect()` (ext-mcp-http) or the first prompt.
- Kernel (P24b, pi 0.99.0): the active tool set is explicit, as in pi. Registering a
  `direct` or `model-only` tool activates it (unless `defaultActive: false`); other
  exposures never activate on registration. Resuming a session or navigating with
  `/tree` restores the active set the transcript declares (tools that register later,
  such as MCP tools, activate when they do), so a resumed session no longer
  re-activates every registered tool. An extension registering a tool name it already
  registered replaces its tool (across extensions the first registration still wins).
- ext-mcp / ext-mcp-http (P24a, pi 0.99.2): MCP tools are named
  `mcp__<server>__<tool>` (was `<server>_<tool>`); characters outside
  `[A-Za-z0-9_]` become `_`, and tools whose names sanitize alike or exceed 64
  characters get an 8-hex sha256 suffix. `toolPrefix` is gone. Server names that
  differ only in `-`/`_` clash and the second is reported unavailable.
  "Always allow" entries recorded under the old names fall back to asking.
- ext-mcp (P24a): no longer depends on `@modelcontextprotocol/sdk`. It is the
  pure-ES client of ext-mcp-http plus a stdio transport ported from pi-mcp
  (`cross-spawn` for Windows `.cmd` shims); `tools/call` has no default timeout
  (the SDK's was 60 s).
- CLI (P23e, pi print mode): `tau -p` exits 1 when the final reply errored, was
  aborted or hit the output limit (it used to exit 0), and errors go to stderr.
  Integer flags are strict (`-w 128k` is an error; env values like
  `TAU_STALL_TIMEOUT_MS=120s` are ignored with a warning instead of becoming 120);
  a flag cannot be taken as the previous flag's value (`--model --tui`).
- CLI (P23e): extension commands typed while a turn runs are refused instead of
  queued as text; queued input left by an aborted turn is restored to the TUI
  editor (the REPL lists what it dropped) instead of being replayed into the next
  prompt.
- ext-feishu (P23e): busy/idle follows `agent_settled`; a missing host action is
  reported to the chat instead of being polled. Downloaded media lives in a 0700
  directory as 0600 files (a planted or foreign-owned default directory is
  replaced by a fresh private one).
- ext-mcp / ext-mcp-http (P23e, pi): results over 20 KB are cut in the middle
  with pi's warning header (ext-mcp saves the full text to a 0600 temp file);
  `structuredContent` is only sent when a result has no other content.
- Kernel (P23d, pi Chat Completions semantics, P21 ruling 8): a stream that
  ends without `finish_reason` is an error ("Stream ended without finish_reason",
  retried), and `content_filter` or any unknown finish reason is an error
  ("Provider finish_reason: …"). Endpoints that omit it: set
  `OpenAICompatConfig.supportsFinishReason: false` (CLI:
  `TAU_SUPPORTS_FINISH_REASON=0`).
- Kernel (P23d, pi parseChunkUsage): Chat Completions usage takes cache hits
  from `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`
  (DeepSeek) or top-level `cached_tokens` (Kimi), reports `cache_write_tokens`
  and `reasoning`, takes all of them out of `input`, and sums `totalTokens` —
  DeepSeek's `usage.input` shrinks by its cache hits.
- Kernel (P23d): empty tool results go out as "(no tool output)"; empty text
  parts are dropped and a user message left empty is skipped; unpaired
  surrogates are removed from outgoing text; a missing or repeated tool call id
  gets a fresh `call_…` id instead of `call_<index>`. The retry and overflow
  tables follow pi v1.2.0 (more transient errors retry, including "Provider
  returned an error…", HTTP 520/524, DNS failures, and tau's own
  "Network request failed"/"Stream read failed"; rate-limit messages that
  mention "too many tokens" are no longer taken for overflow).
- Kernel (P23d): `ChatTransport` may carry `supportsHeaders`; an agent with
  `before_provider_headers` handlers refuses a transport without it
  (`TauError("unsupported")`). `TransportRequest` gains `headers`,
  `cacheRetention`, `thinkingLevel` and `model`.
- ext-provider-anthropic (P23d): a request with an explicit output cap (summaries)
  gets the budget-mode thinking budget on top of it, bounded by
  `config.maxTokens` (pi adjustMaxTokensForThinking); with `contextWindow` set,
  `max_tokens` is held to the room left in the window (pi clampMaxTokensToContext).
- CLI (P23d): `/thinking` and `/model` act on the agent, which sends the level
  and model with every request (`/thinking` no longer writes `extraBody`);
  `--pricing`/`TAU_PRICING` apply to the startup model only — after `/model` the
  cost shows unknown instead of another model's price.
- Kernel (P23c, pi extension loading): `ExtensionRegistry.load()` no longer
  throws. Each extension's registrations are staged; a setup that throws is
  rolled back entirely and recorded in `registry.loadErrors`, and the remaining
  extensions load (`add()` returns `{ errors, warnings }`). Same-name tools and
  flags keep the first registration (it used to be the last) and record a
  warning; duplicate commands all get pi's `name:N` invocation names. A flag
  default of the wrong type, a command without name or handler, and a tool
  without an object schema fail that extension's load. `registerCommand`
  commands carry an `invocationName`.
- Kernel (P23c): every `api.on()` overload returns an unsubscribe function, and
  a dispatch runs on a snapshot of the handlers. `user_bash` fails closed: a
  throwing handler or a malformed result cancels the command; `UserBashEvent`
  gains a required `cwd`.
- host-node (P23c): `loadExtensionsFromDir()`/`importExtensionFiles()` return
  `{ name, factory }` entries named by file path; a module that fails to import
  becomes a load error instead of throwing.
- CLI (P23c, security): the trust decision covers every project resource under
  `.tau/` and `.pi/` — extensions, settings.json, skills, prompts — and its
  digest covers them all, so changing any of them asks again (a project with only
  `.tau/extensions` keeps its old digest). Untrusted projects get no project
  paths and `ctx.isProjectTrusted()` is false; ext-feishu and ext-resources read
  project settings, skills and prompts only from a trusted project. A broken
  extension is reported on stderr and skipped instead of stopping tau.
- Kernel (P23b, pi AgentToolResult): `ToolResult` is
  `{ content: (TextContent | ImageContent)[], details?, isError?, terminate?, usage? }`
  (was `{ output, isError? }`). Migrate `return { output: text }` to
  `return textResult(text)` (or `{ content: [{ type: "text", text }] }`);
  read results with `toolResultText(result)`. Tools can now return images, and
  `details` lands on the `ToolResultMessage`. A tool still returning
  `{ output }` gets an error result naming the new shape. `ToolResultEvent`
  carries `content`/`details`/`usage` instead of `output`, and
  `ToolResultEventResult` overrides those fields.
- Kernel (P23b, pi 0.86.0/0.99.0): `Agent.steer()` and `Agent.followUp()` take
  `UserContent`, run `input` handlers first, and return
  `Promise<"queued" | "handled">`. A `sendUserMessage` during a run passes the
  handlers with `source: "extension"`. `InputEvent` gains `source`,
  `streamingBehavior` and `images`.
- Kernel (P23b): tool calls dispatch against the tools the request declared
  (a per-request snapshot); a tool registered mid-batch answers
  `Unknown tool` until the next request.
- Kernel (P23b, pi runLoop event order): compaction runs before `turn_start`
  (the first turn keeps its slot); steering is polled after `turn_end` and
  committed after the next `turn_start` (it used to land before `turn_end`).
  Queued custom messages count as pending work. Messages queued by `agent_end`
  handlers start a continuation run in the same prompt (a second
  `agent_start`/`agent_end` pair). The AgentEvent stream now ends with
  `agent_settled`. An abort landing in a `turn_start` handler ends the run
  before the request goes out. Tool calls of a `length`-truncated response are
  failed instead of run (pi 0.80.4), and three such turns in a row end the run.
  `sendMessage(…, { triggerTurn: false })` during a run lands after the current
  `turn_end` instead of steering. `turn_end` handlers' return value now
  matters (`{ entries?, continue? }`).
- Kernel (P23a, run slot): `prompt`, `resume`, `compact` and `navigateTo`
  share one slot; entering while another holds the agent throws
  `TauError("busy")` (`compact()` used to run unguarded next to a prompt).
  `compact()` rejects `TauError("cancelled")` when `session_before_compact`
  cancels (it used to resolve `undefined`, like "nothing to compact"), and
  `TauError("aborted")` on abort; failures report `session_compact_failed`
  first. `SessionCompactFailedEvent` takes pi's shape
  `{ reason, errorMessage?, aborted, willRetry, fromExtension }`; the
  `compaction_failed` AgentEvent gains `aborted` and its `errorMessage` is
  optional (`Auto-compaction failed: …` / `Compaction failed: …`, as in pi).
  `SessionBeforeCompactEvent.signal` and `SessionBeforeTreeEvent.signal` are
  required. `completeText()` throws when the summary stops on `length` or
  `error` (pi getSummarizationFailure).
- Kernel (P22, pi 1.2.0 compaction): `prepareCompaction(pathEntries, settings)`
  works on the session projection and lost its third `currentMessages`
  argument; it returns `undefined` when nothing is left to summarize.
  `completeText()` returns `{ text, usage }`. `AgentRunResult` gains a required
  `usage`. The TUI footer cost now sums the whole session log.
- Kernel (P22, D21 seam reshape, pi TranscriptContext): `TransportRequest` is
  `{ messages, signal?, maxTokens? }`. The prompt and tool declarations travel
  as system messages inside `messages`; a transport folds them with
  `resolveTranscript()` (or `collapseSystemMessages()` + `getCurrentTools()`).
  `streamChatCompletion(platform, config, messages, { signal, maxTokens })`
  lost its `systemPrompt`/`tools` options for the same reason. The wire format
  is unchanged by default.
- Kernel (P22): `Agent.messages` starts with a system message carrying the
  prompt (section `prompt`) and the tool declarations; later system messages
  appear when either changes. Hosts that render or count `messages` should skip
  `role: "system"`. `context` handlers no longer see system messages (pi); the
  new `context_with_system` event does. Logged entries are deep-frozen, so an
  in-place edit of `ctx.messages` throws.
- Kernel (P22, session log is the only truth): `Agent.messages` is now a
  read-only projection of the session log (a frozen array replaced after every
  write). Code that pushed onto it must call `agent.appendMessage(message)`;
  `ctx.messages` follows the projection. An Agent without `session` logs to a
  private `InMemorySessionStore` (one code path), so `navigateTo()` no longer
  throws `no_session`. With `session`, `initialMessages` only serves as the
  view until the session is loaded.
- Kernel (P22, pi 0.86.0 / 0.83.0): `AgentMessage` gains `SystemMessage`
  (`role: "system"`); `StopReason` gains `"pending"` (streaming partials seen
  in `message_start`/`message_update` now carry it instead of `"stop"`);
  `ToolCall.arguments` is `JsonObject` and `ToolResultMessage.details` is
  `JsonValue`. Exhaustive switches over `role` or `stopReason` need the new
  members.
- Kernel (P22, pi 1.2.0 session format): `SessionEntry` gains `usage`,
  `context_edit`, `label`, `model_change` and `thinking_level_change`;
  `compaction` gains `usage`/`systemMessage` and `branch_summary` gains
  `usage`. `SessionRecorder` methods return the appended entry, and entries are
  JSON-cloned on append.
- Kernel: `Agent.prompt()`, extension `sendUserMessage()` and the host action
  `submitPrompt()` now take `UserContent` (`string | (TextContent | ImageContent)[]`)
  instead of `string` (P20). Input hooks still receive the text projection and a
  rewrite keeps the image blocks. Hosts implementing `submitPrompt` must accept
  content arrays (`userContentText()` projects them back to text).
- CLI (security, P21-HF-2): endpoint and key env vars are scoped to one wire
  protocol. `OPENAI_BASE_URL`/`OPENAI_API_KEY` only feed `--provider openai`,
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` only feed `--provider anthropic`, and
  `TAU_BASE_URL`/`TAU_API_KEY` only the protocol `TAU_PROVIDER` names (openai when
  unset). Previously an OpenAI key in the env was sent to api.anthropic.com, or an
  Anthropic `-k` key to the OpenAI relay in `TAU_BASE_URL`. If you ran
  `--provider anthropic` with only `TAU_*` set, add `TAU_PROVIDER=anthropic` or
  use the `ANTHROPIC_*` names. Explicit `-b`/`-k` flags are unchanged.
- Kernel (P21-HF-6): `Usage.input` from the OpenAI-compatible client no longer
  includes cached prompt tokens (`input = prompt_tokens - cached_tokens`, pi
  v0.80.3). With `--pricing` the cached part was billed twice; consumers that
  read `usage.input` as "whole prompt" should add `cacheRead`.
- ext-feishu (security, P21-HF-1): project-level settings files
  (`.tau/settings.json`, `.pi/settings.json`) can no longer supply credentials
  (`appId`, `appSecret`, `encryptKey`, `verificationToken`) — only `domain` and
  `botOpenId`. A cloned repository could otherwise rebind your bot to another
  app. Deviation from pi-feishu.
- Kernel (P21-HF-8): tools without an object `parameters` JSON Schema are
  rejected — `registerTool()` and the `Agent` constructor throw
  `TauError("invalid_tool")` (pi 0.86.0).
- Kernel (P21-HF-11): extension `sendUserMessage()` during `input` /
  `before_agent_start` throws `busy`; the CLI and TUI `submitPrompt` host
  actions throw `busy` while a run is active. Both used to drop the message
  silently. Use `sendMessage({ deliverAs })` from those hooks.
- Kernel (P21-HF-16): `JsonlSessionRepo.create()` no longer writes the file;
  the header and earlier entries are written with the first message entry (pi
  0.99.0). `list()` sorts by the new `SessionMetadata.modified` (last
  activity) instead of creation time.
- examples/flutter/mcp-server (not an npm package): `--host` now defaults to
  `127.0.0.1` (P19). LAN access needs an explicit `--host 0.0.0.0`; the new
  `--tunnel` flag (Cloudflare Quick Tunnel, no account) is the remote path.
- CLI TUI (P27): `/tools` without arguments opens a picker that turns tools on
  and off (it toggled tool details; `/tools expand|collapse` and Ctrl+O still
  do that). `/export` writes HTML unless the path ends in `.jsonl` (pi).

### Added
- New packages (P30): `@yophon/tau-gateway` (the resident gateway core: one
  conversation per (channel, account, peer), queued input merged per turn,
  residency limits and idle unloading, owners and an allow list with pairing
  and owner codes, approvals in chat with short ids and a timeout, chat
  commands, channel plugins), `@yophon/tau-channel-weixin` (WeChat over the
  official iLink Bot protocol, ported from yo-agent: QR login, long polling with
  a persisted cursor, CDN media decryption, quotes, tool progress items) and
  `@yophon/tau-channel-feishu` (a Feishu/Lark channel plugin on ext-feishu's
  `FeishuClient`, installed under `~/.tau/gateway`). The CLI gains
  `tau gateway run|stop|status|login|channels|allow|revoke` and depends on the
  gateway and the WeChat channel (not on the Feishu SDK). See docs/gateway.md.
- CLI (P30): models.json reads pi's `input` (`["text", "image"]`); the
  gateway hands images to models that declare it.
- CLI (P29): `--mode json` (one run as pi's JSONL event stream; the prompt
  from `-p` or stdin; exit codes 0/1/130), `--mode rpc` (pi's RPC protocol:
  prompt with streamingBehavior, steer, follow_up, abort, sessions, models,
  thinking, compact, bash, export_html, stats, commands, plus
  `set_permission_mode`; `ctx.ui` and tool approvals as `extension_ui_request`,
  approvals a select with an `approval` field) and `--mode acp` (Agent Client
  Protocol v1 for editors such as Zed: a workspace per session cwd, approvals
  via session/request_permission, reads and writes through the client's fs
  methods, todo_write as the plan, permission modes as session modes, the
  client's MCP servers, session/load). See docs/rpc.md. The CLI now depends on
  `@yophon/tau-ext-mcp`.
- CLI (P28): `~/.tau/models.json` (a subset of pi's format: providers with
  `baseUrl`, `api` — `openai-completions` or `anthropic-messages` — `apiKey`
  as `$NAME`, `${NAME}`, `!command` or a literal, and `headers`; models with
  `contextWindow`, `maxTokens` and `cost`), `defaultProvider` /
  `defaultModel` / `defaultThinkingLevel` in `~/.tau/settings.json`,
  `--list-models`, and `-m provider/id`. `/model` lists the usable models and
  switches between them mid-session, protocol included; Ctrl+S in its picker
  saves the default. A resumed session goes back to its last model.
- Kernel (P28): `Agent.setModel(model, { transport, provider, api,
  contextWindow })` switches provider between requests (D21 addendum, D33);
  `SetModelOptions` is exported.
- New package `@yophon/tau-ext-web` (P28, pure `Platform`): `web_fetch` reads a
  page as markdown (its own HTML converter: main content, absolute links,
  lists, code, tables), text and JSON as is, images as image blocks, 50KB per
  call with `offset` paging; `web_search` over Brave, Tavily, Exa or SearXNG
  with the user's key (`webSearch` in settings, or `BRAVE_API_KEY` /
  `TAVILY_API_KEY` / `EXA_API_KEY`). The CLI loads it by default.
- CLI TUI (P27): slash commands `/mode` (picker or argument; bypass asks
  first), `/usage` (`/cost`: tokens and cost per turn), `/context` (what
  fills the window), `/import <file.jsonl>` (pi), `/init` (the model writes
  AGENTS.md), `/settings`, `/hotkeys` (pi), aliases `/status` and
  `/rename`; `/todos` and `/memory [edit|clear]` in the CLI's built-in
  extensions; `/agents` in ext-subagents; `/skills` and `/skill:<name>`
  (pi's skill block) in ext-resources; `/mcp [reconnect <server>]` in the MCP
  extensions. Typing after `/command ` completes its arguments.
- Kernel (P27, pi): `RegisteredCommand.getArgumentCompletions`,
  `UiCapability.editor` (optional; the TUI opens the external editor),
  `JsonlSessionRepo.importFile()` (pi importFromJsonl); `CommandCompletion` is
  exported.
- Kernel (P26a, pi 1.2.0): grep, find and ls tools with pi's parameters, output
  and limit notices, implemented in pure ES over the injected FileSystem (no
  rg/fd), so they work on every host; they skip `.git` and `node_modules` and
  honor `.gitignore`. edit applies several replacements per call (each must
  match once in the original, no overlaps, all or nothing). read returns
  png/jpg/gif/webp files as image blocks through the new optional
  `FileSystem.readBinaryFile` (host-node, OPFS and memory filesystems implement
  it). Coding tools carry pi's prompt snippets and guidelines. Exports:
  `createGrepTool`, `createFindTool`, `createLsTool`, `globToRegExp`,
  `globMatcher`, `parseGitignore`, `applyEdits`, `encodeBase64`.
- Subagents (P26b, after pi's subagent example and yo-agent): parallel runs (at
  most 8, 4 at a time), chains with `{previous}`, background runs whose result
  comes back as a follow-up message that starts a turn, and `/tasks` to list
  them. Agents are Markdown definitions (`name`, `description`, `tools`,
  `model`, optional `mode`): pi's worker, scout, planner and reviewer are built
  in, `~/.pi/agent/agents` and `~/.tau/agents` override them, and a trusted
  project's `.pi/agents` and `.tau/agents` override those. A subagent never gets
  the subagent tool and never runs in a more permissive mode than its parent;
  its approvals name it. Kernel `AgentSpawnOptions` gains `appendSystemPrompt`,
  `toolNames`, `model`, `thinkingLevel`, `permissionMode`, `label`, `detached`
  and `onEvent`; `ApprovalRequest` gains `subagent` and `detached`;
  `stricterMode` is exported.
- CLI (P26c): `todo_write` keeps a checklist for multi-step work (the whole
  list each call, one item in progress), restored with the session; the TUI
  draws it and shows the item in progress above the input box. Long-term
  memory: `memory_write`, `/remember` and `#fact` in the TUI append to
  `~/.tau/projects/<project>/MEMORY.md`, which is added to the system prompt
  as notes (last 200 lines).
- Permissions (P26d): `accept-edits` mode — file edits inside the working
  directory (and memory writes) run without asking, commands still ask;
  `--permission-mode accept-edits`, and Shift+Tab cycles supervised →
  accept-edits → autonomous → read-only. `isInsideCwd` is exported.
- CLI TUI (P25): approvals show what the call will do (the whole bash command, a
  diff for edit) and offer "Deny and tell the agent what to do instead", which sends
  your text with the denial; pickers, approvals and `ctx.ui` dialogs replace the input
  box instead of floating. Streaming markdown, per-tool views (read, write, edit,
  bash, codemode, tool_search, MCP as `server:tool`), a one-line status line (model,
  mode, context left, tokens, cost, branch, cwd, extension items), a grapheme-aware
  editor with correct CJK widths, bracketed paste (long pastes fold to
  `[Pasted #n · N lines]`), persistent prompt history in `~/.tau/history.jsonl`
  (`TAU_HISTORY=` turns it off), `/` command and `@` file completion. Resumed and
  switched sessions show their history.
- CLI TUI commands (P25): `/new`, `/clone`, `/session`, `/copy` (clip, pbcopy,
  wl-copy/xclip/xsel, else OSC 52), `/export [path]` (JSONL), `/trust` (saves the
  project trust decision; `/reload` applies it), `/clear`, `/reasoning`; `/resume`
  without an argument opens a picker (`/sessions` is an alias). Shift+Tab cycles the
  permission mode supervised → autonomous → read-only; bare `exit`/`quit` quit.
- CLI TUI (P25): while it runs, console output from extensions, SDKs and libraries
  is captured: all of it to `~/.tau/logs/tui-<date>.log`, warnings, errors and stderr
  also as one notice line each, so nothing draws over the screen. Notices extensions
  send in `session_start` are visible (they were swallowed before).
- Kernel (P25): `Agent.setPermissionMode()` / `getPermissionMode()`. The new mode
  applies from the next tool call and to subagents spawned afterwards; it is not
  written to the session, so a resumed session takes its mode from the host again.
- New package `@yophon/tau-ext-codemode` (P24e, pi 0.99.0–1.2.0): the `codemode`
  tool. The model writes JavaScript that calls tools (`tools.<name>()`, resolving to
  structured results where declared), finds unlisted ones with `searchTools()` /
  `describeTool()` / `describeNamespace()`, and keeps JSON values with
  `store()`/`load()` (per branch). Every nested call passes hooks, policy and
  approval. The pure entry takes an injected sandbox; `@yophon/tau-ext-codemode/node`
  runs scripts in `@earendil-works/pi-codemode`'s worker-thread QuickJS sandbox
  (pinned 1.2.0).
- CLI (P24e): `tool_search` and `codemode` ship as built-in extensions, inactive
  until `--tools +codemode` / `--tools +tool_search` (or an MCP server with
  codemode/deferred exposure); `codemode.mode` (`on`/`only`) and
  `codemode.inlineBudget` are read from `~/.tau/settings.json` and a trusted
  project's `.tau/settings.json`. The default system prompt's tool line follows the
  tools the request declares (`--tools`, loaded tools, codemode `only`) and lists
  their guidelines.
- New package `@yophon/tau-ext-tool-search` (P24d, pi 0.99.0–1.2.0): the
  `tool_search` tool (registered inactive) ranks `codemode`/`deferred` tools with
  BM25 and activates the matches for the next request; the activation is recorded
  in the transcript. `Bm25Ranker`, `tokenize` and `createToolSearchDocument` are
  exported for codemode's `searchTools()`.
- ext-mcp / ext-mcp-http (P24d, pi 0.99.2–1.2.0): per-server `exposure` and
  per-tool `toolExposure` (`direct` default, `codemode`, `deferred`, `hidden`),
  `description`; tools carry a namespace (`mcp__<server>`, server instructions) and a
  `CallToolResult` output schema, and return the whole result as
  `structuredContent`. Servers with indirect tools are listed in an `mcp_servers`
  system prompt section, and codemode/tool_search are activated for them. HTTP
  connects retry twice on network errors and 408/429/5xx; `tools/list_changed`
  re-registers a server's tools and withdraws dropped ones as hidden (over HTTP via
  a GET stream: on in ext-mcp, `serverNotifications: true` in ext-mcp-http); a tool
  that reaches a server still connecting waits for it.
- Kernel (P24c, pi 0.99.0): tools can call tools. A tool's `execute` context has
  `executeTool(name, args, options?)` and `tools` (the callable set): the nested call
  runs through the same tool_call hooks, validation, policy and approval as a model
  call, gets the id `<parent>/<n>`, and its hook and tool_execution events carry
  `parentToolCallId`. It stays out of the transcript; the calling tool's result
  message records it in `nestedCalls` (pi limits; read/write/edit keep their path,
  D29) and adds its usage. Compaction and branch summaries list the files nested
  calls touched. One `PreflightLock` per agent tree (shared with subagents,
  `AgentOptions.preflightLock`) keeps hooks and approvals one at a time, so two
  parallel subagents no longer ask for approval at once. Approval requests carry
  `parentToolCallId`.
- Kernel (P24c, pi 0.99.0): `bash` declares an `outputSchema` and returns
  `structuredContent` `{ output, truncated, exit_code, wall_time_seconds }` (up to
  1 MiB, head and tail kept), also on a non-zero exit; the model-facing text is
  unchanged.
- Kernel (P24b, pi 0.99.0–1.2.0): tool `exposure` (`direct` / `model-only` /
  `codemode` / `deferred` / `hidden`), `namespace` (with `aliases`), `outputSchema` and
  `ToolResult.structuredContent` (a `tool_result` handler that replaces `content`
  without returning `structuredContent` drops it), `reachesTools`, `defaultActive`,
  `prepareLoadout` (rewrite declared descriptions, hide declarations from requests
  while keeping the tools callable and recorded), `promptSnippet`/`promptGuidelines`.
  `getAllTools()` reports exposure and namespace; new `Agent.getCallableTools()` and
  `Agent.getDeclaredTools()`.
- CLI (P23e): `--tools/-t <list>` (names pick built-ins, `*` all, `+name`/`-name`)
  and `--no-tools`; `/tree <id> --no-summary` in the REPL and a no-summary
  fallback in the TUI when a branch summary fails; REPL `/compact` and `/tree`
  can be cancelled with Ctrl+C; hosts attach their actions before `session_start`
  and support `ctx.shutdown()`. host-node reports a command killed by a signal as
  exit code 128 + signo. ext-resources follows pi 1.2.0 template arguments
  (`${N:-default}`, one pass), strips UTF-8 BOMs, warns on unclosed frontmatter and
  ends long fallback descriptions with "..."; the CLI trust and permission stores
  and ext-feishu settings tolerate a BOM. MCP tool annotations can raise a tool
  to high risk with `riskFromAnnotations` (never lower it). Kernel:
  `truncateMiddle()`, `limitToolText()`; the write/edit mutation queue resolves
  relative paths against the filesystem cwd.
- Kernel (P23d): `before_provider_headers` (pi 0.80.4; every provider call,
  summaries included), `Agent.model`/`setModel()`, `Agent.thinkingLevel`/
  `setThinkingLevel()` (logged as `model_change`/`thinking_level_change`),
  `api.setModel()`/`getThinkingLevel()`/`setThinkingLevel()`, `ctx.model`/
  `ctx.thinkingLevel`, `AgentOptions.thinkingLevel`, a per-model `pricing`
  resolver, ThinkingLevel `"max"`, `OpenAICompatConfig.maxTokensField`
  (`TAU_MAX_TOKENS_FIELD`) and `input` (`TAU_INPUT=text`: images become pi's
  placeholder for text-only models), `describeError()` (network errors now name
  the innermost cause, e.g. ECONNREFUSED), `normalizeToolCallId()`,
  `sanitizeSurrogates()`, `applyHeaderChanges()`. Summary requests ask for no
  prompt-cache write. The agent stops reading a stream at its final message.
- Kernel (P23c): `InlineExtension { name, factory }`, `ExtensionRegistry.loadErrors` /
  `warnings` / `invalidate()` (a replaced registry's api and ctx throw
  `stale_extension`; the TUI's /reload uses it), `api.getCommands()`,
  `api.getSessionName()`, `ctx.isProjectTrusted()` (`AgentOptions.isProjectTrusted`,
  inherited by subagents), `ctx.cwd`, `RegisteredToolRenderEvent.durationMs` and
  `durationMs` on the `tool_result` AgentEvent.
- Kernel (P23b): active tool set — `Agent.getActiveTools()`, `getAllTools()`,
  `setActiveTools()` and the same three on `ExtensionAPI` (pi); `terminate` on
  `ToolResult` and `ToolCallEventResult` (pi 0.84.1); `textResult()`,
  `toolResultText()`. Subagents inherit the parent's retry settings and its
  `tool_call`/`tool_result` guards (no other events replay into the child).
- Kernel (P23b): actionable `turn_end` (outcome, messageEntryId,
  toolResultEntryIds; handlers return `{ entries, continue }` with custom /
  custom_message drafts), `agent_before_settle`, `agent_settled { aborted }`
  (extension event and AgentEvent; runs started from its handlers wait until all
  returned), `AgentOptions.finishTurn` (`{ action: "end" }`, pi), and
  `ExtensionRegistry.reportError()`.
- Kernel (P23a): `Agent.abort()` stops whatever holds the agent — a run with
  its retry backoff, a host compaction, a branch summary — and `ctx.abort()`
  reaches all of them. `Agent.isIdle`, `Agent.signal`, `Agent.clearQueue()`
  (returns the cleared steering/follow-up messages, pi clearQueue);
  `ctx.isIdle()`, `ctx.signal`, `ctx.hasPendingMessages()`, `ctx.shutdown()`
  (host action `shutdown`). Summaries are retried on transient errors under
  the agent's retry settings (`summarization_retry_*` AgentEvents; `compact()`
  and `navigateTo()` take an `onEvent` callback). `RetrySettings.maxAgentDelayMs`
  caps each backoff (default 60s, pi); `retryDelayMs`, `retryAssistantCall`,
  `getSummarizationFailure`, `compactionSettingsForWindow` exported.
- Kernel (P22): `Agent.flush()` waits until queued log writes (an idle
  extension `sendMessage`, `appendEntry`, `setLabel`) have landed in `messages`;
  the CLI and TUI await it before rendering what an extension command added.
- Kernel (P22, pi extension surface): `ctx.sessionManager` — a synchronous,
  read-only view of the session log (pi ReadonlySessionManager subset:
  getEntries/getBranch/getLeafId/getLeafEntry/getEntry/getLabel/
  buildContextEntries/buildSessionProjection/session id, file, cwd, name);
  `ctx.getSystemPrompt()` returns the prompt the transcript replays to;
  `api.setLabel(entryId, label)` writes `label` entries (host action
  `setLabel`).
- Kernel (P22, D19): usage accounting from the log. `CompactionResult.usage`
  and the compaction / branch_summary entries record the summarization calls
  (priced with the host pricing); `ToolResult.usage` flows into
  `ToolResultMessage.usage`, and ext-subagents reports the child run's usage
  there; `runSubagent` children inherit `pricing`. `Agent.getSessionUsage()` /
  `sumSessionUsage(entries)` fold every branch (pi getSessionStats).
  `estimateProjectedContextTokens()`, `generateSummaryWithUsage()`,
  `combineUsage()`.
- Kernel (P22): system prompt and tools enter the transcript (pi 0.86.0). The
  agent appends a system message only when the effective prompt — including a
  `before_agent_start` rewrite (D27) — or the tool set changes; compaction
  checkpoints them in `CompactionEntry.systemMessage`.
  `OpenAICompatConfig.midConversationSystemMessages` sends later system
  messages in place instead of folding them into the first one.
- Kernel (P22): `AgentOptions.verifyTranscript` (default on): before every
  request the projection is rebuilt from a JSON round trip of the session log
  and must equal what is about to be sent; a mismatch throws
  `TauError("invalid_state")`. `context_with_system` extension event.
- Kernel (P22): `projection.ts` — `buildSessionProjection()` /
  `buildContextEntries()` (pi session-manager) and the transcript helpers
  `getCurrentSystemMessage`, `getCurrentTools`, `collapseSystemMessages`,
  `getToolStateChanges`, `diffSystemPromptSections` (pi transcript.ts).
  `SessionRecorder.appendContextEdit()` / `appendLabel()` / `attach()`,
  `Agent.appendMessage()` / `entryIdOf()`.
- Kernel (P22, pi 1.1.0 / 1.2.0): `AssistantMessage.rawStopReason` (both
  transports), `durationMs` (measured by the agent for every transport);
  `ToolResultMessage.durationMs` and `tool_execution_end.durationMs` (covers
  `tool.execute` only); `ToolResultMessage.usage`. The Anthropic transport now
  records `responseId` and stamps the message at request start.
- Kernel + CLI (P21a): project context files. `loadProjectContextFiles(fs, { cwd, globalDir })`
  finds `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` (pi order, first per
  directory) in the global dir and every directory from the root down to cwd;
  `renderProjectContext()` renders pi's `<project_context>` section. The CLI
  appends it to the system prompt (also with `--system`), re-reads it on TUI
  `/reload`, and `-nc` / `--no-context-files` turns it off. Global dir: `~/.tau`.
- ext-provider-anthropic (P21-HF-5): `effort` (sent as `output_config.effort`),
  `thinkingDisplay` ("summarized" default, "omitted"), and
  `anthropicThinkingForLevel(level, mode)` mapping the shared thinking levels
  onto the wire. CLI: `TAU_ANTHROPIC_THINKING=budget` keeps budget tokens for
  pre-4.6 models; `TAU_MAX_TOKENS` sets the Anthropic output cap.
- Kernel (P21-HF-9): `session_compact_failed` extension event and
  `compaction_failed` agent event.
- Kernel (P21-HF-12): `ExtensionRegistry.setErrorSink()` — once set,
  notification handlers (agent/turn/message/tool/session events) that throw are
  reported to the sink and the remaining handlers still run. The CLI prints them
  to stderr, the TUI into the transcript.
- Kernel (P21-HF-7): `repairJson()` / `parseJsonWithRepair()` (pi v0.80.3).
- Kernel (P21-HF-6): `transformMessages()` (pi's cross-model replay rules) and
  `AssistantMessage.responseId` / `responseModel`; `OpenAICompatConfig.replayEmptyReasoning`.
- `@yophon/tau-ext-feishu` (P20): Feishu/Lark WebSocket + REST channel extension
  ported from pi-feishu — inbound text/post/media/card parsing, media download,
  dedupe/expiry, Typing + CrossMark reactions, editable tool-progress card,
  chunked replies, `/new` `/stop` `/queue` `/compact` `/status` `/help` `/feishu`
  commands, and `send_to_feishu` / `send_image_to_feishu` / `send_file_to_feishu`
  tools. Inbound images are handed to the kernel as image blocks.
- Kernel: `UserContent` type and `userContentText()` helper exported.

### Security
- CLI (P21-HF-1): project extensions under `.tau/extensions` were imported — and
  their top-level code executed — **before** the trust decision, so entering an
  untrusted directory ran its code even though the CLI then reported the
  extensions as skipped. Affects 0.1.0–0.2.0, including `/reload`. Trust is now
  decided first and files are imported only when trusted. The loader also only
  lists regular files (a directory named `x.js` used to abort startup).
  host-node exports `listExtensionFiles()` / `importExtensionFiles()` for hosts
  that gate on trust.
- Kernel (P21-HF-3): the default policy rates Windows destructive commands high
  risk — `rd`/`rmdir /s`, `del`/`erase /s|/q|/f`, `format X:`, `diskpart`,
  `reg delete`, PowerShell `Remove-Item -Recurse/-Force`. The Node host routes
  such commands to cmd.exe, where autonomous mode previously ran them without
  approval.
- Kernel (P21-HF-4): an abort now stops tool calls that have not started yet.
  Calls prepared before the abort (e.g. while a later call of a parallel batch
  waited for approval) and the remaining calls of a sequential batch used to run
  anyway; they now return `Operation aborted`. An aborted run no longer asks
  the approval handler. Mirrors pi v0.80.3 `prepareToolCall` and pi 0.85.0.

### Fixed
- ext-feishu (P25): the Lark SDK logs below warn level no longer reach the console
  (its `[info]` connection logs drew over the TUI); SDK warnings and errors go through
  the extension's own warnings.
- ext-resources (P25): a conventional skills or prompts directory that does not
  exist is skipped quietly instead of reporting a `list_failed` warning on every start.
- Kernel (P22): the barrel now exports `ToolUpdateStream`,
  `ExtensionErrorSink`, `SessionCompactFailedEvent`, `ContextWithSystemEvent`
  and `mutationQueueKey`, which public signatures already referenced; a
  barrel-completeness test keeps it that way (pi 0.86.0 #9642).
- Kernel (P22, pi 0.86.0 #9740): a tool-result tail larger than the keep budget
  made the cut fall back to the first message, so compaction sent an empty
  summary request and wrote an entry that kept everything — every turn. The cut
  now keeps the tail's tool call (split turn) and nothing-to-summarize skips.
- Kernel (P22, pi estimateProjectedContextTokens): after a compaction the kept
  tail's assistant usage still described the pre-compaction context, so
  `getContextUsage()` and the next turn's threshold check could compact again
  right away. Usage recorded before the latest compaction or context edit is
  no longer trusted.
- Kernel (P22, pi 0.80.4): custom messages and branch summaries count toward
  the keep budget and turn detection (cut points follow the projection).
- Kernel (P22, pi 0.86.0): a split turn with no earlier history kept "No prior
  history." and lost the previous compaction's summary; it now carries over.
  The previous kernel compaction's file lists carry over too.
- Kernel (P22, pi 1.2.0 / 0.87.1): summary serialization omits thinking (a
  summary request could exceed the context it summarized); the turn-prefix
  prompt uses pi's `# Conversation` / `# Instructions` structure.
- Kernel (P22): session entry ids were sliced from a uuidv7, whose leading
  digits are the clock: every entry after the first within ~65 s fell back to a
  full UUID. Ids are now 8 random hex digits, as in pi.
- Kernel (P22): an auto-retried failure used to be popped from memory only,
  so a resumed session sent the abandoned attempt to the model again. It now
  leaves the context through a `context_edit` omission (pi
  `_omitRecoveryAttempt`) and stays in the log.
- Kernel (P22): a session file with a malformed line (a crash mid-write) no
  longer fails to open — the line is skipped (pi `parseSessionEntryLine`) — and
  a missing final newline is repaired before the next append (pi 0.84.4).
  Unknown entry types stay in the tree as chain links instead of orphaning
  their children, so sessions written by pi open. `content: null` normalizes
  to empty content (pi 0.80.4).
- Kernel (P22): OpenAI-compatible tool-call fragments are attributed as in pi
  (index, then id, else a new call; id and name set once). A server that omits
  `index` used to merge two calls into one named e.g. `readbash`. A bare
  arguments fragment continues the latest call (tau deviation).
- Kernel (P22): a `tool_call` handler rewriting nested arguments in place no
  longer mutates the logged assistant message (deep copy).
- CLI/ext-provider-anthropic (P21-HF-5): `/thinking` on `--provider anthropic`
  sent `budget_tokens` for every level, which current Claude models (Opus 4.7+,
  Sonnet 5.x, Haiku 5.5, Fable) reject with HTTP 400. Levels now map to adaptive
  thinking + `output_config.effort` (pi v0.80.3 forceAdaptiveThinking); "none"
  requests the lowest effort instead of `{type:"disabled"}`. Signed thinking
  blocks with empty text are replayed instead of dropped — with the API default
  `display: "omitted"` that used to discard all reasoning between tool turns.
- Kernel (P21-HF-6): the OpenAI-compatible client reads the first non-empty of
  `reasoning_content` / `reasoning` / `reasoning_text` (an empty
  `reasoning_content` used to mask a populated `reasoning`), records the field
  and replays same-model reasoning under it. Assistant turns from another model
  or protocol go through `transformMessages`: their thinking becomes text, so an
  Anthropic signature can no longer leak onto the wire as a field name; errored
  or aborted turns are not replayed and orphaned tool calls get a synthetic
  result. DeepSeek endpoints (host deepseek.com) get `reasoning_content: ""` on
  replayed assistant turns without reasoning, as pi does. Messages are stamped
  with the request start time.
- Kernel (P21-HF-7): tool-call arguments with raw control characters or invalid
  escapes (`d` in a regex) are repaired before parsing instead of failing the
  call; the Anthropic provider uses the same parser.
- Kernel (P21-HF-8): a model call to a schemaless tool threw a TypeError out of
  `prompt()` and left an unpaired tool call that broke every later request; a
  tool that bypasses registration now gets an error result.
- Kernel (P21-HF-9): a failing automatic or queued compaction no longer throws
  out of `prompt()` — `turn_end` and `agent_end` were skipped, which left
  ext-feishu's channel busy until restart. The turn continues uncompacted.
  `Agent.compact()` called directly still throws.
- Kernel (P21-HF-10): `resume()` (the run behind `sendMessage({ triggerTurn })`)
  applies `before_agent_start`; it used the base system prompt, dropping
  extension-injected skills and the provider's prompt cache.
- Kernel (P21-HF-13): `edit` writes `newText` literally — `$$`, `$&`, `` $` `` and
  `$'` were interpreted as replacement patterns and corrupted the file.
- Kernel/host-node (P21-HF-14): Windows spellings of one file (`C:a.ts`,
  `c:/a.ts`) share one mutation queue; on Windows `/c/...`, `/cygdrive/c/...`
  and `/mnt/c/...` paths map to `C:...` instead of a phantom tree on the
  current drive.
- ext-mcp (P21-HF-12/15): servers connect in parallel and one unreachable
  server no longer blocks startup or the other servers' tools; shutdown closes
  in-flight connections. Image, audio and binary resource content becomes a
  short placeholder instead of base64 dumped into the transcript.
- ext-feishu (P21-HF-15): inbound images are inlined only when their signature
  is PNG, JPEG, GIF or WebP and the base64 is at most 5 MiB. BMP and unknown
  files used to be sent as `image/png` (and up to 20 MiB), and one bad image
  block failed every later request of the session. Skipped images stay a file
  path with the reason.
- CLI (P21-HF-16): `--continue` resumes the most recently active session and
  a start-up without a prompt no longer leaves an empty session behind (the two
  combined resumed an empty session). The default system prompt names the
  tools actually loaded (read-only mode: `read` only).
- host-node: the Windows cmd.exe routing heuristic only matches unambiguous
  cmd syntax. `set -e`, `type`, `tree`, `whoami`, `ps aux` (the word `aux`),
  `date +%Y-%m` and printf format strings used to be sent to cmd.exe instead of
  Git Bash. `rmdir /s`, `%VAR%` as a word, `>nul`, drive paths, `.bat` and the
  Windows-only command names still route to cmd.exe.
- CLI: the user-level `~/.tau` directory now honors `HOME` when set. On Windows
  `os.homedir()` reads `USERPROFILE` and ignored the override, so e2e runs loaded
  the real `~/.tau/extensions` (and hung on a Feishu WebSocket).
- CLI e2e: sandbox teardown retries `rm` on Windows `EBUSY` (a just-exited child
  still holding its cwd).
- Kernel: session file paths reuse the host directory's separator (Windows: a
  mixed `C:\...\dir/file` `parentSession` no longer disagrees with `path.join`).
- CLI e2e: the SIGINT test is skipped on Windows (`child.kill("SIGINT")` cannot
  deliver a signal there).
- Repo: `.gitattributes` pins LF line endings (Windows `core.autocrlf` produced
  phantom modifications across the tree).
- examples/flutter/mcp-server: `--tunnel` — spawns the system `cloudflared`
  for a public https Quick Tunnel URL (printed with the token for the phone
  app); auth hardening (constant-time token compare, per-IP exponential
  lockout after repeated failures).

## [0.2.0] - 2026-07-21

### ⚠ Breaking
- Kernel/CLI/TUI: multi-tool batches now execute **in parallel by default**
  (P18, pi's `ToolExecutionMode` default). Preflight (extension `tool_call`
  hooks, validation, policy/approval) stays sequential in assistant source
  order and tool results still land on the wire in source order, but
  `tool_execution_update`/`tool_execution_end` extension events and TUI tool
  cards now interleave in completion order. Event-order observers (extensions,
  renderers) that assumed strict per-tool sequencing are affected. Restore the
  old behavior with `AgentOptions.toolExecution: "sequential"`,
  `--tool-execution sequential`, or `TAU_TOOL_EXECUTION=sequential`; a tool
  marked `executionMode: "sequential"` downgrades its whole batch.
- Kernel: `runCompaction`, `generateSummary`, `completeText`, and
  `generateBranchSummary` now take a `ChatTransport` instead of
  `(platform, config)` (P16); `generateBranchSummary` reads the token budget
  from `options.contextWindow`. Callers going through `Agent` are unaffected.
- CLI/TUI now default to `--permission-mode supervised` (P15): medium/high-risk
  tool calls (any bash command, any file write) prompt for approval in a TTY
  and are **denied** in headless (piped `-p`) runs. Restore the old behavior
  with `--permission-mode autonomous` or `TAU_PERMISSION_MODE=autonomous`.
  The kernel library default stays `autonomous` — `new Agent(...)` consumers
  are unaffected unless they opt in.

### Added
- Kernel: `ChatTransport` injection seam (P16, D3's reserved extension point).
  `AgentOptions.transport` swaps the wire protocol per agent; the default
  `createOpenAICompatTransport(platform, config)` wraps the existing client
  with zero behavior change. The agent loop, compaction, and branch summaries
  all speak through the seam; subagents inherit it. New exports:
  `ChatTransport`, `TransportRequest`, `createOpenAICompatTransport`,
  `withStallTimeout`, the summary wire-framing constants, and an optional
  `OpenAICompatConfig.api` label. `ThinkingContent` gains pi's optional
  `thinkingSignature`/`redacted` fields; `streamChatCompletion` accepts
  `maxTokens`.
- `@yophon/tau-ext-provider-anthropic` (new package): pure-Platform Anthropic
  Messages transport — hand-written protocol (no SDK), kernel SseParser,
  bare-engine safe. Native thinking streaming (signature round-trip,
  redacted blocks), tool_result **images as base64 blocks** (no more
  `[image omitted]` on this path), `cache_control` auto placement (system +
  last tool + last user message, pi's layout), usage cacheRead/cacheWrite
  truth (combines with `--pricing` for real costs), pi's stop_reason mapping
  and message transforms (dropped error/aborted turns, synthetic results for
  orphaned tool calls, cross-model degradation).
- CLI: `--provider anthropic` / `TAU_PROVIDER` (flag validates hard, env
  warns and degrades). With it, `--base-url` becomes optional
  (api.anthropic.com), an API key is required, `/model` switches propagate to
  the transport, and `/thinking` levels map onto Anthropic budget tokens
  (pi's defaults: minimal 1024 / low 2048 / medium 8192 / high+xhigh 16384).
- Purity gate now covers pure-Platform extension packages (ext-mcp-http,
  ext-provider-anthropic): same source scan as the kernel plus a neutral
  esbuild bundle with only the kernel external.
- Kernel: first-class permission system (P15, D20 — no pi counterpart).
  `PermissionMode` (read-only/supervised/autonomous/bypass) × static risk
  rules (protected paths, dangerous bash patterns) → allow/ask/deny before
  every tool execution; `ask` resolves via `AgentOptions.onApproval` ??
  `ui.confirm` and degrades to deny when neither exists. Denials are normal
  error tool results — the loop continues. Subagents inherit the permission
  stance. New exports: `PermissionMode`, `RiskLevel`, `PolicyDecision`,
  `ToolPolicy`, `ApprovalRequest`, `createDefaultPolicy`,
  `resolvePolicyAction`, `DEFAULT_PROTECTED_PATHS`, `validateToolArgs`.
- Kernel: tool arguments are validated against the tool's JSON Schema
  (subset) before execution; malformed calls return an error result the
  model can self-correct. Extension tools may self-declare risk via
  `registerTool(tool, { risk })` (built-in names cannot be downgraded).
  `createCodingTools(caps, { mode: "read-only" })` registers only `read`.
- CLI/TUI: `--permission-mode` / `TAU_PERMISSION_MODE`; approval prompts
  (REPL `[y]es/[a]lways/[N]o`, TUI "Allow once / Always allow / Deny"
  selector); "always allow" persists per (tool, rule fingerprint) to
  `~/.tau/permissions.json`; the TUI footer shows the active mode.
- host-node: `digestDirectory` — trust records in `~/.tau/trust.json` now pin
  a sha256 content digest of the project extensions directory; changed
  content re-triggers the trust question (legacy boolean entries are
  upgraded in place without re-asking).
- Kernel: optional `AgentOptions.pricing` (`ModelPricing`, USD per million
  tokens) fills `usage.cost` on assistant messages; without it cost stays
  zero ("unknown"). tau still ships no pricing data — hosts supply prices.
  Cache token prices are optional and uncounted when omitted. New exports:
  `ModelPricing`, `computeUsageCost`.
- CLI/TUI: `--pricing "in=0.5,out=2[,cacheRead=...][,cacheWrite=...]"` flag
  and `TAU_PRICING` env; the TUI footer shows real accumulated cost when set.

### Changed
- Kernel: token estimation is now CJK-aware (P14). CJK-range characters count
  ~1 token each instead of pi's chars/4, which undercounted Chinese/Japanese/
  Korean text 3-4x and delayed auto-compaction. Mixed/CJK-heavy sessions will
  see compaction trigger earlier (a correction, not a regression); pure-ASCII
  behavior is mathematically unchanged. New export: `estimateStringTokens`.
- Kernel: the compaction summary prompts append an identifier-preservation
  rule (UUIDs, hashes, URLs, paths must be preserved verbatim) so summaries
  can no longer strand the agent by paraphrasing opaque identifiers.

## [0.1.1] - 2026-07-17

### Added
- `@yophon/tau-ext-mcp-http` — zero-dependency Streamable HTTP MCP client
  built entirely on the kernel's `Platform` seam, so it runs on bare engines
  (QuickJS/JavaScriptCore via flutter_js) where the official SDK cannot.
  Idempotent `connect()` with silent offline degradation and 404 re-handshake;
  protocol pinned to `2025-06-18` with negotiated fallback.
- Kernel: optional `PlatformResponse.headers` (`PlatformResponseHeaders.get`)
  so header-dependent consumers (MCP-Session-Id, content-type) work; the
  default platform passes native headers through, adapters may omit them.
- `examples/flutter/` — phone-side agent (kernel in flutter_js) plus a
  zero-tau computer-side MCP server; bare-engine MCP round-trip e2e
  (`smoke:quickjs:mcp`) in CI.

## [0.1.0] - 2026-07-16

Initial release.

- `@yophon/tau-kernel` — runtime-agnostic agent kernel: OpenAI-compatible
  streaming, tools, extensions (25+ pi-mirrored hooks), pi v3 sessions,
  compaction, branching, retry/stall-watchdog, pure-ES UTF-8 decoder.
- `@yophon/tau-host-node` / `host-browser` / `host-weapp` / `host-rn` —
  capability providers and Platform adapters for Node, browsers (OPFS),
  WeChat mini-programs, and React Native (Expo).
- `@yophon/tau-cli` — terminal frontend (`tau`): readline REPL, pi-tui TUI,
  one-shot `-p` mode; ships npm-shrinkwrap.json.
- `@yophon/tau-ext-subagents` / `ext-mcp` / `ext-resources` — subagent `task`
  tool, MCP client bridge, pi-compatible skills & prompt templates.
