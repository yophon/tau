// MCP resources (P43, pi extensions/mcp/resources.ts), through the tools Codex and
// opencode use: `list_mcp_resources`, `list_mcp_resource_templates` and
// `read_mcp_resource`. They take a `server` argument and cover every connected
// server with resources, so models trained on those tools use them unchanged.
//
// Listings are JSON, as in Codex: `{ server?, resources: [{ server, ...resource }], nextCursor? }`.
// With a `server`, one page is listed and `cursor` continues it; without, every page
// of every server. MCP App resources (`ui://` URIs and `profile=mcp-app` HTML) are
// left out, since they are user interfaces for hosts that render them, and so are
// icons. Read resources become text and images for the model; binary resources are
// saved where the host can. Scripts get the JSON payloads.
import type { JsonSchema, JsonValue, TauAbortSignal, Tool, ToolExposure, ToolResult } from "@yophon/tau-kernel";
import type {
	McpClient,
	McpReadResourceResult,
	McpRequestOptions,
	McpResource,
	McpResourceTemplate,
} from "./client.ts";
import { JSON_RPC_ERROR_CODES, McpError } from "./jsonrpc.ts";
import {
	limitMcpContent,
	type McpContentOptions,
	type McpModelContent,
	READ_MCP_RESOURCE_TOOL,
	toModelContent,
} from "./result.ts";

export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export { READ_MCP_RESOURCE_TOOL };
export const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** A connected server that offers resources. */
export interface McpResourceServer {
	name: string;
	timeoutMs: number;
	resourcesPage(
		cursor: string | undefined,
		options: McpRequestOptions,
	): Promise<{ resources: McpResource[]; nextCursor?: string }>;
	resourceTemplatesPage(
		cursor: string | undefined,
		options: McpRequestOptions,
	): Promise<{ resourceTemplates: McpResourceTemplate[]; nextCursor?: string }>;
	allResources(options: McpRequestOptions): Promise<McpResource[]>;
	allResourceTemplates(options: McpRequestOptions): Promise<McpResourceTemplate[]>;
	readResource(uri: string, options: McpRequestOptions): Promise<McpReadResourceResult>;
}

/** MCP App user interfaces, which only hosts that render them can use (pi). */
export function isMcpAppResource(item: { uri?: unknown; uriTemplate?: unknown; mimeType?: unknown }): boolean {
	const uri = String(item.uri ?? item.uriTemplate ?? "");
	return uri.startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(String(item.mimeType ?? ""));
}

/** A listed resource or template without `_meta` and icons, tagged with its server. */
function listed(server: string, item: Record<string, unknown>): Record<string, unknown> {
	const { _meta, icons: _icons, ...rest } = item;
	return { server, ...rest };
}

const stringProperty = (description: string) => ({ type: "string", description });
const SERVER_FILTER = stringProperty("MCP server name. Omit to list every server with resources.");
const CURSOR = stringProperty("Opaque cursor from a previous call with the same server; omit for the first page.");
const LIST_PARAMETERS: JsonSchema = {
	type: "object",
	properties: { server: SERVER_FILTER, cursor: CURSOR },
	additionalProperties: false,
};
const READ_PARAMETERS: JsonSchema = {
	type: "object",
	properties: {
		server: stringProperty(
			"MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
		),
		uri: stringProperty("Resource URI to read. Must be one of the URIs returned by list_mcp_resources."),
	},
	required: ["server", "uri"],
	additionalProperties: false,
};

const optionalString = { type: "string" };
const LISTING_ERRORS = {
	type: "array",
	description: "Servers that could not be listed",
	items: {
		type: "object",
		properties: { server: { type: "string" }, error: { type: "string" } },
		required: ["server", "error"],
	},
};
const LIST_OUTPUT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		server: optionalString,
		resources: {
			type: "array",
			items: {
				type: "object",
				properties: {
					server: { type: "string" },
					uri: { type: "string" },
					name: { type: "string" },
					title: optionalString,
					description: optionalString,
					mimeType: optionalString,
					size: { type: "number" },
				},
				required: ["server", "uri", "name"],
			},
		},
		nextCursor: optionalString,
		errors: LISTING_ERRORS,
	},
	required: ["resources"],
};
const LIST_TEMPLATES_OUTPUT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		server: optionalString,
		resourceTemplates: {
			type: "array",
			items: {
				type: "object",
				properties: {
					server: { type: "string" },
					uriTemplate: { type: "string", description: "RFC 6570 URI template" },
					name: { type: "string" },
					title: optionalString,
					description: optionalString,
					mimeType: optionalString,
				},
				required: ["server", "uriTemplate", "name"],
			},
		},
		nextCursor: optionalString,
		errors: LISTING_ERRORS,
	},
	required: ["resourceTemplates"],
};
const READ_OUTPUT_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		server: { type: "string" },
		uri: { type: "string" },
		contents: {
			type: "array",
			items: {
				anyOf: [
					{
						type: "object",
						properties: { uri: { type: "string" }, mimeType: optionalString, text: { type: "string" } },
						required: ["uri", "text"],
					},
					{
						type: "object",
						properties: {
							uri: { type: "string" },
							mimeType: optionalString,
							blob: { type: "string", description: "base64" },
						},
						required: ["uri", "blob"],
					},
				],
			},
		},
	},
	required: ["server", "uri", "contents"],
};

function stringArgument(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value.trim() || undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface McpResourceToolsOptions {
	/** How the tools are reached: the widest exposure of the servers they reach. */
	exposure: ToolExposure;
	/** The servers whose resources they reach, at call time. */
	servers: () => readonly McpResourceServer[];
	/** Conversion of read contents (images, binary resources), as for tool results. */
	content: Omit<McpContentOptions, "server" | "readableResources">;
	/** Where the full text of a truncated result went. */
	where: (full: string) => string;
}

/** The three resource tools (pi createMcpResourceToolDefinitions). */
export function createMcpResourceTools(options: McpResourceToolsOptions): Tool[] {
	const findServer = (name: string): McpResourceServer => {
		const servers = options.servers();
		const server = servers.find((candidate) => candidate.name === name);
		if (server) return server;
		const available = servers.map((candidate) => candidate.name).join(", ");
		throw new Error(
			`MCP server "${name}" has no resources${available ? `. Servers with resources: ${available}` : ""}`,
		);
	};

	/** One page of one server, or every page of every server. */
	const list = async <T extends Record<string, unknown>>(
		params: Record<string, unknown>,
		signal: TauAbortSignal | undefined,
		key: "resources" | "resourceTemplates",
		page: (
			server: McpResourceServer,
			cursor: string | undefined,
			requestOptions: McpRequestOptions,
		) => Promise<{ items: T[]; nextCursor?: string }>,
		all: (server: McpResourceServer, requestOptions: McpRequestOptions) => Promise<T[]>,
	): Promise<Record<string, unknown>> => {
		const serverName = stringArgument(params, "server");
		const cursor = stringArgument(params, "cursor");
		const visible = (item: T) => !isMcpAppResource(item);
		if (serverName) {
			const server = findServer(serverName);
			const result = await page(server, cursor, { ...(signal ? { signal } : {}), timeoutMs: server.timeoutMs });
			return {
				server: server.name,
				[key]: result.items.filter(visible).map((item) => listed(server.name, item)),
				...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
			};
		}
		if (cursor) throw new Error("cursor can only be used when a server is specified");
		const servers = [...options.servers()].sort((a, b) => a.name.localeCompare(b.name));
		const results = await Promise.allSettled(
			servers.map((server) => all(server, { ...(signal ? { signal } : {}), timeoutMs: server.timeoutMs })),
		);
		const items: Record<string, unknown>[] = [];
		const errors: { server: string; error: string }[] = [];
		results.forEach((result, index) => {
			const server = (servers[index] as McpResourceServer).name;
			if (result.status === "fulfilled")
				items.push(...result.value.filter(visible).map((item) => listed(server, item)));
			else errors.push({ server, error: errorMessage(result.reason) });
		});
		return { [key]: items, ...(errors.length > 0 ? { errors } : {}) };
	};

	const jsonResult = (payload: Record<string, unknown>): ToolResult => ({
		content: limitMcpContent([{ type: "text", text: JSON.stringify(payload) }], options.where),
		// The listing is plain JSON.
		structuredContent: payload as unknown as JsonValue,
	});

	/** Failures become error results, as for MCP tools. */
	const run =
		(body: (params: Record<string, unknown>, signal: TauAbortSignal | undefined) => Promise<ToolResult>) =>
		async (params: Record<string, unknown>, signal?: TauAbortSignal): Promise<ToolResult> => {
			try {
				return await body(params, signal);
			} catch (error) {
				return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
			}
		};

	const listResources: Tool = {
		name: LIST_MCP_RESOURCES_TOOL,
		description:
			"Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
		parameters: LIST_PARAMETERS,
		outputSchema: LIST_OUTPUT_SCHEMA,
		exposure: options.exposure,
		execute: run(async (params, signal) =>
			jsonResult(
				await list(
					params,
					signal,
					"resources",
					async (server, cursor, requestOptions) => {
						const result = await server.resourcesPage(cursor, requestOptions);
						return {
							items: result.resources,
							...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
						};
					},
					(server, requestOptions) => server.allResources(requestOptions),
				),
			),
		),
	};

	const listTemplates: Tool = {
		name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
		description:
			"Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
		parameters: LIST_PARAMETERS,
		outputSchema: LIST_TEMPLATES_OUTPUT_SCHEMA,
		exposure: options.exposure,
		execute: run(async (params, signal) =>
			jsonResult(
				await list(
					params,
					signal,
					"resourceTemplates",
					async (server, cursor, requestOptions) => {
						const result = await server.resourceTemplatesPage(cursor, requestOptions);
						return {
							items: result.resourceTemplates,
							...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
						};
					},
					(server, requestOptions) => server.allResourceTemplates(requestOptions),
				),
			),
		),
	};

	const readResource: Tool = {
		name: READ_MCP_RESOURCE_TOOL,
		description: "Read a specific resource from an MCP server given the server name and resource URI.",
		parameters: READ_PARAMETERS,
		outputSchema: READ_OUTPUT_SCHEMA,
		exposure: options.exposure,
		execute: run(async (params, signal) => {
			const serverName = stringArgument(params, "server");
			const uri = stringArgument(params, "uri");
			if (!serverName) throw new Error("server must be provided");
			if (!uri) throw new Error("uri must be provided");
			const server = findServer(serverName);
			const result = await server.readResource(uri, { ...(signal ? { signal } : {}), timeoutMs: server.timeoutMs });
			// Several contents (for example a directory) are labeled with their URIs (pi).
			const blocks = result.contents.flatMap((contents) => [
				...(result.contents.length > 1 ? [{ type: "text", text: `${contents.uri}:` }] : []),
				{ type: "resource", resource: contents },
			]);
			const converted: McpModelContent[] = toModelContent(blocks, { ...options.content, server: server.name });
			const contents = result.contents.map(({ _meta: _ignored, ...rest }) => rest);
			return {
				content: limitMcpContent(
					converted.length > 0 ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }],
					options.where,
				),
				// The resource contents are plain JSON as the server sent them.
				structuredContent: { server: server.name, uri, contents } as unknown as JsonValue,
			};
		}),
	};

	return [listResources, listTemplates, readResource];
}

/** Servers that do not implement resources/templates/list have no templates (pi). */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

/** A connected server as the resource tools see it (P62: moved here from servers.ts). */
export function mcpResourceServer(
	name: string,
	timeoutMs: number,
	run: <T>(call: (client: McpClient) => Promise<T>) => Promise<T>,
): McpResourceServer {
	return {
		name,
		timeoutMs,
		resourcesPage: (cursor, requestOptions) => run((client) => client.listResourcesPage(cursor, requestOptions)),
		resourceTemplatesPage: (cursor, requestOptions) =>
			run((client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, requestOptions), { resourceTemplates: [] }),
			),
		allResources: (requestOptions) => run((client) => client.listResources(requestOptions)),
		allResourceTemplates: (requestOptions) =>
			run((client) => withoutTemplates(() => client.listResourceTemplates(requestOptions), [])),
		readResource: (uri, requestOptions) => run((client) => client.readResource(uri, requestOptions)),
	};
}
