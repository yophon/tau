#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadExtensionsFromDir, NodeFileSystem, NodeShell } from "@tau/host-node";
import { Agent, createCodingTools, ExtensionRegistry, type OpenAICompatConfig, type UiCapability } from "@tau/kernel";

const USAGE = `tau - minimal OpenAI-compatible coding agent

Usage: tau [options] [-p "prompt"]

Options:
  -b, --base-url <url>   API base URL (env: TAU_BASE_URL, OPENAI_BASE_URL)
  -k, --api-key <key>    API key (env: TAU_API_KEY, OPENAI_API_KEY)
  -m, --model <model>    Model id (env: TAU_MODEL)
  -s, --system <text>    Override the system prompt
  -p, --print <prompt>   One-shot mode: run a single prompt and exit
  -h, --help             Show this help

Without -p, tau starts an interactive REPL. Ctrl+C aborts the current turn.`;

interface CliOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	system?: string;
	print?: string;
	help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) {
				console.error(`Missing value for ${arg}`);
				process.exit(1);
			}
			return value;
		};
		switch (arg) {
			case "-b":
			case "--base-url":
				options.baseUrl = next();
				break;
			case "-k":
			case "--api-key":
				options.apiKey = next();
				break;
			case "-m":
			case "--model":
				options.model = next();
				break;
			case "-s":
			case "--system":
				options.system = next();
				break;
			case "-p":
			case "--print":
				options.print = next();
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				console.error(`Unknown option: ${arg}`);
				process.exit(1);
		}
	}
	return options;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;

type Readline = ReturnType<typeof createInterface>;

function createUi(readline: Readline): UiCapability {
	return {
		confirm: async (title, message) => {
			if (message) console.log(dim(message));
			const answer = await readline.question(`${title} [y/N] `);
			return /^y(es)?$/i.test(answer.trim());
		},
		input: async (title) => {
			const answer = await readline.question(`${title}: `);
			return answer === "" ? undefined : answer;
		},
		select: async (title, options) => {
			console.log(title);
			for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
			const answer = await readline.question("> ");
			const index = Number.parseInt(answer.trim(), 10) - 1;
			return options[index];
		},
		notify: (message, level) => {
			const paint = level === "error" ? red : level === "warning" ? cyan : dim;
			console.log(paint(message));
		},
	};
}

function defaultSystemPrompt(cwd: string): string {
	return [
		"You are tau, a coding agent running in a terminal.",
		`Working directory: ${cwd}`,
		"Use the available tools (read, write, edit, bash) to inspect and modify the project.",
		"Be direct and concise. Answer questions before making changes.",
	].join("\n");
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0];
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

async function runTurn(agent: Agent, input: string): Promise<void> {
	const controller = new AbortController();
	const onSigint = (): void => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	let sawReasoning = false;
	try {
		for await (const event of agent.prompt(input, controller.signal)) {
			switch (event.type) {
				case "reasoning_delta":
					sawReasoning = true;
					process.stdout.write(dim(event.delta));
					break;
				case "text_delta":
					if (sawReasoning) {
						sawReasoning = false;
						process.stdout.write("\n\n");
					}
					process.stdout.write(event.delta);
					break;
				case "assistant_message":
					if (event.message.content !== "" || event.message.reasoning) process.stdout.write("\n");
					break;
				case "tool_start":
					process.stdout.write(`${cyan(`⚙ ${event.toolCall.name}`)} ${dim(firstLine(event.toolCall.arguments))}\n`);
					break;
				case "tool_result": {
					const marker = event.result.isError ? red("✗") : dim("✓");
					process.stdout.write(`${marker} ${dim(firstLine(event.result.output))}\n`);
					break;
				}
				case "agent_end": {
					const last = agent.messages.at(-1);
					if (last?.role === "assistant" && last.usage) {
						process.stdout.write(dim(`[tokens: ${last.usage.inputTokens} in, ${last.usage.outputTokens} out]\n`));
					}
					break;
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`\n${red(`Error: ${message}`)}\n`);
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const baseUrl = options.baseUrl ?? process.env.TAU_BASE_URL ?? process.env.OPENAI_BASE_URL;
	const apiKey = options.apiKey ?? process.env.TAU_API_KEY ?? process.env.OPENAI_API_KEY;
	const model = options.model ?? process.env.TAU_MODEL;
	if (!baseUrl || !model) {
		console.error("Missing --base-url and/or --model (or TAU_BASE_URL / TAU_MODEL env vars).\n");
		console.error(USAGE);
		process.exit(1);
	}

	const config: OpenAICompatConfig = { baseUrl, apiKey, model };
	const cwd = process.cwd();
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	const extensions = await ExtensionRegistry.load(await loadExtensionsFromDir(join(cwd, ".tau/extensions")));
	const agent = new Agent({
		config,
		systemPrompt: options.system ?? defaultSystemPrompt(cwd),
		tools: createCodingTools({ fs: new NodeFileSystem(cwd), shell: new NodeShell(cwd) }),
		extensions,
		// Headless stdin (pipes, CI) cannot answer prompts; omit the UI capability
		// so extensions take their no-UI degradation path instead of hanging.
		ui: process.stdin.isTTY ? createUi(readline) : undefined,
	});

	if (options.print !== undefined) {
		await runTurn(agent, options.print);
		readline.close();
		return;
	}

	const extensionNote = extensions.tools.size + extensions.commands.size > 0 ? " · extensions loaded" : "";
	console.log(dim(`tau · ${model} @ ${baseUrl} · cwd ${cwd}${extensionNote} · "exit" or Ctrl+D to quit`));
	readline.on("SIGINT", () => {
		readline.close();
	});
	while (true) {
		let line: string;
		try {
			line = await readline.question("tau> ");
		} catch {
			break;
		}
		const input = line.trim();
		if (input === "") continue;
		if (input === "exit" || input === "quit") break;
		if (input.startsWith("/")) {
			await runCommand(agent, extensions, input);
			continue;
		}
		await runTurn(agent, input);
	}
	readline.close();
}

async function runCommand(agent: Agent, extensions: ExtensionRegistry, input: string): Promise<void> {
	const spaceIndex = input.indexOf(" ");
	const name = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).slice(1);
	const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
	if (name === "help") {
		const commands = [...extensions.commands.values()];
		if (commands.length === 0) console.log(dim("No extension commands registered."));
		for (const command of commands) console.log(`/${command.name} — ${command.description}`);
		return;
	}
	const command = extensions.commands.get(name);
	if (!command) {
		console.log(red(`Unknown command: /${name} (try /help)`));
		return;
	}
	try {
		const output = await command.handler(args, agent.extensionContext());
		if (output !== undefined) console.log(output);
	} catch (error) {
		console.log(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
	}
}

await main();
