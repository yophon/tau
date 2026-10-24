// `tau --mode rpc` on an in-process session hub (P57): the rpc loop (modes/rpc.ts) is a client of
// tau/1 — pi's commands become protocol requests, the session's JSON-mode records come as
// thread/sessionEvent. The first session is chosen as before (new, -c, --session); its project
// trust question and dialogs go to the rpc client as extension_ui_request records.
import { type LocalHubContext, openFirstSession, startLocalHub } from "./local-hub.ts";
import type { RecordWriter } from "./modes/jsonl.ts";
import { answerWithBridge, type RpcModelEntry, type RpcUiBridge, runRpcMode } from "./modes/rpc.ts";
import { conversationLength } from "./tui/format.ts";
import { dim } from "./util.ts";

export interface RpcHubContext extends LocalHubContext {
	bridge: RpcUiBridge;
	out: RecordWriter;
	models: readonly RpcModelEntry[];
	/** The session reached its first command: from here an exit keeps a --worktree (main.ts). */
	started(): void;
}

export async function runRpcOnHub(context: RpcHubContext): Promise<void> {
	const { options, bridge } = context;
	if (options.files.length > 0) {
		console.error("@file arguments are not supported in --mode rpc.");
		process.exit(1);
	}
	const local = await startLocalHub(context, {
		name: "tau-rpc",
		capabilities: { nativeEvents: true, sessionEvents: true },
		startupUi: (params) => answerWithBridge(bridge, params),
	});
	try {
		await openFirstSession(local.session, options);
		// Words on the command line that are not extension flags would be prompts: rpc takes them on stdin.
		const messages = local.messages(options.extras);
		if (messages.length > 0) {
			console.error(`Unexpected argument: ${messages[0]} (--mode rpc takes the prompt with -p or on stdin)`);
			process.exit(1);
		}
		if (local.session.state.lastSessionStart === "resume") {
			const name = local.session.state.name;
			console.log(
				dim(`Resumed session (${conversationLength(local.session.messages)} messages${name ? `, "${name}"` : ""}).`),
			);
		}
		context.started();
		await runRpcMode({
			session: local.session,
			bridge,
			out: context.out,
			cwd: context.cwd,
			models: context.models,
		});
	} finally {
		await local.hub.close();
	}
}
