/**
 * /export as a self-contained HTML page (pi exports HTML by default). One file,
 * no scripts or external assets: messages in order, tool calls and results and
 * reasoning folded into <details>, light and dark themes from the system.
 */

import { type AgentMessage, messageText } from "@yophon/tau-kernel";

export interface HtmlExportInfo {
	title: string;
	model: string;
	cwd: string;
	exportedAt: string;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function textWithPlaceholders(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n");
}

function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

function details(summary: string, body: string, className: string): string {
	return `<details class="${className}"><summary>${escapeHtml(summary)}</summary><pre>${escapeHtml(body)}</pre></details>`;
}

function messageHtml(message: AgentMessage): string {
	switch (message.role) {
		case "system":
			return details("System prompt", textWithPlaceholders(message.content), "system");
		case "user":
			return `<section class="msg user"><h2>User</h2><pre>${escapeHtml(textWithPlaceholders(message.content))}</pre></section>`;
		case "assistant": {
			const parts = message.content.map((block) => {
				if (block.type === "text") return `<pre>${escapeHtml(block.text)}</pre>`;
				if (block.type === "thinking") return details("Reasoning", block.thinking, "thinking");
				return details(`${block.name}`, prettyJson(block.arguments), "call");
			});
			return `<section class="msg assistant"><h2>Assistant</h2>${parts.join("")}</section>`;
		}
		case "toolResult":
			return details(
				`${message.isError ? "✗" : "↳"} ${message.toolName} result`,
				textWithPlaceholders(message.content),
				message.isError ? "result error" : "result",
			);
		case "custom":
			if (!message.display) return "";
			return `<section class="msg custom"><h2>${escapeHtml(message.customType)}</h2><pre>${escapeHtml(textWithPlaceholders(message.content))}</pre></section>`;
		case "compactionSummary":
			return details("Compacted context", message.summary, "summary");
		case "branchSummary":
			return details("Branch summary", message.summary, "summary");
		default:
			return `<pre>${escapeHtml(messageText(message as AgentMessage))}</pre>`;
	}
}

export function sessionHtml(messages: readonly AgentMessage[], info: HtmlExportInfo): string {
	const body = messages.map(messageHtml).filter((part) => part !== "");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(info.title)}</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --dim: #656d76; --line: #d0d7de; --user: #ddf4ff; --panel: #f6f8fa; --error: #cf222e; --accent: #0969da; }
@media (prefers-color-scheme: dark) {
	:root { --bg: #0d1117; --fg: #e6edf3; --dim: #8d96a0; --line: #30363d; --user: #10243e; --panel: #161b22; --error: #f85149; --accent: #4493f8; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
header { border-bottom: 1px solid var(--line); margin-bottom: 20px; padding-bottom: 12px; }
header h1 { font-size: 20px; margin: 0 0 4px; }
header p { color: var(--dim); margin: 0; font-size: 13px; }
.msg { margin: 16px 0; }
.msg h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 0 0 4px; }
.user pre { background: var(--user); border-radius: 8px; padding: 10px 12px; }
pre { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; font: inherit; }
details { margin: 6px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
details > summary { cursor: pointer; padding: 6px 10px; color: var(--dim); font-size: 13px; }
details > pre { padding: 8px 12px; border-top: 1px solid var(--line); font: 13px/1.5 ui-monospace, "Cascadia Code", Menlo, monospace; }
details.call > summary { color: var(--accent); }
details.error > summary { color: var(--error); }
</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(info.title)}</h1>
<p>${escapeHtml(`${info.model} · ${info.cwd} · exported ${info.exportedAt}`)}</p>
</header>
${body.join("\n")}
</main>
</body>
</html>
`;
}
