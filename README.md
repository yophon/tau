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

- **Agent loop** — OpenAI-compatible streaming, tool calls, steering (type
  while it runs), follow-up queues, abort, auto-retry with backoff, stall
  watchdog. Provider failures become `stopReason: "error"/"aborted"` messages
  instead of exceptions (pi semantics). The wire protocol is injectable
  (`ChatTransport`): `--provider anthropic` speaks the Anthropic Messages API
  natively — thinking streams with signatures, prompt caching
  (`cache_control`), images in tool results, true cacheRead/cacheWrite usage.
- **Coding tools** — read (text and images), write, edit (several exact
  replacements in one call), bash, and grep / find / ls in pure ES over the
  host filesystem (they honor `.gitignore` and work on every host, OPFS
  included). The CLI adds `todo_write` (a checklist in the TUI), long-term
  project memory (`memory_write`, `#fact` in the TUI), `web_fetch` /
  `web_search`, and five permission modes (read-only, supervised,
  accept-edits, autonomous, bypass).
- **Models** — describe providers and models once in `~/.tau/models.json`
  (pi's format); `/model` switches between them mid-session, across
  protocols, with per-model context windows and prices.
- **Subagents** — the `subagent` tool delegates to child agents with their
  own context: one, several in parallel, a chain, or in the background (the
  result comes back as a follow-up). Agents are Markdown definitions (pi's
  format): scout, planner, reviewer and worker ship built in.
- **Sessions** — pi v3 JSONL format on disk: resume (`--continue`), in-place
  tree navigation (`/tree`), forking (`/fork`), automatic context compaction
  with pi's exact algorithm and prompts.
- **Extensions** — pi-mirrored API: 25+ lifecycle events, tools, slash
  commands, flags, renderers, widgets, shortcuts. Standard packs: subagents,
  MCP client bridges (a zero-dependency pure-`Platform` MCP core, plus a stdio
  transport on Node), tool_search and codemode, skills & prompt templates
  (pi-file-compatible).
- **Hosts** — terminal (REPL / product-grade TUI / one-shot `-p`), browser
  (OPFS), WeChat mini-program, React Native (Expo), a phone (Flutter via
  `flutter_js`, kernel running in QuickJS), and a bare QuickJS engine with zero
  WinterTC globals — each verified end-to-end, most in CI.

The kernel's only host dependency is the four-method `Platform` seam, so the
agent loop runs anywhere with a JS engine and an HTTP path to an
OpenAI-compatible endpoint. Whether that loop is also a *useful* coding agent
is a separate, capability question — no shell means no `bash` tool, unless a
remote one is wired in over MCP (exactly the Flutter demo's story). See
[docs/architecture.md](docs/architecture.md#可移植性广度前提与边界) for the honest
reach, prerequisites, and boundaries (network + BYOK, engine polyfills for
older runtimes, paths that are code-present but not yet e2e-verified).

## Packages

| Package | Role | May touch the runtime? |
|---------|------|------------------------|
| `@yophon/tau-kernel` | Agent loop, OpenAI-compatible streaming client, SSE parser, tool system, sessions, compaction, branching, extension system, capability interfaces | **No** — enforced by `npm run check:purity` |
| `@yophon/tau-host-node` | `FileSystem` + `Shell` capability providers for Node.js | Yes |
| `@yophon/tau-host-browser` | OPFS + in-memory `FileSystem` capability providers and browser session repo helper | Yes |
| `@yophon/tau-host-weapp` | WeChat mini-program `Platform` adapter: `wx.request` chunked streaming → `PlatformFetch` | Yes |
| `@yophon/tau-host-rn` | React Native (Expo) `Platform` adapter over `expo/fetch` | Yes |
| `@yophon/tau-cli` | Terminal frontend: REPL, TUI, one-shot mode | Yes |
| `@yophon/tau-ext-subagents` | The `subagent` tool: single, parallel, chain and background subagents over Markdown agent definitions | No direct runtime API |
| `@yophon/tau-ext-mcp` | MCP extension for Node: the ext-mcp-http core plus a stdio transport for local servers (no MCP SDK) | Yes — child processes |
| `@yophon/tau-ext-mcp-http` | Pure-ES MCP client and extension core (Streamable HTTP) written entirely on the `Platform` seam — zero dependencies, runs on bare engines | **No** — pure `Platform` |
| `@yophon/tau-ext-provider-anthropic` | Anthropic Messages `ChatTransport` written entirely on the `Platform` seam — native thinking, prompt caching, images in tool results | **No** — pure `Platform` |
| `@yophon/tau-ext-web` | `web_fetch` (HTML to markdown over `Platform.fetch`) and BYOK `web_search` (Brave, Tavily, Exa, SearXNG) | **No** — pure `Platform` |
| `@yophon/tau-ext-tool-search` | `tool_search`: BM25 search over deferred tools (e.g. MCP tools), loading the matches for the next request | No — pure ES |
| `@yophon/tau-ext-codemode` | `codemode`: the model writes JavaScript that calls tools, run in pi's QuickJS sandbox (`./node`) | Yes — worker threads + wasm (Node entry) |
| `@yophon/tau-ext-resources` | Extension package for pi-compatible skills and prompt templates | No direct runtime API |
| `@yophon/tau-ext-feishu` | Feishu/Lark WebSocket bridge with media, reactions, progress cards, and outbound tools | Yes — Feishu SDK and Node filesystem |

### Feishu/Lark bridge

The optional `@yophon/tau-ext-feishu` package ports the
[pi-feishu](https://github.com/surenkid/pi-feishu) workflow to tau. It accepts
text, post, image, file, audio, video, sticker, and card messages; downloads
inbound media; streams tool progress through an editable card; and exposes
`send_to_feishu`, `send_image_to_feishu`, and `send_file_to_feishu` tools.

Install it in the project that runs tau, then add a wrapper under
`.tau/extensions/feishu.ts` (or `~/.tau/extensions/`):

```ts
import createFeishuExtension from "@yophon/tau-ext-feishu";

export default createFeishuExtension();
```

Configure `FEISHU_APP_ID` and `FEISHU_APP_SECRET` (or the corresponding
`--feishu-*` flags). The extension also reads `feishu` from
`~/.pi/agent/settings.json`, `~/.tau/settings.json`, project `.pi/settings.json`,
and project `.tau/settings.json`, in that order from lower to higher priority.
The tau runtime currently has one Agent, so Feishu chats share the active tau
conversation and are serialized through per-chat FIFO queues.

## Design rules

1. **Kernel purity is mechanical, not aspirational.** `scripts/check-kernel-purity.mjs`
   bundles the kernel with esbuild `platform: "neutral"` (zero externals) and
   scans sources for banned globals (`process`, `Buffer`, `fetch`, timers,
   `TextDecoder`, `crypto`, dynamic import). Only `platform.ts` — the seam
   itself — may reference WinterTC globals, and only to build `defaultPlatform()`.
2. **Capabilities are optional.** `createCodingTools({ fs, shell })` registers
   only the tools whose capabilities exist. No filesystem → no read/write/edit;
   the agent still runs (that is exactly what the mini-program demo does).
3. **The kernel defines structural types, not lib types.** `PlatformFetch`,
   `PlatformResponse`, `TauAbortSignal` are minimal structural subsets. Real
   `fetch`/`AbortSignal` satisfy them; a `wx.request` adapter does too.
   Adapters must bridge signals both ways (see `docs/development.md`, hard
   rule 8) — three reference implementations ship in-tree.
4. **Zero build, zero kernel dependencies.** Everything runs from source on
   Node ≥ 22.19 (native type stripping). The kernel has no npm dependencies —
   it even ships its own pure-ES incremental UTF-8 decoder for hosts without
   `TextDecoder` (mini-program iOS JSC, Hermes, bare QuickJS).
5. **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces,
   or parameter properties.

## Quick start

```bash
npm install --ignore-scripts
npm run check   # lint + types + kernel purity
npm test        # node --test: kernel unit tests + host tests + CLI e2e

# Describe your models once in ~/.tau/models.json (see "Models" below), then:
npm run tau                       # the TUI on a terminal (/help lists commands and keys)
npm run tau -- --list-models      # what is configured and usable

# Or point it at any OpenAI-compatible endpoint ad hoc (BYOK)
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau -- --repl             # line-based REPL instead
npm run tau -- -p "list the files here and summarize"

# Or speak the Anthropic Messages API natively (base URL optional)
npm run tau -- --provider anthropic -k sk-ant-... -m claude-sonnet-5 -p "hi"
```

### Models

`~/.tau/models.json` uses a subset of pi's format. Keys are never stored by
tau: `apiKey` reads `$NAME` / `${NAME}` from the environment, runs
`!command` (a password manager, say), or takes a literal.

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-chat", "contextWindow": 128000, "cost": { "input": 0.27, "output": 1.1 } }]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_API_KEY",
      "models": [{ "id": "claude-sonnet-5-5", "contextWindow": 200000, "maxTokens": 32000 }]
    }
  }
}
```

The context window turns on auto-compaction and the context meter; `cost`
(USD per million tokens) prices the session. `/model` lists every model with
a usable key and switches between them mid-session, protocol included; Ctrl+S
in its picker saves the default (`defaultProvider` / `defaultModel` in
`~/.tau/settings.json`). `-m provider/id` picks one at startup. With a usable
table, `TAU_BASE_URL`-style variables are ignored; `-b` / `-k` /
`--provider` still run an ad-hoc endpoint.

### Web

`web_fetch` reads a page as markdown (pure ES over the host's fetch). For
`web_search`, set a provider in `~/.tau/settings.json` —
`{ "webSearch": { "provider": "brave", "apiKey": "$BRAVE_API_KEY" } }` (also
`tavily`, `exa`, or `searxng` with a `baseUrl`) — or just export
`BRAVE_API_KEY`, `TAVILY_API_KEY` or `EXA_API_KEY`.

> **Permissions (P15, breaking):** the CLI/TUI now default to
> `--permission-mode supervised` — bash commands and file writes ask for
> approval in a TTY and are **denied** in headless (`-p` piped) runs. Use
> `--permission-mode autonomous` (or `TAU_PERMISSION_MODE=autonomous`) to
> restore the old behavior, `read-only` to strip mutating tools entirely,
> `bypass` to disable the gate. "Always allow" answers persist to
> `~/.tau/permissions.json`. The kernel library default remains `autonomous`.

Portability proofs and demos:

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
```

In Zed: `{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }`.
Approvals become the editor's permission prompts, reads and edits go through the
editor's buffers, todo_write shows as the plan, and the permission modes are the
session modes. See [docs/rpc.md](docs/rpc.md) for the protocols and where they
differ from pi.

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

The extension API **deliberately mirrors pi's extension API** — same event
names, event shapes, and result conventions — restricted to the subset that is
meaningful in a runtime-agnostic kernel. Porting a pi extension is mechanical.

An extension is a plain setup function — a static value, never a module the
kernel discovers. This is what makes the system portable to hosts that forbid
dynamic code (mini-programs, React Native): they import extensions statically;
Node hosts may use `loadExtensionsFromDir()` as a convenience.

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

25+ hooks with pi semantics cover the whole lifecycle: input transformation,
per-request context rewriting, message/tool streaming, tool blocking and
result overrides, session events (compaction, fork, tree navigation, switch),
model/thinking selection, project trust, resource discovery. The full list
with event ordering guarantees lives in
[docs/architecture.md](docs/architecture.md). UI interaction goes through the
optional `UiCapability`; headless hosts omit it and extensions degrade instead
of hanging.

The CLI loads global extensions from `~/.tau/extensions/` (always trusted) and
project extensions from `cwd/.tau/extensions/` behind a **trust gate**: the
first run in a directory asks for confirmation (remembered in
`~/.tau/trust.json`); headless runs skip untrusted project extensions. See
[examples/extensions/guard.ts](examples/extensions/guard.ts).

## Documentation

Living docs under [docs/](docs/) — start here when picking up development:

- [docs/development.md](docs/development.md) — process source of truth: commands, hard rules, spec-first phase workflow, Definition of Done
- [docs/architecture.md](docs/architecture.md) — current architecture, kernel code map, glossary
- [docs/roadmap.md](docs/roadmap.md) — phased plan (P0–P20) with status, dependencies, and tech-debt register
- [docs/specs/](docs/specs/) — per-phase specifications (written and confirmed before coding each phase)
- [docs/decisions.md](docs/decisions.md) — design decision records (D1–D33)
- [docs/rpc.md](docs/rpc.md) — the JSON, RPC and ACP modes
- [docs/pi-parity.md](docs/pi-parity.md) — pi lifecycle/hook parity checklist

## License

MIT
