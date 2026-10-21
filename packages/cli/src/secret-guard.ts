// The secret guard (P32b), a built-in extension: tools the model calls cannot
// read tau's credential files, and known secret values are masked in tool
// results before they reach the model or the session log. It reduces accidents;
// a determined model can still get around it (base64, path tricks). Blocked
// calls are ordinary tool results the model can explain, and the audit ledger
// records them as decided by a hook.
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Extension, ExtensionContext, JsonValue } from "@yophon/tau-kernel";
import { maskSecrets, scrubbedNames } from "./secrets.ts";

/** Files under ~/.tau that hold secrets, and the gateway's channel data (WeChat tokens). */
export function protectedPaths(home: string): { files: string[]; dirs: string[] } {
	const tau = join(home, ".tau");
	return {
		files: [
			join(tau, "credentials.json"),
			join(tau, "models.json"),
			join(tau, "mcp.json"),
			join(tau, "mcp-auth.json"),
			join(tau, "gateway", "config.json"),
		],
		dirs: [join(tau, "gateway", "weixin"), join(tau, "gateway", "feishu")],
	};
}

/** Text a shell command would contain to name one of them (any slash, any case). */
const COMMAND_MARKERS = [
	"credentials.json",
	"mcp-auth.json",
	".tau/models.json",
	".tau/mcp.json",
	"gateway/config.json",
	"gateway/weixin",
	"gateway/feishu",
];

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function inside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const norm = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

export function createSecretGuard(options: {
	home: string;
	envAllow?: readonly string[];
	env?: Record<string, string | undefined>;
}): Extension {
	const { files, dirs } = protectedPaths(options.home);
	const env = options.env ?? process.env;
	const reason = (what: string) =>
		`Blocked: ${what} holds tau's credentials. tau keeps secrets away from the model; ask the user if you need something from it.`;

	/** The protected location this path is or (for grep, which reads contents) contains, if any. */
	const touches = (path: string, ctx: ExtensionContext | undefined, searchesBelow: boolean): string | undefined => {
		const base = ctx?.sessionManager?.getCwd() ?? process.cwd();
		const target = norm(resolve(base, path));
		for (const file of files) {
			if (target === norm(file) || (searchesBelow && inside(norm(file), target))) return file;
		}
		for (const dir of dirs) {
			if (inside(target, norm(dir)) || (searchesBelow && inside(norm(dir), target))) return dir;
		}
		return undefined;
	};

	return (api) => {
		api.on("tool_call", (event, ctx) => {
			if (PATH_TOOLS.has(event.toolName)) {
				const value = event.input.path ?? event.input.file_path;
				if (typeof value !== "string" || value === "") return undefined;
				const hit = touches(value, ctx, event.toolName === "grep");
				return hit ? { block: true, reason: reason(hit) } : undefined;
			}
			// P40b: PowerShell commands are checked like bash ones.
			if ((event.toolName === "bash" || event.toolName === "powershell") && typeof event.input.command === "string") {
				const command = event.input.command.replaceAll("\\", "/").toLowerCase();
				const marker = COMMAND_MARKERS.find((candidate) => command.includes(candidate));
				return marker ? { block: true, reason: reason(marker) } : undefined;
			}
			return undefined;
		});

		api.on("tool_result", (event) => {
			let changed = false;
			const content = event.content.map((block) => {
				if (block.type !== "text") return block;
				const masked = maskSecrets(block.text);
				if (masked === block.text) return block;
				changed = true;
				return { ...block, text: masked };
			});
			// A command that used a variable tau removed gets a hint instead of a puzzling failure.
			if ((event.toolName === "bash" || event.toolName === "powershell") && typeof event.input.command === "string") {
				const command = event.input.command;
				const missing = scrubbedNames(env, options.envAllow).filter(
					(name) =>
						command.includes(`$${name}`) ||
						command.includes(`\${${name}}`) ||
						command.includes(`%${name}%`) ||
						command.toLowerCase().includes(`$env:${name.toLowerCase()}`),
				);
				if (missing.length > 0) {
					changed = true;
					content.push({
						type: "text",
						text: `(tau removes ${missing.join(", ")} from the environment of commands the model runs; the user can keep ${missing.length > 1 ? "them" : "it"} with shell.envAllow in ~/.tau/settings.json.)`,
					});
				}
			}
			const mask = (value: JsonValue | undefined): JsonValue | undefined => {
				if (value === undefined) return undefined;
				const text = JSON.stringify(value);
				const masked = maskSecrets(text);
				if (masked === text) return value;
				changed = true;
				return JSON.parse(masked) as JsonValue;
			};
			const details = mask(event.details);
			const structuredContent = mask(event.structuredContent);
			if (!changed) return undefined;
			return {
				content,
				...(details !== undefined ? { details } : {}),
				...(structuredContent !== undefined ? { structuredContent } : {}),
			};
		});
	};
}
