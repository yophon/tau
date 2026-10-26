// The phone's pieces (P59): Markdown, the conversation's entries, approval and dialog cards, the
// composer. Agent output is drawn as elements from parsed data, never as HTML.
import type { InputBlock, ServerRequests } from "@yophon/tau-protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { inputText, toolSummary, type ViewEntry } from "./conversation.ts";
import { shrinkImage } from "./images.ts";
import { type Block, parseMarkdown, type Span } from "./markdown.ts";

// ── Markdown ─────────────────────────────────────────────────────────────────

function SpanView({ span }: { span: Span }): ComponentChildren {
	switch (span.kind) {
		case "text":
			return span.text;
		case "code":
			return <code>{span.text}</code>;
		case "strong":
			return (
				<strong>
					{span.children.map((child, i) => (
						<SpanView key={i} span={child} />
					))}
				</strong>
			);
		case "em":
			return (
				<em>
					{span.children.map((child, i) => (
						<SpanView key={i} span={child} />
					))}
				</em>
			);
		case "link":
			return (
				<a href={span.href} target="_blank" rel="noopener noreferrer">
					{span.children.map((child, i) => (
						<SpanView key={i} span={child} />
					))}
				</a>
			);
	}
}

const spans = (list: Span[]) => list.map((span, i) => <SpanView key={i} span={span} />);

function BlockView({ block }: { block: Block }): ComponentChildren {
	switch (block.kind) {
		case "paragraph":
			return <p>{spans(block.spans)}</p>;
		case "heading":
			return <p class={`heading h${block.level}`}>{spans(block.spans)}</p>;
		case "code":
			return (
				<pre>
					<code>{block.text}</code>
				</pre>
			);
		case "list": {
			const items = block.items.map((item, i) => <li key={i}>{spans(item)}</li>);
			return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
		}
		case "quote":
			return (
				<blockquote>
					{block.blocks.map((inner, i) => (
						<BlockView key={i} block={inner} />
					))}
				</blockquote>
			);
		case "rule":
			return <hr />;
	}
}

export function Markdown({ text }: { text: string }) {
	return (
		<div class="md">
			{parseMarkdown(text).map((block, i) => (
				<BlockView key={i} block={block} />
			))}
		</div>
	);
}

// ── Entries ──────────────────────────────────────────────────────────────────

export function EntryView({ entry }: { entry: ViewEntry }) {
	const [open, setOpen] = useState(false);
	if (entry.kind === "notice") return <div class={`notice ${entry.level}`}>{entry.text}</div>;
	const { item, streaming } = entry;
	switch (item.type) {
		case "userMessage": {
			const { text, images } = inputText(item);
			return (
				<div class="user">
					{text}
					{images > 0 ? <span class="muted"> · {images === 1 ? "1 image" : `${images} images`}</span> : null}
				</div>
			);
		}
		case "agentMessage":
			return (
				<div class={`agent${streaming ? " streaming" : ""}`}>
					<Markdown text={item.text} />
				</div>
			);
		case "reasoning":
			return (
				<details class="reasoning">
					<summary>{streaming ? "Thinking…" : "Thought"}</summary>
					<div class="pre-wrap">{item.text}</div>
				</details>
			);
		case "compaction":
			return <div class="notice info">Earlier messages were summarized.</div>;
		case "toolCall": {
			const output = item.result ?? entry.output ?? "";
			return (
				<div class={`tool ${item.status}`}>
					<button type="button" class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
						<span class="dot" />
						<span class="tool-name">{item.toolName}</span>
						<span class="tool-arg">{toolSummary(item.args)}</span>
					</button>
					{open && output !== "" ? (
						<pre class="tool-out">{output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output}</pre>
					) : null}
				</div>
			);
		}
	}
}

// ── Requests (approvals and dialogs) ─────────────────────────────────────────

export type PendingRequest =
	| {
			requestId: string;
			method: "item/tool/requestApproval";
			params: ServerRequests["item/tool/requestApproval"]["params"];
			resolve: (result: ServerRequests["item/tool/requestApproval"]["result"]) => void;
	  }
	| {
			requestId: string;
			method: "ui/request";
			params: ServerRequests["ui/request"]["params"];
			resolve: (result: ServerRequests["ui/request"]["result"]) => void;
	  };

export function RequestCard({ request }: { request: PendingRequest }) {
	if (request.method === "item/tool/requestApproval") {
		const { params, resolve } = request;
		return (
			<div class={`card approval risk-${params.risk}`}>
				<div class="card-title">
					Allow <b>{params.toolName}</b>?
				</div>
				<div class="card-body mono">{toolSummary(params.args)}</div>
				{params.reason ? <div class="card-body muted">{params.reason}</div> : null}
				<div class="actions">
					<button type="button" class="primary" onClick={() => resolve({ decision: "once" })}>
						Allow once
					</button>
					{params.always ? (
						<button type="button" onClick={() => resolve({ decision: "always" })} title={params.always}>
							Always
						</button>
					) : null}
					<button type="button" class="danger" onClick={() => resolve({ decision: "deny" })}>
						Deny
					</button>
				</div>
			</div>
		);
	}
	return <DialogCard params={request.params} resolve={request.resolve} />;
}

function DialogCard({
	params,
	resolve,
}: {
	params: ServerRequests["ui/request"]["params"];
	resolve: (result: ServerRequests["ui/request"]["result"]) => void;
}) {
	const [text, setText] = useState(params.prefill ?? "");
	const [chosen, setChosen] = useState<string[]>([]);
	const cancel = () => resolve({ cancelled: true });
	const header = (
		<>
			<div class="card-title">{params.title}</div>
			{params.message ? <div class="card-body">{params.message}</div> : null}
		</>
	);
	if (params.signIn) {
		const url = /https?:\/\/\S+/.exec(params.message ?? "")?.[0];
		return (
			<div class="card">
				{header}
				<div class="actions">
					{url ? (
						<a class="button primary" href={url} target="_blank" rel="noopener noreferrer">
							Open sign-in page
						</a>
					) : null}
					<button type="button" onClick={cancel}>
						Dismiss
					</button>
				</div>
			</div>
		);
	}
	switch (params.kind) {
		case "confirm":
			return (
				<div class="card">
					{header}
					<div class="actions">
						<button type="button" class="primary" onClick={() => resolve({ confirmed: true })}>
							Yes
						</button>
						<button type="button" onClick={() => resolve({ confirmed: false })}>
							No
						</button>
					</div>
				</div>
			);
		case "select":
			return (
				<div class="card">
					{header}
					<div class="choices">
						{(params.options ?? []).map((option) => (
							<button type="button" key={option} onClick={() => resolve({ value: option })}>
								{option}
							</button>
						))}
					</div>
					<div class="actions">
						<button type="button" onClick={cancel}>
							Cancel
						</button>
					</div>
				</div>
			);
		case "selectMany":
			return (
				<div class="card">
					{header}
					<div class="choices">
						{(params.options ?? []).map((option) => (
							<label key={option} class="check">
								<input
									type="checkbox"
									checked={chosen.includes(option)}
									onChange={() =>
										setChosen(
											chosen.includes(option) ? chosen.filter((value) => value !== option) : [...chosen, option],
										)
									}
								/>
								{option}
							</label>
						))}
					</div>
					<div class="actions">
						<button type="button" class="primary" onClick={() => resolve({ values: chosen })}>
							Done
						</button>
						<button type="button" onClick={cancel}>
							Cancel
						</button>
					</div>
				</div>
			);
		case "form":
			return <FormCard params={params} resolve={resolve} />;
		default: {
			const multiline = params.kind === "editor";
			return (
				<div class="card">
					{header}
					{multiline ? (
						<textarea rows={6} value={text} onInput={(event) => setText(event.currentTarget.value)} />
					) : (
						<input
							type="text"
							value={text}
							placeholder={params.placeholder}
							onInput={(event) => setText(event.currentTarget.value)}
						/>
					)}
					<div class="actions">
						<button type="button" class="primary" onClick={() => resolve({ value: text })}>
							OK
						</button>
						<button type="button" onClick={cancel}>
							Cancel
						</button>
					</div>
				</div>
			);
		}
	}
}

interface FormField {
	name: string;
	title: string;
	description?: string;
	required: boolean;
	type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
	options?: Array<{ value: string; label: string }>;
	default?: string | number | boolean | string[];
}

/** An extension's or MCP server's form (the kernel's UiForm): each field by its type. */
function FormCard({
	params,
	resolve,
}: {
	params: ServerRequests["ui/request"]["params"];
	resolve: (result: ServerRequests["ui/request"]["result"]) => void;
}) {
	const form = (params.form ?? {}) as { title?: string; message?: string; fields?: FormField[] };
	const fields = form.fields ?? [];
	const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>(() =>
		Object.fromEntries(fields.flatMap((field) => (field.default !== undefined ? [[field.name, field.default]] : []))),
	);
	const set = (name: string, value: string | number | boolean | string[]) => setValues({ ...values, [name]: value });
	return (
		<div class="card">
			<div class="card-title">{form.title ?? params.title}</div>
			{form.message ? <div class="card-body">{form.message}</div> : null}
			{fields.map((field) => (
				<div key={field.name} class="field">
					<label htmlFor={`field-${field.name}`}>
						{field.title}
						{field.required ? " *" : ""}
					</label>
					{field.type === "boolean" ? (
						<input
							id={`field-${field.name}`}
							type="checkbox"
							checked={values[field.name] === true}
							onChange={(event) => set(field.name, event.currentTarget.checked)}
						/>
					) : field.type === "select" ? (
						<select
							id={`field-${field.name}`}
							value={String(values[field.name] ?? "")}
							onChange={(event) => set(field.name, event.currentTarget.value)}
						>
							<option value="">—</option>
							{(field.options ?? []).map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					) : field.type === "multiselect" ? (
						<select
							id={`field-${field.name}`}
							multiple
							onChange={(event) =>
								set(
									field.name,
									[...event.currentTarget.selectedOptions].map((option) => option.value),
								)
							}
						>
							{(field.options ?? []).map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					) : field.type === "string" ? (
						<input
							id={`field-${field.name}`}
							type="text"
							value={String(values[field.name] ?? "")}
							onInput={(event) => set(field.name, event.currentTarget.value)}
						/>
					) : (
						<input
							id={`field-${field.name}`}
							type="number"
							value={String(values[field.name] ?? "")}
							onInput={(event) => set(field.name, Number(event.currentTarget.value))}
						/>
					)}
					{field.description ? <small class="muted">{field.description}</small> : null}
				</div>
			))}
			<div class="actions">
				<button type="button" class="primary" onClick={() => resolve({ form: { action: "submit", values } })}>
					Submit
				</button>
				<button type="button" onClick={() => resolve({ form: { action: "decline" } })}>
					Decline
				</button>
			</div>
		</div>
	);
}

// ── Composer ─────────────────────────────────────────────────────────────────

export function Composer({
	running,
	onSend,
	onStop,
}: {
	running: boolean;
	onSend: (input: string | InputBlock[], how: "turn" | "steer" | "followUp") => void;
	onStop: () => void;
}) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<Array<{ data: string; mimeType: string; preview: string }>>([]);
	const [how, setHow] = useState<"steer" | "followUp">("steer");
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
		element.style.overflowY = element.scrollHeight > 160 ? "auto" : "hidden";
	}, [text]);
	const send = () => {
		const trimmed = text.trim();
		if (trimmed === "" && images.length === 0) return;
		const input: string | InputBlock[] =
			images.length === 0
				? trimmed
				: [
						...(trimmed !== "" ? [{ type: "text" as const, text: trimmed }] : []),
						...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
					];
		onSend(input, running ? how : "turn");
		setText("");
		setImages([]);
	};
	const attach = async (files: FileList | null) => {
		for (const file of [...(files ?? [])]) {
			const shrunk = await shrinkImage(file).catch(() => undefined);
			if (shrunk) setImages((current) => [...current, shrunk]);
		}
	};
	return (
		<div class="composer">
			{images.length > 0 ? (
				<div class="thumbs">
					{images.map((image, i) => (
						<button type="button" key={i} class="thumb" onClick={() => setImages(images.filter((_, j) => j !== i))}>
							<img src={image.preview} alt="Attached (tap to remove)" />
						</button>
					))}
				</div>
			) : null}
			{running ? (
				<div class="segmented">
					<button type="button" aria-pressed={how === "steer"} onClick={() => setHow("steer")}>
						Steer now
					</button>
					<button type="button" aria-pressed={how === "followUp"} onClick={() => setHow("followUp")}>
						After this turn
					</button>
					<button type="button" class="danger" onClick={onStop}>
						Stop
					</button>
				</div>
			) : null}
			<div class="row">
				<label class="attach" title="Attach a photo">
					<input type="file" accept="image/*" multiple onChange={(event) => void attach(event.currentTarget.files)} />
					<span aria-hidden="true">＋</span>
				</label>
				<textarea
					ref={area}
					rows={1}
					placeholder={running ? "Say something while it works…" : "Message tau"}
					value={text}
					onInput={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.isComposing &&
							window.matchMedia("(pointer: fine)").matches
						) {
							event.preventDefault();
							send();
						}
					}}
				/>
				<button type="button" class="send primary" onClick={send} aria-label="Send">
					↑
				</button>
			</div>
		</div>
	);
}
