/**
 * `tau gateway run` minus the agent (P30): config, lock, logs, plugins and
 * channels, the gateway, status.json. The host supplies built-in plugins and
 * how to open a conversation.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FileAccessStore } from "./access.ts";
import { type GatewayConfig, type GatewayPaths, gatewayPaths, loadGatewayConfig } from "./config.ts";
import { Gateway, type GatewayOptions } from "./gateway.ts";
import { loadChannelPlugin } from "./plugins.ts";
import { ScheduleStore } from "./schedule.ts";
import { acquireLock, DailyLog, writeStatus } from "./state.ts";
import type { Channel, ChannelContext, ChannelPlugin } from "./types.ts";

export interface BootOptions {
	home: string;
	cwd: string;
	env: Record<string, string | undefined>;
	/** --workspace; overrides config.json. */
	workspace?: string;
	builtinPlugins: ChannelPlugin[];
	openConversation: GatewayOptions["openConversation"];
	/** Console output (the log file gets everything). */
	print(line: string): void;
	pairingCode?: string;
	statusIntervalMs?: number;
	/** Resolves ${cred:<name>} in config.json channel sections (P32b). */
	credential?: (name: string) => string | undefined;
}

export interface BootedGateway {
	gateway: Gateway;
	config: GatewayConfig;
	paths: GatewayPaths;
	/** Resolves once stop() has finished (Ctrl+C, `tau gateway stop`, or a caller). */
	stopped: Promise<void>;
	stop(): Promise<void>;
}

export function channelContext(
	paths: GatewayPaths,
	name: string,
	config: GatewayConfig,
	log: (line: string) => void,
): ChannelContext {
	const dataDir = join(paths.dir, name);
	const mediaDir = join(paths.media, name);
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
	const section = config.channels[name];
	return {
		dataDir,
		mediaDir,
		settings: section === false ? undefined : section,
		log: (line) => log(`[${name}] ${line}`),
	};
}

/** Load the configured plugins: built-ins first, then config.json `plugins`; failures are reported, not fatal. */
export async function loadPlugins(
	builtins: readonly ChannelPlugin[],
	specs: readonly string[],
	gatewayDir: string,
): Promise<{ plugins: ChannelPlugin[]; failed: Array<{ channel: string; detail: string }> }> {
	const plugins = [...builtins];
	const failed: Array<{ channel: string; detail: string }> = [];
	for (const spec of specs) {
		try {
			const plugin = await loadChannelPlugin(spec, gatewayDir);
			if (plugins.some((existing) => existing.name === plugin.name)) {
				failed.push({ channel: plugin.name, detail: `${spec}: a channel named "${plugin.name}" is already loaded` });
				continue;
			}
			plugins.push(plugin);
		} catch (error) {
			failed.push({ channel: spec, detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return { plugins, failed };
}

export async function bootGateway(options: BootOptions): Promise<BootedGateway> {
	const paths = gatewayPaths(options.home);
	mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const { config, diagnostics } = loadGatewayConfig(paths.config, {
		cwd: options.cwd,
		env: options.env,
		...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
		...(options.credential ? { credential: options.credential } : {}),
	});
	const release = acquireLock(paths.lock);
	rmSync(paths.stopRequest, { force: true });
	const daily = new DailyLog(paths.logs);
	const log = (line: string) => {
		try {
			daily.write(line);
		} catch {
			// A full disk must not take the gateway down.
		}
	};
	const say = (line: string) => {
		log(line);
		options.print(line);
	};
	for (const diagnostic of diagnostics) say(`config: ${diagnostic}`);

	const { plugins, failed } = await loadPlugins(options.builtinPlugins, config.plugins, paths.dir);
	const channels: Channel[] = [];
	for (const plugin of plugins) {
		if (config.channels[plugin.name] === false) {
			say(`channel ${plugin.name}: off (config.json)`);
			continue;
		}
		try {
			channels.push(await plugin.create(channelContext(paths, plugin.name, config, log)));
		} catch (error) {
			failed.push({ channel: plugin.name, detail: error instanceof Error ? error.message : String(error) });
		}
	}
	for (const entry of failed) say(`channel ${entry.channel} unavailable: ${entry.detail}`);

	const gateway = new Gateway({
		channels,
		openConversation: options.openConversation,
		access: new FileAccessStore(paths.access),
		config,
		log: (line) => {
			log(line);
			if (!line.startsWith("out ") && !line.startsWith("in ")) options.print(line);
		},
		unavailable: failed,
		onChange: () => soon(),
		schedules: new ScheduleStore(paths.schedules, { timeZone: config.timeZone }),
		...(options.pairingCode !== undefined ? { pairingCode: options.pairingCode } : {}),
	});
	let stopping: Promise<void> | undefined;
	const snapshot = () => {
		if (stopping) return;
		try {
			writeStatus(paths.status, {
				...gateway.status(),
				pid: process.pid,
				updatedAt: Date.now(),
				workspace: config.workspace,
				timeZone: config.timeZone,
			});
		} catch (error) {
			// Status is advisory; say why once per distinct failure.
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastStatusError) log(`status.json not written: ${message}`);
			lastStatusError = message;
		}
	};
	let lastStatusError = "";
	// Changes (a conversation opens, a turn ends, a channel reconnects) refresh status.json soon after.
	let pending: ReturnType<typeof setTimeout> | undefined;
	const soon = () => {
		if (pending || stopping) return;
		pending = setTimeout(() => {
			pending = undefined;
			snapshot();
		}, 200);
	};
	say(`workspace: ${config.workspace}`);
	say(`time zone: ${config.timeZone}`);
	say(`channels: ${channels.map((channel) => channel.name).join(", ") || "(none)"}`);
	options.print(`pairing code: ${gateway.pairingCode}  (others send "配对 ${gateway.pairingCode}" to get access)`);
	options.print(
		`owner code:   ${gateway.ownerCode}  (on an account without an owner, send "认主 ${gateway.ownerCode}" to become its owner)`,
	);
	const done = gateway.start();
	snapshot();
	const timer = setInterval(snapshot, options.statusIntervalMs ?? 10_000);
	timer.unref?.();
	let markStopped = () => {};
	const stopped = new Promise<void>((resolve) => {
		markStopped = resolve;
	});
	const stop = () => {
		stopping ??= (async () => {
			clearInterval(timer);
			clearInterval(watcher);
			if (pending) clearTimeout(pending);
			await gateway.stop();
			await done;
			rmSync(paths.status, { force: true });
			rmSync(paths.stopRequest, { force: true });
			release();
			say("gateway stopped");
			markStopped();
		})();
		return stopping;
	};
	// Windows has no signal to send a background process: `tau gateway stop` leaves a file instead.
	const watcher = setInterval(() => {
		if (existsSync(paths.stopRequest)) {
			say("stop requested");
			void stop();
		}
	}, 1000);
	return { gateway, config, paths, stopped, stop };
}
