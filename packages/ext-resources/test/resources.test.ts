import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeFileSystem } from "@yophon/tau-host-node";
import { Agent, type Extension, ExtensionRegistry } from "@yophon/tau-kernel";
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

test("missing resource directories are skipped without a diagnostic", async () => {
	await withTempDir(async (dir) => {
		const fs = new NodeFileSystem(dir);
		const skills = await loadSkills(fs, [join(dir, "no-such-skills")]);
		const prompts = await loadPromptTemplates(fs, [join(dir, "no-such-prompts")]);
		assert.deepEqual(skills, { skills: [], diagnostics: [] });
		assert.deepEqual(prompts.diagnostics, []);
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

test("resources extension exposes loaded resource diagnostics", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "demo"), { recursive: true });
		await writeFile(join(dir, "skills", "demo", "SKILL.md"), "---\ndescription: Demo\n---\nDemo skill");
		await mkdir(join(dir, "prompts"), { recursive: true });
		await writeFile(join(dir, "prompts", "greet.md"), "---\ndescription: Greet\n---\nHello $1");

		const registry = await ExtensionRegistry.load([
			createResourcesExtension({
				includeDefaults: false,
				skillPaths: [join(dir, "skills")],
				promptPaths: [join(dir, "prompts")],
			}),
		]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([]),
			extensions: registry,
			capabilities: { fs: new NodeFileSystem(dir), paths: { cwd: dir } },
		});

		await registry.notifySessionStart("startup", agent.extensionContext());
		const diagnostic = await registry.diagnostics.get("resources")?.handler(agent.extensionContext());
		assert.deepEqual(diagnostic, {
			label: "resources",
			value: "1 skills, 1 prompts, 0 warnings",
			details: ["reason: startup", `skill paths: ${join(dir, "skills")}`, `prompt paths: ${join(dir, "prompts")}`],
		});
	});
});

test("project skills reach the prompt only from a trusted project (P23c)", async () => {
	await withTempDir(async (dir) => {
		const projectTauDir = join(dir, ".tau");
		await mkdir(join(projectTauDir, "skills", "local"), { recursive: true });
		await writeFile(join(projectTauDir, "skills", "local", "SKILL.md"), "---\ndescription: Project skill\n---\nLocal");
		const systemPromptFor = async (trusted: boolean): Promise<string> => {
			const requests: unknown[] = [];
			const registry = await ExtensionRegistry.load([createResourcesExtension()]);
			const agent = new Agent({
				config: { baseUrl: "https://fake.test/v1", model: "fake" },
				platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
				extensions: registry,
				capabilities: { fs: new NodeFileSystem(dir), paths: { cwd: dir, projectTauDir } },
				isProjectTrusted: () => trusted,
			});
			await registry.notifySessionStart("startup", agent.extensionContext());
			for await (const _event of agent.prompt("hi")) {
				// drain
			}
			const request = requests[0] as { messages: { role: string; content: string | null }[] };
			return request.messages.find((message) => message.role === "system")?.content ?? "";
		};
		assert.ok(!(await systemPromptFor(false)).includes("<name>local</name>"));
		assert.ok((await systemPromptFor(true)).includes("<name>local</name>"));
	});
});

test("template arguments follow pi 1.2.0: defaults, one pass, slices (P23e)", () => {
	// "$" + "{" keeps template placeholders out of the source (as the test above does).
	const d = "$" + "{";
	assert.equal(substituteArgs(`Hi ${d}1:-there}!`, []), "Hi there!");
	assert.equal(substituteArgs(`Hi ${d}1:-there}!`, ["you"]), "Hi you!");
	assert.equal(substituteArgs(`All: ${d}@:-nothing}`, []), "All: nothing");
	assert.equal(substituteArgs(`All: ${d}ARGUMENTS:-x}`, ["a", "b"]), "All: a b");
	// An argument containing "$@" is not expanded again.
	assert.equal(substituteArgs("$1 then $@", ["$@"]), "$@ then $@");
	assert.equal(substituteArgs(`${d}@:2:1}`, ["a", "b", "c"]), "b");
});

test("a SKILL.md with a BOM loads; a long first line becomes a 60-char description with ...; unclosed frontmatter warns (P23e)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "bom"), { recursive: true });
		await writeFile(join(dir, "skills", "bom", "SKILL.md"), "\uFEFF---\ndescription: With a BOM\n---\nBody");
		const skills = await loadSkills(new NodeFileSystem(dir), [join(dir, "skills")]);
		assert.deepEqual(
			skills.skills.map((skill) => skill.description),
			["With a BOM"],
		);
		await mkdir(join(dir, "prompts"), { recursive: true });
		await writeFile(join(dir, "prompts", "long.md"), `${"w".repeat(80)}\nrest`);
		await writeFile(join(dir, "prompts", "open.md"), "---\ndescription: never closed\nbody");
		const prompts = await loadPromptTemplates(new NodeFileSystem(dir), [join(dir, "prompts")]);
		const long = prompts.promptTemplates.find((template) => template.name === "long");
		assert.equal(long?.description, `${"w".repeat(60)}...`);
		assert.ok(prompts.diagnostics.some((diagnostic) => diagnostic.code === "invalid_frontmatter"));
	});
});
