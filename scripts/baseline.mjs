#!/usr/bin/env node
// Baseline (P62a): how long tau takes to start, answer, serve and test, measured the same way each
// time so a later phase can compare. Medians of several runs; a mock model, a throwaway HOME.
//
//   node scripts/baseline.mjs                    # every section this machine can run
//   node scripts/baseline.mjs --only startup,serve --runs 9
//   node scripts/baseline.mjs --long-sizes 2000,10000
//
// Sections: startup (`tau --version`, `--help`), print (`tau -p` with one tool call), serve (the
// resident server: start, attach, a session, ten turns, its memory), long (bench-long-session.mjs),
// tests (`npm test` wall clock), tui (first screen in tmux; Linux/WSL only). Not part of CI: the
// numbers depend on the machine and its load (P42). docs/baseline.md keeps them.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { defaultAddress, probeDaemon, readDaemonInfo } from "../packages/cli/src/daemon.ts";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../test-fixtures/mock-openai.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "src", "main.ts");
const argv = process.argv.slice(2);
const option = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const only = option("--only")?.split(",");
const runs = Number(option("--runs") ?? 7);
const hasTmux = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const want = (section) => (only ? only.includes(section) : section !== "tui" || hasTmux);

const temps = [];
function tempDir(label) {
	const dir = mkdtempSync(join(tmpdir(), `tau-baseline-${label}-`));
	temps.push(dir);
	return dir;
}

/** A throwaway HOME and working directory, and the environment that points tau at the mock. */
function sandbox(label, baseUrl, settings = {}) {
	const home = tempDir(`${label}-home`);
	const cwd = tempDir(`${label}-cwd`);
	mkdirSync(join(home, ".tau"), { recursive: true });
	writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
	const env = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: baseUrl ?? "http://127.0.0.1:9/v1",
		TAU_API_KEY: "test",
		TAU_MODEL: "mock",
		TAU_PERMISSION_MODE: "supervised",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
		TAU_HISTORY: "",
	};
	for (const name of ["TAU_PROVIDER", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	return { home, cwd, env };
}

function runProcess(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		const started = performance.now();
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => resolvePromise({ ms: performance.now() - started, code, stdout, stderr }));
	});
}

const tau = (args, context) =>
	runProcess(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
		cwd: context.cwd,
		env: context.env,
	});

function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return { median, min: sorted[0], max: sorted.at(-1), runs: sorted.length };
}

const rows = [];
const notes = [];
const record = (item, values, unit = "ms") => rows.push({ item, unit, ...stats(values) });

/** A process's resident memory in MB. */
function residentMb(pid) {
	if (process.platform === "linux") {
		const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
		return Number(match?.[1] ?? Number.NaN) / 1024;
	}
	if (process.platform === "win32") {
		const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], {
			encoding: "utf8",
		});
		return Number(out.trim()) / 1048576;
	}
	return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
}

async function startup() {
	const context = sandbox("startup");
	for (const flag of ["--version", "--help"]) {
		const times = [];
		for (let i = 0; i < runs; i++) {
			const result = await tau([flag], context);
			if (result.code !== 0) throw new Error(`tau ${flag} exited ${result.code}: ${result.stderr}`);
			times.push(result.ms);
		}
		record(`tau ${flag}`, times);
	}
}

/** The model reads a file, then answers: one tool round trip. */
function readThenAnswer(request) {
	const messages = request.messages ?? [];
	return messages.at(-1)?.role === "tool"
		? mockTextTurn("BASELINE_DONE")
		: mockToolCallTurn("read", { path: "note.txt" });
}

async function print() {
	const mock = await startMockOpenAI([readThenAnswer]);
	try {
		const context = sandbox("print", mock.baseUrl);
		writeFileSync(join(context.cwd, "note.txt"), "a note\n");
		const times = [];
		for (let i = 0; i < Math.max(3, Math.ceil(runs / 2)); i++) {
			const result = await tau(["-p", "read note.txt"], context);
			if (result.code !== 0 || !result.stdout.includes("BASELINE_DONE")) {
				throw new Error(`tau -p failed (${result.code}): ${result.stdout}${result.stderr}`);
			}
			times.push(result.ms);
		}
		record("tau -p, one tool call (mock model)", times);
	} finally {
		await mock.close();
	}
}

async function serve() {
	const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
	const context = sandbox("serve", mock.baseUrl, { daemon: { shutdownGraceSeconds: 0 } });
	try {
		const start = await tau(["serve", "start"], context);
		if (start.code !== 0) throw new Error(`tau serve start: ${start.stdout}${start.stderr}`);
		record("tau serve start (until it accepts)", [start.ms]);
		const attachStarted = performance.now();
		const probe = await probeDaemon(defaultAddress(context.home), { name: "baseline" });
		if (probe.state !== "running") throw new Error(`no server: ${probe.state}`);
		record("attach (connect + initialize)", [performance.now() - attachStarted]);
		const client = probe.client;
		const completed = [];
		client.on("turn/completed", () => completed.push(performance.now()));
		const threadStarted = performance.now();
		const { thread } = await client.startThread({ cwd: context.cwd });
		record("open a session (thread/start)", [performance.now() - threadStarted]);
		const pid = readDaemonInfo(context.home)?.pid;
		const idle = pid ? residentMb(pid) : Number.NaN;
		const turns = [];
		for (let i = 0; i < 10; i++) {
			const before = completed.length;
			const turnStarted = performance.now();
			await client.startTurn(thread.id, `turn ${i}`);
			while (completed.length === before) await new Promise((r) => setTimeout(r, 2));
			turns.push(completed.at(-1) - turnStarted);
		}
		record("one turn through the server (mock model)", turns);
		rows.push({ item: "server memory, one idle session", unit: "MB", median: idle, min: idle, max: idle, runs: 1 });
		const busy = pid ? residentMb(pid) : Number.NaN;
		rows.push({ item: "server memory after 10 turns", unit: "MB", median: busy, min: busy, max: busy, runs: 1 });
		client.close();
	} finally {
		await tau(["serve", "stop"], context);
		await mock.close();
	}
}

async function long() {
	const sizes = option("--long-sizes");
	const result = await runProcess(
		process.execPath,
		[join(root, "scripts", "bench-long-session.mjs"), ...(sizes ? ["--sizes", sizes] : [])],
		{ cwd: root, env: process.env },
	);
	if (result.code !== 0) throw new Error(`bench-long-session: ${result.stderr}`);
	notes.push(`### Long session (bench-long-session.mjs)\n\n${result.stdout.trim()}`);
}

async function tests() {
	// One command line through the shell (npm is npm.cmd on Windows).
	const result = await runProcess("npm test", [], { cwd: root, env: process.env, shell: true });
	const summary = result.stdout
		.split("\n")
		.filter((line) => /^ℹ (tests|pass|fail|skipped) /.test(line))
		.map((line) => line.slice(2).trim())
		.join(", ");
	rows.push({
		item: `npm test (${summary})`,
		unit: "s",
		median: result.ms / 1000,
		min: result.ms / 1000,
		max: result.ms / 1000,
		runs: 1,
	});
	if (result.code !== 0) notes.push(`npm test exited ${result.code}.`);
}

async function tui() {
	const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
	try {
		const times = [];
		for (let i = 0; i < Math.max(3, Math.ceil(runs / 2)); i++) {
			const context = sandbox("tui", mock.baseUrl);
			const name = `tau-baseline-${process.pid}-${i}`;
			const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
			const command = [
				"env",
				`HOME=${quote(context.home)}`,
				`TAU_BASE_URL=${quote(mock.baseUrl)}`,
				"TAU_MODEL=mock TAU_API_KEY=test TAU_AUTO_TITLE=0 TAU_HISTORY=",
				...(process.env.CI ? [`CI=${quote(process.env.CI)}`] : []),
				quote(process.execPath),
				"--disable-warning=ExperimentalWarning",
				quote(cli),
				"--no-daemon",
			].join(" ");
			const started = performance.now();
			execFileSync("tmux", ["new-session", "-d", "-x", "120", "-y", "38", "-s", name, "-c", context.cwd, command]);
			try {
				for (;;) {
					const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", name], { encoding: "utf8" });
					if (pane.includes("tau ·")) break;
					if (performance.now() - started > 30_000) throw new Error(`no first screen:\n${pane}`);
					await new Promise((r) => setTimeout(r, 10));
				}
				times.push(performance.now() - started);
			} finally {
				execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
			}
		}
		record("TUI first screen (tmux, --no-daemon)", times);
	} finally {
		await mock.close();
	}
}

const sections = { startup, print, serve, long, tests, tui };
try {
	for (const [name, run] of Object.entries(sections)) {
		if (!want(name)) continue;
		process.stderr.write(`baseline: ${name}…\n`);
		await run();
	}
} finally {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

const format = (value, unit) => (Number.isFinite(value) ? (unit === "ms" ? value.toFixed(0) : value.toFixed(1)) : "—");
console.log(`Baseline ${new Date().toLocaleDateString("sv")} · Node ${process.versions.node} · ${process.platform}\n`);
console.log("| item | median | min | max | runs |\n|---|---|---|---|---|");
for (const row of rows) {
	console.log(
		`| ${row.item} | ${format(row.median, row.unit)} ${row.unit} | ${format(row.min, row.unit)} | ${format(row.max, row.unit)} | ${row.runs} |`,
	);
}
for (const note of notes) console.log(`\n${note}`);
