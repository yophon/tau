/**
 * `tau --mode json` (P29, pi json.md): one invocation as a JSONL event stream
 * on stdout — the session header, then pi-shaped session events — and exit.
 * Nothing else is written to stdout; diagnostics go to stderr. There is no
 * one to ask, so calls that would need approval are denied (headless D20).
 */
import { randomUUID } from "node:crypto";
import type { Agent, ExtensionRegistry, SessionStore, UserContent } from "@yophon/tau-kernel";
import { agentEventRecord, sessionEventStream } from "./events.ts";
import type { RecordWriter } from "./jsonl.ts";

export interface JsonModeOptions {
	agent: Agent;
	extensions: ExtensionRegistry;
	store: SessionStore | undefined;
	cwd: string;
	prompt: UserContent;
	sessionReason: "startup" | "resume";
	out: RecordWriter;
}

/** Exit code: 0 done, 1 error (or a cut-off reply), 130 aborted. */
export async function runJsonMode(options: JsonModeOptions): Promise<number> {
	const { agent, extensions, out } = options;
	const metadata = options.store ? await options.store.getMetadata() : undefined;
	out.write({
		type: "session",
		version: 3,
		// An unsaved run (--no-session) has no session id before its first entry: the header gets a fresh one.
		id: metadata?.id ?? randomUUID(),
		timestamp: metadata?.timestamp ?? new Date().toISOString(),
		cwd: metadata?.cwd ?? options.cwd,
	});
	await extensions.add([sessionEventStream((record) => out.write(record))]);
	const controller = new AbortController();
	const onSignal = (): void => controller.abort();
	process.once("SIGINT", onSignal);
	let stopReason = "stop";
	let aborted = false;
	try {
		await extensions.notifySessionStart(options.sessionReason, agent.extensionContext());
		for await (const event of agent.prompt(options.prompt, controller.signal)) {
			const record = agentEventRecord(event);
			if (record) out.write(record);
			if (event.type === "assistant_message") stopReason = event.message.stopReason;
			if (event.type === "agent_settled") aborted = event.aborted;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		stopReason = "error";
	} finally {
		process.off("SIGINT", onSignal);
		await extensions.notifySessionShutdown("quit", agent.extensionContext());
	}
	if (aborted || stopReason === "aborted") return 130;
	return stopReason === "error" || stopReason === "length" ? 1 : 0;
}
