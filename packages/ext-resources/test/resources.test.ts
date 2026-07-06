import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeFileSystem } from "@tau/host-node";
import { Agent, type Extension, ExtensionRegistry } from "@tau/kernel";
import { fakePlatform, makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import {
	createResourcesExtension,
	formatSkillsForSystemPrompt,
	loadPromptTemplates,
	loadSkills,
	parseCommandArgs,
	substituteArgs,
} from "../src/index.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tau-resources-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("prompt argument parsing and substitution follow pi syntax", () => {
	assert.deepEqual(parseCommandArgs("one \"two words\" 'three words'"), ["one", "two words", "three words"]);
	assert.equal(
		substituteArgs("$1 $" + "{@:2} $" + "{@:2:1} $ARGUMENTS $@", ["hello world", "two", "three"]),
		"hello world two three two hello world two three hello world two three",
	);
});

test("skills load from SKILL.md and format the pi system prompt block", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "demo"), { recursive: true });
		await writeFile(
			join(dir, "skills", "demo", "SKILL.md"),
			"---\ndescription: Use <demo> & examples\n---\nFull skill text\n",
		);
		await mkdir(join(dir, "skills", "hidden"), { recursive: true });
		await writeFile(
			join(dir, "skills", "hidden", "SKILL.md"),
			"---\ndescription: Hidden\ndisable-model-invocation: true\n---\nHidden text\n",
		);

		const { skills, diagnostics } = await loadSkills(new NodeFileSystem(dir), [join(dir, "skills")]);
		assert.equal(diagnostics.length, 0);
		assert.deepEqual(
			skills.map((skill) => skill.name),
			["demo", "hidden"],
		);
		const block = formatSkillsForSystemPrompt(skills);
		assert.match(block, /<available_skills>/);
		assert.match(block, /<name>demo<\/name>/);
		assert.match(block, /Use &lt;demo&gt; &amp; examples/);
		assert.doesNotMatch(block, /hidden/);
	});
});

test("prompt templates load direct md files only", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "prompts", "nested"), { recursive: true });
		await writeFile(join(dir, "prompts", "greet.md"), "---\ndescription: Greet\n---\nHello $1");
		await writeFile(join(dir, "prompts", "nested", "skip.md"), "Skip");

		const { promptTemplates, diagnostics } = await loadPromptTemplates(new NodeFileSystem(dir), [join(dir, "prompts")]);
		assert.equal(diagnostics.length, 0);
		assert.equal(promptTemplates.length, 1);
		assert.equal(promptTemplates[0]?.name, "greet");
		assert.equal(promptTemplates[0]?.description, "Greet");
	});
});

test("resources extension consumes resources_discover skill paths", async () => {
	await withTempDir(async (dir) => {
		const discoveredSkills = join(dir, "discovered-skills");
		await mkdir(join(discoveredSkills, "extra"), { recursive: true });
		await writeFile(join(discoveredSkills, "extra", "SKILL.md"), "---\ndescription: Extra skill\n---\nExtra");

		const provider: Extension = (api) => {
			api.on("resources_discover", () => ({ skillPaths: [discoveredSkills] }));
		};
		const requests: unknown[] = [];
		const registry = await ExtensionRegistry.load([provider, createResourcesExtension({ includeDefaults: false })]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
			extensions: registry,
			capabilities: { fs: new NodeFileSystem(dir), paths: { cwd: dir } },
		});
		await registry.notifySessionStart("startup", agent.extensionContext());
		for await (const _event of agent.prompt("use discovered")) {
			// drain
		}

		const firstRequest = requests[0] as { messages: { role: string; content: string | null }[] };
		const system = firstRequest.messages.find((message) => message.role === "system")?.content ?? "";
		assert.ok(system.includes("<name>extra</name>"), system);
	});
});

test("resources extension reloads prompt commands with resources_discover reload reason", async () => {
	await withTempDir(async (dir) => {
		const discoveredPrompts = join(dir, "discovered-prompts");
		await mkdir(discoveredPrompts, { recursive: true });
		await writeFile(join(discoveredPrompts, "hello.md"), "---\ndescription: Reload hello\n---\nReload hello $1");

		const reasons: string[] = [];
		const provider: Extension = (api) => {
			api.on("resources_discover", (event) => {
				reasons.push(event.reason);
				return event.reason === "reload" ? { promptPaths: [discoveredPrompts] } : {};
			});
		};
		const registry = await ExtensionRegistry.load([provider, createResourcesExtension({ includeDefaults: false })]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([]),
			extensions: registry,
			capabilities: { fs: new NodeFileSystem(dir), paths: { cwd: dir } },
		});

		await registry.notifySessionStart("reload", agent.extensionContext());
		const command = registry.commands.get("hello");
		assert.ok(command);
		assert.deepEqual(reasons, ["reload"]);
		assert.deepEqual(await command.handler("world", agent.extensionContext()), {
			action: "prompt",
			text: "Reload hello world",
		});
	});
});
