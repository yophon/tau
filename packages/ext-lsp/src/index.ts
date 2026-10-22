// @yophon/tau-ext-lsp — LSP code intelligence (P45, Claude Code): diagnostics after
// edits and the lsp navigation tool, over servers configured in Claude Code's
// .lsp.json shape. This entry is pure ES; @yophon/tau-ext-lsp/node starts servers.
export { catalogEntryFor, LSP_CATALOG, type LspCatalogEntry } from "./catalog.ts";
export {
	type LspClientOptions,
	type LspDiagnostic,
	type LspServerState,
	type LspSpawn,
	MAX_OPEN_DOCUMENTS,
} from "./client.ts";
export {
	DEFAULT_MAX_RESTARTS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	DEFAULT_SHUTDOWN_TIMEOUT_MS,
	DEFAULT_STARTUP_TIMEOUT_MS,
	fileExtension,
	type LspServerConfig,
	type ParsedLspConfig,
	parseLspConfig,
} from "./config.ts";
export { JsonRpcConnection, type LspProcess, LspResponseError, LspTimeoutError } from "./connection.ts";
export { DiagnosticRegistry, diagnosticsSummary, type FileDiagnostics, formatDiagnostics } from "./diagnostics.ts";
export {
	createLspExtension,
	LSP_DIAGNOSTICS_TYPE,
	type LspDiagnosticsDetails,
	type LspExtensionHandle,
	type LspExtensionOptions,
} from "./extension.ts";
export {
	encodeMessage,
	encodeUtf8,
	LspProtocolError,
	MAX_BODY_BYTES,
	MAX_HEADER_BYTES,
	MessageReader,
} from "./framing.ts";
export { LspManager, type LspServerStatus } from "./manager.ts";
export { displayPath, pathKey, pathToUri, resolvePath, uriToPath } from "./paths.ts";
export { createLspTool, LSP_OPERATIONS, LSP_TOOL_DESCRIPTION, LSP_TOOL_PARAMETERS, type LspOperation } from "./tool.ts";
