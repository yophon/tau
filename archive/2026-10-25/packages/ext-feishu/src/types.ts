/**
 * Types shared by the tau Feishu extension and its client.
 *
 * The SDK-facing types intentionally stay small.  The official Lark SDK has
 * a very large generated declaration file, while callers generally only need
 * the bridge contract below (and tests can provide a structural mock).
 */

/** Maximum characters accepted by a single Feishu message payload. */
export const FEISHU_MAX_MESSAGE_CHARS = 4000;

/** Conservative limit for one interactive-card markdown element. */
export const FEISHU_MAX_CARD_CONTENT_CHARS = 3500;

/** Feishu/Lark application credentials and event verification settings. */
export interface FeishuConfig {
	/** Feishu app id (usually starts with `cli_`). */
	appId: string;
	/** Feishu app secret. */
	appSecret: string;
	/** `feishu` for mainland China or `lark` for the international endpoint. */
	domain?: "feishu" | "lark";
	/** Optional event encryption key. */
	encryptKey?: string;
	/** Optional event verification token. */
	verificationToken?: string;
	/** Optional bot open id used when removing @bot placeholders. */
	botOpenId?: string;
}

/** Lifecycle state of the WebSocket bridge. */
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

/** Shape of the optional `feishu` section in a settings file. */
export interface FeishuSettingsSection {
	appId?: string;
	appSecret?: string;
	domain?: string;
	encryptKey?: string;
	verificationToken?: string;
	botOpenId?: string;
}

/** A mention entry included in an `im.message.receive_v1` payload. */
export interface FeishuMention {
	key: string;
	id: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
	tenant_key?: string;
}

/** A media item referenced by an inbound Feishu message. */
export interface InboundResource {
	type: "image" | "file" | "audio" | "video";
	fileKey: string;
	fileName?: string;
}

/** Callback invoked after an inbound message has been parsed and filtered. */
export type FeishuMessageCallback = (
	chatId: string,
	messageId: string,
	text: string,
	chatType: "p2p" | "group",
	resources: InboundResource[],
) => void | Promise<void>;

/** Callback invoked for WebSocket lifecycle changes. */
export type FeishuStatusCallback = (status: BridgeStatus) => void;

/**
 * Public bridge contract.  Keeping this separate from the concrete class
 * makes the extension straightforward to mock in tau host tests.
 */
export interface FeishuClientLike {
	connect(): Promise<void>;
	disconnect(): void;
	getStatus(): BridgeStatus;
	sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void>;
	sendCard(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string | null>;
	updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
	downloadResource(messageId: string, fileKey: string, resourceType: string, fileName?: string): Promise<string | null>;
	uploadImage(filePath: string): Promise<string | null>;
	uploadFile(filePath: string, fileName: string, fileType?: string): Promise<string | null>;
	sendImage(chatId: string, imageKey: string, replyToMsgId?: string): Promise<void>;
	sendFile(chatId: string, fileKey: string, replyToMsgId?: string): Promise<void>;
	startTyping(chatId: string, messageId: string): Promise<void>;
	stopTyping(chatId: string, success?: boolean): Promise<void>;
	setOnMessage(callback: FeishuMessageCallback): void;
	setOnStatusChange(callback: FeishuStatusCallback): void;
}

/**
 * A deliberately small structural description of the official SDK surface
 * used by FeishuClient.  Every member is optional so a test can inject only
 * the constructors it exercises; the client reports a useful error when a
 * required constructor is missing.
 */
export interface FeishuSdkLike {
	Client?: unknown;
	/** Optional pre-built REST client exposed by lightweight test SDKs. */
	client?: unknown;
	/** Optional pre-built event/WS instances exposed by test SDKs. */
	eventDispatcher?: unknown;
	wsClient?: unknown;
	WSClient?: unknown;
	EventDispatcher?: unknown;
	Domain?: { Feishu?: unknown; Lark?: unknown };
	AppType?: { SelfBuild?: unknown };
	LoggerLevel?: { info?: unknown; warn?: unknown };
}

/** Options for constructing a concrete FeishuClient. */
export interface FeishuClientOptions {
	/** Inject an already-created SDK REST client (normally used by tests). */
	client?: unknown;
	/** Explicit alias for client when both REST and WS seams are injected. */
	restClient?: unknown;
	/** Alias for client, useful when a test SDK is passed separately. */
	sdkClient?: unknown;
	/** Factory alternative to supplying an already-created REST client. */
	clientFactory?: (params: Record<string, unknown>) => unknown;
	/** Inject SDK constructors/constants (defaults to @larksuiteoapi/node-sdk). */
	sdk?: FeishuSdkLike;
	/** Directory used for downloaded inbound media. */
	mediaDir?: string;
	/** Alias for mediaDir accepted for readability at call sites. */
	mediaDirectory?: string;
	/** Clock injection for deterministic expiry/dedup/file-name tests. */
	now?: () => number;
	/** Override deduplication TTL (defaults to twelve hours). */
	dedupTtlMs?: number;
	/** Override the maximum number of remembered message ids. */
	dedupMaxEntries?: number;
	/** Override periodic dedup sweep interval. */
	dedupSweepIntervalMs?: number;
	/** Override inbound message expiry (defaults to thirty minutes). */
	messageExpiryMs?: number;
	/** Skip creating mediaDir during construction (useful for virtual mocks). */
	ensureMediaDir?: boolean;
	/** Optional pre-built dispatcher/WS factory hooks for deterministic tests. */
	eventDispatcherFactory?: (params: Record<string, unknown>) => unknown;
	wsClientFactory?: (params: Record<string, unknown>) => unknown;
	/** Pre-built instances, equivalent to the factory hooks. */
	eventDispatcher?: unknown;
	wsClient?: unknown;
}

/** Options commonly consumed by the extension factory. */
export interface FeishuExtensionOptions {
	config?: Partial<FeishuConfig>;
	client?: FeishuClientLike;
	clientFactory?: (config: FeishuConfig) => FeishuClientLike;
	clientOptions?: FeishuClientOptions;
	/** Start the bridge automatically on `session_start` (default true). */
	autoStart?: boolean;
	/** Convenience alias for `clientOptions.mediaDir`. */
	mediaDir?: string;
}
