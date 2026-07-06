# tau

Runtime-agnostic coding agent kernel. The kernel is pure ECMAScript plus one
injectable platform seam; every host capability (filesystem, shell, HTTP,
UI, …) is provided by plugins. BYOK only, OpenAI-compatible protocol only.

Architecture and interface design are heavily inspired by
[pi](https://github.com/earendil-works/pi-mono) (MIT), pushed one step further:
where pi's kernel is browser-safe, tau's kernel assumes nothing beyond the
language standard — every non-ECMAScript API is resolved through the `Platform`
interface, so hosts like WeChat mini-programs or React Native only need to
inject a small adapter instead of polyfilling globals.

## Packages

| Package | Role | May touch the runtime? |
|---------|------|------------------------|
| `@tau/kernel` | Agent loop, OpenAI-compatible streaming client, SSE parser, tool system, capability interfaces | **No** — enforced by `npm run check:purity` |
| `@tau/host-node` | `FileSystem` + `Shell` capability providers for Node.js | Yes |
| `@tau/cli` | Minimal terminal frontend | Yes |
| `@tau/ext-subagents` | Extension package that registers a `task` tool backed by child Agents | No direct runtime API |
| `@tau/ext-mcp` | Extension package that bridges MCP server tools into tau tools | Yes — MCP SDK transports |
| `@tau/ext-resources` | Extension package for pi-compatible skills and prompt templates | No direct runtime API |

## Design rules

1. **Kernel purity is mechanical, not aspirational.** `scripts/check-kernel-purity.mjs`
   bundles the kernel with esbuild `platform: "neutral"` (zero externals) and
   scans sources for banned globals (`process`, `Buffer`, `fetch`, timers,
   `TextDecoder`, `crypto`, dynamic import). Only `platform.ts` — the seam
   itself — may reference WinterTC globals, and only to build `defaultPlatform()`.
2. **Capabilities are optional.** `createCodingTools({ fs, shell })` registers
   only the tools whose capabilities exist. No filesystem → no read/write/edit;
   the agent still runs.
3. **The kernel defines structural types, not lib types.** `PlatformFetch`,
   `PlatformResponse`, `TauAbortSignal` are minimal structural subsets. Real
   `fetch`/`AbortSignal` satisfy them; a `wx.request` adapter can too.
4. **Zero build, zero kernel dependencies.** Everything runs from source on
   Node ≥ 22.19 (native type stripping). The kernel has no npm dependencies.
5. **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces,
   or parameter properties.

## Quick start

```bash
npm install --ignore-scripts
npm run check   # lint + types + kernel purity
npm test        # node --test, includes a fake-provider agent-loop test

# Run the CLI against any OpenAI-compatible endpoint (BYOK)
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau                       # interactive REPL
npm run tau -- --tui              # experimental TUI mode
npm run tau -- -p "list the files here and summarize"
```

## Embedding the kernel

```ts
import { Agent, createCodingTools } from "@tau/kernel";

const agent = new Agent({
	config: { baseUrl, apiKey, model },
	// platform defaults to WinterTC globals; inject your own on exotic hosts:
	// platform: { fetch: wxFetchAdapter, createUtf8Decoder: ... },
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
import type { Extension } from "@tau/kernel";

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

Hooks (pi semantics): `input` (`continue` / `transform` / `handled`),
`tool_call` (block via result, modify args by mutating `event.input` in place),
`tool_result` (override `output` / `isError`), `agent_start` / `agent_end` /
`turn_start` / `turn_end` (observe; `turn_end` carries the turn's tool
results). Handlers chain in registration order. UI interaction goes through
the optional `UiCapability` the host provides (the CLI backs it with readline,
and omits it on non-TTY stdin so extensions degrade instead of hanging).

The CLI loads global extensions from `~/.tau/extensions/` (always trusted) and
project extensions from `cwd/.tau/extensions/` behind a **trust gate**: the
first run in a directory asks for confirmation (remembered in
`~/.tau/trust.json`); headless runs skip untrusted project extensions. It
dispatches `/command` input to registered extension commands (`/help` lists
them), forwards extension-declared `--flags`, queues lines typed during a
running turn as steering messages, and Ctrl+C aborts the current turn. See
[examples/extensions/guard.ts](examples/extensions/guard.ts).

## Documentation

Living docs under [docs/](docs/) — start here when picking up development:

- [docs/development.md](docs/development.md) — process source of truth: commands, hard rules, spec-first phase workflow, Definition of Done
- [docs/architecture.md](docs/architecture.md) — current architecture, kernel code map, glossary
- [docs/roadmap.md](docs/roadmap.md) — phased plan (P0–P11) with status, dependencies, and tech-debt register
- [docs/specs/](docs/specs/) — per-phase specifications (written and confirmed before coding each phase)
- [docs/decisions.md](docs/decisions.md) — design decision records (D1–D12)
- [docs/pi-parity.md](docs/pi-parity.md) — pi lifecycle/hook parity checklist

## License

MIT
