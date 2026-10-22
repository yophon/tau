// Ported from pi 1.4.0 (unchanged since 1.2.0) packages/mcp/src/oauth/index.ts (MIT, earendil-works/pi) for P32b; changes are
// limited to imports. Keep in step with pi when the reference is re-pinned (D23).
export {
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthCallbackServerOptions,
} from "./callback.ts";
export {
	buildAuthorizationServerDiscoveryUrls,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	parseWwwAuthenticate,
	resourceUrlFromServerUrl,
	selectResource,
} from "./discovery.ts";
export {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
} from "./errors.ts";
export {
	type AddClientAuthentication,
	adaptOAuthProvider,
	authorizeMcp,
	exchangeAuthorizationCode,
	type OAuthClientMetadataDocument,
	type OAuthClientProvider,
	type OAuthFlowOptions,
	type OAuthFlowResult,
	refreshAuthorization,
	registerClient,
	startAuthorization,
	stepUpScope,
	type TokenRequestOptions,
} from "./flow.ts";
export {
	McpOAuthProvider,
	type McpOAuthProviderOptions,
	type McpOAuthState,
	type McpOAuthStateStore,
	MemoryOAuthStateStore,
} from "./provider.ts";
export type {
	AuthorizationServerMetadata,
	OAuthChallenge,
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthProtectedResourceMetadata,
	OAuthServerInfo,
	OAuthTokens,
} from "./types.ts";
