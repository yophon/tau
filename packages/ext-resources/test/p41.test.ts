// P41a: skills and prompt templates as pi 1.2 loads them, the host's directories and flags,
// hidden skill commands, and one copy per registry.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeFileSystem } from "@yophon/tau-host-node";
import { Agent, ExtensionRegistry } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { createResourcesExtension, loadPromptTemplates, loadSkills } from "../src/index.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tau-p41-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function skill(dir: string, name: string, description = `About ${name}`): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nDo ${name}\n`);
}

describe("P41a: skills load as pi 1.2 loads them", () => {
	it("a SKILL.md directory ends the search; dot directories and node_modules are skipped; standalone .md only at the top", async () => {
		await withTempDir(async (dir) => {
			const root = join(dir, "skills");
			await skill(join(root, "outer"), "outer");
			await skill(join(root, "outer", "inner"), "inner");
			await skill(join(root, "group", "nested"), "nested");
			await skill(join(root, ".hidden", "secret"), "secret");
			await skill(join(root, "node_modules", "dep"), "dep");
			await writeFile(join(root, "top.md"), "---\ndescription: A top-level skill\n---\nTop\n");
			await writeFile(join(root, "group", "deep.md"), "---\ndescription: Not a skill here\n---\nDeep\n");
			const { skills } = await loadSkills(new NodeFileSystem(dir), [root]);
			assert.deepEqual(skills.map((entry) => entry.name).sort(), ["nested", "outer", "top"]);
		});
	});

	it("the first skill of a name wins and the later one is reported; the same file loads once; explicit .md files work", async () => {
		await withTempDir(async (dir) => {
			await skill(join(dir, "a", "same"), "same", "From a");
			await skill(join(dir, "b", "same"), "same", "From b");
			await writeFile(join(dir, "single.md"), "---\nname: single\ndescription: One file\n---\nSingle\n");
			const { skills, diagnostics } = await loadSkills(
				new NodeFileSystem(dir),
				[join(dir, "a"), join(dir, "b"), join(dir, "a")],
				[join(dir, "single.md"), join(dir, "missing")],
			);
			assert.deepEqual(
				skills.map((entry) => `${entry.name}: ${entry.description}`),
				["same: From a", "single: One file"],
			);
			assert.ok(diagnostics.some((entry) => entry.code === "collision" && entry.path.includes(join("b", "same"))));
			assert.ok(diagnostics.some((entry) => entry.code === "missing_path" && entry.path.endsWith("missing")));
			assert.equal(diagnostics.filter((entry) => entry.code === "collision").length, 1, "a/ twice is not a collision");
		});
	});

	it("prompt templates: direct .md files of a directory, explicit files, first one of a name wins", async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, "p1", "sub"), { recursive: true });
			await mkdir(join(dir, "p2"), { recursive: true });
			await writeFile(join(dir, "p1", "greet.md"), "---\ndescription: First greet\n---\nHi");
			await writeFile(join(dir, "p1", "sub", "nested.md"), "Nested");
			await writeFile(join(dir, "p2", "greet.md"), "---\ndescription: Second greet\n---\nHello");
			await writeFile(join(dir, "one.md"), "One file");
			const { promptTemplates } = await loadPromptTemplates(
				new NodeFileSystem(dir),
				[join(dir, "p1"), join(dir, "p2")],
				[join(dir, "one.md")],
			);
			assert.deepEqual(
				promptTemplates.map((entry) => `${entry.name}: ${entry.description}`),
				["greet: First greet", "one: One file"],
			);
		});
	});
});

describe("P41a: the host's directories, flags and command lists", () => {
	async function load(options: Parameters<typeof createResourcesExtension>[0], cwd: string, extra = false) {
		const registry = await ExtensionRegistry.load([
			createResourcesExtension(options),
			...(extra ? [createResourcesExtension()] : []),
		]);
		const requests: unknown[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
			extensions: registry,
			capabilities: { fs: new NodeFileSystem(cwd), paths: { cwd } },
		});
		await registry.notifySessionStart("startup", agent.extensionContext());
		for await (const _event of agent.prompt("hi")) {
			// drained
		}
		const system = JSON.stringify((requests[0] as { messages: unknown[] }).messages[0]);
		return { registry, system };
	}

	it("the host's directories come first, then configured paths, then explicit ones; -ns keeps only the explicit", async () => {
		await withTempDir(async (dir) => {
			await skill(join(dir, "user", "alpha"), "alpha");
			await skill(join(dir, "configured", "beta"), "beta");
			await skill(join(dir, "cli", "gamma"), "gamma");
			const base = {
				defaultSkillPaths: () => [join(dir, "user")],
				configuredSkillPaths: () => [join(dir, "configured")],
				skillPaths: () => [join(dir, "cli")],
			};
			const all = await load(base, dir);
			for (const name of ["alpha", "beta", "gamma"]) assert.match(all.system, new RegExp(`<name>${name}</name>`));
			const onlyCli = await load({ ...base, noSkills: () => true }, dir);
			assert.match(onlyCli.system, /<name>gamma<\/name>/);
			assert.doesNotMatch(onlyCli.system, /<name>alpha<\/name>|<name>beta<\/name>/);
		});
	});

	it("enableSkillCommands off keeps /skill:name out of lists but registered; a second copy in the registry does nothing", async () => {
		await withTempDir(async (dir) => {
			await skill(join(dir, "user", "alpha"), "alpha");
			const hidden = await load(
				{ defaultSkillPaths: () => [join(dir, "user")], skillCommands: () => false },
				dir,
				true,
			);
			const command = hidden.registry.commands.get("skill:alpha");
			assert.ok(command);
			assert.equal(command.hidden, true);
			// One skills block although two copies were loaded.
			assert.equal(hidden.system.split("<available_skills>").length - 1, 1);
			assert.equal(hidden.registry.warnings.length, 0, hidden.registry.warnings.join("\n"));
		});
	});
});
