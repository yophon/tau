// Shared fakes for the gateway tests: a channel, a conversation, a gateway around them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AssistantMessage } from "@yophon/tau-kernel";
import {
	type Channel,
	type ChannelSink,
	type Conversation,
	type ConversationHooks,
	type ConversationInput,
	type ConversationKey,
	type ConversationPolicy,
	FileAccessStore,
	Gateway,
	type GatewayConfig,
	type GatewayOptions,
	type InboundMessage,
	type OutboundReply,
} from "../src/index.ts";

export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
export async function until(check: () => boolean, label = "condition"): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await tick();
	}
	throw new Error(`timed out waiting for ${label}`);
}

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "tau-gateway-"));
}

export class FakeChannel implements Channel {
	readonly name = "fake";
	textLimit = 2000;
	sink: ChannelSink | undefined;
	sent: Array<{ key: ConversationKey; reply: OutboundReply }> = [];
	typingCalls: boolean[] = [];
	ownerIds: string[];
	private seq = 0;

	constructor(owners: string[] = ["boss"]) {
		this.ownerIds = owners;
	}

	start(sink: ChannelSink, signal: AbortSignal): Promise<void> {
		this.sink = sink;
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	}

	async send(key: ConversationKey, reply: OutboundReply): Promise<void> {
		this.sent.push({ key, reply });
	}

	async typing(_key: ConversationKey, on: boolean): Promise<void> {
		this.typingCalls.push(on);
	}

	owners(): readonly string[] {
		return this.ownerIds;
	}

	message(peer: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
		return {
			key: { channel: "fake", account: "acc", peer },
			sender: peer,
			messageId: `m${++this.seq}`,
			text,
			receivedAt: Date.now(),
			...extra,
		};
	}

	texts(peer: string): string[] {
		return this.sent
			.filter((entry) => entry.key.peer === peer && entry.reply.kind === "text")
			.map((entry) => (entry.reply as { text: string }).text);
	}
}

export function assistant(text: string): AgentEvent {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake",
		provider: "fake",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
	return { type: "assistant_message", message };
}

export interface FakeRun {
	input: ConversationInput;
	finish(text?: string): void;
	abort(): void;
}

export class FakeConversation implements Conversation {
	readonly key: ConversationKey;
	readonly policy: ConversationPolicy;
	readonly hooks: ConversationHooks;
	runs: FakeRun[] = [];
	commands: string[] = [];
	closed = false;
	/** Called inside run() before it waits; tests use it to request approvals. */
	onRun?: (conversation: FakeConversation, input: ConversationInput) => Promise<void> | void;
	private current: { resolve(value: { stopReason: string; aborted: boolean }): void } | undefined;

	constructor(key: ConversationKey, policy: ConversationPolicy, hooks: ConversationHooks) {
		this.key = key;
		this.policy = policy;
		this.hooks = hooks;
	}

	async run(input: ConversationInput) {
		await this.onRun?.(this, input);
		return new Promise<{ stopReason: string; aborted: boolean }>((resolve) => {
			this.current = { resolve };
			this.runs.push({
				input,
				finish: (text = `echo: ${input.text}`) => {
					this.hooks.onEvent(assistant(text));
					resolve({ stopReason: "stop", aborted: false });
				},
				abort: () => resolve({ stopReason: "aborted", aborted: true }),
			});
		});
	}

	abort(): void {
		this.current?.resolve({ stopReason: "aborted", aborted: true });
	}

	async command(name: string, args: string): Promise<string> {
		this.commands.push(`${name} ${args}`.trim());
		return `did ${name}`;
	}

	describe(): string {
		return `fake ${this.key.peer}`;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

export function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
	return {
		workspace: "/work",
		ownerMode: "supervised",
		allowedMode: "read-only",
		approvalTimeoutSec: 300,
		idleMinutes: 30,
		maxResident: 16,
		progress: true,
		plugins: [],
		channels: {},
		timeZone: "Asia/Shanghai",
		...overrides,
	};
}

export function setup(
	options: {
		config?: Partial<GatewayConfig>;
		owners?: string[];
		allowed?: string[];
		gateway?: Partial<GatewayOptions>;
	} = {},
) {
	const dir = tempDir();
	const channel = new FakeChannel(options.owners);
	const access = new FileAccessStore(join(dir, "access.json"));
	for (const user of options.allowed ?? []) access.allow("fake", "acc", user, "allowed");
	const conversations: FakeConversation[] = [];
	const logs: string[] = [];
	const gateway = new Gateway({
		channels: [channel],
		access,
		config: config(options.config),
		log: (line) => logs.push(line),
		pairingCode: "111111",
		ownerCode: "222222",
		stopGraceMs: 200,
		...options.gateway,
		openConversation: async (key, policy, hooks) => {
			const conversation = new FakeConversation(key, policy, hooks);
			conversations.push(conversation);
			return conversation;
		},
	});
	const started = gateway.start();
	const conversationOf = (peer: string) => conversations.filter((entry) => entry.key.peer === peer).at(-1);
	return { dir, channel, access, conversations, conversationOf, gateway, started, logs };
}
