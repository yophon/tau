// Ported from pi 1.4.0 (unchanged since 1.2.0) packages/mcp/src/oauth/errors.ts (MIT, earendil-works/pi) for P32b; changes are
// limited to imports, except P48: McpOAuthAuthorizationRequiredError carries the server's challenge
// (pi hands it to the auth provider's onChallenge callback instead). Keep in step with pi when the
// reference is re-pinned (D23).
import type { OAuthChallenge } from "./types.ts";

export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;

	constructor(code: string, message: string, errorUri?: string) {
		super(message || code);
		this.name = "OAuthError";
		this.code = code;
		this.errorUri = errorUri;
	}
}

export class OAuthIssuerMismatchError extends Error {
	/** `undefined` when no authorization server metadata was discovered. */
	readonly expected: string | undefined;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	readonly received: string | undefined;

	constructor(expected: string | undefined, received: string | undefined) {
		const format = (issuer: string | undefined) => (issuer === undefined ? "none" : JSON.stringify(issuer));
		super(`OAuth issuer mismatch: expected ${format(expected)}, received ${format(received)}`);
		this.name = "OAuthIssuerMismatchError";
		this.expected = expected;
		this.received = received;
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${endpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = endpoint;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`OAuth dynamic client registration failed with status ${status}: ${body}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = body;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	/** What the server asked for, a 401 or a 403 `insufficient_scope` (P48); sign-in can pass it on. */
	readonly challenge?: OAuthChallenge;

	constructor(challenge?: OAuthChallenge) {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
		if (challenge) this.challenge = challenge;
	}
}
