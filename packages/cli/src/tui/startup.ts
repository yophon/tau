/**
 * UiCapability for startup, before the TUI is mounted (the project trust
 * question, extension notices while loading). Each question renders a small
 * Ink dialog in the same style as the TUI's bottom area and unmounts once it
 * is answered; notices print as plain lines that stay in the scrollback above
 * the TUI (the P8 TUI dropped them, debt #15).
 */

import type { UiCapability } from "@yophon/tau-kernel";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import * as ed from "./input/editor.ts";

const h = React.createElement;

type Dialog =
	| { kind: "choice"; title: string; message?: string; items: Array<{ label: string; key?: string }> }
	| { kind: "input"; title: string; placeholder?: string };

function ChoiceDialog(props: {
	dialog: Extract<Dialog, { kind: "choice" }>;
	done: (index: number | undefined) => void;
}): React.ReactElement {
	const [selected, setSelected] = useState(0);
	const { items } = props.dialog;
	useInput((input, key) => {
		if (key.upArrow) setSelected((value) => (value - 1 + items.length) % items.length);
		else if (key.downArrow) setSelected((value) => (value + 1) % items.length);
		else if (key.return) props.done(selected);
		else if (key.escape || (key.ctrl && input === "c")) props.done(undefined);
		else {
			// Fast typing can deliver the key and Enter in one chunk ("y\r").
			const typed = input.replace(/[\r\n]/g, "").toLowerCase();
			const index = items.findIndex((item) => item.key !== undefined && item.key === typed);
			if (index !== -1) props.done(index);
			else if (typed === "" && /[\r\n]/.test(input)) props.done(selected);
		}
	});
	return h(
		Box,
		{ flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1 },
		h(Text, { bold: true }, props.dialog.title),
		props.dialog.message ? h(Text, { dimColor: true }, props.dialog.message) : null,
		h(Text, null, " "),
		...items.map((item, i) =>
			h(
				Text,
				{ key: `i${i}`, color: i === selected ? "cyan" : undefined },
				`${i === selected ? "❯" : " "} ${item.label}${item.key ? ` (${item.key})` : ""}`,
			),
		),
		h(Text, { dimColor: true }, "↑↓ to choose · Enter to confirm · Esc to cancel"),
	);
}

function InputDialog(props: {
	dialog: Extract<Dialog, { kind: "input" }>;
	done: (text: string | undefined) => void;
}): React.ReactElement {
	const [editor, setEditor] = useState(ed.EMPTY);
	useInput((input, key) => {
		if (key.return) props.done(editor.text.trim() === "" ? undefined : editor.text.trim());
		else if (key.escape || (key.ctrl && input === "c")) props.done(undefined);
		else if (key.backspace || key.delete) setEditor((state) => ed.backspace(state));
		else if (key.leftArrow) setEditor((state) => ed.left(state));
		else if (key.rightArrow) setEditor((state) => ed.right(state));
		else if (input !== "" && !key.ctrl && !key.meta) setEditor((state) => ed.insert(state, input.replace(/\n/g, " ")));
	});
	const { before, at, after } = ed.splitAtCursor(editor.text, editor.cursor);
	return h(
		Box,
		{ flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1 },
		h(Text, { bold: true }, props.dialog.title),
		h(
			Text,
			null,
			h(Text, { color: "cyan" }, "› "),
			before,
			h(Text, { inverse: true }, at),
			after,
			editor.text === "" && props.dialog.placeholder ? h(Text, { dimColor: true }, props.dialog.placeholder) : null,
		),
		h(Text, { dimColor: true }, "Enter to submit · Esc to cancel"),
	);
}

async function show<T>(render: (done: (value: T) => void) => React.ReactElement): Promise<T> {
	const ink = await import("ink");
	return await new Promise<T>((resolve) => {
		let instance: ReturnType<typeof ink.render> | undefined;
		const done = (value: T): void => {
			// Erase the dialog: the answer shows in what follows, not as a stale panel.
			instance?.clear();
			instance?.unmount();
			resolve(value);
		};
		instance = ink.render(render(done), { exitOnCtrlC: false, patchConsole: false });
	});
}

export function createStartupUi(): UiCapability {
	const choose = (dialog: Extract<Dialog, { kind: "choice" }>): Promise<number | undefined> =>
		show<number | undefined>((done) => h(ChoiceDialog, { dialog, done }));
	return {
		confirm: async (title, message) =>
			(await choose({
				kind: "choice",
				title,
				...(message !== undefined ? { message } : {}),
				items: [
					{ label: "Yes", key: "y" },
					{ label: "No", key: "n" },
				],
			})) === 0,
		select: async (title, values) => {
			const index = await choose({ kind: "choice", title, items: values.map((label) => ({ label })) });
			return index === undefined ? undefined : values[index];
		},
		input: (title, placeholder) =>
			show<string | undefined>((done) =>
				h(InputDialog, {
					dialog: { kind: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) },
					done,
				}),
			),
		notify: (message, level) => {
			const color = level === "error" ? "\x1b[31m" : level === "warning" ? "\x1b[33m" : "\x1b[2m";
			process.stdout.write(`${color}${message}\x1b[0m\n`);
		},
	};
}
