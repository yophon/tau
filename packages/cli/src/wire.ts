// tau/1's native data and the kernel's types (P62: one place for the conversions the hub, the TUI and
// the json/rpc/acp adapters each wrote inline). The protocol carries the kernel's own values as plain
// JSON — messages, AgentEvents, session entries, usage, dialog forms (P57) — and types them loosely,
// since @yophon/tau-protocol has no dependencies. The shapes match by construction, so each
// conversion is a cast; this is the only place it is written.
import type {
	AgentEvent,
	AgentMessage,
	RegisteredToolRenderEvent,
	SessionEntry,
	UiForm,
	UiFormResult,
	Usage,
} from "@yophon/tau-kernel";
import type { NativeEntry, NativeEvent, NativeMessage } from "@yophon/tau-protocol";

/** What the protocol types as a loose JSON object (usage, forms and form results). */
type WireObject = Record<string, unknown>;

export const toWireMessages = (messages: readonly AgentMessage[]): NativeMessage[] =>
	messages as unknown as NativeMessage[];

export const fromWireMessages = (messages: readonly NativeMessage[]): AgentMessage[] =>
	messages as unknown as AgentMessage[];

export const toWireMessage = (message: AgentMessage): NativeMessage => message as unknown as NativeMessage;

export const fromWireMessage = (message: NativeMessage): AgentMessage => message as unknown as AgentMessage;

export const toWireEvent = (event: AgentEvent | { type: "agent_end" }): NativeEvent => event as unknown as NativeEvent;

export const fromWireEvent = (event: NativeEvent): AgentEvent => event as unknown as AgentEvent;

export const toWireEntry = (entry: SessionEntry): NativeEntry => entry as unknown as NativeEntry;

export const toWireEntries = (entries: readonly SessionEntry[]): NativeEntry[] => entries as unknown as NativeEntry[];

export const fromWireEntry = (entry: NativeEntry): SessionEntry => entry as unknown as SessionEntry;

export const fromWireEntries = (entries: readonly NativeEntry[]): SessionEntry[] =>
	entries as unknown as SessionEntry[];

export const toWireToolRender = (
	event: RegisteredToolRenderEvent,
): { phase: "start" | "update" | "result" } & WireObject =>
	event as unknown as { phase: "start" | "update" | "result" } & WireObject;

export const fromWireToolRender = (event: WireObject): RegisteredToolRenderEvent =>
	event as unknown as RegisteredToolRenderEvent;

export const toWireObject = (value: object): WireObject => value as unknown as WireObject;

export const fromWireUsage = (value: WireObject): Usage => value as unknown as Usage;

export const fromWireForm = (form: WireObject): UiForm => form as unknown as UiForm;

export const fromWireFormResult = (result: WireObject): UiFormResult => result as unknown as UiFormResult;
