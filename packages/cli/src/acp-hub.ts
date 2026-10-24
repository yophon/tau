// `tau --mode acp` on tau's session hub (P60): the resident server when it can be used — the TUI's
// policy (tui-link.ts): started first when settings daemon.autoStart allows; not with --no-daemon,
// options the server fixed when it started, or an administrator's terminal on Windows — else a hub
// in this process with the host `tau serve` builds. Either way the adapter (modes/acp.ts) is a
// client of tau/1, so the editor sees the same thing; the lines saying why go to stderr.
import type { CliOptions } from "./args.ts";
import { type InProcessHost, startHub } from "./local-hub.ts";
import { type AcpLink, runAcpMode } from "./modes/acp.ts";
import type { RecordWriter } from "./modes/jsonl.ts";
import { residentAllowed, residentClient } from "./tui-link.ts";
import { CLI_VERSION } from "./util.ts";

export interface AcpHubContext {
	options: CliOptions;
	cwd: string;
	home: string;
	/** settings daemon.autoStart (default true). */
	autoStart: boolean;
	/** The hub's host when it runs in this process (`tau serve`'s). */
	host: InProcessHost;
	out: RecordWriter;
	/** What a session the resident server opens takes from this run (-m, --permission-mode). */
	opening: { model?: string; permissionMode?: string };
}

const CLIENT = { name: "tau-acp", capabilities: { nativeEvents: true } };

export async function runAcpOnHub(context: AcpHubContext): Promise<void> {
	await runAcpMode({
		link: () => linkAcp(context),
		out: context.out,
		version: CLI_VERSION,
		cwd: context.cwd,
		opening: context.opening,
		...(context.options.noMcp ? { noMcp: true } : {}),
	});
}

async function linkAcp(context: AcpHubContext): Promise<AcpLink> {
	const notices: string[] = [];
	if (await residentAllowed(context, notices)) {
		const resident = await residentClient(context, CLIENT, notices);
		if (resident) {
			return {
				client: resident.client,
				resident: true,
				reconnect: resident.reconnect,
				notices,
				close: async () => resident.client.close(),
			};
		}
	}
	const { hub, client } = await startHub(context.host, CLIENT);
	return { client, resident: false, notices, close: () => hub.close() };
}
