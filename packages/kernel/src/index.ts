export { Agent, type AgentEvent, type AgentOptions } from "./agent.ts";
export type { FileInfo, FileKind, FileSystem, Shell, ShellExecResult } from "./capabilities.ts";
export { createCodingTools } from "./coding-tools.ts";
export {
	FileError,
	type FileErrorCode,
	HttpError,
	ShellError,
	type ShellErrorCode,
	TauError,
	type TauErrorCode,
	toError,
} from "./errors.ts";
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type Extension,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	ExtensionRegistry,
	type InputEvent,
	type InputEventResult,
	type RegisteredCommand,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
	type ToolResultEventResult,
	type TurnEndEvent,
	type TurnStartEvent,
	type UiCapability,
} from "./extensions.ts";
export type {
	AgentMessage,
	AssistantMessage,
	SystemMessage,
	ToolCallRequest,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./messages.ts";
export {
	type ChatStreamEvent,
	type JsonSchema,
	type OpenAICompatConfig,
	streamChatCompletion,
	type ToolDefinition,
} from "./openai.ts";
export {
	defaultPlatform,
	type Platform,
	type PlatformBodyReader,
	type PlatformFetch,
	type PlatformRequestInit,
	type PlatformResponse,
	type TauAbortSignal,
	type Utf8Decoder,
} from "./platform.ts";
export { type SseEvent, SseParser } from "./sse.ts";
export { errorResult, optionalNumber, requireString, type Tool, type ToolResult } from "./tools.ts";
