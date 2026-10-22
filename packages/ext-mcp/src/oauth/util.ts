// Ported from pi 1.4.0 (unchanged since 1.2.0) packages/mcp/src/protocol/types.ts and protocol/jsonrpc.ts (two helpers) (MIT, earendil-works/pi) for P32b; changes are
// limited to imports. Keep in step with pi when the reference is re-pinned (D23).

export const LATEST_PROTOCOL_VERSION = "2025-11-25";

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
