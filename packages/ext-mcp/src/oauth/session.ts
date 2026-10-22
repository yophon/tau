// OAuth sign-in and token use for MCP servers (P32b), adapted from pi 1.4.0 (unchanged since 1.2.0)
// packages/coding-agent/src/extensions/mcp/oauth.ts (MIT). Connections never
// start a browser flow: they send the stored access token and, after a 401 or
// near expiry, refresh it; when that is not possible they fail with
// McpOAuthAuthorizationRequiredError and the user runs `tau mcp login <server>`.
// P48 (pi 1.2 challenge handling): a 403 `insufficient_scope` is remembered in the
// store, and sign-in asks an unauthenticated request for the server's challenge (it
// runs in another process than the connection that saw the 401).
// Differences from pi: no Client ID Metadata Documents (dynamic registration or
// a configured client only) and no cross-process refresh lock (pi uses
// proper-lockfile): a refresh re-reads the store first, and the store is
// written whole by rename, so two processes refreshing at once keep the later grant.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpAuth } from "@yophon/tau-ext-mcp-http";
import type { OAuthCallback } from "./callback.ts";
import { OAuthCallbackServer } from "./callback.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import { McpOAuthAuthorizationRequiredError } from "./errors.ts";
import { authorizeMcp, stepUpScope } from "./flow.ts";
import { McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "./provider.ts";
import type { OAuthChallenge, OAuthClientInformationMixed } from "./types.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
/** Bounds each request to the authorization server. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved (${cred:…}). */
	clientSecret?: string;
	callbackPort?: number;
	/** Scopes to request, separated by spaces. */
	scope?: string;
	/** `client_name` for dynamic client registration. */
	clientName?: string;
}

type StoredStates = Record<string, McpOAuthState>;

/** Per-server OAuth state (client registration, tokens, PKCE verifier) in one 0600 JSON file, keyed by name and URL. */
export class McpOAuthFileStore {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private read(): StoredStates {
		if (!existsSync(this.file)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
		} catch {
			return {};
		}
	}

	private write(states: StoredStates): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(states, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(temp, 0o600);
		} catch {
			// Windows has no POSIX modes.
		}
		renameSync(temp, this.file);
	}

	static key(name: string, serverUrl: string): string {
		return `${name}|${String(new URL(serverUrl))}`;
	}

	forServer(name: string, serverUrl: string): McpOAuthStateStore {
		const key = McpOAuthFileStore.key(name, serverUrl);
		return {
			load: () => {
				const state = this.read()[key];
				return state === undefined ? undefined : structuredClone(state);
			},
			save: (state) => {
				const states = this.read();
				states[key] = structuredClone(state);
				this.write(states);
			},
		};
	}

	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		return this.read()[McpOAuthFileStore.key(name, serverUrl)]?.tokens;
	}

	/** Forget a server's sign-in; true when something was stored. */
	remove(name: string, serverUrl: string): boolean {
		const states = this.read();
		const key = McpOAuthFileStore.key(name, serverUrl);
		if (!(key in states)) return false;
		delete states[key];
		this.write(states);
		return true;
	}
}

function timedFetch(): typeof fetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

/** The scopes of all arguments, each once, in order (pi mergeScopes). */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

/**
 * The server's challenge to a request without a token (P48): what a connection's 401 would carry —
 * the resource metadata URL and scope. `tau mcp login` runs apart from the connection that saw it.
 * A JSON-RPC ping has no effect on any protocol version; anything but a 401/403 means no challenge.
 */
export async function probeOAuthChallenge(
	serverUrl: string,
	options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<OAuthChallenge | undefined> {
	try {
		const response = await (options.fetch ?? timedFetch())(serverUrl, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "tau-oauth-probe", method: "ping" }),
			...(options.signal ? { signal: options.signal } : {}),
		});
		await response.body?.cancel().catch(() => undefined);
		if (response.status !== 401 && response.status !== 403) return undefined;
		const header = response.headers.get("www-authenticate");
		return header ? parseWwwAuthenticate(header) : undefined;
	} catch {
		// Unreachable now: the flow's own discovery reports it.
		return undefined;
	}
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? "tau" },
		...(settings.clientId ? { clientId: settings.clientId } : {}),
		...(settings.clientSecret ? { clientSecret: settings.clientSecret } : {}),
		store,
		onRedirect,
	});
}

/**
 * Token provider for an MCP connection: the stored access token, refreshed when it is about to
 * expire or after a 401. Throws McpOAuthAuthorizationRequiredError when the user has to sign in,
 * including when the server asks for more scope.
 */
export function createMcpOAuth(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
}): McpAuth {
	const { serverUrl, store, settings } = options;
	let refreshing: Promise<void> | undefined;
	const refresh = (staleToken: string | undefined, challenge?: OAuthChallenge) => {
		refreshing ??= (async () => {
			const state = await store.load();
			// Another request (or process) already replaced the token.
			if (state?.tokens?.access_token !== staleToken) return;
			if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError(challenge);
			const redirectUrl = registeredRedirectUrls(state.clientInformation)[0] ?? FALLBACK_REDIRECT_URL;
			const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
			const result = await authorizeMcp(provider, {
				serverUrl,
				...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
				...(challenge?.scope ? { scope: challenge.scope } : {}),
				fetch: timedFetch(),
			});
			if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError(challenge);
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};
	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const token = state?.tokens?.access_token;
			if (!token) throw new McpOAuthAuthorizationRequiredError();
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// A failed refresh falls through: the request goes out with the old token and a 401 decides.
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers?.get("www-authenticate") ?? null);
			// A refresh keeps the granted scope, so more scope needs a new sign-in. The scope asked for is
			// remembered for it: `tau mcp login` runs in another process (P48).
			if (challenge.error === "insufficient_scope") {
				const state = await store.load();
				if (state && challenge.scope) {
					await store.save({ ...state, requiredScope: mergeScopes(state.requiredScope, challenge.scope) });
				}
				throw new McpOAuthAuthorizationRequiredError(challenge);
			}
			await refresh(context.token, challenge);
		},
	};
}

/** A sign-in got the scope a 403 asked for: forget it. */
async function clearRequiredScope(store: McpOAuthStateStore): Promise<void> {
	const state = await store.load();
	if (state?.requiredScope === undefined) return;
	const next = { ...state };
	delete next.requiredScope;
	await store.save(next);
}

export interface McpSignInPrompt {
	/** Show the authorization URL (and open a browser if possible). */
	showAuthorizationUrl(url: URL): void;
	/**
	 * Ask for the redirect URL from the browser address bar, for a browser that cannot reach the
	 * loopback callback (the gateway on a server). Aborted once the callback arrives.
	 */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return { code, ...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss") ?? undefined } : {}) };
}

async function waitForAuthorizationResponse(
	callback: OAuthCallbackServer,
	state: string,
	redirectUrl: URL,
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
	const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl);
	});
	try {
		return await Promise.race([fromBrowser, fromUser]);
	} finally {
		controller.abort();
		fromBrowser.catch(() => undefined);
		fromUser.catch(() => undefined);
	}
}

/**
 * Sign in to an MCP server: a stored refresh token when it still works, else the browser
 * authorization code flow (PKCE) against a loopback callback, or a pasted redirect URL.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	/** The server's challenge (resource metadata URL, scope) when the caller has it; probed when absent (P48). */
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
}): Promise<void> {
	const { serverUrl, store, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	const stored = await store.load();
	const challenge = options.challenge ?? (await probeOAuthChallenge(serverUrl, signal ? { signal } : {}));
	if (signal?.aborted) throw new McpSignInCancelledError();
	// A server that asked for more scope (now, or in a connection's 403) gets it on top of the scope
	// granted so far, since the challenge may list only the missing scopes (pi 1.2 step-up).
	const required = stored?.requiredScope;
	const stepUp = challenge?.error === "insufficient_scope" || required !== undefined;
	const scope = mergeScopes(
		settings.scope,
		stepUp ? stepUpScope(stored?.tokens?.scope, mergeScopes(challenge?.scope, required)) : challenge?.scope,
	);
	// Reuse the port of the registered redirect URI so the registered client stays valid.
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const port = settings.callbackPort ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	let callback: OAuthCallbackServer;
	try {
		callback = await OAuthCallbackServer.listen({ host: CALLBACK_HOST, path: CALLBACK_PATH, port: port ?? 0 });
	} catch (error) {
		if (settings.callbackPort !== undefined || port === undefined) throw error;
		callback = await OAuthCallbackServer.listen({ host: CALLBACK_HOST, path: CALLBACK_PATH });
	}
	const redirectUrl = callback.redirectUrl;
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			delete next.oauthState;
			// P47: a sign-in discovers again, as the server may name another authorization server now;
			// the flow then drops a client registered with the old one (SEP-2352).
			delete next.discovery;
			// A registered client cannot use another redirect URI, and its tokens belong to it.
			if (!settings.clientId && !registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			await store.save(next);
		}
		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
			serverUrl,
			fetch: timedFetch(),
			...(signal ? { signal } : {}),
			...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
			...(scope ? { scope } : {}),
		};
		// A refresh keeps the granted scope; a server asking for more needs the browser flow.
		if ((await authorizeMcp(provider, { ...flow, skipRefresh: stepUp })) === "AUTHORIZED") {
			await clearRequiredScope(store);
			return;
		}
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
		const state = await provider.state();
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		options.prompt.showAuthorizationUrl(authorizationUrl);
		const { code, iss } = await waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
			options.prompt,
			signal,
		);
		await authorizeMcp(provider, { ...flow, authorizationCode: code, ...(iss ? { iss } : {}) });
		await clearRequiredScope(store);
	} catch (error) {
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await callback.close();
	}
}
