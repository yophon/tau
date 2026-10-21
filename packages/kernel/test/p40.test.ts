// P40 in the kernel: the PowerShell tool and its permission rules (40b).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type BackgroundShell,
	createCodingTools,
	createDefaultPolicy,
	matchPermissionRules,
	type PermissionRule,
	type PermissionRules,
	parsePermissionRule,
	parsePowerShellCommand,
	type Shell,
} from "../src/index.ts";

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
