// The model table (P28, after pi's models.json): providers with their wire
// API, endpoint and key source, and per-model context window, output cap and
// prices. Only ~/.tau/models.json is read — a repository never picks the
// endpoint a key is sent to. tau ships no model data (D2/D3, D33): every entry
// is the user's.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ModelPricing } from "@yophon/tau-kernel";
import { defaultCredentialLookup } from "./credentials.ts";
import { registerSecret } from "./secrets.ts";

/** Wire APIs tau speaks (pi names): the kernel's Chat Completions and the ext-provider-* transports (P54: Responses, Gemini). */
export const MODEL_APIS = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"google-generative-ai",
] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

/** Prices in USD per million tokens (pi `cost`). */
export interface ModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ConfiguredModel {
	provider: string;
	id: string;
	name?: string;
	api: ModelApi;
	/** Required for openai-completions; the other protocols have their vendor's endpoint by default. */
	baseUrl?: string;
	/** The key as written: `$NAME`, `${NAME}`, `!command` or a literal; resolve with resolveConfigValue. */
	apiKey?: string;
	headers: Record<string, string>;
	reasoning: boolean;
	/** pi `input`: what the model accepts; omitted = text only (P30: images in gateway chats). */
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
	/** P54d (yo-agent's prompt shim): "prompt" for a model without native tool calling. */
	toolCalling?: "native" | "prompt";
}

export interface ModelsConfig {
	path: string;
	/** Whether the file exists (an empty or broken file still counts as configured). */
	present: boolean;
	models: ConfiguredModel[];
	/** Problems worth telling the user: unreadable file, bad fields, unsupported APIs. */
	diagnostics: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const nonNegative = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	return out;
}

function parseCost(value: unknown): ModelCost | undefined {
	if (!isRecord(value)) return undefined;
	const cost: ModelCost = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const n = nonNegative(value[key]);
		if (n !== undefined) cost[key] = n;
	}
	return Object.keys(cost).length > 0 ? cost : undefined;
}

/** Parse the text of a models.json; never throws (problems become diagnostics). */
export function parseModelsConfig(text: string, path: string): ModelsConfig {
	const config: ModelsConfig = { path, present: true, models: [], diagnostics: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		config.diagnostics.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		return config;
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		config.diagnostics.push(`${path}: expected { "providers": { ... } }`);
		return config;
	}
	for (const [provider, raw] of Object.entries(parsed.providers)) {
		const where = `${path}: providers.${provider}`;
		if (!isRecord(raw)) {
			config.diagnostics.push(`${where}: expected an object`);
			continue;
		}
		const providerApi = typeof raw.api === "string" ? raw.api : "openai-completions";
		const providerBaseUrl = typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl : undefined;
		const providerKey = typeof raw.apiKey === "string" && raw.apiKey !== "" ? raw.apiKey : undefined;
		const providerHeaders = stringRecord(raw.headers);
		if (!Array.isArray(raw.models) || raw.models.length === 0) {
			config.diagnostics.push(`${where}: no models listed`);
			continue;
		}
		raw.models.forEach((entry, index) => {
			const at = `${where}.models[${index}]`;
			if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
				config.diagnostics.push(`${at}: "id" is required`);
				return;
			}
			const api = typeof entry.api === "string" ? entry.api : providerApi;
			if (!(MODEL_APIS as readonly string[]).includes(api)) {
				config.diagnostics.push(`${at}: api "${api}" is not supported (${MODEL_APIS.join(", ")}); skipped`);
				return;
			}
			const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl !== "" ? entry.baseUrl : providerBaseUrl;
			if (api === "openai-completions" && baseUrl === undefined) {
				config.diagnostics.push(`${at}: "baseUrl" is required for openai-completions; skipped`);
				return;
			}
			if (config.models.some((model) => model.provider === provider && model.id === entry.id)) {
				config.diagnostics.push(`${at}: duplicate model "${entry.id}"; the first one wins`);
				return;
			}
			const model: ConfiguredModel = {
				provider,
				id: entry.id,
				api: api as ModelApi,
				headers: { ...providerHeaders, ...stringRecord(entry.headers) },
				reasoning: entry.reasoning === true,
			};
			if (typeof entry.name === "string" && entry.name !== "") model.name = entry.name;
			if (Array.isArray(entry.input)) {
				const input = entry.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
				if (input.length > 0) model.input = input;
			}
			if (baseUrl !== undefined) model.baseUrl = baseUrl;
			if (providerKey !== undefined) model.apiKey = providerKey;
			const contextWindow = positive(entry.contextWindow);
			if (contextWindow !== undefined) model.contextWindow = Math.floor(contextWindow);
			const maxTokens = positive(entry.maxTokens);
			if (maxTokens !== undefined) model.maxTokens = Math.floor(maxTokens);
			const cost = parseCost(entry.cost);
			if (cost) model.cost = cost;
			if (entry.toolCalling === "prompt" || entry.toolCalling === "native") model.toolCalling = entry.toolCalling;
			config.models.push(model);
		});
	}
	return config;
}

export function loadModelsConfig(path: string): ModelsConfig {
	if (!existsSync(path)) return { path, present: false, models: [], diagnostics: [] };
	try {
		return parseModelsConfig(readFileSync(path, "utf8"), path);
	} catch (error) {
		return {
			path,
			present: true,
			models: [],
			diagnostics: [`${path}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

export interface ValueResolver {
	env: Record<string, string | undefined>;
	/** Run a `!command`; returns its trimmed stdout. Throws on failure. */
	exec?: (command: string) => string;
	/** A `${cred:<name>}` value (P32b); default: ~/.tau/credentials.json under env HOME/USERPROFILE. */
	credential?: (name: string) => string | undefined;
}

const commandCache = new Map<string, string | undefined>();

/** Forget cached `!command` results (tests). */
export function clearConfigValueCache(): void {
	commandCache.clear();
}

/**
 * A config value as pi reads it: `$NAME` / `${NAME}` from the environment,
 * `!command` from a command's stdout (run once per process, P28 — pi runs it
 * per request), anything else literally. Undefined when it resolves to nothing.
 */
export function resolveConfigValue(spec: string | undefined, resolver: ValueResolver): string | undefined {
	if (spec === undefined || spec === "") return undefined;
	// Referenced values are secrets: registered so tool output masks them (P32b).
	const credential = /^\$\{cred:([a-z0-9_-]{1,64})\}$/.exec(spec);
	if (credential) {
		const name = credential[1] as string;
		const value = (resolver.credential ?? defaultCredentialLookup(resolver.env))(name);
		registerSecret(value, `cred:${name}`);
		return value === "" ? undefined : value;
	}
	const env = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(spec) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(spec);
	if (env) {
		const value = resolver.env[env[1] as string];
		registerSecret(value, env[1] as string);
		return value === undefined || value === "" ? undefined : value;
	}
	if (spec.startsWith("!")) {
		const command = spec.slice(1).trim();
		if (commandCache.has(command)) return commandCache.get(command);
		let value: string | undefined;
		try {
			value = (resolver.exec ?? defaultExec)(command).trim() || undefined;
		} catch {
			value = undefined;
		}
		commandCache.set(command, value);
		registerSecret(value, "!command");
		return value;
	}
	return spec;
}

function defaultExec(command: string): string {
	return execSync(command, {
		encoding: "utf8",
		timeout: 15_000,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}

/** Header values may use the same `$NAME` / `!command` forms (pi). */
export function resolveHeaders(model: ConfiguredModel, resolver: ValueResolver): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(model.headers)) {
		const resolved = resolveConfigValue(value, resolver);
		if (resolved !== undefined) out[key] = resolved;
	}
	return out;
}

/** `provider/id`, the name /model and -m use. */
export function modelRef(model: Pick<ConfiguredModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The models whose key resolves (pi lists only models with usable auth). A
 * model without an apiKey field counts as usable: local endpoints need none.
 */
export function availableModels(config: ModelsConfig, resolver: ValueResolver): ConfiguredModel[] {
	return config.models.filter((model) => model.apiKey === undefined || resolveConfigValue(model.apiKey, resolver));
}

/** Find `provider/id`, or a bare id when exactly one provider has it. */
export function findModel(models: readonly ConfiguredModel[], ref: string): ConfiguredModel | "ambiguous" | undefined {
	const exact = models.find((model) => modelRef(model) === ref);
	if (exact) return exact;
	const byId = models.filter((model) => model.id === ref);
	if (byId.length > 1) return "ambiguous";
	return byId[0];
}

/** The model's prices in the kernel's shape; undefined unless input and output are both known. */
export function modelPricing(model: ConfiguredModel): ModelPricing | undefined {
	const cost = model.cost;
	if (cost?.input === undefined || cost.output === undefined) return undefined;
	return {
		inputPerMTok: cost.input,
		outputPerMTok: cost.output,
		...(cost.cacheRead !== undefined ? { cacheReadPerMTok: cost.cacheRead } : {}),
		...(cost.cacheWrite !== undefined ? { cacheWritePerMTok: cost.cacheWrite } : {}),
	};
}

/** One line per model for `--list-models` and the /model picker hints. */
export function describeModel(model: ConfiguredModel): string {
	const parts: string[] = [];
	if (model.contextWindow) parts.push(`${formatTokens(model.contextWindow)} ctx`);
	if (model.cost?.input !== undefined && model.cost.output !== undefined) {
		parts.push(`$${model.cost.input}/$${model.cost.output} per M`);
	}
	if (model.reasoning) parts.push("reasoning");
	if (model.api === "anthropic-messages") parts.push("anthropic");
	if (model.api === "openai-responses") parts.push("responses");
	if (model.api === "google-generative-ai") parts.push("gemini");
	return parts.join(" · ");
}

function formatTokens(n: number): string {
	if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

export interface StartupModelInput {
	/** -m (a flag, not TAU_MODEL). */
	requested?: string;
	/** settings.json defaultProvider / defaultModel. */
	defaultProvider?: string;
	defaultModel?: string;
}

export type StartupModelChoice =
	| { kind: "configured"; model: ConfiguredModel; requestedId?: string }
	| { kind: "none" }
	| { kind: "error"; message: string };

/**
 * Pick the startup model from the table (spec order): -m, then the settings
 * default, then the first usable model. -m with an id the table lacks runs that
 * id on the default (or first) model's provider, as -m always did on the
 * configured endpoint. "none" = no usable model: the caller falls back to env.
 */
export function chooseStartupModel(
	available: readonly ConfiguredModel[],
	input: StartupModelInput,
): StartupModelChoice {
	if (available.length === 0) return { kind: "none" };
	const defaultRef =
		input.defaultModel === undefined
			? undefined
			: input.defaultProvider !== undefined && !input.defaultModel.includes("/")
				? `${input.defaultProvider}/${input.defaultModel}`
				: input.defaultModel;
	const fallback = (defaultRef ? findModel(available, defaultRef) : undefined) ?? available[0];
	const base = fallback === "ambiguous" ? available[0] : fallback;
	if (input.requested !== undefined) {
		const found = findModel(available, input.requested);
		if (found === "ambiguous") {
			return { kind: "error", message: `Model "${input.requested}" exists on several providers; use provider/id.` };
		}
		if (found) return { kind: "configured", model: found };
		const slash = input.requested.indexOf("/");
		if (slash > 0) {
			const provider = input.requested.slice(0, slash);
			const sameProvider = available.find((model) => model.provider === provider);
			if (sameProvider) {
				return { kind: "configured", model: sameProvider, requestedId: input.requested.slice(slash + 1) };
			}
		}
		return { kind: "configured", model: base as ConfiguredModel, requestedId: input.requested };
	}
	return { kind: "configured", model: base as ConfiguredModel };
}

export const MODELS_EXAMPLE = `{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-chat", "contextWindow": 128000 }]
    }
  }
}`;
