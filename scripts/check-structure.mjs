#!/usr/bin/env node
// Structure gate (P51): keeps the files P50 split from growing back, and the CLI's non-TUI entry
// points from loading the TUI.
//
// 1. Line limits. Every source file under packages/*/src stays within DEFAULT_LIMIT lines; the files
//    already above it have their own ceiling (their size when the gate was added, rounded up to 50),
//    and the three files P50 split keep P50's targets. Over the limit: split the file, or raise its
//    ceiling here on purpose, with the reason in a comment.
// 2. Dependency direction. The CLI's root modules and modes/ must not reach tui/controller.ts through
//    static imports: -p, the REPL, json, rpc and acp do not load the TUI (main.ts imports it
//    dynamically when the TUI starts).
// 3. The TUI is a client (P57): nothing under tui/ imports the kernel's Agent or ExtensionRegistry, or
//    the hub (server/); it reaches the session through the protocol (tui/session-client.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 1000;
const LIMITS = {
	// P50's targets for the files it split.
	"packages/cli/src/main.ts": 1000,
	"packages/cli/src/tui/controller.ts": 1500,
	"packages/kernel/src/agent.ts": 2500,
	// Above the default when the gate was added (2026-10-23): no further growth.
	"packages/kernel/src/extensions.ts": 2350,
	"packages/cli/src/tui/commands.ts": 1500,
	"packages/ext-mcp-http/src/client.ts": 1250,
	"packages/ext-feishu/src/index.ts": 1200,
	"packages/cli/src/hooks.ts": 1200,
	"packages/ext-mcp-http/src/servers.ts": 1150,
	"packages/ext-feishu/src/feishu-client.ts": 1100,
	"packages/gateway/src/gateway.ts": 1050,
	"packages/kernel/src/permission-rules.ts": 1050,
	"packages/cli/src/tui/model.ts": 1050,
};

const sources = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) sources.push(path);
	}
};
for (const pkg of readdirSync(join(root, "packages"))) {
	const src = join(root, "packages", pkg, "src");
	if (existsSync(src)) walk(src);
}

const problems = [];
for (const file of sources) {
	const key = relative(root, file).split("\\").join("/");
	const lines = readFileSync(file, "utf8").split("\n").length - 1;
	const limit = LIMITS[key] ?? DEFAULT_LIMIT;
	if (lines > limit)
		problems.push(
			`${key}: ${lines} lines, limit ${limit}. Split it, or raise its limit in scripts/check-structure.mjs with the reason.`,
		);
}
for (const key of Object.keys(LIMITS)) {
	if (!existsSync(join(root, key)))
		problems.push(`${key} is listed in LIMITS but does not exist (moved? update the list).`);
}

// Static imports only: `import type` / `export type` are erased, `import("…")` is dynamic.
const STATIC_IMPORT = /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
function staticImports(file) {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(STATIC_IMPORT)]
		.map((match) => resolve(dirname(file), match[1]))
		.filter((path) => existsSync(path));
}
const cliSrc = join(root, "packages", "cli", "src");
const controller = join(cliSrc, "tui", "controller.ts");
const entries = [
	...readdirSync(cliSrc)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(cliSrc, name)),
	...readdirSync(join(cliSrc, "modes"))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(cliSrc, "modes", name)),
];
for (const entry of entries) {
	// Breadth-first, remembering how each module was reached, to print the chain.
	const via = new Map([[entry, undefined]]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift();
		if (file === controller) {
			const chain = [];
			for (let at = file; at !== undefined; at = via.get(at)) chain.unshift(relative(cliSrc, at).split("\\").join("/"));
			problems.push(
				`${chain[0]} reaches tui/controller.ts through static imports: ${chain.join(" → ")}. Load the TUI dynamically, or move what it needs to a module without the controller.`,
			);
			break;
		}
		for (const next of staticImports(file)) {
			if (via.has(next)) continue;
			via.set(next, file);
			queue.push(next);
		}
	}
}

const tuiDir = join(cliSrc, "tui");
const KERNEL_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@yophon\/tau-kernel["']/g;
for (const file of sources.filter((path) => path.startsWith(tuiDir))) {
	const key = relative(root, file).split("\\").join("/");
	const text = readFileSync(file, "utf8");
	for (const match of text.matchAll(KERNEL_IMPORT)) {
		const names = match[1].split(",").map(
			(name) =>
				name
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)[0],
		);
		for (const forbidden of ["Agent", "ExtensionRegistry"]) {
			if (names.includes(forbidden)) {
				problems.push(
					`${key}: imports ${forbidden} from @yophon/tau-kernel; the TUI reaches the session through the protocol (tui/session-client.ts).`,
				);
			}
		}
	}
	if (/from\s+["'](?:\.\.\/)+server\//.test(text)) {
		problems.push(`${key}: imports the hub (server/); the TUI is a client of it (tui/session-client.ts).`);
	}
}

if (problems.length > 0) {
	console.error(`Structure check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	process.exit(1);
}
console.log(
	`Structure check passed (${sources.length} source files within their line limits; the CLI's non-TUI entry points do not load the TUI controller; the TUI reaches sessions through the protocol only).`,
);
