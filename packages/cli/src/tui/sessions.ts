// Session switches in the TUI (P50: split out of controller.ts): moving to another session
// (/new, /resume, /fork, /clone, /tree's branches) and drawing it again, restoring its model
// (P28), reloading extensions (/reload, P46 moves), /model and /thinking.
import {
	restoreSession,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type ThinkingLevel,
} from "@yophon/tau-kernel";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { messagesToBlocks } from "./replay.ts";
import { conversationLength } from "./runs.ts";

export class TuiSessions {
	private readonly host: TuiController;

	constructor(host: TuiController) {
		this.host = host;
	}

	/** A fresh screen with the current conversation, then a note. */
	showSession(note: string): void {
		this.host.clearScreen();
		this.host.dispatch({ type: "reset" });
		this.host.dispatch({ type: "replay", blocks: messagesToBlocks(this.host.agent.messages) });
		this.host.runs.markCustomShown();
		this.host.notice("dim", note);
	}

	/** Switch to another session store; extensions may veto it (session_before_switch). */
	async switchSession(
		store: SessionStore,
		reason: "resume" | "fork" | "new",
	): Promise<{ cancelled: true } | { cancelled: false; metadata: SessionMetadata; messageCount: number }> {
		const target = await store.getMetadata();
		const decision = await this.host.extensions.runSessionBeforeSwitch(
			{
				reason: reason === "new" ? "new" : "resume",
				...(target.filePath !== undefined ? { targetSessionFile: target.filePath } : {}),
			},
			this.host.agent.extensionContext(),
		);
		if (decision.cancelled) return { cancelled: true };
		const restored = await restoreSession(store);
		this.host.sessionStore = store;
		this.host.recorder = await SessionRecorder.open(store);
		this.host.agent = this.host.options.buildAgent(restored.messages, this.host.recorder, this.host.extensions);
		this.host.agent.setUi(this.host.ui);
		await this.host.extensions.notifySessionStart(
			reason === "new" ? "startup" : "resume",
			this.host.agent.extensionContext(),
		);
		this.host.lastSessionStart = reason === "new" ? "startup" : "resume";
		const metadata = await store.getMetadata();
		const messageCount = conversationLength(restored.messages);
		this.showSession(
			reason === "new"
				? "New session."
				: `${reason === "fork" ? "Forked to" : "Resumed"} ${metadata.name ? `"${metadata.name}"` : `session ${metadata.id.slice(0, 8)}`} (${messageCount} messages).`,
		);
		await this.host.refreshSurfaces();
		if (reason === "resume") await this.restoreSessionModel(store);
		return { cancelled: false, metadata, messageCount };
	}

	/** A resumed session goes back to its last model when the model table has it (pi, P28). */
	private async restoreSessionModel(store: SessionStore): Promise<void> {
		if (!this.host.options.resolveModelSwitch) return;
		const path = await store.getPathToRoot(await store.getLeafId());
		const last = path.findLast((entry) => entry.type === "model_change");
		if (last?.type !== "model_change") return;
		const ref = `${last.provider}/${last.modelId}`;
		if (ref === this.host.model || !this.host.modelChoices.includes(ref)) return;
		await this.switchModel(ref);
	}

	async reloadExtensions(): Promise<void> {
		if (this.host.state.task !== undefined) {
			this.host.notice("dim", "Reload is unavailable while a task is running.");
			return;
		}
		const previousExtensions = this.host.extensions;
		const previousAgent = this.host.agent;
		let previousShutdown = false;
		// pi reads keybindings.json again on /reload too (P39e).
		this.host.loadKeybindings();
		await this.host.runs.runTask("reload", "Reloading extensions", async () => {
			try {
				await previousExtensions.notifySessionShutdown("quit", previousAgent.extensionContext());
				previousShutdown = true;
				const nextExtensions = await this.host.options.reloadExtensions(this.host.ui);
				const nextAgent = this.host.options.buildAgent([...previousAgent.messages], this.host.recorder, nextExtensions);
				nextAgent.setUi(this.host.ui);
				// Host actions first, then session_start: a handler that submits a prompt there must
				// find the new agent (P23e, pi bindExtensions order).
				this.host.extensions = nextExtensions;
				this.host.agent = nextAgent;
				this.host.attachHostActions(nextExtensions);
				await nextExtensions.notifySessionStart("reload", nextAgent.extensionContext());
				// Only now that the new registry took over: an api/ctx captured from the old one
				// throws instead of reaching the new agent (pi runtime invalidate).
				previousExtensions.invalidate();
				this.host.lastSessionStart = "reload";
				this.host.inputBox.menuCache = undefined;
				this.host.checkShortcuts();
				this.host.notice("info", "Extensions reloaded.");
			} catch (error) {
				this.host.extensions = previousExtensions;
				this.host.agent = previousAgent;
				this.host.agent.setUi(this.host.ui);
				this.host.attachHostActions(previousExtensions);
				if (previousShutdown) {
					await previousExtensions
						.notifySessionStart("resume", previousAgent.extensionContext())
						.catch(() => undefined);
				}
				this.host.notice("error", `Reload failed: ${errorText(error)}`);
			}
		});
	}

	async switchModel(requested: string): Promise<void> {
		// With a model table (P28) the choice may switch provider, endpoint and protocol too.
		const resolved = this.host.options.resolveModelSwitch?.(requested);
		if (resolved && "error" in resolved) {
			this.host.notice("error", resolved.error);
			return;
		}
		const previous = this.host.agent.model;
		const target = resolved ? resolved.model : requested;
		const decision = await this.host.extensions.runModelSelectBefore(
			{ currentModel: previous, requestedModel: target },
			this.host.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.host.notice("dim", `Model switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		// An extension that rewrote the choice gets exactly its id, on the current provider.
		const followsTable = resolved !== undefined && decision.model === target;
		if (followsTable) resolved.commit();
		else this.host.options.setModel(decision.model);
		this.host.model = followsTable ? resolved.display : decision.model;
		this.host.modelChoices = unique([this.host.model, ...this.host.modelChoices]);
		// The agent sends the model with each request and logs a model_change entry (P23d).
		this.host.agent.setModel(decision.model, followsTable ? resolved.options : {});
		await this.host.extensions.notifyModelSelected(
			{ previousModel: previous, requestedModel: target, selectedModel: decision.model },
			this.host.agent.extensionContext(),
		);
		await this.host.refreshStatus();
		this.host.notice("dim", `Model set to ${this.host.model}.`);
	}

	async switchThinking(requested: ThinkingLevel | undefined): Promise<void> {
		const previous = this.host.thinkingLevel;
		const decision = await this.host.extensions.runThinkingLevelSelectBefore(
			{ currentLevel: previous, requestedLevel: requested },
			this.host.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.host.notice("dim", `Thinking level switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		this.host.thinkingLevel = decision.level;
		this.host.options.setThinkingLevel(decision.level);
		this.host.agent.setThinkingLevel(decision.level);
		await this.host.extensions.notifyThinkingLevelSelected(
			{ previousLevel: previous, requestedLevel: requested, selectedLevel: decision.level },
			this.host.agent.extensionContext(),
		);
		await this.host.refreshStatus();
		this.host.notice("dim", `Thinking level set to ${decision.level ?? "default"}.`);
	}
}

export function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}
