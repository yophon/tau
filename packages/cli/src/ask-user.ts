/**
 * ask_user (P35): the model asks the user one or more questions with options.
 * By default it does not wait: the tool returns at once, the question stays on
 * screen (or in chat), and the answer arrives later as a user message
 * ("[Answer q1] …"). settings.json askUser.wait = true makes it wait. Asked
 * through UiCapability (select / selectMany / input), so every host that has a
 * UI shows it its own way: a picker, a chat message, an editor's buttons.
 * Shapes from pi's question/questionnaire examples and Claude Code's
 * AskUserQuestion; not waiting is tau's own (the user asked for it).
 */
import type { Extension, ToolResult, UiCapability } from "@yophon/tau-kernel";

/** The last item of every question: answer in your own words. */
export const OWN_ANSWER = "Write my own answer…";
/** Not waiting: put a question aside for good. */
export const SKIP_QUESTION = "Skip this question";

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	header?: string;
	options: AskOption[];
	multiSelect?: boolean;
}

export interface AskAnswer {
	/** Picked options, as indexes into the question's options. */
	picked: number[];
	wrote?: string;
	skipped?: boolean;
	/** A multiSelect question asked on a host without selectMany. */
	singleOnly?: boolean;
}

/** Lenient validation: at least one question with a text and at least one option; no upper limits. */
export function parseQuestions(value: unknown): AskQuestion[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error('"questions" must be a non-empty array');
	return value.map((item, index) => {
		const raw = (item ?? {}) as Record<string, unknown>;
		const question = typeof raw.question === "string" ? raw.question.trim() : "";
		if (question === "") throw new Error(`questions[${index}].question is empty`);
		const options = (Array.isArray(raw.options) ? raw.options : [])
			.map((option) => {
				const entry = (typeof option === "string" ? { label: option } : (option ?? {})) as Record<string, unknown>;
				const label = typeof entry.label === "string" ? entry.label.trim() : "";
				const description = typeof entry.description === "string" ? entry.description.trim() : "";
				return label === "" ? undefined : { label, ...(description ? { description } : {}) };
			})
			.filter((option): option is AskOption => option !== undefined);
		if (options.length === 0) throw new Error(`questions[${index}] needs at least one option`);
		const header = typeof raw.header === "string" ? raw.header.trim() : "";
		return {
			question,
			...(header ? { header } : {}),
			options,
			...(raw.multiSelect === true ? { multiSelect: true } : {}),
		};
	});
}

const headerOf = (question: AskQuestion, index: number) => question.header ?? `Q${index + 1}`;

/** One line per question (pi questionnaire's shape). */
export function formatAnswers(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): string {
	return questions
		.map((question, index) => {
			const answer = answers[index];
			const head = `${headerOf(question, index)}: `;
			if (!answer || answer.skipped) return `${head}user skipped this question`;
			const picked = answer.picked.map((i) => `${i + 1}. ${question.options[i]?.label ?? ""}`).join(", ");
			const parts = [
				picked ? `user selected ${picked}` : "",
				answer.wrote !== undefined ? `${picked ? "and wrote" : "user wrote"}: ${answer.wrote}` : "",
			].filter((part) => part !== "");
			return `${head}${parts.join("; ")}${answer.singleOnly ? " (this client can pick only one)" : ""}`;
		})
		.join("\n");
}

/** The picker title: "[1/3] Scope · Which packages?" */
export function questionTitle(question: AskQuestion, index: number, total: number): string {
	return `${total > 1 ? `[${index + 1}/${total}] ` : ""}${question.header ? `${question.header} · ` : ""}${question.question}`;
}

const optionItem = (option: AskOption) =>
	option.description ? `${option.label} — ${option.description}` : option.label;

/** Ask one question; undefined when dismissed (Esc). */
async function askOne(
	ui: UiCapability,
	question: AskQuestion,
	title: string,
	options: { freeAnswer: boolean; skip: boolean },
): Promise<AskAnswer | undefined> {
	const items = question.options.map(optionItem);
	const extras = [...(options.freeAnswer ? [OWN_ANSWER] : []), ...(options.skip ? [SKIP_QUESTION] : [])];
	const all = [...items, ...extras];
	const indexOf = (value: string) => items.indexOf(value);
	for (;;) {
		if (question.multiSelect && ui.selectMany) {
			const chosen = await ui.selectMany(title, all);
			if (chosen === undefined) return undefined;
			if (chosen.includes(SKIP_QUESTION)) return { picked: [], skipped: true };
			const picked = chosen.map(indexOf).filter((i) => i >= 0);
			if (!chosen.includes(OWN_ANSWER)) return { picked };
			const wrote = (await ui.input(question.question))?.trim();
			if (wrote) return { picked, wrote };
			continue;
		}
		const chosen = await ui.select(title, all);
		if (chosen === undefined) return undefined;
		if (chosen === SKIP_QUESTION) return { picked: [], skipped: true };
		const singleOnly = question.multiSelect === true ? { singleOnly: true } : {};
		if (chosen === OWN_ANSWER) {
			const wrote = (await ui.input(question.question))?.trim();
			if (wrote) return { picked: [], wrote, ...singleOnly };
			continue;
		}
		return { picked: [indexOf(chosen)].filter((i) => i >= 0), ...singleOnly };
	}
}

/** Ask every question in turn; undefined as soon as one is dismissed. */
export async function askQuestions(
	ui: UiCapability,
	questions: readonly AskQuestion[],
	options: { freeAnswer: boolean; skip: boolean },
): Promise<AskAnswer[] | undefined> {
	const answers: AskAnswer[] = [];
	for (const [index, question] of questions.entries()) {
		const answer = await askOne(ui, question, questionTitle(question, index, questions.length), options);
		if (!answer) return undefined;
		answers.push(answer);
	}
	return answers;
}

export interface AskUserHost {
	/** Whether to wait for the answer (settings.json askUser.wait, default false). */
	wait(): boolean;
	/** The host has free text input (ACP does not: no "write my own answer" item). */
	freeAnswer: boolean;
	/** Why nobody can answer right now (a scheduled run in the gateway); undefined = ask. */
	unavailable?(): string | undefined;
	/** A question is about to be shown (Notification hooks). */
	onAsk?(): void;
}

interface Pending {
	id: string;
	questions: AskQuestion[];
	ui: UiCapability;
	/** The session it was asked in; answers from an older session are dropped. */
	generation: number;
}

export const ANSWER_PREFIX = "[Answer ";

export function createAskUserExtension(host: AskUserHost): Extension {
	return (api) => {
		/** Questions put aside with Esc, oldest first (not waiting). */
		const parked: Pending[] = [];
		let counter = 0;
		let generation = 0;
		// One dialog at a time: a second question waits for the first to be answered or put aside.
		let queue: Promise<unknown> = Promise.resolve();
		const serial = <T>(task: () => Promise<T>): Promise<T> => {
			const next = queue.then(task, task);
			queue = next.catch(() => undefined);
			return next;
		};

		const open = (pending: Pending): Promise<void> =>
			serial(async () => {
				if (pending.generation !== generation) return;
				host.onAsk?.();
				let answers: AskAnswer[] | undefined;
				try {
					answers = await askQuestions(pending.ui, pending.questions, { freeAnswer: host.freeAnswer, skip: true });
				} catch {
					// The host could not ask (a closed chat, say): keep it waiting like a dismissed one.
					answers = undefined;
				}
				if (pending.generation !== generation) return;
				const at = parked.indexOf(pending);
				if (!answers) {
					if (at < 0) parked.push(pending);
					pending.ui.notify(`Question ${pending.id} is waiting. Ctrl+Q (or click it) to answer.`, "info");
					return;
				}
				if (at >= 0) parked.splice(at, 1);
				api.sendUserMessage(`${ANSWER_PREFIX}${pending.id}]\n${formatAnswers(pending.questions, answers)}`, {
					deliverAs: "steer",
				});
			});

		const reopen = (): string | undefined => {
			const pending = parked[0];
			if (!pending) return "No question is waiting.";
			void open(pending);
			return undefined;
		};

		const reset = () => {
			generation++;
			parked.length = 0;
		};
		api.on("session_start", reset);
		api.on("session_before_switch", () => {
			reset();
			return undefined;
		});

		api.registerTool(
			{
				name: "ask_user",
				description:
					"Ask the user one or more questions, each with options to pick from (the user can always answer in their own words instead). Use it when a decision is genuinely the user's to make.",
				promptSnippet: "Ask the user questions with options",
				promptGuidelines: [
					"Use ask_user only when the decision is the user's and you cannot settle it from the request, the code or sensible defaults; never to ask whether to continue.",
					'Put the option you recommend first and end its label with "(Recommended)"; ask related questions in one call.',
					...(host.wait()
						? []
						: [
								'ask_user does not wait for the answer: go on with work that does not depend on it, or end your turn if there is none. The answer arrives later as a message starting with "[Answer q<n>]".',
							]),
				],
				parameters: {
					type: "object",
					properties: {
						questions: {
							type: "array",
							description: "The questions, asked one after another",
							items: {
								type: "object",
								properties: {
									question: { type: "string", description: "The full question" },
									header: { type: "string", description: 'A short label, e.g. "Scope"' },
									options: {
										type: "array",
										description: "The choices",
										items: {
											type: "object",
											properties: {
												label: { type: "string" },
												description: { type: "string", description: "What choosing it means" },
											},
											required: ["label"],
										},
									},
									multiSelect: { type: "boolean", description: "Let the user pick several options" },
								},
								required: ["question", "options"],
							},
						},
					},
					required: ["questions"],
				},
				executionMode: "sequential",
				execute: async (args, signal, _onUpdate, ctx): Promise<ToolResult> => {
					let questions: AskQuestion[];
					try {
						questions = parseQuestions(args.questions);
					} catch (error) {
						return {
							content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
							isError: true,
						};
					}
					const unavailable = host.unavailable?.();
					const ui = ctx?.ui;
					if (unavailable !== undefined || !ui) {
						return {
							content: [
								{
									type: "text",
									text: `${unavailable ?? "No one can answer here."} Decide yourself and say what you assumed.`,
								},
							],
						};
					}
					if (host.wait()) {
						const answers = await serial(async () => {
							host.onAsk?.();
							return askQuestions(ui, questions, { freeAnswer: host.freeAnswer, skip: false });
						});
						if (signal?.aborted) return { content: [{ type: "text", text: "The question was cancelled." }] };
						if (!answers) {
							return {
								content: [{ type: "text", text: "The user dismissed the questions. Wait for their next message." }],
								terminate: true,
							};
						}
						return {
							content: [{ type: "text", text: formatAnswers(questions, answers) }],
							details: { questions: questions.map((q) => q.question), answered: true },
						};
					}
					const pending: Pending = { id: `q${++counter}`, questions, ui, generation };
					void open(pending);
					return {
						content: [
							{
								type: "text",
								text: `Question ${pending.id} sent to the user; you are not waiting for it. Their answer will arrive later as a message starting with "${ANSWER_PREFIX}${pending.id}]". Go on with work that does not depend on it; if there is none, end your turn.`,
							},
						],
						details: { id: pending.id, questions: questions.map((q) => q.question) },
					};
				},
			},
			{ risk: "low" },
		);

		api.registerShortcut("ask_user", {
			key: "ctrl+q",
			description: "Answer the question that is waiting (ask_user)",
			handler: () => reopen(),
		});

		api.registerWidget("ask_user", {
			placement: "above-editor",
			description: "Questions waiting for an answer",
			handler: () => {
				const first = parked[0];
				if (!first) return undefined;
				const more = parked.length > 1 ? ` · ${parked.length - 1} more` : "";
				return `❓ ${first.id} ${questionTitle(first.questions[0], 0, first.questions.length)}  (Ctrl+Q to answer${more})`;
			},
			onClick: () => {
				reopen();
			},
		});
	};
}
