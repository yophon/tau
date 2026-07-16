# tau

**English** | [简体中文](README.zh-CN.md)

Runtime-agnostic coding agent kernel. The kernel is pure ECMAScript plus one
injectable platform seam; every host capability (filesystem, shell, HTTP,
UI, …) is provided by plugins. BYOK only, OpenAI-compatible protocol only.

Architecture and interface design are heavily inspired by
[pi](https://github.com/earendil-works/pi-mono) (MIT), pushed one step further:
where pi's kernel is browser-safe, tau's kernel assumes nothing beyond the
language standard — every non-ECMAScript API is resolved through the `Platform`
interface, so hosts like WeChat mini-programs or React Native only need to
inject a small adapter instead of polyfilling globals.

## What works today

- **Agent loop** — OpenAI-compatible streaming, tool calls, steering (type
  while it runs), follow-up queues, abort, auto-retry with backoff, stall
  watchdog. Provider failures become `stopReason: "error"/"aborted"` messages
  instead of exceptions (pi semantics).
- **Sessions** — pi v3 JSONL format on disk: resume (`--continue`), in-place
  tree navigation (`/tree`), forking (`/fork`), automatic context compaction
  with pi's exact algorithm and prompts.
- **Extensions** — pi-mirrored API: 25+ lifecycle events, tools, slash
  commands, flags, renderers, widgets, shortcuts. Standard packs: subagents
  (`task` tool), MCP client bridge, skills & prompt templates
  (pi-file-compatible).
- **Hosts** — terminal (REPL / product-grade TUI / one-shot `-p`), browser
  (OPFS), WeChat mini-program, React Native (Expo), and a bare QuickJS engine
  with zero WinterTC globals — each verified end-to-end, most in CI.

## Packages

| Package | Role | May touch the runtime? |
|---------|------|------------------------|
| `@yophon/tau-kernel` | Agent loop, OpenAI-compatible streaming client, SSE parser, tool system, sessions, compaction, branching, extension system, capability interfaces | **No** — enforced by `npm run check:purity` |
| `@yophon/tau-host-node` | `FileSystem` + `Shell` capability providers for Node.js | Yes |
| `@yophon/tau-host-browser` | OPFS + in-memory `FileSystem` capability providers and browser session repo helper | Yes |
| `@yophon/tau-host-weapp` | WeChat mini-program `Platform` adapter: `wx.request` chunked streaming → `PlatformFetch` | Yes |
| `@yophon/tau-host-rn` | React Native (Expo) `Platform` adapter over `expo/fetch` | Yes |
| `@yophon/tau-cli` | Terminal frontend: REPL, TUI, one-shot mode | Yes |
| `@yophon/tau-ext-subagents` | Extension package that registers a `task` tool backed by child Agents | No direct runtime API |
| `@yophon/tau-ext-mcp` | Extension package that bridges MCP server tools into tau tools | Yes — MCP SDK transports |
| `@yophon/tau-ext-resources` | Extension package for pi-compatible skills and prompt templates | No direct runtime API |

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

# Run the CLI against any OpenAI-compatible endpoint (BYOK)
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau                       # readline REPL
npm run tau -- --tui              # TUI mode (streaming markdown, /tree, /fork, /model, …)
npm run tau -- -p "list the files here and summarize"
```

Portability proofs and demos:

```bash
npm run smoke:quickjs             # full agent loop on a bare QuickJS engine (no WinterTC globals)
npm run smoke:browser             # bundle the browser host demo
npm run smoke:weapp               # bundle the WeChat mini-program demo (no Node leakage)
npm run demo:browser              # serve the browser demo locally (CORS proxy included)
npm run demo:weapp                # build examples/weapp/miniprogram/lib/tau.js for WeChat devtools
```

- `examples/browser/` — static page, OPFS filesystem, BYOK in the browser
- `examples/weapp/` — WeChat mini-program chat demo ([README](examples/weapp/README.md))
- `examples/rn/` — React Native (Expo) chat demo ([README](examples/rn/README.md))

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
- [docs/roadmap.md](docs/roadmap.md) — phased plan (P0–P12) with status, dependencies, and tech-debt register
- [docs/specs/](docs/specs/) — per-phase specifications (written and confirmed before coding each phase)
- [docs/decisions.md](docs/decisions.md) — design decision records (D1–D16)
- [docs/pi-parity.md](docs/pi-parity.md) — pi lifecycle/hook parity checklist

## License

MIT
