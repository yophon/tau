import { BrowserMemoryFileSystem, hasOpfsSupport, OpfsFileSystem } from "@yophon/tau-host-browser";
import {
	Agent,
	createCodingTools,
	defaultPlatform,
	type FileInfo,
	type FileSystem,
	messageText,
} from "@yophon/tau-kernel";

const cwd = "/workspace";
const platform = defaultPlatform();
const fs: FileSystem = hasOpfsSupport() ? new OpfsFileSystem({ cwd }) : new BrowserMemoryFileSystem(cwd);

const storageStatus = document.querySelector<HTMLParagraphElement>("#storage-status");
const transcript = document.querySelector<HTMLPreElement>("#transcript");
const files = document.querySelector<HTMLUListElement>("#files");
const form = document.querySelector<HTMLFormElement>("#prompt-form");
const refreshFiles = document.querySelector<HTMLButtonElement>("#refresh-files");
const runButton = document.querySelector<HTMLButtonElement>("#run");
const baseUrlInput = document.querySelector<HTMLInputElement>("#base-url");
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key");
const modelInput = document.querySelector<HTMLInputElement>("#model");
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt");

function requireElement<T extends Element>(element: T | null, selector: string): T {
	if (!element) throw new Error(`Missing element ${selector}`);
	return element;
}

function appendTranscript(text: string): void {
	const target = requireElement(transcript, "#transcript");
	target.textContent += text;
	target.scrollTop = target.scrollHeight;
}

async function refreshFileList(): Promise<void> {
	const target = requireElement(files, "#files");
	target.replaceChildren();
	let entries: FileInfo[];
	try {
		entries = await fs.listDir(".");
	} catch {
		entries = [];
	}
	if (entries.length === 0) {
		const item = document.createElement("li");
		item.textContent = "No files yet";
		target.append(item);
		return;
	}
	for (const entry of entries) {
		const item = document.createElement("li");
		const name = document.createElement("span");
		const kind = document.createElement("span");
		name.textContent = entry.name;
		kind.className = "file-kind";
		kind.textContent = `${entry.kind} · ${entry.size} bytes`;
		item.append(name, kind);
		target.append(item);
	}
}

async function runPrompt(input: string): Promise<void> {
	const baseUrl = requireElement(baseUrlInput, "#base-url").value.trim();
	const apiKey = requireElement(apiKeyInput, "#api-key").value.trim();
	const model = requireElement(modelInput, "#model").value.trim();
	const shouldProxy =
		typeof window !== "undefined" &&
		!baseUrl.startsWith("/") &&
		!baseUrl.startsWith(window.location.origin) &&
		!baseUrl.startsWith("http://127.0.0.1") &&
		!baseUrl.startsWith("http://localhost");
	const agent = new Agent({
		config: {
			baseUrl: shouldProxy ? `${window.location.origin}/proxy` : baseUrl,
			apiKey: apiKey === "" ? undefined : apiKey,
			model,
			headers: shouldProxy ? { "x-tau-target-base-url": baseUrl } : undefined,
		},
		platform,
		systemPrompt: [
			"You are tau running in a browser demo.",
			"Use read/write/edit tools to inspect and modify files in the browser filesystem.",
			"Shell is unavailable in this host.",
		].join("\n"),
		tools: createCodingTools({ fs }),
		capabilities: { fs, paths: { cwd, projectTauDir: "/.tau", projectPiDir: "/.pi", userTauDir: "/.tau" } },
	});
	appendTranscript(`\n> ${input}\n`);
	for await (const event of agent.prompt(input)) {
		switch (event.type) {
			case "text_delta":
				appendTranscript(event.delta);
				break;
			case "tool_start":
				appendTranscript(`\n[tool:${event.toolCall.name}] ${JSON.stringify(event.toolCall.arguments)}\n`);
				break;
			case "tool_result":
				appendTranscript(`[result:${event.toolCall.name}] ${event.result.output}\n`);
				await refreshFileList();
				break;
			case "assistant_message": {
				if (messageText(event.message) !== "") appendTranscript("\n");
				break;
			}
			default:
				break;
		}
	}
	await refreshFileList();
}

if (storageStatus) {
	storageStatus.textContent = hasOpfsSupport()
		? "Using Origin Private File System for browser files."
		: "OPFS unavailable; using in-memory files for this page session.";
}

requireElement(refreshFiles, "#refresh-files").addEventListener("click", () => {
	void refreshFileList();
});

requireElement(form, "#prompt-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const prompt = requireElement(promptInput, "#prompt").value.trim();
	if (prompt === "") return;
	const button = requireElement(runButton, "#run");
	button.disabled = true;
	void runPrompt(prompt).finally(() => {
		button.disabled = false;
	});
});

void refreshFileList();
