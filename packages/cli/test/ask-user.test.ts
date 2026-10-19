// P35: ask_user — questions with options; by default the model does not wait for the answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Agent,
	type AgentEvent,
	ExtensionRegistry,
	toolResultText,
	type UiCapability,
	type UserContent,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import {
	type AskUserHost,
	askQuestions,
	createAskUserExtension,
	formatAnswers,
	OWN_ANSWER,
	parseQuestions,
	SKIP_QUESTION,
} from "../src/ask-user.ts";

/** A UI that answers from a script: select/selectMany get the next answer, input the next text. */
function scriptedUi(answers: Array<string | string[] | undefined>, log: string[] = []): UiCapability {
	const next = () => answers.shift();
	return {
		confirm: async () => false,
		select: async (title, options) => {
			log.push(`select ${title} | ${options.join(" / ")}`);
			return next() as string | undefined;
		},
		selectMany: async (title, options) => {
			log.push(`many ${title} | ${options.join(" / ")}`);
			return next() as string[] | undefined;
		},
		input: async (title) => {
			log.push(`input ${title}`);
			return next() as string | undefined;
		},
		notify: (message) => {
			log.push(`notify ${message}`);
		},
	};
}

const QUESTIONS = [
	{
		question: "Which packages?",
		header: "Scope",
		options: [{ label: "All (Recommended)" }, { label: "cli only", description: "packages/cli" }],
	},
	{ question: "Which checks?", header: "Checks", options: ["lint", "types", "smoke"], multiSelect: true },
];

describe("ask_user questions", () => {
	it("accepts any number of questions and options, and rejects only empty ones", () => {
		const parsed = parseQuestions(QUESTIONS);
		assert.equal(parsed.length, 2);
		assert.deepEqual(
			parsed[1]?.options.map((o) => o.label),
			["lint", "types", "smoke"],
		);
		assert.throws(() => parseQuestions([]), /non-empty/);
		assert.throws(() => parseQuestions([{ question: "x", options: [] }]), /at least one option/);
		const many = parseQuestions(Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, options: ["a"] })));
		assert.equal(many.length, 9);
	});

	it("asks in turn: options with descriptions, own answer, several picks; formats one line each", async () => {
		const log: string[] = [];
		const ui = scriptedUi(["cli only — packages/cli", ["lint", OWN_ANSWER], "only fast ones"], log);
		const questions = parseQuestions(QUESTIONS);
		const answers = await askQuestions(ui, questions, { freeAnswer: true, skip: false });
		assert.ok(answers);
		assert.equal(
			log[0],
			`select [1/2] Scope · Which packages? | All (Recommended) / cli only — packages/cli / ${OWN_ANSWER}`,
		);
		assert.match(log[1] ?? "", /^many \[2\/2\] Checks · Which checks\? \| lint \/ types \/ smoke \//);
		assert.equal(
			formatAnswers(questions, answers),
			"Scope: user selected 2. cli only\nChecks: user selected 1. lint; and wrote: only fast ones",
		);
	});

	it("falls back to one pick without selectMany, and says so; no own answer where there is no text input", async () => {
		const log: string[] = [];
		const ui = { ...scriptedUi(["All (Recommended)", "types"], log), selectMany: undefined };
		const questions = parseQuestions(QUESTIONS);
		const answers = await askQuestions(ui, questions, { freeAnswer: false, skip: false });
		assert.ok(answers);
		assert.ok(!log.join("\n").includes(OWN_ANSWER));
		assert.equal(
			formatAnswers(questions, answers),
			"Scope: user selected 1. All (Recommended)\nChecks: user selected 2. types (this client can pick only one)",
		);
	});
});

function agentWith(host: AskUserHost, ui: UiCapability, extraTurns: unknown[][] = []) {
	const requests: unknown[] = [];
	return ExtensionRegistry.load([createAskUserExtension(host)]).then((registry) => {
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform(
				[toolCallTurn("ask_user", { questions: QUESTIONS.slice(0, 1) }), textTurn("ok"), ...extraTurns].map((turn) =>
					makeSseResponse(turn),
				),
				requests,
			),
			extensions: registry,
			ui,
		});
		return { agent, registry, requests };
	});
}

async function drain(agent: Agent, input: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input)) events.push(event);
	return events;
}

const toolText = (events: AgentEvent[]) =>
	events.filter((event) => event.type === "tool_result").map((event) => toolResultText(event.result))[0] ?? "";

describe("ask_user in a run", () => {
	it("waiting: the answer is the tool result; dismissing ends the run", async () => {
		const host = { wait: () => true, freeAnswer: true };
		const answered = await agentWith(host, scriptedUi(["All (Recommended)"]));
		assert.equal(toolText(await drain(answered.agent, "go")), "Scope: user selected 1. All (Recommended)");
		const dismissed = await agentWith(host, scriptedUi([undefined]));
		const events = await drain(dismissed.agent, "go");
		assert.match(toolText(events), /dismissed the questions/);
		// terminate: no second model request after the dismissed question.
		assert.equal(dismissed.requests.length, 1);
	});

	it("not waiting (default): the tool returns at once, the answer arrives later as a user message", async () => {
		let answer: (value: string) => void = () => undefined;
		const ui: UiCapability = {
			...scriptedUi([]),
			select: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		};
		const { agent, registry } = await agentWith({ wait: () => false, freeAnswer: true }, ui);
		const sent: UserContent[] = [];
		registry.attachHostActions({ submitPrompt: (content) => sent.push(content) });
		const events = await drain(agent, "go");
		assert.match(toolText(events), /^Question q1 sent to the user; you are not waiting for it\./);
		answer("cli only — packages/cli");
		for (let i = 0; i < 20 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(sent, ["[Answer q1]\nScope: user selected 2. cli only"]);
	});

	it("not waiting: Esc puts the question aside; the widget shows it and Ctrl+Q (or a click) asks again", async () => {
		const log: string[] = [];
		const ui = scriptedUi([undefined, SKIP_QUESTION], log);
		const { agent, registry } = await agentWith({ wait: () => false, freeAnswer: true }, ui);
		const sent: UserContent[] = [];
		registry.attachHostActions({ submitPrompt: (content) => sent.push(content) });
		await drain(agent, "go");
		for (let i = 0; i < 20 && !log.some((line) => line.startsWith("notify")); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const widget = registry.widgets.get("ask_user");
		const ctx = agent.extensionContext();
		assert.match(String(await widget?.handler(ctx)), /^❓ q1 Scope · Which packages\? {2}\(Ctrl\+Q to answer\)$/);
		assert.ok(log.at(-2)?.includes(SKIP_QUESTION));
		await registry.shortcuts.get("ask_user")?.handler(ctx);
		for (let i = 0; i < 20 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(sent, ["[Answer q1]\nScope: user skipped this question"]);
		assert.equal(await widget?.handler(ctx), undefined);
	});

	it("nobody to ask (a scheduled run): the model is told to decide itself", async () => {
		const { agent } = await agentWith(
			{ wait: () => false, freeAnswer: true, unavailable: () => "This run is a scheduled task." },
			scriptedUi([]),
		);
		assert.equal(
			toolText(await drain(agent, "go")),
			"This run is a scheduled task. Decide yourself and say what you assumed.",
		);
	});
});
