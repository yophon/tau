# tau

**English** | [简体中文](README.zh-CN.md)

Runtime-agnostic coding agent kernel. The kernel is pure ECMAScript plus one
injectable platform seam; every host capability (filesystem, shell, HTTP,
UI, …) is provided by plugins. BYOK only. The kernel ships an OpenAI-compatible
client; other protocols plug in through the `ChatTransport` seam — an Anthropic
Messages transport ships as an extension package.

Architecture and interface design are heavily inspired by
[pi](https://github.com/earendil-works/pi) (MIT), pushed one step further:
where pi's kernel is browser-safe, tau's kernel assumes nothing beyond the
language standard — every non-ECMAScript API is resolved through the `Platform`
interface, so hosts like WeChat mini-programs or React Native only need to
inject a small adapter instead of polyfilling globals.

## What works today

- **Agent loop** — streaming, tool calls, steering while it runs, follow-up
  queues, abort, retry with backoff. Provider failures become
  `stopReason: "error"/"aborted"` messages (pi semantics). Besides Chat Completions,
  tau speaks the Anthropic Messages, OpenAI Responses and Gemini APIs natively;
  `--fallback-model` switches models when a request keeps failing.
- **Coding tools** — read (images too), write, edit, bash (and `powershell` on
  Windows) with background commands, grep / find / ls in pure ES; Codex's
  `apply_patch` on request (`--tools +apply_patch`). Checkpoints before every
  prompt's file edits, restored with `/rewind`; optional loop detection. The CLI adds
  `todo_write`, long-term memory ([docs/memory.md](docs/memory.md)),
  `session_search`, `web_fetch` / `web_search`, `ask_user`, `/loop` and
  scheduled prompts, `monitor`, and `push_notification`.
- **Permissions** — five modes (read-only, supervised, accept-edits, autonomous,
  bypass) and Claude Code's `permissions.allow/ask/deny` rules
  ([docs/permissions.md](docs/permissions.md)); user hooks in Claude Code's
  format ([docs/hooks.md](docs/hooks.md)).
- **Models and settings** — providers and models in `~/.tau/models.json` (pi's
  format), `/model` switches mid-session across protocols; settings in
  `~/.tau/settings.json` with pi's key names ([docs/settings.md](docs/settings.md)).
  `HTTP_PROXY` / `HTTPS_PROXY` reach every request.
- **Sessions** — pi v3 JSONL on disk: `--continue`, `-r` (pick one), `--session <id|name>`, `/tree`, `/fork`, automatic
  compaction with pi's algorithm, `/handoff`; `tau --worktree` and
  `enter_worktree` for a session in its own git worktree
  ([docs/worktrees.md](docs/worktrees.md)). A resident server keeps sessions
  running after a terminal closes, and several terminals share one session
  (see "Resident server" below).
- **Subagents** — one, parallel, chain or background, from Markdown agent
  definitions; `send_message` continues one; worktree isolation
  ([docs/subagents.md](docs/subagents.md)).
- **Connectors** — MCP over stdio and HTTP (2026-07-28 with fallback to the
  2025 handshake, OAuth, prompts as commands, `@` resources, elicitation),
  language servers with diagnostics after edits and an `lsp` tool, credentials
  out of the model's reach ([docs/connectors.md](docs/connectors.md)).
- **Extensions** — pi-mirrored API (lifecycle events, tools, commands, flags,
  renderers, widgets, shortcuts); skills and prompt templates built in.
- **Hosts** — terminal (full-screen or inline TUI, REPL, one-shot `-p`, JSON,
  RPC, ACP), browser (OPFS), WeChat mini-program, React Native (Expo), a phone
  (Flutter, kernel in QuickJS), and a bare QuickJS engine — each verified
  end-to-end, most in CI.

The kernel's only host dependency is the four-method `Platform` seam, so the
agent loop runs anywhere with a JS engine and an HTTP path to an
OpenAI-compatible endpoint. Whether that loop is also a *useful* coding agent
depends on the capabilities the host gives it — no shell means no `bash` tool,
unless a remote one is wired in over MCP (the Flutter demo's story). See
[docs/architecture.md](docs/architecture.md#示例宿主与可移植性) for the reach and
its boundaries.

## Packages

| Package | Role | May touch the runtime? |
|---------|------|------------------------|
| `@yophon/tau-kernel` | Agent loop, OpenAI-compatible streaming client, sessions, compaction, branching, tools, permissions, extension system, capability interfaces | **No** — enforced by `npm run check:purity` |
| `@yophon/tau-host-node` | Filesystem, bash and PowerShell, background commands, image resizing for Node.js | Yes |
| `@yophon/tau-host-browser` | OPFS and in-memory filesystems, browser session repo | Yes |
| `@yophon/tau-host-weapp` | WeChat mini-program `Platform` adapter (`wx.request` chunked streaming) | Yes |
| `@yophon/tau-host-rn` | React Native (Expo) `Platform` adapter over `expo/fetch` | Yes |
| `@yophon/tau-protocol` | tau's client protocol (tau/1): types, a JSON-RPC peer, transports and a typed client | **No** — pure ES |
| `@yophon/tau-cli` | Terminal frontend: TUI, REPL, one-shot, JSON / RPC / ACP modes | Yes |
| `@yophon/tau-ext-subagents` | The `subagent` tool and `send_message` over Markdown agent definitions | No direct runtime API |
| `@yophon/tau-ext-mcp` | MCP for Node: the ext-mcp-http core plus stdio servers and OAuth sign-in | Yes — child processes |
| `@yophon/tau-ext-mcp-http` | Pure-ES MCP client and extension core (Streamable HTTP), zero dependencies | **No** — pure `Platform` |
| `@yophon/tau-ext-provider-anthropic` | Anthropic Messages `ChatTransport`: native thinking, prompt caching, images in tool results | **No** — pure `Platform` |
| `@yophon/tau-ext-provider-openai-responses` | OpenAI Responses `ChatTransport`: reasoning effort, encrypted reasoning replayed statelessly | **No** — pure `Platform` |
| `@yophon/tau-ext-provider-google` | Gemini API `ChatTransport`: thinking levels and budgets, thought signatures | **No** — pure `Platform` |
| `@yophon/tau-ext-web` | `web_fetch` (HTML to markdown) and BYOK `web_search` (Brave, Tavily, Exa, SearXNG) | **No** — pure `Platform` |
| `@yophon/tau-ext-tool-search` | `tool_search`: BM25 over deferred tools, loading the matches | No — pure ES |
| `@yophon/tau-ext-loop-detection` | Stops a run that keeps repeating the same tool call (Gemini CLI's check) | No — pure ES |
| `@yophon/tau-ext-checkpoint` | Files kept before each prompt changes them; the TUI's `/rewind` restores them | No — pure ES over `FileSystem` |
| `@yophon/tau-ext-lsp` | Language servers (Claude Code's `.lsp.json`): diagnostics after edits and the `lsp` tool | Yes — child processes (Node entry) |
| `@yophon/tau-ext-codemode` | `codemode`: the model writes JavaScript that calls tools, in pi's QuickJS sandbox | Yes — worker threads (Node entry) |
| `@yophon/tau-ext-resources` | pi-compatible skills and prompt templates | No direct runtime API |
| `@yophon/tau-ext-feishu` | Feishu/Lark bridge: media, reactions, progress cards, outbound tools | Yes — Feishu SDK |
| `@yophon/tau-gateway` | Resident gateway core: one conversation per chat, approvals in chat, channel plugins | Yes — Node filesystem |
| `@yophon/tau-channel-weixin` | WeChat channel, built into `tau gateway` | Yes — network, filesystem |
| `@yophon/tau-channel-feishu` | Feishu/Lark channel plugin for the gateway | Yes — Feishu SDK |

The Feishu bridge (a port of [pi-feishu](https://github.com/surenkid/pi-feishu))
loads through a wrapper in `.tau/extensions/feishu.ts` or `~/.tau/extensions/`:

```ts
import createFeishuExtension from "@yophon/tau-ext-feishu";

export default createFeishuExtension();
```

It reads `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (or `--feishu-*` flags, or
`feishu` in pi/tau settings). Chats share the one tau conversation, one at a time.

## Design rules

1. **Kernel purity is mechanical, not aspirational.** `npm run check:purity`
   bundles the kernel with esbuild `platform: "neutral"` and scans for banned
   globals (`process`, `Buffer`, `fetch`, timers, `TextDecoder`, `crypto`,
   dynamic import). Only `platform.ts` — the seam itself — may reference
   WinterTC globals.
2. **Capabilities are optional.** `createCodingTools({ fs, shell })` registers
   only the tools whose capabilities exist; the agent still runs without them.
3. **The kernel defines structural types, not lib types.** `PlatformFetch`,
   `PlatformResponse`, `TauAbortSignal` are minimal structural subsets; adapters
   bridge signals both ways (`docs/development.md`, hard rule 8).
4. **Zero build, zero kernel dependencies.** Everything runs from source on
   Node ≥ 22.19 (native type stripping); the kernel even ships its own UTF-8
   decoder for hosts without `TextDecoder`.
5. **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces,
   or parameter properties.

## Quick start

```bash
npm install --ignore-scripts
npm run check   # lint + types + kernel purity
npm test        # node --test: kernel unit tests + host tests + CLI e2e

# Describe your models once in ~/.tau/models.json (see "Models" below), then:
npm run tau                       # the TUI on a terminal (/help lists commands, ? the keys)
npm run tau -- --list-models      # what is configured and usable

# Or point it at any OpenAI-compatible endpoint ad hoc (BYOK)
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau -- --repl             # line-based REPL instead
npm run tau -- -p "list the files here and summarize"

# Or speak a vendor API natively (base URL optional)
npm run tau -- --provider anthropic -k sk-ant-... -m claude-sonnet-5 -p "hi"
npm run tau -- --provider openai-responses -k sk-... -m gpt-5.5 -p "hi"
npm run tau -- --provider google -k ... -m gemini-3-pro-preview -p "hi"
```

The TUI runs full screen with its own scrollable, searchable transcript
(`--inline`, `TAU_TUI_MODE=inline` or `/settings` → Screen keep the history in
the terminal's scrollback). Keys follow pi and can be changed in
`~/.tau/keybindings.json`; `/btw` asks a side question while the agent works,
Ctrl+B moves a running command to the background, `/diff` shows uncommitted
changes. `TAU_KEYBOARD=legacy` turns extended key reporting off for unusual
terminals. The TUI is a client of tau's own protocol: it runs a session hub in
its process and talks to it as any other client would (docs/protocol.md).

The CLI and TUI default to `--permission-mode supervised`: bash commands and
file writes ask for approval in a terminal and are denied in headless runs.
`autonomous` (or `TAU_PERMISSION_MODE=autonomous`) runs without asking,
`read-only` strips mutating tools, `ci` never asks (edits in the project run, the
rest is denied — for unattended runs), `bypass` turns the gate off. The kernel
library default is `autonomous`.

### Models

`~/.tau/models.json` uses a subset of pi's format. Keys are never stored by
tau: `apiKey` reads `$NAME` / `${NAME}` from the environment, runs `!command`
(a password manager, say), takes `${cred:name}` from `tau credentials`, or a
literal.

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-flash", "input": ["text", "image"], "contextWindow": 1000000 }]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_API_KEY",
      "models": [{ "id": "claude-sonnet-5-5", "contextWindow": 200000, "maxTokens": 32000 }]
    },
    "openai": {
      "api": "openai-responses",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{ "id": "gpt-5.5", "reasoning": true, "input": ["text", "image"] }]
    },
    "google": {
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [{ "id": "gemini-3-pro-preview", "reasoning": true, "input": ["text", "image"] }]
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "none",
      "models": [{ "id": "small-model", "toolCalling": "prompt" }]
    }
  }
}
```

`contextWindow` turns on auto-compaction and the context meter, `cost` (USD per
million tokens) prices the session, `input` says whether the model takes
images, `reasoning` turns on reasoning controls (Responses, Gemini), and
`toolCalling: "prompt"` describes the tools in the prompt for a model without
native tool calling (`TAU_TOOL_SHIM=1` for an ad-hoc endpoint). `--fallback-model
provider/id` (repeatable, or `fallbackModels` in settings) switches models when a
request fails before answering and retries are spent. Ctrl+S in `/model` saves the default; `-m provider/id` picks one at
startup; `-b` / `-k` / `--provider` run an ad-hoc endpoint. For `web_search`,
set `webSearch` in settings or export `BRAVE_API_KEY`, `TAVILY_API_KEY` or
`EXA_API_KEY`.

### Portability demos

```bash
npm run smoke:quickjs             # full agent loop on a bare QuickJS engine (no WinterTC globals)
npm run smoke:quickjs:mcp         # bare-engine kernel calling a real MCP server over a bridged fetch
npm run smoke:browser             # bundle the browser host demo
npm run smoke:weapp               # bundle the WeChat mini-program demo (no Node leakage)
npm run demo:browser              # serve the browser demo locally (CORS proxy included)
npm run demo:weapp                # build examples/weapp/miniprogram/lib/tau.js for WeChat devtools
```

- `examples/browser/` — static page, OPFS filesystem, BYOK in the browser
- `examples/weapp/` — WeChat mini-program chat demo ([README](examples/weapp/README.md))
- `examples/rn/` — React Native (Expo) chat demo ([README](examples/rn/README.md))
- `examples/flutter/` — a phone agent (kernel in `flutter_js`) plus a zero-tau
  computer-side MCP server it drives over the LAN ([app](examples/flutter/app/README.md) · [mcp-server](examples/flutter/mcp-server/README.md))

## Scripts and editors

```bash
tau --mode json -p "review the diff" | jq -c 'select(.type=="tool_execution_end")'   # a JSONL event stream
tau --mode rpc                      # JSONL commands on stdin (pi's RPC protocol), events on stdout
tau --mode acp                      # Agent Client Protocol: use tau inside an editor such as Zed
tau serve                           # tau's own protocol: several clients on the same session (docs/protocol.md)
```

In Zed: `{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }`.
Approvals become the editor's permission prompts, reads and edits go through the
editor's buffers, and the permission modes are the session modes. See
[docs/rpc.md](docs/rpc.md).

## Resident server

```bash
tau serve start      # a tau in the background, on a local socket (a named pipe on Windows)
tau                  # any terminal, any directory: the TUI connects to it
tau -c               # in another terminal: the same session, live in both
tau serve status     # running, version, sessions, clients (one JSON object)
tau serve stop       # running turns may finish first (settings daemon.shutdownGraceSeconds, 60 s)
```

The TUI is a client of tau's protocol ([docs/protocol.md](docs/protocol.md)). When a
resident server runs, it connects to it; when none runs, it starts one first
(settings `daemon.autoStart`, on by default; it says so once, and how to stop it),
as Codex's TUI does with its daemon. Two terminals on one session see each
other's prompts, replies and tool output; an approval answered in one closes in
the other. Leaving with `/quit` or closing the terminal does not stop the session:
a running turn finishes, and `tau -c` or `/resume` (which lists what the server
holds, in every directory, with how many terminals are on each) picks it up again.

The server's configuration is fixed when it starts: its models, keys and
environment variables (tools and `!` commands run with them), so after changing
`~/.tau/models.json` run `tau serve restart`. Each terminal's `-m` and
`--permission-mode` go with the session it opens. Options that configure what
the server fixed — `--extension`, `--no-mcp`, `--tools`, `--system-prompt`,
`--base-url`, permission rules, `--worktree` and the like — run the session in
the TUI's own process instead, as does `--no-daemon`; the TUI says why in one
line. `-p`, the REPL and `--mode json|rpc|acp` always run in their own process.

## Resident gateway

```bash
tau gateway login weixin     # scan the QR code with WeChat; the scanner owns the account
tau gateway run              # stays up; each chat gets its own session
tau gateway stop
```

The gateway runs tau for chat apps: one session per conversation, approvals by
replying in chat, pairing codes for other people, and reminders, recurring
tasks and goals in the owner's chat. WeChat is built in; Feishu is a plugin.
The gateway is parked: it works as described in [docs/gateway.md](docs/gateway.md),
and features added since then are off there.

## Embedding the kernel

```ts
import { Agent, createCodingTools } from "@yophon/tau-kernel";

const agent = new Agent({
	config: { baseUrl, apiKey, model },
	// platform defaults to WinterTC globals (Node/browser/edge);
	// on exotic hosts inject an adapter instead:
	//   @yophon/tau-host-weapp → createWeappPlatform(wx)
	//   @yophon/tau-host-rn    → createRnPlatform({ fetch: expoFetch })
	tools: createCodingTools({ fs: myFileSystem, shell: myShell }),
});

for await (const event of agent.prompt("fix the failing test")) {
	if (event.type === "text_delta") render(event.delta);
}
```

## Extensions

The extension API **deliberately mirrors pi's** — same event names, event
shapes, and result conventions — restricted to what is meaningful in a
runtime-agnostic kernel, so porting a pi extension is mechanical. An extension
is a plain setup function, a static value the host passes in: hosts that forbid
dynamic code import extensions statically; Node hosts may use
`loadExtensionsFromDir()`.

```ts
import type { Extension } from "@yophon/tau-kernel";

const guard: Extension = (api) => {
	api.registerTool(myTool);
	api.registerCommand("guard", { description: "…", handler: () => "…" });
	api.on("tool_call", async (event, ctx) => {
		if (!isDangerous(event.input)) return;                     // no opinion
		if (!ctx.ui) return { block: true, reason: "no UI" };       // headless degradation
		return (await ctx.ui.confirm("Allow?")) ? undefined : { block: true, reason: "rejected" };
	});
};
export default guard;
```

The events and their order are in [docs/architecture.md](docs/architecture.md),
pi parity member by member in [docs/pi-parity.md](docs/pi-parity.md). The CLI
loads global extensions from `~/.tau/extensions/` (always trusted) and project
extensions from `.tau/extensions/` behind a **trust gate** (asked once, remembered
in `~/.tau/trust.json`, asked again when the content changes); headless runs skip
untrusted project extensions. See [examples/extensions/guard.ts](examples/extensions/guard.ts).

## Documentation

Living docs under [docs/](docs/) — start here when picking up development:

- [docs/development.md](docs/development.md) — process source of truth: commands, hard rules, spec-first phase workflow, Definition of Done
- [docs/architecture.md](docs/architecture.md) — current architecture by package and module, code maps, glossary
- [docs/roadmap.md](docs/roadmap.md) — completed phases, current work, backlog, tech-debt register
- [docs/specs/](docs/specs/) — per-phase specifications (written and confirmed before coding each phase)
- [docs/decisions.md](docs/decisions.md) — design decision records (D1–D55)
- [docs/settings.md](docs/settings.md) — every settings.json key, its default, and whether a project may set it
- [docs/rpc.md](docs/rpc.md) — the JSON, RPC and ACP modes
- [docs/protocol.md](docs/protocol.md) — `tau serve`, the resident server and tau's client protocol (several clients on one session)
- [docs/gateway.md](docs/gateway.md) — the resident gateway and channel plugins
- [docs/memory.md](docs/memory.md) — long-term memory and session search
- [docs/connectors.md](docs/connectors.md) — MCP connectors, language servers, credentials, OAuth, keeping secrets from the model
- [docs/audit.md](docs/audit.md) — the audit ledger: what tau did, who approved it, what it cost (`tau audit`)
- [docs/hooks.md](docs/hooks.md) — user hooks: shell commands at fixed points of a run (Claude Code's format)
- [docs/permissions.md](docs/permissions.md) — permission rules, "always allow", working directories (Claude Code's format)
- [docs/statusline.md](docs/statusline.md) — a custom status line (Claude Code's `statusLine`)
- [docs/worktrees.md](docs/worktrees.md) — `tau --worktree` and `enter_worktree` / `exit_worktree`: a session in its own git worktree
- [docs/subagents.md](docs/subagents.md) — subagents: modes, agent definitions, `send_message`, worktree isolation
- [docs/pi-parity.md](docs/pi-parity.md) — pi extension surface, member by member
- [docs/retrospectives/](docs/retrospectives/) — project retrospectives (2026-10-23: state, problems, candidate next phases)

## License

MIT
