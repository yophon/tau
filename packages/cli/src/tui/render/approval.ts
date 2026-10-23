/**
 * Approval panel body (from yo-agent surface-cli render/approval.ts): show what
 * the call will do before it is allowed — the whole command for bash, a diff
 * for edit, a preview for write, pretty JSON otherwise. Capped so a large
 * argument cannot push the options off the screen. Pure.
 */
import type { ApprovalRequest } from "@yophon/tau-kernel";
import { plainLine, type StyledLine, span } from "./spans.ts";
import { displayToolName, editDiff, editPairs, patchLines } from "./tool-views.ts";

const MAX_LINES = 20;

const str = (args: Record<string, unknown>, field: string): string => {
	const value = args[field];
	return typeof value === "string" ? value : "";
};

function cap(lines: StyledLine[], max = MAX_LINES): StyledLine[] {
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), plainLine(`… ${lines.length - max} more lines`, { dim: true })];
}

export function approvalTitle(request: ApprovalRequest): string {
	return `${displayToolName(request.toolName)} wants to run`;
}

/** `max`: rows the body may take (Ctrl+O raises it to what fits on the screen, P38c). */
export function approvalBody(request: ApprovalRequest, max = MAX_LINES): StyledLine[] {
	const args = request.args;
	const lines: StyledLine[] = [];
	// A write's preview and other arguments show ten rows until expanded.
	const small = max === MAX_LINES ? 10 : max;
	switch (request.toolName) {
		case "bash":
		case "powershell":
			lines.push(
				...cap(
					str(args, "command")
						.split("\n")
						.map((line) => [span(line, { bold: true })]),
					max,
				),
			);
			break;
		case "apply_patch":
			lines.push(...cap(patchLines(str(args, "input")), max));
			break;
		case "edit":
			lines.push(plainLine(str(args, "path"), { underline: true }));
			lines.push(...cap(editDiff(editPairs(args)), max));
			break;
		case "write": {
			const content = str(args, "content");
			const contentLines = content === "" ? [] : content.split("\n");
			lines.push(plainLine(`${str(args, "path")} (${contentLines.length} lines)`, { underline: true }));
			lines.push(
				...cap(
					contentLines.map((line) => plainLine(line, { dim: true })),
					small,
				),
			);
			break;
		}
		default: {
			let pretty: string;
			try {
				pretty = JSON.stringify(args, null, 1) ?? "";
			} catch {
				pretty = "[unserializable arguments]";
			}
			lines.push(
				...cap(
					pretty.split("\n").map((line) => plainLine(line, { dim: true })),
					small,
				),
			);
		}
	}
	if (request.reason) lines.push(plainLine(request.reason, { dim: true }));
	if (request.subagent !== undefined) {
		lines.push(
			plainLine(`called by ${request.detached ? "background " : ""}subagent ${request.subagent}`, { dim: true }),
		);
	} else if (request.parentToolCallId !== undefined) lines.push(plainLine("called by another tool", { dim: true }));
	return lines;
}
