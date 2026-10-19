#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "packages", "cli", "src", "main.ts");
const resourcesUrl = pathToFileURL(join(repoRoot, "packages", "ext-resources", "src", "index.ts")).href;

// Distinguish repeated approval outcomes on a capture-the-whole-pane screen.
let approvalDoneCount = 0;
let approvalDenyCount = 0;

async function main() {
	await requireTmux();
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-tui-smoke-")));
	const mock = await startMockOpenAI();
	const only = process.env.SMOKE_ONLY;
	const run = async (name, scenario) => {
		if (only === undefined || name.includes(only)) await scenario(root, mock.baseUrl);
	};
	try {
		await run("startup", runStartupConfirmSmoke);
		await run("prompt", runPromptToolAbortSmoke);
		await run("reload", runExtensionAndReloadSmoke);
		await run("selector", runSelectorSmoke);
		await run("abort", runExtensionAbortSmoke);
		await run("parallel", runParallelToolsSmoke);
		await run("pricing", runPricingFooterSmoke);
		await run("approval", runApprovalSmoke);
		await run("trust", runTrustDigestSmoke);
		await run("subagent", runSubagentSmoke);
		await run("commands", runCommandsSmoke);
		await run("models", runModelsSmoke);
		await run("resize", runResizeSmoke);
		await run("fullscreen-resize", runFullscreenResizeSmoke);
		await run("fullscreen-scroll", runFullscreenScrollSmoke);
		await run("fullscreen-exit", runFullscreenExitSmoke);
		await run("fullscreen-signal", runFullscreenSignalSmoke);
		console.log("TUI smoke passed");
	} finally {
		await mock.close();
		// A TUI still shutting down may be writing its log; do not mask the real failure.
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
	}
}

async function runStartupConfirmSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "startup-confirm", false);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("startup-confirm", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("Trust this directory", 10_000);
		await session.send("y", "Enter");
		await session.waitFor("SMOKE_HEADER", 10_000);
		const startup = await session.capture();
		if (startup.includes("Loaded diagnostics")) throw new Error(`Startup dumped diagnostics:\n${startup}`);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok startup confirm");
	} finally {
		await session.kill();
	}
}

async function runPromptToolAbortSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "prompt-tool-abort", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("prompt-tool-abort", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("SMOKE_WIDGET", 10_000);

		await session.send("stream smoke", "Enter");
		await session.waitFor("SMOKE_STREAM_OK", 10_000);

		await session.send("bash smoke", "Enter");
		await session.waitFor("BASH_SMOKE_LINE_1", 10_000);
		await session.waitFor("SMOKE_BASH_DONE", 15_000);

		await session.send("custom smoke tool", "Enter");
		await session.waitFor("SMOKE_TOOL_RENDER_result", 15_000);
		await session.waitFor("SMOKE_CUSTOM_TOOL_DONE", 15_000);

		await session.send("hang smoke", "Enter");
		await session.waitFor("SMOKE_ABORT_STREAM", 10_000);
		await session.send("C-c");
		await session.waitFor("■ Interrupted", 10_000);

		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok prompt tool abort");
	} finally {
		await session.kill();
	}
}

async function runExtensionAndReloadSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "extension-reload", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("extension-reload", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("SMOKE_FOOTER", 10_000);
		await session.send("C-x");
		await session.waitFor("SMOKE_SHORTCUT_OK", 10_000);

		await session.send("/smoke-ui", "Enter");
		await session.waitFor("SMOKE_UI_CONFIRM", 10_000);
		await session.send("y", "Enter");
		await session.waitFor("SMOKE_UI_CONFIRMED", 10_000);

		await mkdir(join(dirs.cwd, ".tau", "reload-prompts"), { recursive: true });
		await writeFile(
			join(dirs.cwd, ".tau", "reload-prompts", "reload-smoke.md"),
			"---\ndescription: Reload smoke\n---\nSMOKE_RELOAD_PROMPT $ARGUMENTS\n",
			"utf8",
		);
		await session.send("/reload", "Enter");
		await session.waitFor("Extensions reloaded.", 15_000);
		await session.send("/reload-smoke after", "Enter");
		await session.waitFor("SMOKE_RELOAD_RESPONSE", 15_000);

		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok extension reload");
	} finally {
		await session.kill();
	}
}

async function runSelectorSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "selector", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("selector", dirs, baseUrl, []);
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("selector first", "Enter");
		await session.waitFor("SMOKE_SELECTOR_FIRST", 10_000);
		await session.send("/smoke-render", "Enter");
		await session.waitFor("SMOKE_MESSAGE_RENDERED", 10_000);
		await session.send("/tree", "Enter");
		await session.waitFor("SMOKE_ENTRY_RENDERED", 10_000);
		await session.send("Escape");
		await session.waitFor("Navigation cancelled.", 10_000);
		await session.send("/fork", "Enter");
		await session.waitFor("Fork from", 10_000);
		await session.send("Enter");
		await session.waitFor("Forked to", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok selector");
	} finally {
		await session.kill();
	}
}

// P11 验收:扩展经 ctx.abort() 中止运行中的轮(独立 session,避免和 Ctrl+C 场景的
// "Turn aborted." 文本混淆)。
async function runExtensionAbortSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "extension-abort", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("extension-abort", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("SMOKE_WIDGET", 10_000);
		await session.send("ext abort smoke", "Enter");
		await session.waitFor("EXT_ABORT_TRIGGER", 10_000);
		await session.waitFor("■ Interrupted", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok extension ctx.abort");
	} finally {
		await session.kill();
	}
}

async function createSandbox(root, name, trusted) {
	const projectPath = join(root, name, "project");
	const home = join(root, name, "home");
	await mkdir(projectPath, { recursive: true });
	await mkdir(home, { recursive: true });
	const cwd = await realpath(projectPath);
	if (trusted) await writeTrust(home, cwd, true);
	return { cwd, home };
}

async function writeTrust(home, cwd, trusted) {
	await mkdir(join(home, ".tau"), { recursive: true });
	await writeFile(join(home, ".tau", "trust.json"), `${JSON.stringify({ trusted: { [cwd]: trusted } })}\n`, "utf8");
}

async function writeSmokeExtension(cwd) {
	const extensionDir = join(cwd, ".tau", "extensions");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(
		join(extensionDir, "smoke.mjs"),
		`
import resources from ${JSON.stringify(resourcesUrl)};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function smoke(api) {
	await resources(api);
	api.registerCommand("smoke-ui", {
		description: "Exercise TUI UI capability.",
		handler: async (_args, ctx) => {
			const confirmed = await ctx.ui?.confirm("SMOKE_UI_CONFIRM", "confirm smoke UI");
			return confirmed ? "SMOKE_UI_CONFIRMED" : "SMOKE_UI_CANCELLED";
		},
	});
	api.registerCommand("smoke-render", {
		description: "Exercise custom message and entry renderers.",
		handler: () => {
			api.sendMessage({ customType: "smoke_custom", content: "custom payload", display: true });
			api.appendEntry("smoke_entry", { ok: true });
			return "SMOKE_RENDER_COMMAND_OK";
		},
	});
	api.registerShortcut("smoke-shortcut", {
		key: "ctrl+x",
		description: "Exercise extension shortcut dispatch.",
		handler: () => "SMOKE_SHORTCUT_OK",
	});
	api.registerHeaderItem("smoke-header", { handler: () => "SMOKE_HEADER" });
	api.registerFooterItem("smoke-footer", { handler: () => "SMOKE_FOOTER" });
	api.registerWidget("smoke-widget", { placement: "above-editor", handler: () => "SMOKE_WIDGET" });
	api.registerDiagnostic("smoke-diagnostic", { handler: () => ({ label: "smoke", value: "SMOKE_DIAGNOSTIC_OK" }) });
	api.registerMessageRenderer("smoke-message", {
		customTypes: ["smoke_custom"],
		handler: () => "SMOKE_MESSAGE_RENDERED",
	});
	api.registerEntryRenderer("smoke-entry", {
		customTypes: ["smoke_entry"],
		handler: () => ({ label: "SMOKE_ENTRY_RENDERED", description: "custom entry renderer" }),
	});
	api.registerTool({
		name: "smoke_tool",
		description: "Smoke test custom tool.",
		parameters: { type: "object", properties: {} },
		execute: async (_args, _signal, onUpdate) => {
			onUpdate?.("SMOKE_TOOL_UPDATE_1\\n", "stdout");
			await sleep(50);
			onUpdate?.("SMOKE_TOOL_UPDATE_2\\n", "stdout");
			return { content: [{ type: "text", text: "SMOKE_TOOL_OUTPUT" }] };
		},
	});
	api.registerToolRenderer("smoke-tool-renderer", {
		toolNames: ["smoke_tool"],
		handler: (event) => "SMOKE_TOOL_RENDER_" + event.phase,
	});
	api.on("message_update", (event, ctx) => {
		if (JSON.stringify(event.message.content ?? []).includes("EXT_ABORT_TRIGGER")) ctx.abort?.();
	});
	api.on("resources_discover", (event, ctx) => {
		if (event.reason !== "reload") return undefined;
		const projectTauDir = ctx.capabilities?.paths?.projectTauDir;
		return projectTauDir ? { promptPaths: [projectTauDir + "/reload-prompts"] } : undefined;
	});
}
`,
		"utf8",
	);
}

async function startTui(label, dirs, baseUrl, args, extraEnv = []) {
	const name = `tau-smoke-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const command = [
		"env",
		`HOME=${shellQuote(dirs.home)}`,
		`TAU_BASE_URL=${shellQuote(baseUrl)}`,
		"TAU_MODEL=mock-model",
		"TAU_API_KEY=test",
		// Pre-P15 behavior for scenarios that are not about permissions; the
		// approval scenario overrides with an explicit --permission-mode flag.
		"TAU_PERMISSION_MODE=autonomous",
		"TAU_HISTORY=",
		// SMOKE_TUI_MODE=inline runs every scenario in the inline TUI (P33); a scenario's own env wins.
		...(process.env.SMOKE_TUI_MODE ? [`TAU_TUI_MODE=${shellQuote(process.env.SMOKE_TUI_MODE)}`] : []),
		...extraEnv.map(shellQuote),
		shellQuote(process.execPath),
		"--disable-warning=ExperimentalWarning",
		shellQuote(cliPath),
		...args.map(shellQuote),
	].join(" ");
	await tmux(["new-session", "-d", "-x", "120", "-y", "38", "-s", name, "-c", dirs.cwd, command]);
	return new TmuxSession(name);
}

class TmuxSession {
	constructor(name) {
		this.name = name;
	}

	async send(...keys) {
		await tmux(["send-keys", "-t", this.name, ...keys]);
	}

	async capture() {
		return await tmux(["capture-pane", "-t", this.name, "-p", "-J", "-S", "-"]);
	}

	async waitFor(needle, timeoutMs = 10_000) {
		// The first screen of a session may wait on a cold module load (slow on WSL /mnt drives).
		if (!this.started) {
			this.started = true;
			timeoutMs += 30_000;
		}
		const started = Date.now();
		let screen = "";
		while (Date.now() - started < timeoutMs) {
			screen = await this.capture();
			if (screen.includes(needle)) return;
			await sleep(100);
		}
		throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in tmux ${this.name}:\n${screen}`);
	}

	async waitForExit(timeoutMs = 10_000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				await tmux(["has-session", "-t", this.name]);
			} catch {
				return;
			}
			await sleep(100);
		}
		throw new Error(`Timed out waiting for tmux ${this.name} to exit:\n${await this.capture()}`);
	}

	async kill() {
		try {
			await tmux(["kill-session", "-t", this.name]);
		} catch {
			// Already exited.
		}
	}
}

// P18 验收：一批两个 bash 工具并发执行——快工具（PAR_B）在慢工具（PAR_A，1s）
// 仍在跑时就完成并渲染，两张工具卡片互不串扰；全部完成后模型收到两个结果收尾。
async function runParallelToolsSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "parallel-tools", true);
	const session = await startTui("parallel-tools", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("tau", 10_000);
		await session.send("parallel smoke", "Enter");
		// 快工具先完成——此刻慢工具必然未完成（1s sleep），即并发证据
		await session.waitFor("PAR_B_2", 10_000);
		const midway = await session.capture();
		if (midway.includes("PAR_A_2")) {
			throw new Error(`slow tool finished before fast tool rendered — no concurrency evidence:\n${midway}`);
		}
		await session.waitFor("PAR_A_2", 10_000);
		await session.waitFor("SMOKE_PARALLEL_DONE", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok parallel tools");
	} finally {
		await session.kill();
	}
}

// P14 验收：mock provider 返回 usage，TAU_PRICING 注入单价后 footer 显示真实成本
// （2M input × $0.5/MTok + 1M output × $2/MTok = $3.0000）；无 pricing 时为 "cost unknown"。
async function runPricingFooterSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "pricing-footer", false);
	const session = await startTui("pricing-footer", dirs, baseUrl, ["--no-session"], ["TAU_PRICING=in=0.5,out=2"]);
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("pricing smoke", "Enter");
		await session.waitFor("SMOKE_PRICING_OK", 10_000);
		await session.waitFor("$3.00", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok pricing footer");
	} finally {
		await session.kill();
	}
}

// A width change re-wraps the screen under Ink; without a redraw, each shrink left a copy of
// the input box behind (user report 2026-10-19). After shrinking and widening there is one box.
async function runResizeSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "resize", false);
	const session = await startTui(
		"resize",
		dirs,
		baseUrl,
		["--no-session"],
		["TAU_PRICING=in=0.5,out=2", "TAU_TUI_MODE=inline"],
	);
	const boxes = async () => {
		const screen = await tmux(["capture-pane", "-t", session.name, "-p"]);
		return { count: screen.split("\n").filter((line) => line.trimStart().startsWith("╭")).length, screen };
	};
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("pricing smoke", "Enter");
		await session.waitFor("SMOKE_PRICING_OK", 10_000);
		// Everything the TUI writes from here on, to check what a resize sends.
		const raw = join(dirs.home, "resize-output.bin");
		await tmux(["pipe-pane", "-o", "-t", session.name, `cat >> ${shellQuote(raw)}`]);
		await sleep(200);
		for (const width of [100, 80, 60, 110]) {
			const offset = await readFile(raw).then(
				(data) => data.length,
				() => 0,
			);
			await tmux(["resize-window", "-t", session.name, "-x", String(width)]);
			// The live pass is immediate: one box well before the full rewrite (200 ms) runs.
			await sleep(60);
			const early = await boxes();
			if (early.count !== 1) {
				throw new Error(
					`60 ms after resizing to ${width} columns there are ${early.count} input boxes:\n${early.screen}`,
				);
			}
			// ...and it repainted only the live area: no clear screen yet (that is the full pass).
			const live = (await readFile(raw)).subarray(offset).toString("utf8");
			if (!live.startsWith("\x1b[?2026h") || live.includes("\x1b[2J")) {
				throw new Error(
					`The first pass after resizing to ${width} columns was not a live repaint: ${JSON.stringify(live.slice(0, 120))}`,
				);
			}
			await sleep(400);
			const { count, screen } = await boxes();
			if (count !== 1) throw new Error(`After resizing to ${width} columns there are ${count} input boxes:\n${screen}`);
			// One synchronized frame, and nothing before it: Ink's own erase-and-redraw no longer runs.
			const written = (await readFile(raw)).subarray(offset).toString("utf8");
			if (!written.startsWith("\x1b[?2026h") || !written.includes("\x1b[?2026l")) {
				throw new Error(
					`A resize to ${width} columns was not one synchronized frame: ${JSON.stringify(written.slice(0, 120))}`,
				);
			}
		}
		await tmux(["pipe-pane", "-t", session.name]);
		await session.waitFor("SMOKE_PRICING_OK", 5_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok resize (inline)");
	} finally {
		await session.kill();
	}
}

// P33: full screen clips instead of re-wrapping; every resize repaints one synchronized frame.
async function runFullscreenResizeSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "fs-resize", false);
	const session = await startTui(
		"fs-resize",
		dirs,
		baseUrl,
		["--no-session"],
		["TAU_PRICING=in=0.5,out=2", "TAU_TUI_MODE=fullscreen"],
	);
	const boxes = async () => {
		const screen = await tmux(["capture-pane", "-t", session.name, "-p"]);
		return { count: screen.split("\n").filter((line) => line.trimStart().startsWith("╭")).length, screen };
	};
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("pricing smoke", "Enter");
		await session.waitFor("SMOKE_PRICING_OK", 10_000);
		const raw = join(dirs.home, "fs-resize-output.bin");
		await tmux(["pipe-pane", "-o", "-t", session.name, `cat >> ${shellQuote(raw)}`]);
		await sleep(200);
		for (const [width, height] of [
			[100, 38],
			[70, 30],
			[50, 24],
			[110, 40],
		]) {
			const offset = await readFile(raw).then(
				(data) => data.length,
				() => 0,
			);
			await tmux(["resize-window", "-t", session.name, "-x", String(width), "-y", String(height)]);
			await sleep(400);
			const { count, screen } = await boxes();
			if (count !== 1)
				throw new Error(`After resizing to ${width}x${height} there are ${count} input boxes:\n${screen}`);
			if (!screen.includes("SMOKE_PRICING_OK"))
				throw new Error(`The transcript is gone after resizing to ${width}x${height}:\n${screen}`);
			const written = (await readFile(raw)).subarray(offset).toString("utf8");
			if (!written.startsWith("\x1b[?2026h\x1b[2J")) {
				throw new Error(
					`A resize to ${width}x${height} did not repaint the screen in one frame: ${JSON.stringify(written.slice(0, 80))}`,
				);
			}
		}
		await tmux(["pipe-pane", "-t", session.name]);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok fullscreen resize");
	} finally {
		await session.kill();
	}
}

// P33: a transcript taller than the screen scrolls; Ctrl+Home shows the start, Ctrl+End follows again.
async function runFullscreenScrollSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "fs-scroll", false);
	const session = await startTui("fs-scroll", dirs, baseUrl, ["--no-session"], ["TAU_TUI_MODE=fullscreen"]);
	const screen = () => tmux(["capture-pane", "-t", session.name, "-p"]);
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("long smoke", "Enter");
		await session.waitFor("LINE_080", 10_000);
		let shown = await screen();
		if (shown.includes("LINE_001")) throw new Error(`The start of a long answer should be scrolled away:\n${shown}`);
		await session.send("C-Home");
		await sleep(300);
		shown = await screen();
		if (!shown.includes("tau ·") || shown.includes("LINE_080") || !/more lines? below/.test(shown)) {
			throw new Error(`Ctrl+Home did not show the start with a "below" hint:\n${shown}`);
		}
		await session.send("PageDown");
		await sleep(300);
		shown = await screen();
		if (!/LINE_0[0-4]\d/.test(shown)) throw new Error(`PgDn did not move down a page:\n${shown}`);
		await session.send("C-End");
		await sleep(300);
		shown = await screen();
		if (!shown.includes("LINE_080") || /more lines? below/.test(shown))
			throw new Error(`Ctrl+End did not return to the end:\n${shown}`);
		// Two wheel notches up (SGR reports as the terminal sends them), nothing typed: 6 rows
		// scrolled, plus the one the "below" hint takes from the view.
		await session.send("-l", "\x1b[<64;20;5M\x1b[<64;20;5M");
		await sleep(300);
		shown = await screen();
		if (!/↓ 7 more lines below/.test(shown) || shown.includes("[<64")) {
			throw new Error(`The mouse wheel did not scroll the view:\n${shown}`);
		}
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok fullscreen scroll");
	} finally {
		await session.kill();
	}
}

// P33: leaving full screen restores the main screen and leaves the conversation in it.
async function runFullscreenExitSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "fs-exit", false);
	const session = await startTui(
		"fs-exit",
		dirs,
		baseUrl,
		["--no-session"],
		["TAU_PRICING=in=0.5,out=2", "TAU_TUI_MODE=fullscreen"],
	);
	try {
		await tmux(["set-option", "-t", session.name, "remain-on-exit", "on"]);
		await session.waitFor("tau ·", 10_000);
		await session.send("pricing smoke", "Enter");
		await session.waitFor("SMOKE_PRICING_OK", 10_000);
		await session.send("exit", "Enter");
		const pane = await deadPaneModes(session);
		if (pane !== "1 0 0") throw new Error(`tau did not exit back to the main screen with the mouse off: ${pane}`);
		const main = await tmux(["capture-pane", "-t", session.name, "-p", "-S", "-"]);
		if (!main.includes("› pricing smoke") || !main.includes("SMOKE_PRICING_OK")) {
			throw new Error(`The conversation was not written to the main screen:\n${main}`);
		}
		console.log("ok fullscreen exit");
	} finally {
		await session.kill();
	}
}

// P33: killed with SIGTERM, tau still leaves the alternate screen and turns the mouse off.
async function runFullscreenSignalSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "fs-signal", false);
	const session = await startTui("fs-signal", dirs, baseUrl, ["--no-session"], ["TAU_TUI_MODE=fullscreen"]);
	try {
		await tmux(["set-option", "-t", session.name, "remain-on-exit", "on"]);
		await session.waitFor("tau ·", 10_000);
		const pid = await tmux(["display-message", "-p", "-t", session.name, "#{pane_pid}"]);
		process.kill(Number(pid.trim()), "SIGTERM");
		const pane = await deadPaneModes(session);
		if (pane !== "1 0 0") throw new Error(`After SIGTERM the terminal was not restored: ${pane}`);
		console.log("ok fullscreen signal");
	} finally {
		await session.kill();
	}
}

/** "#{pane_dead} #{alternate_on} #{mouse_any_flag}" once the pane's process has exited (remain-on-exit). */
async function deadPaneModes(session) {
	const started = Date.now();
	let pane = "";
	while (Date.now() - started < 10_000) {
		pane = (
			await tmux(["display-message", "-p", "-t", session.name, "#{pane_dead} #{alternate_on} #{mouse_any_flag}"])
		).trim();
		if (pane.startsWith("1")) break;
		await sleep(100);
	}
	return pane;
}

// P15 验收：supervised 档下高风险 bash 触发审批选择器——Allow once 执行 / Deny 拒绝
// / Always allow 持久化到 ~/.tau/permissions.json，且第二个 TUI 进程直接放行。
async function runApprovalSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "approval", false);
	const session = await startTui("approval", dirs, baseUrl, ["--no-session", "--permission-mode", "supervised"]);
	try {
		await session.waitFor("· supervised", 10_000);

		// Allow once: the command runs, the model sees its output.
		await session.send("approval smoke", "Enter");
		await session.waitFor("bash wants to run", 10_000);
		await session.waitFor("high risk", 10_000);
		await session.waitFor("Always allow", 10_000);
		await session.send("1", "Enter");
		await session.waitFor("SMOKE_APPROVAL_DONE_1", 15_000);

		// Deny: the model sees the denial instead.
		await session.send("approval smoke", "Enter");
		await session.waitFor("Deny", 10_000);
		await session.send("3", "Enter");
		await session.waitFor("SMOKE_APPROVAL_DENIED_1", 15_000);

		// Always allow: runs now and persists the rule.
		await session.send("approval smoke", "Enter");
		await session.waitFor("Always allow", 10_000);
		await session.send("2", "Enter");
		await session.waitFor("SMOKE_APPROVAL_DONE_2", 15_000);

		// Same process, same rule: no selector — the flow only completes if the
		// call goes straight through.
		await session.send("approval smoke", "Enter");
		await session.waitFor("SMOKE_APPROVAL_DONE_3", 15_000);

		await session.send("exit", "Enter");
		await session.waitForExit();

		const persisted = await readFile(join(dirs.home, ".tau", "permissions.json"), "utf8");
		if (!persisted.includes('"bash"')) throw new Error(`permissions.json missing bash rule:\n${persisted}`);
	} finally {
		await session.kill();
	}

	// A fresh TUI process against the same HOME honors the persisted rule.
	const second = await startTui("approval-2", dirs, baseUrl, ["--no-session", "--permission-mode", "supervised"]);
	try {
		await second.waitFor("· supervised", 10_000);
		await second.send("approval smoke", "Enter");
		await second.waitFor("SMOKE_APPROVAL_DONE_4", 15_000);
		await second.send("exit", "Enter");
		await second.waitForExit();
		console.log("ok approval gate");
	} finally {
		await second.kill();
	}
}

// P27 验收：真终端里 Shift+Tab 切档、/mode 选择器与参数补全、/tools 选择器、
// /export 写出 HTML、/hotkeys。
async function runCommandsSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "commands", false);
	const session = await startTui("commands", dirs, baseUrl, ["--no-session", "--permission-mode", "supervised"]);
	try {
		await session.waitFor("· supervised", 10_000);
		await session.send("BTab");
		await session.waitFor("Accept edits:", 10_000);
		await session.waitFor("· accept-edits", 10_000);
		await session.send("/mode", "Enter");
		await session.waitFor("Permission mode (current: accept-edits)", 10_000);
		await session.send("Escape");
		await session.send("/mode rea");
		await session.waitFor("tools that change files or run commands are denied", 10_000);
		await session.send("Enter");
		await session.send("Enter");
		await session.waitFor("Read-only:", 10_000);
		await session.waitFor("· read-only", 10_000);
		await session.send("/tools", "Enter");
		await session.waitFor("Tools (", 10_000);
		await session.send("Escape");
		await session.send("/export", "Enter");
		await session.waitFor("Exported the session to", 10_000);
		const exported = (await readdir(dirs.cwd)).filter((name) => name.endsWith(".html"));
		if (exported.length !== 1) throw new Error(`expected one exported HTML file, found ${exported.join(", ")}`);
		await session.send("/hotkeys", "Enter");
		await session.waitFor("/mode for bypass", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok commands");
	} finally {
		await session.kill();
	}
}

// P28 验收：只靠 ~/.tau/models.json 与 settings 缺省模型启动（指向别处的
// TAU_BASE_URL、TAU_MODEL 被忽略），/model 跨供应商切换后请求换了模型。
async function runModelsSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "models", false);
	await mkdir(join(dirs.home, ".tau"), { recursive: true });
	await writeFile(
		join(dirs.home, ".tau", "models.json"),
		JSON.stringify({
			providers: {
				alpha: { baseUrl, apiKey: "k", models: [{ id: "alpha-1", contextWindow: 32000 }] },
				beta: { baseUrl, apiKey: "k", models: [{ id: "beta-2", contextWindow: 64000 }] },
			},
		}),
		"utf8",
	);
	await writeFile(join(dirs.home, ".tau", "settings.json"), JSON.stringify({ defaultModel: "alpha/alpha-1" }), "utf8");
	const session = await startTui(
		"models",
		dirs,
		baseUrl,
		["--no-session"],
		["TAU_BASE_URL=http://127.0.0.1:9/v1", "TAU_MODEL=ignored-model"],
	);
	try {
		await session.waitFor("alpha/alpha-1", 10_000);
		await session.send("which model", "Enter");
		await session.waitFor("MODEL_IS_alpha-1", 10_000);
		await session.send("/model beta/beta-2", "Enter");
		await session.waitFor("Model set to beta/beta-2.", 10_000);
		await session.send("which model", "Enter");
		await session.waitFor("MODEL_IS_beta-2", 10_000);
		await session.waitFor("beta/beta-2 · autonomous", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok models");
	} finally {
		await session.kill();
	}
}

// P15 验收：trust.json 内容 digest——同内容二次启动不再询问；扩展内容修改后
// 重新触发信任询问。
async function runTrustDigestSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "trust-digest", false);
	await writeSmokeExtension(dirs.cwd);

	const first = await startTui("trust-digest-1", dirs, baseUrl, ["--no-session"]);
	try {
		await first.waitFor("Trust this directory", 10_000);
		await first.send("y", "Enter");
		await first.waitFor("SMOKE_HEADER", 10_000);
		await first.send("exit", "Enter");
		await first.waitForExit();
	} finally {
		await first.kill();
	}

	// Unchanged content: no question — the header can only appear if startup
	// was not blocked on the trust confirm.
	const second = await startTui("trust-digest-2", dirs, baseUrl, ["--no-session"]);
	try {
		await second.waitFor("SMOKE_HEADER", 10_000);
		const screen = await second.capture();
		if (screen.includes("Trust this directory")) throw new Error(`Unexpected re-question:\n${screen}`);
		await second.send("exit", "Enter");
		await second.waitForExit();
	} finally {
		await second.kill();
	}

	// Changed content: the digest no longer matches → question again.
	const extensionPath = join(dirs.cwd, ".tau", "extensions", "smoke.mjs");
	await writeFile(extensionPath, `${await readFile(extensionPath, "utf8")}\n// digest-buster\n`, "utf8");
	const third = await startTui("trust-digest-3", dirs, baseUrl, ["--no-session"]);
	try {
		await third.waitFor("changed since they were last trusted", 10_000);
		await third.waitFor("Trust this directory", 10_000);
		await third.send("y", "Enter");
		await third.waitFor("SMOKE_HEADER", 10_000);
		await third.send("exit", "Enter");
		await third.waitForExit();
		console.log("ok trust digest");
	} finally {
		await third.kill();
	}
}

// P26b: parallel subagents through the built-in subagent tool, with live progress.
async function runSubagentSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "subagent", true);
	const session = await startTui("subagent", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("tau ·", 10_000);
		await session.send("subagent smoke", "Enter");
		await session.waitFor("subagent(2 in parallel: scout, worker)", 10_000);
		await session.waitFor("SMOKE_SUBAGENT_DONE", 15_000);
		const screen = await session.capture();
		if (!screen.includes("RESULT_SCOUT") || !screen.includes("RESULT_WORKER")) {
			throw new Error(`subagent answers missing:
${screen}`);
		}
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok subagent");
	} finally {
		await session.kill();
	}
}

async function startMockOpenAI() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			const parsed = JSON.parse(body);
			requests.push(parsed);
			const response = responseFor(parsed);
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const payload of response.payloads) {
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
				if (response.chunkDelayMs) await sleep(response.chunkDelayMs);
			}
			if (!response.hold) res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function responseFor(request) {
	const messages = Array.isArray(request.messages) ? request.messages : [];
	const toolContents = messages
		.filter((message) => message.role === "tool")
		.map((message) => String(message.content ?? ""));
	if (toolContents.some((c) => c.includes("PAR_A_2")) && toolContents.some((c) => c.includes("PAR_B_2"))) {
		return textTurn("SMOKE_PARALLEL_DONE");
	}
	const lastMessage = messages.at(-1);
	if (lastMessage?.role === "tool" && String(lastMessage.content ?? "").includes("RESULT_SCOUT")) {
		return textTurn("SMOKE_SUBAGENT_DONE");
	}
	if (lastMessage?.role === "tool") {
		const content = String(lastMessage.content ?? "");
		if (content.includes("BASH_SMOKE_LINE_3")) return textTurn("SMOKE_BASH_DONE");
		if (content.includes("SMOKE_TOOL_OUTPUT")) return textTurn("SMOKE_CUSTOM_TOOL_DONE");
		if (content.includes("APPROVAL_RAN_42")) return textTurn(`SMOKE_APPROVAL_DONE_${++approvalDoneCount}`);
		if (content.includes("Denied by policy")) return textTurn(`SMOKE_APPROVAL_DENIED_${++approvalDenyCount}`);
	}
	const lastUser = messages.findLast((message) => message.role === "user");
	const content = String(lastUser?.content ?? "");
	if (content.includes("which model")) return textTurn(`MODEL_IS_${request.model}`);
	if (content.includes("stream smoke")) return textTurn("SMOKE_STREAM_OK", 40);
	if (content === "SCOUT_TASK") return textTurn("RESULT_SCOUT", 40);
	if (content === "WORKER_TASK") return textTurn("RESULT_WORKER", 40);
	if (content.includes("subagent smoke")) {
		return toolCallTurn("subagent", { tasks: [{ agent: "scout", task: "SCOUT_TASK" }, { task: "WORKER_TASK" }] });
	}
	if (content.includes("approval smoke")) {
		// rm -rf hits the kernel's dangerous-command rules (high risk) but only
		// touches a scratch path inside the sandbox; the echo only prints when
		// the command actually executed.
		return toolCallTurn("bash", { command: "rm -rf ./approval-scratch; echo APPROVAL_RAN_$((6*7))" });
	}
	if (content.includes("bash smoke")) {
		return toolCallTurn("bash", {
			command:
				"node -e 'let i=0; const timer=setInterval(() => { i++; console.log(\"BASH_SMOKE_LINE_\" + i); if (i === 3) clearInterval(timer); }, 120)'",
		});
	}
	if (content.includes("custom smoke tool")) return toolCallTurn("smoke_tool", {});
	if (content.includes("parallel smoke")) {
		return {
			payloads: [
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_par_a",
										function: { name: "bash", arguments: '{"command":"sleep 1 && echo PAR_A_$((1+1))"}' },
									},
									{
										index: 1,
										id: "call_par_b",
										function: { name: "bash", arguments: '{"command":"echo PAR_B_$((1+1))"}' },
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				},
			],
		};
	}
	if (content.includes("ext abort smoke")) {
		return { payloads: [{ choices: [{ delta: { content: "EXT_ABORT_TRIGGER " } }] }], hold: true };
	}
	if (content.includes("hang smoke")) {
		return { payloads: [{ choices: [{ delta: { content: "SMOKE_ABORT_STREAM " } }] }], hold: true };
	}
	if (content.includes("long smoke")) {
		const lines = Array.from({ length: 80 }, (_, i) => `LINE_${String(i + 1).padStart(3, "0")}`).join("\n\n");
		return { payloads: [{ choices: [{ delta: { content: lines }, finish_reason: "stop" }] }] };
	}
	if (content.includes("pricing smoke")) {
		return {
			payloads: [
				{ choices: [{ delta: { content: "SMOKE_PRICING_OK" }, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000, total_tokens: 3_000_000 } },
			],
		};
	}
	if (content.includes("selector first")) return textTurn("SMOKE_SELECTOR_FIRST");
	if (content.includes("SMOKE_RELOAD_PROMPT")) return textTurn("SMOKE_RELOAD_RESPONSE");
	return textTurn("SMOKE_DEFAULT_RESPONSE");
}

function textTurn(text, chunkDelayMs = 0) {
	return { payloads: [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }], chunkDelayMs };
}

function toolCallTurn(name, args) {
	return {
		payloads: [
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		],
	};
}

async function requireTmux() {
	try {
		await execFileP("tmux", ["-V"]);
	} catch (error) {
		throw new Error(`tmux is required for TUI smoke tests: ${error.message}`);
	}
}

async function tmux(args) {
	return await execFileP("tmux", args);
}

function execFileP(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
			if (error) {
				error.message = `${error.message}\n${stderr}`;
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
