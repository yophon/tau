/**
 * `tau gateway` (P30): the resident gateway on top of the CLI's workspaces.
 * Each chat conversation is a HeadlessSession in a workspace opened at the
 * configured directory, with its own session directory, permission mode and
 * the gateway's approval hook. The subcommands other than `run` need no model.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ALLOWED_MODES,
	bootGateway,
	type ChannelPlugin,
	type Conversation,
	type ConversationHooks,
	type ConversationInput,
	type ConversationKey,
	type ConversationPolicy,
	channelContext,
	describeGoal,
	describeSchedule,
	describeStatus,
	FileAccessStore,
	gatewayPaths,
	isPermissionMode,
	loadGatewayConfig,
	loadPlugins,
	OWNER_MODES,
	readStatus,
	ScheduleStore,
} from "@yophon/tau-gateway";
import type {
	ApprovalRequest,
	Extension,
	ExtensionRegistry,
	ImageContent,
	PermissionMode,
	TextContent,
	UiCapability,
	UserContent,
} from "@yophon/tau-kernel";
import { restoreSession, SessionRecorder } from "@yophon/tau-kernel";
import type { GatewayCommand } from "./main.ts";
import { HeadlessSession, type HeadlessWorkspace, type ModelSwitch } from "./modes/headless.ts";

/** What main.ts hands the gateway: its workspace factory and the model state. */
export interface GatewayHost {
	home: string;
	cwd: string;
	env: Record<string, string | undefined>;
	openWorkspace(spec: {
		cwd: string;
		ui: UiCapability | undefined;
		onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
		sessionDir?: string;
		permissionMode?: PermissionMode;
		promptNote?: string;
		extensions?: Extension[];
		memoryFile?: string;
	}): Promise<HeadlessWorkspace & { extensions: ExtensionRegistry; setPermissionMode(mode: PermissionMode): void }>;
	modelDisplay(): string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
	/** Whether the current model takes images (models.json `input`). */
	supportsImages(): boolean;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CHANNEL_NAMES: Record<string, string> = { weixin: "WeChat", feishu: "Feishu" };

async function builtinPlugins(): Promise<ChannelPlugin[]> {
	const { weixinPlugin } = await import("@yophon/tau-channel-weixin");
	return [weixinPlugin];
}

/** A path segment from an id the channel chose (no separators, no dot-dot). */
function segment(id: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
	const safe = id.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.\./g, "_");
	return safe === "" ? "_" : safe;
}

function promptNote(key: ConversationKey, policy: ConversationPolicy): string {
	const where = CHANNEL_NAMES[key.channel] ?? key.channel;
	return [
		`You are chatting through ${where} (a chat app), not a terminal.`,
		policy.role === "owner"
			? "The person writing is your owner."
			: "The person writing is not your owner: be helpful, but you can only read; changes need the owner.",
		"Replies are shown as plain chat messages: keep them short, avoid wide tables and long code blocks unless asked.",
	].join(" ");
}

/** The merged chat messages as the user turn: images inline when the model takes them, the rest as paths. */
export function conversationContent(input: ConversationInput, images: boolean): UserContent {
	const notes: string[] = [];
	const blocks: ImageContent[] = [];
	for (const attachment of input.attachments) {
		const label =
			attachment.kind === "image"
				? "图片"
				: attachment.kind === "video"
					? "视频"
					: attachment.kind === "audio"
						? "语音"
						: "文件";
		const name = attachment.name ? `「${attachment.name}」` : "";
		if (attachment.kind === "image" && images && attachment.mimeType?.startsWith("image/")) {
			try {
				if (statSync(attachment.path).size <= MAX_IMAGE_BYTES) {
					blocks.push({
						type: "image",
						data: readFileSync(attachment.path).toString("base64"),
						mimeType: attachment.mimeType,
					});
					notes.push(`[用户发来图片，已附上；文件在 ${attachment.path}]`);
					continue;
				}
			} catch {
				// Fall through to the path.
			}
		}
		notes.push(
			attachment.kind === "image"
				? `[用户发来图片，已保存到 ${attachment.path}。当前模型不能直接看图；如需内容请让用户描述]`
				: `[用户发来${label}${name}，已保存到 ${attachment.path}。文本类文件可用 read 工具读取]`,
		);
	}
	// P31: the time first, so the model can turn "at three" into a schedule days into a conversation.
	const text = [input.time ? `[${input.time}]` : "", input.text, ...notes]
		.filter((part) => part.trim() !== "")
		.join("\n");
	if (blocks.length === 0) return text;
	const textBlock: TextContent = { type: "text", text };
	return [textBlock, ...blocks];
}

/** A gateway guest's own memory: ~/.tau/gateway/people/<channel>/<account>/<peer>/USER.md. */
export function guestMemoryFile(home: string, key: ConversationKey): string {
	return join(
		home,
		".tau",
		"gateway",
		"people",
		segment(key.channel),
		segment(key.account),
		segment(key.peer),
		"USER.md",
	);
}

/** One chat conversation: a workspace and a HeadlessSession, sessions under the gateway's directory. */
export async function openConversation(
	host: GatewayHost,
	sessionsDir: string,
	key: ConversationKey,
	policy: ConversationPolicy,
	hooks: ConversationHooks,
): Promise<Conversation> {
	const ws = await host.openWorkspace({
		cwd: policy.workspace,
		ui: undefined,
		onApproval: hooks.onApproval,
		sessionDir: join(sessionsDir, segment(key.channel), segment(key.account), segment(key.peer)),
		permissionMode: policy.permissionMode,
		promptNote: promptNote(key, policy),
		...(hooks.extensions ? { extensions: hooks.extensions } : {}),
		// Someone other than the owner never sees the owner's memory, only their own (P32).
		...(policy.role === "owner" ? {} : { memoryFile: guestMemoryFile(host.home, key) }),
	});
	const existing = (await ws.sessionRepo.list())[0];
	const store = existing ? await ws.sessionRepo.open(existing) : await ws.sessionRepo.create();
	const restored = existing ? await restoreSession(store) : undefined;
	const recorder = await SessionRecorder.open(store);
	if (!existing) await recorder.appendCustom("tau.gateway.conversation", { ...key, role: policy.role });
	const agent = ws.buildAgent(restored?.messages, recorder, ws.extensions);
	const headless = new HeadlessSession(
		{
			workspace: ws,
			modelDisplay: host.modelDisplay(),
			modelChoices: host.modelChoices,
			...(host.resolveModelSwitch ? { resolveModelSwitch: host.resolveModelSwitch } : {}),
			onEvent: (event) => hooks.onEvent(event),
			onNotice: (level, text) => process.stderr.write(`[${key.channel}/${key.peer}] ${level}: ${text}\n`),
			setHostPermissionMode: (mode) => ws.setPermissionMode(mode),
		},
		agent,
		store,
		recorder,
	);
	await headless.start(existing ? "resume" : "startup");
	return {
		run: (input) => headless.run(conversationContent(input, host.supportsImages())),
		abort: () => headless.abort(),
		async command(name, args) {
			if (name === "mode" && args !== "") {
				const allowed = policy.role === "owner" ? OWNER_MODES : ALLOWED_MODES;
				if (!isPermissionMode(args) || !allowed.includes(args)) return `可选档位：${allowed.join("、")}`;
				const before = headless.agent.getPermissionMode();
				headless.setPermissionMode(args);
				// read-only builds no write/edit/bash: crossing that line rebuilds the agent on the same session.
				if ((before === "read-only") !== (args === "read-only") && headless.store) {
					await headless.switchTo(headless.store, "resume");
				}
				return `权限档位：${args}`;
			}
			const result = await headless.command(`/${name}${args ? ` ${args}` : ""}`);
			return result?.output ?? "";
		},
		describe: () =>
			`${headless.modelDisplay} · ${headless.agent.getPermissionMode()} · ${headless.agent.messages.length} 条消息`,
		close: () => headless.stop(),
	};
}

export async function runGateway(command: GatewayCommand, host: GatewayHost): Promise<void> {
	const paths = gatewayPaths(host.home);
	let booted: Awaited<ReturnType<typeof bootGateway>>;
	try {
		booted = await bootGateway({
			home: host.home,
			cwd: host.cwd,
			env: host.env,
			...(command.workspace ? { workspace: command.workspace } : {}),
			builtinPlugins: await builtinPlugins(),
			...(host.env.TAU_GATEWAY_PAIRING_CODE ? { pairingCode: host.env.TAU_GATEWAY_PAIRING_CODE } : {}),
			print: (line) => console.log(line),
			openConversation: (key, policy, hooks) => openConversation(host, paths.sessions, key, policy, hooks),
		});
	} catch (error) {
		console.error(`tau gateway: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return;
	}
	console.log(`model: ${host.modelDisplay()}`);
	console.log("Ctrl+C or `tau gateway stop` stops the gateway (running turns get 30 seconds to finish).");
	const onSignal = () => {
		console.log("stopping…");
		void booted.stop();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	await booted.stopped;
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
}

const GATEWAY_USAGE = `tau gateway - run tau as a resident agent in chat apps

Usage:
  tau gateway run [--workspace <dir>] [tau options]   Run the gateway (Ctrl+C stops it)
  tau gateway stop                                    Stop the running gateway
  tau gateway status                                  Show the running gateway and access list
  tau gateway login <channel>                         Log a channel in (weixin: scan a QR code)
  tau gateway channels                                List channel plugins and whether they load
  tau gateway allow <channel> <account> <user> [--owner | --mode <mode>]
                                                      Let someone in (or make them owner, or set their mode)
  tau gateway revoke <channel> <account> <user>       Remove someone
  tau gateway schedules [cancel <id>]                 List schedules in all chats, or cancel one
  tau gateway goals                                   List goals in all chats

Config: ~/.tau/gateway/config.json (workspace, ownerMode, allowedMode, approvalTimeoutSec,
idleMinutes, maxResident, progress, plugins, channels, timeZone). Channel plugins install with
  npm install --prefix ~/.tau/gateway <package>
and are listed in "plugins". See docs/gateway.md.`;

export async function runGatewayCommand(
	command: GatewayCommand,
	context: { home: string; cwd: string },
): Promise<number> {
	const paths = gatewayPaths(context.home);
	const access = () => new FileAccessStore(paths.access);
	switch (command.command) {
		case "help":
			console.log(GATEWAY_USAGE);
			return 0;
		case "stop": {
			const status = readStatus(paths.status);
			if (!status) {
				console.log("The gateway is not running.");
				return 0;
			}
			writeFileSync(paths.stopRequest, `${Date.now()}\n`);
			console.log(`Asked the gateway (pid ${status.pid}) to stop; waiting…`);
			for (let waited = 0; waited < 45_000; waited += 250) {
				if (!readStatus(paths.status)) {
					console.log("Stopped.");
					return 0;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			console.error("The gateway did not stop within 45 seconds.");
			return 1;
		}
		case "status": {
			console.log(describeStatus(readStatus(paths.status), Date.now()));
			const entries = access().list();
			console.log(`Access (${paths.access}):`);
			if (entries.length === 0)
				console.log("  (nobody yet: pair with the code the gateway prints, or tau gateway allow)");
			for (const entry of entries) {
				console.log(
					`  ${entry.channel}/${entry.account}/${entry.user}: ${entry.role}${entry.mode ? ` (${entry.mode})` : ""}`,
				);
			}
			return 0;
		}
		case "allow": {
			const [channel, account, user] = command.args;
			if (!channel || !account || !user) {
				console.error("Usage: tau gateway allow <channel> <account> <user> [--owner | --mode <mode>]");
				return 1;
			}
			const role = command.owner ? "owner" : "allowed";
			const allowed = role === "owner" ? OWNER_MODES : ALLOWED_MODES;
			if (command.mode !== undefined && (!isPermissionMode(command.mode) || !allowed.includes(command.mode))) {
				console.error(`--mode must be one of: ${allowed.join(", ")}`);
				return 1;
			}
			access().allow(channel, account, user, role, command.mode as PermissionMode | undefined);
			console.log(
				`${channel}/${account}/${user}: ${role}${command.mode ? ` (${command.mode})` : ""}. A running gateway applies it to new conversations.`,
			);
			return 0;
		}
		case "revoke": {
			const [channel, account, user] = command.args;
			if (!channel || !account || !user) {
				console.error("Usage: tau gateway revoke <channel> <account> <user>");
				return 1;
			}
			const removed = access().revoke(channel, account, user);
			console.log(
				removed ? `Removed ${channel}/${account}/${user}.` : `${channel}/${account}/${user} was not on the list.`,
			);
			return removed ? 0 : 1;
		}
		case "schedules":
		case "goals": {
			const { config } = loadGatewayConfig(paths.config, { cwd: context.cwd, env: process.env });
			const store = new ScheduleStore(paths.schedules, { timeZone: config.timeZone });
			const now = Date.now();
			const where = (key: { channel: string; account: string; peer: string }) =>
				`${key.channel}/${key.account}/${key.peer}`;
			if (command.command === "goals") {
				const goals = store.goals();
				if (goals.length === 0) console.log("No goals.");
				for (const goal of goals) console.log(`${where(goal.key)}  ${describeGoal(store, goal, now)}`);
				return 0;
			}
			if (command.args[0] === "cancel") {
				const id = (command.args[1] ?? "").replace(/^#/, "");
				const entry = id ? store.cancelSchedule(id) : undefined;
				if (!entry) {
					console.error(id ? `No active schedule #${id}.` : "Usage: tau gateway schedules cancel <id>");
					return 1;
				}
				console.log(
					`Cancelled #${entry.id} 「${entry.title}」 (${where(entry.key)}). A running gateway applies it at once.`,
				);
				return 0;
			}
			if (command.args.length > 0) {
				console.error("Usage: tau gateway schedules [cancel <id>]");
				return 1;
			}
			const entries = store.schedules().filter((entry) => entry.state === "active");
			console.log(`Schedules (${paths.schedules}, time zone ${config.timeZone}):`);
			if (entries.length === 0) console.log("  (none)");
			for (const entry of entries) console.log(`  ${where(entry.key)}  ${describeSchedule(store, entry, now)}`);
			const ended = store.schedules().length - entries.length;
			if (ended > 0) console.log(`  (${ended} ended in the last 30 days not shown)`);
			return 0;
		}
		case "channels":
		case "login": {
			const { config, diagnostics } = loadGatewayConfig(paths.config, { cwd: context.cwd, env: process.env });
			for (const diagnostic of diagnostics) console.error(`config: ${diagnostic}`);
			const { plugins, failed } = await loadPlugins(await builtinPlugins(), config.plugins, paths.dir);
			if (command.command === "channels") {
				for (const plugin of plugins) {
					const off = config.channels[plugin.name] === false;
					console.log(
						`${plugin.name}: ${off ? "off (config.json)" : "loaded"}${plugin.login ? ` · tau gateway login ${plugin.name}` : ""}`,
					);
				}
				for (const entry of failed) console.log(`${entry.channel}: failed — ${entry.detail}`);
				return failed.length > 0 ? 1 : 0;
			}
			const name = command.args[0];
			const plugin = plugins.find((candidate) => candidate.name === name);
			if (!name || !plugin) {
				console.error(
					`Usage: tau gateway login <channel>  (channels: ${plugins.map((entry) => entry.name).join(", ")})`,
				);
				return 1;
			}
			if (!plugin.login) {
				console.log(`${name} needs no login (its credentials come from the config).`);
				return 0;
			}
			const controller = new AbortController();
			const onSignal = () => controller.abort();
			process.once("SIGINT", onSignal);
			try {
				await plugin.login(
					channelContext(paths, name, config, () => {}),
					{
						print: (text) => console.log(text),
						signal: controller.signal,
					},
				);
				return 0;
			} catch (error) {
				console.error(`login failed: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			} finally {
				process.off("SIGINT", onSignal);
			}
		}
		default:
			console.error(`Unknown gateway command "${command.command}".\n\n${GATEWAY_USAGE}`);
			return 1;
	}
}
