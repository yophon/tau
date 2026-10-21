// P40 in the kernel: the PowerShell tool and its permission rules (40b); the rest of pi's
// extension surface (40d): provider events, UI prompt events, markdown transformers, overflow
// recovery, and the tree preparation's summary choice and label.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Agent,
	type AgentEvent,
	type BackgroundShell,
	type ChatTransport,
	createCodingTools,
	createDefaultPolicy,
	type Extension,
	ExtensionRegistry,
	JsonlSessionRepo,
	matchPermissionRules,
	type PermissionRule,
	type PermissionRules,
	parsePermissionRule,
	parsePowerShellCommand,
	SessionRecorder,
	type Shell,
	type TreePreparation,
	type UiCapability,
} from "../src/index.ts";
import type { PlatformResponse } from "../src/platform.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const tick = String.fromCharCode(96);

function rule(text: string, kind: PermissionRule["kind"]): PermissionRule {
	const parsed = parsePermissionRule(text, kind);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed.rule;
}

function rules(spec: { allow?: string[]; ask?: string[]; deny?: string[] }): PermissionRules {
	return {
		allow: (spec.allow ?? []).map((text) => rule(text, "allow")),
		ask: (spec.ask ?? []).map((text) => rule(text, "ask")),
		deny: (spec.deny ?? []).map((text) => rule(text, "deny")),
	};
}

const decide = (set: PermissionRules, command: string) =>
	matchPermissionRules(set, { toolName: "powershell", args: { command } })?.kind;

describe("P40b: PowerShell commands taken apart", () => {
	it("splits at | ; && || and line breaks, resolves aliases, keeps quoted separators", () => {
		assert.deepEqual(parsePowerShellCommand("gci -Recurse | sort Name").segments, [
			"Get-ChildItem -Recurse",
			"Sort-Object Name",
		]);
		assert.deepEqual(parsePowerShellCommand("Get-Process && echo ok || echo bad").segments, [
			"Get-Process",
			"Write-Output ok",
			"Write-Output bad",
		]);
		assert.deepEqual(parsePowerShellCommand("cd src\nls").segments, ["Set-Location src", "Get-ChildItem"]);
		assert.deepEqual(parsePowerShellCommand(`Write-Output 'a;b' "c|d" e${tick};f`).segments, [
			"Write-Output a;b c|d e;f",
		]);
		assert.deepEqual(parsePowerShellCommand("git commit -m 'it''s done'").segments, ["git commit -m it's done"]);
		assert.deepEqual(parsePowerShellCommand(`Get-ChildItem ${tick}\n  -Force`).segments, ["Get-ChildItem -Force"]);
		assert.deepEqual(parsePowerShellCommand("ls # list it").segments, ["Get-ChildItem"]);
	});

	it("redirection targets are writes; stream merges and $null are not", () => {
		const parsed = parsePowerShellCommand("Get-Content a.txt > out.txt 2>&1; echo x 2> $null");
		assert.deepEqual(parsed.segments, ["Get-Content a.txt", "Write-Output x"]);
		assert.deepEqual(parsed.writes, ["out.txt"]);
	});

	it("what the tokenizer cannot take apart is not ok", () => {
		for (const command of [
			"Write-Output $(Get-Date)",
			'Write-Output "now: $(Get-Date)"',
			"Get-ChildItem | Where-Object { $_.Length -gt 1 }",
			"& .\\build.ps1",
			"Start-Job -ScriptBlock {}",
			"@(1, 2)",
			"Get-Content < in.txt",
			"a |",
			"| a",
			"'open",
			'"open',
		]) {
			assert.equal(parsePowerShellCommand(command).ok, false, command);
		}
	});
});

describe("P40b: PowerShell permission rules (Claude Code)", () => {
	const set = rules({
		allow: ["PowerShell(Get-ChildItem *)", "PowerShell(git commit:*)"],
		deny: ["PowerShell(Remove-Item *)"],
	});

	it("a cmdlet rule covers its aliases, without regard to case", () => {
		assert.equal(decide(set, "gci"), "allow");
		assert.equal(decide(set, "DIR -Force"), "allow");
		assert.equal(decide(set, "get-childitem src"), "allow");
		assert.equal(decide(set, "git commit -m 'x'"), "allow");
		assert.equal(decide(rules({ allow: ["PowerShell(gci *)"] }), "Get-ChildItem x"), "allow");
	});

	it("every command of a compound must be allowed; any denied one denies it", () => {
		assert.equal(decide(set, "gci; Get-Date"), undefined);
		assert.equal(decide(set, "gci; Remove-Item x"), "deny");
		assert.equal(decide(set, "ls | rm x"), "deny");
		assert.equal(decide(set, "gci && git commit -m y"), "allow");
	});

	it("an unparseable command is never allowed by a rule; a bare PowerShell rule allows everything", () => {
		assert.equal(decide(set, "dir $(pwd)"), undefined);
		assert.equal(decide(rules({ allow: ["PowerShell"] }), "anything | at all"), "allow");
		assert.equal(decide(rules({ allow: ["PowerShell(*)"] }), "a; b"), "allow");
	});

	it("Bash rules do not cover PowerShell, nor PowerShell rules bash", () => {
		assert.equal(decide(rules({ allow: ["Bash(ls *)"] }), "ls"), undefined);
		assert.equal(
			matchPermissionRules(rules({ allow: ["PowerShell(ls *)"] }), { toolName: "bash", args: { command: "ls" } }),
			undefined,
		);
	});

	it("Edit deny rules apply to redirection targets", () => {
		assert.equal(decide(rules({ deny: ["Edit(secret.txt)"] }), "Get-Date > secret.txt"), "deny");
	});
});

describe("P40b: the powershell tool", () => {
	const shell = (seen: string[]): Shell => ({
		exec: async (command) => {
			seen.push(command);
			return { stdout: "ok", stderr: "", exitCode: 0 };
		},
	});

	it("comes with the shell when the host gives one, with pi's snippet and Claude Code's primary-shell guideline", () => {
		const tools = createCodingTools({ shell: shell([]), powershell: { shell: shell([]) } });
		const powershell = tools.find((tool) => tool.name === "powershell");
		assert.ok(powershell);
		assert.equal(powershell.promptSnippet, "Execute PowerShell commands");
		assert.match(powershell.promptGuidelines?.join("\n") ?? "", /primary shell/);
		assert.match(powershell.description ?? "", /^Run a PowerShell command/);
		assert.ok(!createCodingTools({ shell: shell([]) }).some((tool) => tool.name === "powershell"));
		assert.ok(
			!createCodingTools({ shell: shell([]), powershell: { shell: shell([]) } }, { mode: "read-only" }).some(
				(tool) => tool.name === "powershell",
			),
		);
	});

	it("runs through its own shell; Start-Sleep stops at its timeout, other commands move to the background", async () => {
		const bashSeen: string[] = [];
		const psSeen: string[] = [];
		const runs: Array<{ command: string; onTimeout?: string }> = [];
		const background: BackgroundShell = {
			start: async () => ({ id: "b1", command: "", outputPath: "/t/b1", status: "running", startedAt: 0 }),
			stop: async () => ({ id: "b1", command: "", outputPath: "/t/b1", status: "killed", startedAt: 0 }),
			list: () => [],
			run: async (command, options) => {
				runs.push({ command, ...(options?.onTimeout ? { onTimeout: options.onTimeout } : {}) });
				return { kind: "exited", result: { stdout: "done", stderr: "", exitCode: 0 } };
			},
		};
		const tools = createCodingTools({
			shell: shell(bashSeen),
			background,
			powershell: { shell: shell(psSeen), background },
		});
		const powershell = tools.find((tool) => tool.name === "powershell");
		assert.ok(powershell);
		await powershell.execute({ command: "Start-Sleep 5" }, undefined);
		await powershell.execute({ command: "npm run build" }, undefined);
		assert.deepEqual(runs, [
			{ command: "Start-Sleep 5", onTimeout: "stop" },
			{ command: "npm run build", onTimeout: "background" },
		]);
		assert.deepEqual(bashSeen, []);
		assert.match(tools.find((tool) => tool.name === "task_stop")?.description ?? "", /bash or powershell/);
	});

	it("risk is bash's: medium, high for a dangerous command", () => {
		const policy = createDefaultPolicy();
		assert.equal(policy.assess({ toolName: "powershell", args: { command: "Get-Date" } }, "supervised").risk, "medium");
		assert.equal(policy.assess({ toolName: "powershell", args: { command: "rm -rf /" } }, "supervised").risk, "high");
	});
});

async function drain(agent: Agent, input: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input)) events.push(event);
	return events;
}

const withHeaders = (response: PlatformResponse, headers: Record<string, string>): PlatformResponse => {
	const map = new Map(Object.entries(headers));
	return {
		...response,
		headers: {
			get: (name: string) => map.get(name.toLowerCase()) ?? null,
			forEach: (callback: (value: string, key: string) => void) => {
				for (const [key, value] of map) callback(value, key);
			},
		} as PlatformResponse["headers"],
	};
};

/** Replies in order to the conversation; a summary request (it sets max_tokens) gets a summary. */
function routed(replies: PlatformResponse[], requests: unknown[] = []) {
	const queue = [...replies];
	const respond = (init?: { body?: string }): PlatformResponse => {
		const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		if (body.max_tokens !== undefined) return makeSseResponse(textTurn("SUMMARY of what happened"));
		const next = queue.shift();
		if (!next) throw new Error("no reply left");
		return next;
	};
	return fakePlatform(
		Array.from({ length: 20 }, () => respond),
		requests,
	);
}

const overflowResponse = (): PlatformResponse => ({
	ok: false,
	status: 400,
	text: async () => JSON.stringify({ error: { message: "prompt is too long: 300000 tokens > 200000 maximum" } }),
	body: null,
});

describe("P40d: provider events (pi)", () => {
	it("before_provider_request replaces the payload; after_provider_response and provider_stream_event report", async () => {
		const requests: unknown[] = [];
		const responses: Array<{ status: number; headers: Record<string, string> }> = [];
		const streamed: Array<{ provider: string; api: string; model: string; data: unknown }> = [];
		const extension: Extension = (api) => {
			api.on("before_provider_request", (event) => ({ ...(event.payload as object), custom_field: "set" }));
			api.on("before_provider_request", (event) => {
				(event.payload as Record<string, unknown>).second = (event.payload as Record<string, unknown>).custom_field;
				return undefined;
			});
			api.on("after_provider_response", (event) => {
				responses.push({ status: event.status, headers: event.headers });
			});
			api.on("provider_stream_event", (event) => {
				streamed.push({ provider: event.provider, api: event.api, model: event.model, data: event.data });
			});
		};
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
			platform: fakePlatform([withHeaders(makeSseResponse(textTurn("hello")), { "x-request-id": "r1" })], requests),
			extensions: await ExtensionRegistry.load([extension]),
		});
		await drain(agent, "hi");
		assert.equal((requests[0] as Record<string, unknown>).custom_field, "set");
		assert.equal((requests[0] as Record<string, unknown>).second, "set");
		assert.deepEqual(responses, [{ status: 200, headers: { "x-request-id": "r1" } }]);
		assert.ok(streamed.length > 0);
		assert.deepEqual(
			{ provider: streamed[0].provider, api: streamed[0].api, model: streamed[0].model },
			{ provider: "openai-compat", api: "openai-completions", model: "fake-model" },
		);
		assert.ok(JSON.stringify(streamed.map((event) => event.data)).includes("hello"));
	});

	it("a transport that does not report them makes those handlers an error, not a silent no-op", async () => {
		const transport: ChatTransport = async function* () {
			yield* [];
		};
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			transport,
			extensions: await ExtensionRegistry.load([
				(api) => {
					api.on("provider_stream_event", () => undefined);
				},
			]),
		});
		await assert.rejects(drain(agent, "hi"), /supportsProviderEvents/);
	});
});

describe("P40d: ui_prompt_start / ui_prompt_end (pi)", () => {
	it("an extension's prompt is bracketed by the two events; notify and approvals are not", async () => {
		const seen: string[] = [];
		const ui: UiCapability = {
			confirm: async () => {
				seen.push("confirm shown");
				return true;
			},
			input: async () => "typed",
			select: async (_title, options) => options[0],
			notify: () => seen.push("notified"),
			selectMany: async (_title, options) => options,
		};
		const registry = await ExtensionRegistry.load([
			(api) => {
				api.on("ui_prompt_start", (event) => {
					seen.push(`start ${event.kind} ${event.title} ${event.reason}`);
				});
				api.on("ui_prompt_end", (event) => {
					seen.push(`end ${event.kind} ${event.title}`);
				});
				api.registerCommand("ask", {
					description: "ask",
					handler: async (_args, ctx) => {
						ctx.ui?.notify("hello");
						const sure = await ctx.ui?.confirm("Sure?");
						const many = await ctx.ui?.selectMany?.("Pick", ["a", "b"]);
						return `${sure} ${many?.join(",")}`;
					},
				});
			},
		]);
		const agent = new Agent({ config: { baseUrl: "https://fake.test/v1", model: "m" }, extensions: registry, ui });
		const result = await registry.commands.get("ask")?.handler("", agent.extensionContext());
		assert.equal(result, "true a,b");
		assert.deepEqual(seen, [
			"notified",
			"start confirm Sure? ui_prompt",
			"confirm shown",
			"end confirm Sure?",
			"start select Pick ui_prompt",
			"end select Pick",
		]);
	});
});

describe("P40d: registerMarkdownTransformer (pi)", () => {
	it("one per extension, a later call replaces it, in load order", async () => {
		const registry = await ExtensionRegistry.load([
			(api) => {
				api.registerMarkdownTransformer((text) => `${text} first`);
				api.registerMarkdownTransformer((text) => `${text} A`);
			},
			(api) => api.registerMarkdownTransformer((text, context) => `${text} B:${context.messageType}`),
		]);
		const transformers = registry.markdownTransformers();
		assert.equal(transformers.length, 2);
		const context = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };
		assert.equal(
			transformers.reduce((text, transform) => transform(text, context), "x"),
			"x A B:assistant",
		);
	});
});

describe("P40d: overflow recovery (pi)", () => {
	const settings = { compaction: { keepRecentTokens: 1 } };

	it("compacts with reason overflow and runs the turn again", async () => {
		const compactions: Array<{ reason: string; willRetry: boolean }> = [];
		const requests: unknown[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform: routed(
				[makeSseResponse(textTurn("first answer")), overflowResponse(), makeSseResponse(textTurn("second answer"))],
				requests,
			),
			...settings,
			extensions: await ExtensionRegistry.load([
				(api) => {
					api.on("session_before_compact", (event) => {
						compactions.push({ reason: event.reason, willRetry: event.willRetry });
					});
					api.on("session_compact", (event) => {
						compactions.push({ reason: `done:${event.reason}`, willRetry: event.willRetry });
					});
				},
			]),
		});
		await drain(agent, "first question");
		const events = await drain(agent, "second question");
		assert.deepEqual(compactions, [
			{ reason: "overflow", willRetry: true },
			{ reason: "done:overflow", willRetry: true },
		]);
		assert.ok(events.some((event) => event.type === "compaction"));
		const last = agent.messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.match(JSON.stringify(last), /second answer/);
		// The failed attempt left the context: the retried request carries no error message.
		assert.doesNotMatch(JSON.stringify(requests.at(-1)), /prompt is too long/);
		assert.ok(
			requests.some((request) => (request as Record<string, unknown>).max_tokens !== undefined),
			"a summary request",
		);
	});

	it("a second overflow in a row ends with pi's message instead of trying again", async () => {
		const failures: Array<{ reason: string; errorMessage?: string; willRetry: boolean }> = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform: routed([makeSseResponse(textTurn("first answer")), overflowResponse(), overflowResponse()]),
			...settings,
			extensions: await ExtensionRegistry.load([
				(api) => {
					api.on("session_compact_failed", (event) => {
						failures.push({
							reason: event.reason,
							willRetry: event.willRetry,
							...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
						});
					});
				},
			]),
		});
		await drain(agent, "first question");
		const events = await drain(agent, "second question");
		assert.deepEqual(failures, [
			{
				reason: "overflow",
				willRetry: false,
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
			},
		]);
		const failed = events.find((event) => event.type === "compaction_failed");
		assert.ok(failed?.type === "compaction_failed" && failed.reason === "overflow");
		assert.equal(agent.messages.at(-1)?.role, "assistant");
		assert.match(JSON.stringify(agent.messages.at(-1)), /prompt is too long/);
	});
});

describe("P40d: session_before_tree's summary choice and label (pi)", () => {
	async function branched(responses: PlatformResponse[], extensions: Extension[] = []) {
		const { NodeFileSystem } = await import("../../host-node/src/index.ts");
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { defaultPlatform } = await import("../src/platform.ts");
		const dir = mkdtempSync(join(tmpdir(), "tau-p40-tree-"));
		const repo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), dir, dir);
		const store = await repo.create();
		const requests: unknown[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform: fakePlatform(responses, requests),
			session: await SessionRecorder.open(store),
			extensions: await ExtensionRegistry.load(extensions),
		});
		await drain(agent, "first question");
		await drain(agent, "second question");
		const entries = await store.getEntries();
		const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(firstUser);
		return { agent, store, requests, target: firstUser.id };
	}

	it("the label goes on the summary entry; handlers see userWantsSummary and may change the label and prompt", async () => {
		const prepared: TreePreparation[] = [];
		const { agent, store, requests, target } = await branched(
			[makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two")), makeSseResponse(textTurn("THE SUMMARY"))],
			[
				(api) => {
					api.on("session_before_tree", (event) => {
						prepared.push(event.preparation);
						return { label: "from hook", replaceInstructions: true };
					});
				},
			],
		);
		await agent.navigateTo(target, { summarize: true, customInstructions: "ONLY THIS PROMPT", label: "mine" });
		assert.equal(prepared[0]?.userWantsSummary, true);
		assert.equal(prepared[0]?.label, "mine");
		const entries = await store.getEntries();
		const summary = entries.find((entry) => entry.type === "branch_summary");
		assert.ok(summary);
		const label = entries.find((entry) => entry.type === "label");
		assert.ok(label?.type === "label");
		assert.equal(label.targetId, summary.id);
		assert.equal(label.label, "from hook");
		// replaceInstructions: the custom text is the prompt.
		assert.match(JSON.stringify(requests[2]), /ONLY THIS PROMPT/);
	});

	it("without a summary the label goes on the target; userWantsSummary is false", async () => {
		const prepared: TreePreparation[] = [];
		const { agent, store, target } = await branched(
			[makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two"))],
			[
				(api) => {
					api.on("session_before_tree", (event) => void prepared.push(event.preparation));
				},
			],
		);
		await agent.navigateTo(target, { summarize: false, label: "here" });
		assert.equal(prepared[0]?.userWantsSummary, false);
		const label = (await store.getEntries()).find((entry) => entry.type === "label");
		assert.ok(label?.type === "label");
		assert.equal(label.targetId, target);
	});
});
