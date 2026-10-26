// The model and endpoint a session runs on (P50: split out of main.ts): the startup choice
// (models.json, then flags and environment variables scoped to one wire protocol), each
// endpoint's config and native transport config (Anthropic, OpenAI Responses, Gemini), /model's switch
// across providers (D21 addendum, D33), and the prices that apply.
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	ANTHROPIC_MESSAGES_API,
	type AnthropicTransportConfig,
	createAnthropicTransport,
	defaultMaxTokens,
} from "@yophon/tau-ext-provider-anthropic";
import {
	createGoogleTransport,
	GOOGLE_DEFAULT_BASE_URL,
	GOOGLE_GENERATIVE_AI_API,
	type GoogleTransportConfig,
} from "@yophon/tau-ext-provider-google";
import {
	createOpenAIResponsesTransport,
	OPENAI_DEFAULT_BASE_URL,
	OPENAI_RESPONSES_API,
	type OpenAIResponsesTransportConfig,
} from "@yophon/tau-ext-provider-openai-responses";
import {
	type ChatTransport,
	createOpenAICompatTransport,
	type ModelPricing,
	type OpenAICompatConfig,
	type Platform,
	type SetModelOptions,
	withPromptToolShim,
} from "@yophon/tau-kernel";
import {
	type CliOptions,
	envInt,
	isProvider,
	PROVIDERS,
	type ProviderKind,
	parsePricing,
	splitList,
	USAGE,
} from "./args.ts";
import {
	type ConfiguredModel,
	chooseStartupModel,
	findModel,
	type loadModelsConfig,
	MODELS_EXAMPLE,
	type ModelApi,
	modelPricing,
	modelRef,
	resolveConfigValue,
	resolveHeaders,
	type ValueResolver,
} from "./models.ts";
import type { TauSettings } from "./settings.ts";

/** A protocol the kernel does not speak itself, with its transport's config (read per request). */
export type NativeTransportConfig =
	| { kind: "anthropic"; config: AnthropicTransportConfig }
	| { kind: "openai-responses"; config: OpenAIResponsesTransportConfig }
	| { kind: "google"; config: GoogleTransportConfig };

/** The endpoint a session runs on (P50: one object, so /model's switch reaches every reader). */
export interface ActiveEndpoint {
	/** The table entry; undefined on the ad-hoc / env path. */
	activeModel: ConfiguredModel | undefined;
	config: OpenAICompatConfig;
	/** Undefined for Chat Completions, the kernel's own protocol. */
	native: NativeTransportConfig | undefined;
	transport: ChatTransport | undefined;
}

/** The --provider kind of a models.json api. */
function providerKindOf(api: ModelApi): ProviderKind {
	return api === "anthropic-messages"
		? "anthropic"
		: api === "openai-responses"
			? "openai-responses"
			: api === "google-generative-ai"
				? "google"
				: "openai";
}

/** The endpoint a protocol has when none is given; Chat Completions has none. */
function defaultBaseUrl(provider: ProviderKind): string | undefined {
	return provider === "anthropic"
		? ANTHROPIC_DEFAULT_BASE_URL
		: provider === "openai-responses"
			? OPENAI_DEFAULT_BASE_URL
			: provider === "google"
				? GOOGLE_DEFAULT_BASE_URL
				: undefined;
}

/** What every endpoint of the run shares: the stall timeout, TAU_MAX_TOKENS and the Chat Completions dialect knobs. */
export interface EndpointDefaults {
	stallTimeout: { stallTimeoutMs?: number };
	envMaxTokens: number | undefined;
	dialect: Pick<OpenAICompatConfig, "maxTokensField" | "supportsFinishReason" | "input">;
}

export interface StartupEndpoint {
	activeModel: ConfiguredModel | undefined;
	model: string;
	provider: ProviderKind;
	baseUrl: string | undefined;
	apiKey: string | undefined;
	/** The table entry when the model is one of its ids (its per-model values apply). */
	tableEntry: ConfiguredModel | undefined;
	contextWindow: number | undefined;
	/** What /model offers. */
	modelChoices: string[];
	effectiveBaseUrl: string;
	defaults: EndpointDefaults;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

/**
 * The model and endpoint at startup: a models.json entry (flags, settings' default), else the
 * ad-hoc endpoint from flags and environment variables. Exits with the usage text when there
 * is none.
 */
export function resolveStartupEndpoint(input: {
	options: CliOptions;
	userSettings: TauSettings;
	modelsConfig: ReturnType<typeof loadModelsConfig>;
	configuredModels: ConfiguredModel[];
	valueResolver: ValueResolver;
}): StartupEndpoint {
	const { options, userSettings, modelsConfig, configuredModels, valueResolver } = input;
	const adHocEndpoint = options.baseUrl !== undefined || options.apiKey !== undefined || options.provider !== undefined;
	const startup = adHocEndpoint
		? ({ kind: "none" } as const)
		: chooseStartupModel(configuredModels, {
				...(options.model !== undefined ? { requested: options.model } : {}),
				...(userSettings.defaultProvider !== undefined ? { defaultProvider: userSettings.defaultProvider } : {}),
				...(userSettings.defaultModel !== undefined ? { defaultModel: userSettings.defaultModel } : {}),
			});
	if (startup.kind === "error") {
		console.error(startup.message);
		process.exit(1);
	}
	/** The table entry the session runs on; undefined on the ad-hoc / env path. */
	const activeModel: ConfiguredModel | undefined = startup.kind === "configured" ? startup.model : undefined;
	const model =
		startup.kind === "configured"
			? (startup.requestedId ?? startup.model.id)
			: (options.model ?? process.env.TAU_MODEL);
	let envProvider: ProviderKind | undefined;
	if (process.env.TAU_PROVIDER) {
		const value = process.env.TAU_PROVIDER;
		if (isProvider(value)) envProvider = value;
		else console.error(`Ignoring TAU_PROVIDER="${value}" (expected one of: ${PROVIDERS.join(", ")})`);
	}
	const provider: ProviderKind = activeModel
		? providerKindOf(activeModel.api)
		: (options.provider ?? envProvider ?? "openai");
	// Endpoint and credential env vars are scoped to one wire protocol, so a key
	// configured for one vendor is never sent to another vendor's host: OPENAI_* only
	// feed openai and openai-responses, ANTHROPIC_* only feed anthropic, GEMINI_API_KEY only google, and TAU_BASE_URL/TAU_API_KEY only
	// the protocol TAU_PROVIDER names (openai when unset). Explicit flags always win.
	const tauEnvApplies = (envProvider ?? "openai") === provider;
	const vendorEnv =
		provider === "anthropic"
			? { baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY }
			: provider === "google"
				? { baseUrl: undefined, apiKey: process.env.GEMINI_API_KEY }
				: { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY };
	const baseUrl = activeModel
		? activeModel.baseUrl
		: (options.baseUrl ?? (tauEnvApplies ? process.env.TAU_BASE_URL : undefined) ?? (vendorEnv.baseUrl || undefined));
	const apiKey = activeModel
		? resolveConfigValue(activeModel.apiKey, valueResolver)
		: (options.apiKey ?? (tauEnvApplies ? process.env.TAU_API_KEY : undefined) ?? (vendorEnv.apiKey || undefined));
	// The vendor protocols have well-known default endpoints; the OpenAI-compatible world does not.
	if (!model || (provider === "openai" && !baseUrl)) {
		if (modelsConfig.present) {
			console.error(`No model in ${modelsConfig.path} has a usable API key, and no --base-url/--model was given.\n`);
		} else {
			console.error(
				`No model configured. Describe your models once in ${modelsConfig.path}, for example:\n\n${MODELS_EXAMPLE}\n\nor pass an endpoint: tau --base-url <url> --model <id> (env: TAU_BASE_URL, TAU_MODEL).\n`,
			);
		}
		console.error(USAGE);
		process.exit(1);
	}
	if (provider !== "openai" && !apiKey) {
		const vendorKey =
			provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
		console.error(
			`--provider ${provider} requires an API key (--api-key, ${vendorKey}, or TAU_API_KEY with TAU_PROVIDER=${provider}).`,
		);
		process.exit(1);
	}

	// -w beats the table, the table beats TAU_CONTEXT_WINDOW (P28). An id the table
	// lacks (-m on a configured provider) takes none of the entry's per-model values.
	const tableEntry = activeModel && activeModel.id === model ? activeModel : undefined;
	const contextWindow = options.contextWindow ?? tableEntry?.contextWindow ?? envInt("TAU_CONTEXT_WINDOW", 1);
	const modelChoices = activeModel
		? uniqueStrings([modelRef({ provider: activeModel.provider, id: model }), ...configuredModels.map(modelRef)])
		: uniqueStrings([model, ...(options.models ?? []), ...splitList(process.env.TAU_MODELS)]);
	// "120s" used to become a 120 ms watchdog; now it is rejected with a warning.
	const envStall = envInt("TAU_STALL_TIMEOUT_MS", 0);
	const stallTimeout = envStall !== undefined ? { stallTimeoutMs: envStall } : {};
	const effectiveBaseUrl = baseUrl ?? defaultBaseUrl(provider) ?? ANTHROPIC_DEFAULT_BASE_URL;
	// Output cap for the Anthropic transport (it must send max_tokens; default 8192 is
	// tight once adaptive thinking runs at high/xhigh effort).
	const envMaxTokens = envInt("TAU_MAX_TOKENS", 1);
	// With an injected transport the config's protocol fields are inert; it still
	// carries the message labels (provider/api/model) and contextWindow.
	// Chat Completions dialect knobs (P23d), env only: the output-cap field for summary
	// requests, endpoints that omit finish_reason, text-only models.
	const dialect: Pick<OpenAICompatConfig, "maxTokensField" | "supportsFinishReason" | "input"> = {};
	const envMaxTokensField = process.env.TAU_MAX_TOKENS_FIELD;
	if (envMaxTokensField === "max_tokens" || envMaxTokensField === "max_completion_tokens") {
		dialect.maxTokensField = envMaxTokensField;
	} else if (envMaxTokensField) {
		console.error(
			`Ignoring TAU_MAX_TOKENS_FIELD="${envMaxTokensField}" (expected max_tokens or max_completion_tokens)`,
		);
	}
	const envFinishReason = process.env.TAU_SUPPORTS_FINISH_REASON;
	if (envFinishReason === "0" || envFinishReason === "false") dialect.supportsFinishReason = false;
	else if (envFinishReason && envFinishReason !== "1" && envFinishReason !== "true") {
		console.error(`Ignoring TAU_SUPPORTS_FINISH_REASON="${envFinishReason}" (expected 0 or 1)`);
	}
	const envInput = process.env.TAU_INPUT;
	if (envInput === "text") dialect.input = ["text"];
	else if (envInput && envInput !== "text,image" && envInput !== "image") {
		console.error(`Ignoring TAU_INPUT="${envInput}" (expected text or text,image)`);
	}
	return {
		activeModel,
		model,
		provider,
		baseUrl,
		apiKey,
		tableEntry,
		contextWindow,
		modelChoices,
		effectiveBaseUrl,
		defaults: { stallTimeout, envMaxTokens, dialect },
	};
}

/**
 * The transport for a built endpoint: its native protocol's, else undefined (the agent's
 * OpenAI-compatible default). A model without native tool calling gets the prompt shim around it
 * (P54d): models.json `toolCalling: "prompt"`, or TAU_TOOL_SHIM=1 for an endpoint from flags or
 * the environment.
 */
export function endpointTransport(
	platform: Platform,
	built: { config: OpenAICompatConfig; native: NativeTransportConfig | undefined },
	model: ConfiguredModel | undefined,
): ChatTransport | undefined {
	const native = built.native;
	const base =
		native?.kind === "anthropic"
			? createAnthropicTransport(native.config, platform)
			: native?.kind === "openai-responses"
				? createOpenAIResponsesTransport(native.config, platform)
				: native?.kind === "google"
					? createGoogleTransport(native.config, platform)
					: undefined;
	const shim = model ? model.toolCalling === "prompt" : process.env.TAU_TOOL_SHIM === "1";
	return shim ? withPromptToolShim(base ?? createOpenAICompatTransport(platform, built.config)) : base;
}

export function buildEndpoint(
	defaults: EndpointDefaults,
	spec: {
		kind: ProviderKind;
		label: string | undefined;
		baseUrl: string | undefined;
		apiKey: string | undefined;
		model: string;
		contextWindow: number | undefined;
		maxTokens: number | undefined;
		headers: Record<string, string>;
		/** P36: a table model's `input` (pi: omitted = text only); undefined for an endpoint from env/flags. */
		input?: ("text" | "image")[];
		/** A table model's `reasoning` (pi: omitted = false); undefined for an endpoint from env/flags. */
		reasoning?: boolean;
	},
): { config: OpenAICompatConfig; native: NativeTransportConfig | undefined } {
	const { stallTimeout, envMaxTokens, dialect } = defaults;
	const headers = Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : {};
	const config: OpenAICompatConfig = {
		baseUrl: spec.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
		apiKey: spec.apiKey,
		model: spec.model,
		contextWindow: spec.contextWindow,
		// Summary requests use the model's output limit when it is known (P48): models.json
		// `maxTokens`, else on Anthropic the cap its turns use; unknown keeps reserveTokens shares.
		maxOutputTokens:
			spec.kind === "anthropic" ? (spec.maxTokens ?? envMaxTokens ?? defaultMaxTokens(spec.model)) : spec.maxTokens,
		...(spec.kind === "anthropic"
			? { provider: spec.label ?? "anthropic", api: ANTHROPIC_MESSAGES_API }
			: spec.kind === "openai-responses"
				? { provider: spec.label ?? "openai", api: OPENAI_RESPONSES_API }
				: spec.kind === "google"
					? { provider: spec.label ?? "google", api: GOOGLE_GENERATIVE_AI_API }
					: spec.label !== undefined
						? { provider: spec.label }
						: {}),
		...headers,
		...stallTimeout,
		// TAU_INPUT (in dialect) still wins over the table.
		...(spec.input ? { input: spec.input } : {}),
		...dialect,
	};
	const maxTokens = spec.maxTokens ?? envMaxTokens;
	if (spec.kind === "google") {
		const google: GoogleTransportConfig = {
			// The required-key gate ran already; assert for the type system.
			apiKey: spec.apiKey as string,
			model: spec.model,
			...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(spec.label !== undefined ? { provider: spec.label } : {}),
			// An endpoint from flags or the environment is taken for a thinking model (current Gemini models are).
			reasoning: spec.reasoning ?? true,
			...(config.input ? { input: config.input } : {}),
			...headers,
			...stallTimeout,
		};
		return { config, native: { kind: "google", config: google } };
	}
	if (spec.kind === "openai-responses") {
		const responses: OpenAIResponsesTransportConfig = {
			// The required-key gate ran already; assert for the type system.
			apiKey: spec.apiKey as string,
			model: spec.model,
			...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(spec.label !== undefined ? { provider: spec.label } : {}),
			// An endpoint from flags or the environment is taken for a reasoning model (current OpenAI models are).
			reasoning: spec.reasoning ?? true,
			...(config.input ? { input: config.input } : {}),
			...headers,
			...stallTimeout,
		};
		return { config, native: { kind: "openai-responses", config: responses } };
	}
	const anthropic: AnthropicTransportConfig | undefined =
		spec.kind === "anthropic"
			? {
					// The required-key gate ran already; assert for the type system.
					apiKey: spec.apiKey as string,
					model: spec.model,
					...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
					...(maxTokens !== undefined ? { maxTokens } : {}),
					...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
					...(spec.label !== undefined ? { provider: spec.label } : {}),
					...headers,
					thinkingMode: process.env.TAU_ANTHROPIC_THINKING === "budget" ? "budget" : "adaptive",
					...stallTimeout,
				}
			: undefined;
	return { config, native: anthropic ? { kind: "anthropic", config: anthropic } : undefined };
}

/**
 * The prices a model is billed at. --pricing / TAU_PRICING belong to the startup model.
 */
export function createPricing(input: {
	fixed: ModelPricing | undefined;
	pricedModel: string;
	configuredModels: ConfiguredModel[];
	endpoint: ActiveEndpoint;
}): (forModel: string) => ModelPricing | undefined {
	const { pricedModel, configuredModels, endpoint } = input;
	let fixedPricing = input.fixed;
	if (!fixedPricing && process.env.TAU_PRICING) {
		const parsed = parsePricing(process.env.TAU_PRICING);
		// Env is a convenience knob: a bad value degrades to "cost unknown" with a
		// warning instead of refusing to start (the explicit flag does exit).
		if (parsed instanceof Error) console.error(`Ignoring TAU_PRICING: ${parsed.message}`);
		else fixedPricing = parsed;
	}
	// The given prices belong to the startup model: after /model the cost is unknown
	// rather than priced at another model's rates (debt #12, D19-3). Table models
	// carry their own prices (P28): the active provider's entry first, then any.
	return (forModel: string): ModelPricing | undefined => {
		if (fixedPricing && forModel === pricedModel) return fixedPricing;
		const entry =
			configuredModels.find(
				(candidate) => candidate.provider === endpoint.activeModel?.provider && candidate.id === forModel,
			) ?? configuredModels.find((candidate) => candidate.id === forModel);
		return entry ? modelPricing(entry) : undefined;
	};
}

/**
 * Resolve a /model choice (P28): a table model switches endpoint and protocol
 * along with the id (D21 addendum); without a table, or for an id the table
 * lacks, only the id changes, as before.
 */
export function createModelSwitch(input: {
	endpoint: ActiveEndpoint;
	configuredModels: ConfiguredModel[];
	valueResolver: ValueResolver;
	/** -w: wins over a table model's window. */
	contextWindowFlag: number | undefined;
	platform: Platform;
	defaults: EndpointDefaults;
}): (
	requested: string,
) => { model: string; display: string; options: SetModelOptions; commit(): void } | { error: string } {
	const { endpoint, configuredModels, valueResolver, platform } = input;
	return (requested) => {
		const found = findModel(configuredModels, requested);
		if (found === "ambiguous") return { error: `"${requested}" exists on several providers; use provider/id.` };
		if (!found) {
			const prefix = endpoint.activeModel ? `${endpoint.activeModel.provider}/` : undefined;
			const id = prefix && requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
			return {
				model: id,
				display: endpoint.activeModel ? modelRef({ provider: endpoint.activeModel.provider, id }) : id,
				options: {},
				commit: () => {
					endpoint.config.model = id;
					if (endpoint.native) endpoint.native.config.model = id;
				},
			};
		}
		const key = resolveConfigValue(found.apiKey, valueResolver);
		const kind = providerKindOf(found.api);
		const window = input.contextWindowFlag ?? found.contextWindow;
		const next = buildEndpoint(input.defaults, {
			kind,
			label: found.provider,
			baseUrl: found.baseUrl,
			apiKey: key,
			model: found.id,
			contextWindow: window,
			maxTokens: found.maxTokens,
			headers: resolveHeaders(found, valueResolver),
			input: found.input ?? ["text"],
			reasoning: found.reasoning,
		});
		const nextTransport = endpointTransport(platform, next, found);
		return {
			model: found.id,
			display: modelRef(found),
			options: {
				transport: nextTransport ?? createOpenAICompatTransport(platform, next.config),
				provider: next.config.provider ?? "openai-compat",
				api: next.config.api ?? "openai-completions",
				contextWindow: window,
				maxOutputTokens: next.config.maxOutputTokens,
			},
			// Agents built later (/reload, /resume) start from the switched endpoint.
			commit: () => {
				endpoint.activeModel = found;
				endpoint.config = next.config;
				endpoint.native = next.native;
				endpoint.transport = nextTransport;
			},
		};
	};
}
