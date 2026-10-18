// P28a: the model table (models.json), settings defaults, and the web search config.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveWebSearch } from "../src/builtins.ts";
import {
	availableModels,
	chooseStartupModel,
	clearConfigValueCache,
	describeModel,
	findModel,
	modelPricing,
	parseModelsConfig,
	resolveConfigValue,
} from "../src/models.ts";
import { readSettings, writeSettings } from "../src/settings.ts";

const TABLE = JSON.stringify({
	providers: {
		deepseek: {
			baseUrl: "https://api.deepseek.com/v1",
			api: "openai-completions",
			apiKey: "$DEEPSEEK_API_KEY",
			models: [
				{ id: "deepseek-chat", contextWindow: 128000, cost: { input: 0.27, output: 1.1, cacheRead: 0.07 } },
				{ id: "deepseek-reasoner", reasoning: true },
			],
		},
		anthropic: {
			api: "anthropic-messages",
			apiKey: `\${ANTHROPIC_API_KEY}`,
			headers: { "x-team": "$TEAM" },
			models: [{ id: "claude-sonnet-5-5", contextWindow: 200000, maxTokens: 32000 }],
		},
		local: {
			baseUrl: "http://localhost:11434/v1",
			models: [{ id: "qwen", name: "Qwen local" }, { id: "deepseek-chat" }],
		},
		google: { api: "google-generative-ai", apiKey: "$G", models: [{ id: "gemini" }] },
		broken: { models: [{ id: "x" }] },
	},
});

describe("models.json", () => {
	it("parses providers and models, with diagnostics for what it skips", () => {
		const config = parseModelsConfig(TABLE, "/home/u/.tau/models.json");
		assert.deepEqual(
			config.models.map((model) => `${model.provider}/${model.id}:${model.api}`),
			[
				"deepseek/deepseek-chat:openai-completions",
				"deepseek/deepseek-reasoner:openai-completions",
				"anthropic/claude-sonnet-5-5:anthropic-messages",
				"local/qwen:openai-completions",
				"local/deepseek-chat:openai-completions",
			],
		);
		assert.deepEqual(config.diagnostics, [
			'/home/u/.tau/models.json: providers.google.models[0]: api "google-generative-ai" is not supported (openai-completions, anthropic-messages); skipped',
			'/home/u/.tau/models.json: providers.broken.models[0]: "baseUrl" is required for openai-completions; skipped',
		]);
		const claude = config.models[2];
		assert.equal(claude?.maxTokens, 32000);
		assert.deepEqual(claude?.headers, { "x-team": "$TEAM" });
		assert.equal(describeModel(config.models[0] as never), "128k ctx · $0.27/$1.1 per M");
		assert.deepEqual(parseModelsConfig("{", "/m.json").diagnostics.length, 1);
		assert.match(parseModelsConfig("[]", "/m.json").diagnostics[0] ?? "", /expected \{ "providers"/);
	});

	it(`resolves $NAME, \${NAME}, !command (once per process) and literals`, () => {
		clearConfigValueCache();
		const env = { KEY: "from-env" };
		let runs = 0;
		const exec = (command: string): string => {
			runs++;
			return `${command}-output\n`;
		};
		assert.equal(resolveConfigValue("$KEY", { env }), "from-env");
		assert.equal(resolveConfigValue(`\${KEY}`, { env }), "from-env");
		assert.equal(resolveConfigValue("$MISSING", { env }), undefined);
		assert.equal(resolveConfigValue("!op read x", { env, exec }), "op read x-output");
		assert.equal(resolveConfigValue("!op read x", { env, exec }), "op read x-output");
		assert.equal(runs, 1);
		assert.equal(
			resolveConfigValue("!fails", {
				env,
				exec: () => {
					throw new Error("no");
				},
			}),
			undefined,
		);
		assert.equal(resolveConfigValue("sk-literal", { env }), "sk-literal");
	});

	it("lists only models whose key resolves; finds provider/id or an unambiguous id", () => {
		const config = parseModelsConfig(TABLE, "/m.json");
		const available = availableModels(config, { env: { DEEPSEEK_API_KEY: "d" } });
		assert.deepEqual(
			available.map((model) => `${model.provider}/${model.id}`),
			["deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "local/qwen", "local/deepseek-chat"],
		);
		assert.equal(findModel(available, "deepseek-chat"), "ambiguous");
		assert.equal((findModel(available, "local/deepseek-chat") as { provider: string }).provider, "local");
		assert.equal((findModel(available, "qwen") as { id: string }).id, "qwen");
		assert.equal(findModel(available, "nope"), undefined);
		assert.deepEqual(modelPricing(available[0] as never), {
			inputPerMTok: 0.27,
			outputPerMTok: 1.1,
			cacheReadPerMTok: 0.07,
		});
		assert.equal(modelPricing(available[1] as never), undefined);
	});

	it("chooses the startup model: -m, then the settings default, then the first usable model", () => {
		const available = availableModels(parseModelsConfig(TABLE, "/m.json"), {
			env: { DEEPSEEK_API_KEY: "d", ANTHROPIC_API_KEY: "a" },
		});
		const pick = (input: Parameters<typeof chooseStartupModel>[1]) => {
			const choice = chooseStartupModel(available, input);
			return choice.kind === "configured"
				? `${choice.model.provider}/${choice.requestedId ?? choice.model.id}`
				: choice.kind === "error"
					? `error: ${choice.message}`
					: "none";
		};
		assert.equal(pick({}), "deepseek/deepseek-chat");
		assert.equal(
			pick({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" }),
			"anthropic/claude-sonnet-5-5",
		);
		assert.equal(pick({ defaultModel: "local/qwen" }), "local/qwen");
		assert.equal(pick({ requested: "claude-sonnet-5-5", defaultModel: "local/qwen" }), "anthropic/claude-sonnet-5-5");
		assert.equal(
			pick({ requested: "deepseek-chat" }),
			'error: Model "deepseek-chat" exists on several providers; use provider/id.',
		);
		// An id the table lacks runs on the default model's provider (as -m on an endpoint always did).
		assert.equal(pick({ requested: "deepseek-v4", defaultModel: "deepseek/deepseek-chat" }), "deepseek/deepseek-v4");
		assert.equal(pick({ requested: "anthropic/claude-opus-5-5" }), "anthropic/claude-opus-5-5");
		assert.equal(chooseStartupModel([], {}).kind, "none");
	});
});

describe("settings.json", () => {
	it("reads the default model keys and webSearch, ignores bad values, merges writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-settings-"));
		const file = join(dir, "settings.json");
		writeFileSync(
			file,
			JSON.stringify({
				codemode: { mode: "on" },
				defaultProvider: "deepseek",
				defaultModel: "deepseek-chat",
				defaultThinkingLevel: "off",
				webSearch: { provider: "brave", apiKey: "$BRAVE" },
			}),
		);
		assert.deepEqual(readSettings(file), {
			defaultProvider: "deepseek",
			defaultModel: "deepseek-chat",
			defaultThinkingLevel: "none",
			webSearch: { provider: "brave", apiKey: "$BRAVE" },
		});
		writeSettings(file, { defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" });
		const written = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(written.codemode, { mode: "on" });
		assert.equal(written.defaultProvider, "anthropic");
		writeFileSync(file, JSON.stringify({ defaultThinkingLevel: "loud", webSearch: { provider: "bing" } }));
		assert.deepEqual(readSettings(file), {});
	});

	it("web search: settings first (key resolved), else the first search key in the environment", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-search-"));
		const file = join(dir, "settings.json");
		assert.equal(resolveWebSearch(file, {}), undefined);
		assert.deepEqual(resolveWebSearch(file, { TAVILY_API_KEY: "t", EXA_API_KEY: "e" }), {
			provider: "tavily",
			apiKey: "t",
		});
		writeFileSync(file, JSON.stringify({ webSearch: { provider: "exa", apiKey: "$MY_EXA" } }));
		assert.deepEqual(resolveWebSearch(file, { MY_EXA: "x", BRAVE_API_KEY: "b" }), { provider: "exa", apiKey: "x" });
		assert.equal(resolveWebSearch(file, { BRAVE_API_KEY: "b" }), undefined);
		writeFileSync(file, JSON.stringify({ webSearch: { provider: "searxng", baseUrl: "https://searx.example" } }));
		assert.deepEqual(resolveWebSearch(file, {}), { provider: "searxng", baseUrl: "https://searx.example" });
	});
});

describe("models.json input (P30)", () => {
	it("reads pi's input list and ignores unknown kinds", () => {
		const config = parseModelsConfig(
			JSON.stringify({
				providers: {
					p: {
						baseUrl: "https://x/v1",
						models: [{ id: "vision", input: ["text", "image", "audio"] }, { id: "plain" }],
					},
				},
			}),
			"/m.json",
		);
		assert.deepEqual(config.models[0]?.input, ["text", "image"]);
		assert.equal(config.models[1]?.input, undefined);
	});
});
