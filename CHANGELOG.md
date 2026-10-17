# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

## [Unreleased]

### ⚠ Breaking
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

### Added
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
