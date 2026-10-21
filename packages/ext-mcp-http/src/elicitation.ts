// MCP elicitation (P44; MCP 2025-11-25 client/elicitation, Claude Code's dialogs):
// a server asks the user for input during a request. Form mode carries a flat
// schema of primitive fields, turned here into a kernel UiForm; URL mode asks
// to open a link in the browser. The host decides how to ask (McpElicitHandler);
// elicitWithUi is the plain dialog flow over UiCapability. Pure ES.
import {
	askFormStepByStep,
	type TauAbortSignal,
	type UiCapability,
	type UiForm,
	type UiFormField,
	type UiFormValue,
} from "@yophon/tau-kernel";
import { isObject, JSON_RPC_ERROR_CODES, McpError } from "./jsonrpc.ts";

/** What the client declares: both modes (MCP 2025-11-25). */
export const ELICITATION_CAPABILITY = { form: {}, url: {} } as const;

/** URLElicitationRequiredError (MCP 2025-11-25). */
export const URL_ELICITATION_REQUIRED = -32042;

export type McpElicitation =
	| { mode: "form"; server: string; message: string; requestedSchema: Record<string, unknown>; form: UiForm }
	| { mode: "url"; server: string; message: string; url: string; elicitationId: string };

export interface McpElicitResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, UiFormValue>;
}

/** How the host answers an elicitation; `signal` aborts when the server cancels it. */
export type McpElicitHandler = (
	request: McpElicitation,
	context: { ui: UiCapability | undefined; signal: TauAbortSignal },
) => Promise<McpElicitResult>;

const invalidParams = (message: string) => new McpError(JSON_RPC_ERROR_CODES.invalidParams, message);

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

const optionalNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function titled(list: unknown): Array<{ value: string; label: string }> | undefined {
	if (!Array.isArray(list)) return undefined;
	const options: Array<{ value: string; label: string }> = [];
	for (const item of list) {
		if (!isObject(item) || typeof item.const !== "string") return undefined;
		options.push({ value: item.const, label: typeof item.title === "string" ? item.title : item.const });
	}
	return options;
}

function untitled(list: unknown, names?: unknown): Array<{ value: string; label: string }> | undefined {
	if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) return undefined;
	// enumNames: the legacy titles of an untitled enum (MCP 2025-06-18).
	const labels = Array.isArray(names) ? names : [];
	return (list as string[]).map((value, index) => ({
		value,
		label: typeof labels[index] === "string" ? (labels[index] as string) : value,
	}));
}

/** One property of a form schema as a field; throws for types the mode does not allow. */
function toField(name: string, schema: unknown, required: boolean): UiFormField {
	if (!isObject(schema)) throw invalidParams(`Elicitation field "${name}" has no schema`);
	const base = {
		name,
		title: typeof schema.title === "string" && schema.title !== "" ? schema.title : name,
		...(typeof schema.description === "string" && schema.description !== "" ? { description: schema.description } : {}),
		required,
	};
	const type = schema.type;
	if (type === "string") {
		const options = titled(schema.oneOf) ?? titled(schema.anyOf) ?? untitled(schema.enum, schema.enumNames);
		if (options) {
			return {
				...base,
				type: "select",
				options,
				...(typeof schema.default === "string" ? { default: schema.default } : {}),
			};
		}
		const format = typeof schema.format === "string" && FORMATS.has(schema.format) ? schema.format : undefined;
		return {
			...base,
			type: "string",
			...(typeof schema.default === "string" ? { default: schema.default } : {}),
			...(optionalNumber(schema.minLength) !== undefined ? { minLength: schema.minLength as number } : {}),
			...(optionalNumber(schema.maxLength) !== undefined ? { maxLength: schema.maxLength as number } : {}),
			...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
			...(format ? { format: format as UiFormField["format"] } : {}),
		};
	}
	if (type === "number" || type === "integer") {
		return {
			...base,
			type,
			...(optionalNumber(schema.default) !== undefined ? { default: schema.default as number } : {}),
			...(optionalNumber(schema.minimum) !== undefined ? { minimum: schema.minimum as number } : {}),
			...(optionalNumber(schema.maximum) !== undefined ? { maximum: schema.maximum as number } : {}),
		};
	}
	if (type === "boolean") {
		return { ...base, type: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
	}
	if (type === "array" && isObject(schema.items)) {
		const options = titled(schema.items.anyOf) ?? titled(schema.items.oneOf) ?? untitled(schema.items.enum);
		if (!options) throw invalidParams(`Elicitation field "${name}": an array must list its choices`);
		const defaults = Array.isArray(schema.default) && schema.default.every((item) => typeof item === "string");
		return {
			...base,
			type: "multiselect",
			options,
			...(defaults ? { default: schema.default as string[] } : {}),
			...(optionalNumber(schema.minItems) !== undefined ? { minItems: schema.minItems as number } : {}),
			...(optionalNumber(schema.maxItems) !== undefined ? { maxItems: schema.maxItems as number } : {}),
		};
	}
	throw invalidParams(`Elicitation field "${name}" has unsupported type ${JSON.stringify(type)}`);
}

/** A form schema (flat object of primitive properties) as a kernel form. */
export function elicitationForm(server: string, message: string, schema: Record<string, unknown>): UiForm {
	if (schema.type !== undefined && schema.type !== "object")
		throw invalidParams("requestedSchema must be an object schema");
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [],
	);
	return {
		title: `MCP server "${server}"`,
		message,
		fields: Object.entries(properties).map(([name, property]) => toField(name, property, required.has(name))),
	};
}

/** Check elicitation/create params (MCP 2025-11-25); invalid params throw McpError -32602. */
export function parseElicitation(server: string, params: unknown): McpElicitation {
	if (!isObject(params) || typeof params.message !== "string") throw invalidParams("Elicitation needs a message");
	const mode = params.mode ?? "form";
	if (mode === "form") {
		if (!isObject(params.requestedSchema)) throw invalidParams("Form elicitation needs a requestedSchema");
		return {
			mode: "form",
			server,
			message: params.message,
			requestedSchema: params.requestedSchema,
			form: elicitationForm(server, params.message, params.requestedSchema),
		};
	}
	if (mode === "url") {
		if (typeof params.url !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(params.url)) {
			throw invalidParams("URL elicitation needs a valid url");
		}
		if (typeof params.elicitationId !== "string" || params.elicitationId === "") {
			throw invalidParams("URL elicitation needs an elicitationId");
		}
		return { mode: "url", server, message: params.message, url: params.url, elicitationId: params.elicitationId };
	}
	throw invalidParams(`Unsupported elicitation mode ${JSON.stringify(mode)}`);
}

/** The URL elicitations an URLElicitationRequiredError carries (MCP 2025-11-25). */
export function requiredUrlElicitations(server: string, data: unknown): McpElicitation[] {
	const list = isObject(data) && Array.isArray(data.elicitations) ? data.elicitations : [];
	const found: McpElicitation[] = [];
	for (const item of list) {
		try {
			const parsed = parseElicitation(server, item);
			if (parsed.mode === "url") found.push(parsed);
		} catch {
			// Not a valid URL elicitation: skip it.
		}
	}
	return found;
}

/** Characters a command line has to escape count four times (Claude Code's cap on the URL argument). */
const ESCAPED = new Set(["%", "&", "^", "|", "<", ">", "(", ")", '"', "!", " "]);
/** About 8000 characters of plain URL (Claude Code). */
export const MAX_URL_ARGUMENT = 8000;

export function urlArgumentLength(url: string): number {
	let length = 0;
	for (const ch of url) length += ESCAPED.has(ch) ? 4 : 1;
	return length;
}

/** The host of a URL (for highlighting) and whether it looks spoofable (punycode). */
export function urlHost(url: string): { host: string; punycode: boolean } {
	const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]*)/.exec(url);
	const host = (match?.[1] ?? "").toLowerCase();
	return { host, punycode: host.split(".").some((label) => label.startsWith("xn--")) };
}

/**
 * The dialog flow over UiCapability (MCP 2025-11-25 client requirements): the form
 * dialog (or field by field); for a URL, the full URL with its host, then consent
 * before `openUrl`. No UI = cancel.
 */
export async function elicitWithUi(
	request: McpElicitation,
	ui: UiCapability | undefined,
	signal: TauAbortSignal,
	openUrl?: (url: string) => void,
): Promise<McpElicitResult> {
	if (!ui) return { action: "cancel" };
	if (request.mode === "form") {
		const result = ui.form
			? await ui.form(request.form, { signal })
			: await askFormStepByStep(ui, request.form, signal);
		if (!result || signal.aborted) return { action: "cancel" };
		return result.action === "decline" ? { action: "decline" } : { action: "accept", content: result.values };
	}
	const { host, punycode } = urlHost(request.url);
	const lines = [
		`MCP server "${request.server}" asks you to open a link: ${request.message}`,
		request.url,
		`Site: ${host}${punycode ? " — warning: the name uses punycode (xn--), it may imitate another site" : ""}`,
	];
	const tooLong = urlArgumentLength(request.url) > MAX_URL_ARGUMENT || !openUrl;
	const choice = await ui.select(lines.join("\n"), tooLong ? ["Decline"] : ["Open in browser", "Decline"]);
	if (choice === undefined || signal.aborted) return { action: "cancel" };
	if (choice !== "Open in browser") return { action: "decline" };
	openUrl?.(request.url);
	return { action: "accept" };
}
