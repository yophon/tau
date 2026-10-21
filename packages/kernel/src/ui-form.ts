/**
 * Forms (P44, tau): a flat list of fields a host shows in one dialog, first for MCP
 * elicitation's form mode. The field types are what that mode allows (MCP
 * 2025-11-25: strings with formats, numbers, booleans, single and multi select).
 * Hosts with a form dialog implement UiCapability.form; askFormStepByStep asks the
 * same fields one at a time through select/input for hosts without one. Pure ES.
 */
import type { UiCapability } from "./extensions.ts";
import type { TauAbortSignal } from "./platform.ts";

export interface UiFormOption {
	value: string;
	label: string;
}

export type UiFormValue = string | number | boolean | string[];

export interface UiFormField {
	name: string;
	title: string;
	description?: string;
	required: boolean;
	type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
	/** The choices of `select` and `multiselect`. */
	options?: UiFormOption[];
	default?: UiFormValue;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: "email" | "uri" | "date" | "date-time";
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
}

export interface UiForm {
	/** Who asks, e.g. `MCP server "github"`. */
	title: string;
	message?: string;
	fields: UiFormField[];
}

/** Submitted values, or an explicit decline; a host returns undefined when the user cancels. */
export type UiFormResult = { action: "submit"; values: Record<string, UiFormValue> } | { action: "decline" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

function validDate(year: string, month: string, day: string): boolean {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (m < 1 || m > 12 || d < 1) return false;
	const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return d <= (days[m - 1] ?? 31);
}

/** Whether a value counts as filled in. */
export function hasFormValue(value: UiFormValue | undefined): value is UiFormValue {
	if (value === undefined) return false;
	if (typeof value === "string") return value !== "";
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

/** Why `value` is not acceptable for the field, or undefined when it is. */
export function formFieldError(field: UiFormField, value: UiFormValue | undefined): string | undefined {
	if (!hasFormValue(value)) return field.required ? "Required" : undefined;
	switch (field.type) {
		case "string": {
			if (typeof value !== "string") return "Enter text";
			const length = [...value].length;
			if (field.minLength !== undefined && length < field.minLength) return `At least ${field.minLength} characters`;
			if (field.maxLength !== undefined && length > field.maxLength) return `At most ${field.maxLength} characters`;
			if (field.pattern !== undefined) {
				let pattern: RegExp | undefined;
				try {
					pattern = new RegExp(field.pattern, "u");
				} catch {
					// A pattern the engine cannot compile is not the user's fault: skip it.
				}
				if (pattern && !pattern.test(value)) return `Must match ${field.pattern}`;
			}
			if (field.format === "email" && !EMAIL.test(value)) return "Enter an email address";
			if (field.format === "uri" && !URI.test(value)) return "Enter a URI";
			if (field.format === "date") {
				const match = DATE.exec(value);
				if (!match || !validDate(match[1] ?? "", match[2] ?? "", match[3] ?? "")) return "Enter a date (YYYY-MM-DD)";
			}
			if (field.format === "date-time") {
				const match = DATE_TIME.exec(value);
				if (!match || !validDate(match[1] ?? "", match[2] ?? "", match[3] ?? "")) {
					return "Enter a date and time (YYYY-MM-DDTHH:MM:SSZ)";
				}
			}
			return undefined;
		}
		case "number":
		case "integer": {
			if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number";
			if (field.type === "integer" && !Number.isInteger(value)) return "Enter a whole number";
			if (field.minimum !== undefined && value < field.minimum) return `At least ${field.minimum}`;
			if (field.maximum !== undefined && value > field.maximum) return `At most ${field.maximum}`;
			return undefined;
		}
		case "boolean":
			return typeof value === "boolean" ? undefined : "Choose yes or no";
		case "select":
			return typeof value === "string" && (field.options ?? []).some((option) => option.value === value)
				? undefined
				: "Choose one of the options";
		case "multiselect": {
			if (
				!Array.isArray(value) ||
				value.some((item) => !(field.options ?? []).some((option) => option.value === item))
			) {
				return "Choose from the options";
			}
			if (field.minItems !== undefined && value.length < field.minItems) return `Choose at least ${field.minItems}`;
			if (field.maxItems !== undefined && value.length > field.maxItems) return `Choose at most ${field.maxItems}`;
			return undefined;
		}
	}
}

/** Errors by field name; empty when the form can be submitted. */
export function formErrors(form: UiForm, values: Record<string, UiFormValue | undefined>): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const field of form.fields) {
		const error = formFieldError(field, values[field.name]);
		if (error !== undefined) errors[field.name] = error;
	}
	return errors;
}

/** The values a form starts with: each field's default. */
export function initialFormValues(form: UiForm): Record<string, UiFormValue> {
	const values: Record<string, UiFormValue> = {};
	for (const field of form.fields) if (field.default !== undefined) values[field.name] = field.default;
	return values;
}

/** Typed text for a string or number field: the value, or why it is not one. */
export function parseFormText(
	field: UiFormField,
	text: string,
): { value: UiFormValue | undefined } | { error: string } {
	if (field.type === "number" || field.type === "integer") {
		const trimmed = text.trim();
		if (trimmed === "") return { value: undefined };
		const value = Number(trimmed);
		return Number.isFinite(value) ? { value } : { error: "Enter a number" };
	}
	return { value: text === "" ? undefined : text };
}

/** How a value reads in a list of fields. */
export function formValueText(field: UiFormField, value: UiFormValue | undefined): string {
	if (!hasFormValue(value)) return "";
	const label = (item: string) => field.options?.find((option) => option.value === item)?.label ?? item;
	if (Array.isArray(value)) return value.map(label).join(", ");
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return field.type === "select" ? label(String(value)) : String(value);
}

/** A field's prompt line: title, `*` when required, then its description. */
export function formFieldTitle(field: UiFormField): string {
	return `${field.title}${field.required ? " *" : ""}${field.description ? ` — ${field.description}` : ""}`;
}

/**
 * A form on a host without a form dialog: Fill in or Decline first, then each field
 * in turn (select, selectMany, input), asking again until the value is acceptable.
 * Cancelling any step cancels the form (undefined).
 */
export async function askFormStepByStep(
	ui: UiCapability,
	form: UiForm,
	signal?: TauAbortSignal,
): Promise<UiFormResult | undefined> {
	const header = form.message ? `${form.title}: ${form.message}` : form.title;
	const start = await ui.select(header, ["Fill in", "Decline"]);
	if (start === undefined || signal?.aborted) return undefined;
	if (start === "Decline") return { action: "decline" };
	const values = initialFormValues(form);
	for (const field of form.fields) {
		for (;;) {
			if (signal?.aborted) return undefined;
			const title = formFieldTitle(field);
			const current = values[field.name];
			let next: UiFormValue | undefined;
			if (field.type === "boolean") {
				const yes = current === true ? "Yes (current)" : "Yes";
				const no = current === false ? "No (current)" : "No";
				const choice = await ui.select(title, field.required ? [yes, no] : [yes, no, "Skip"]);
				if (choice === undefined) return undefined;
				next = choice === "Skip" ? undefined : choice === yes;
			} else if (field.type === "select") {
				const labels = (field.options ?? []).map((option) => option.label);
				const choice = await ui.select(title, field.required ? labels : [...labels, "Skip"]);
				if (choice === undefined) return undefined;
				next = field.options?.find((option) => option.label === choice)?.value;
			} else if (field.type === "multiselect") {
				const labels = (field.options ?? []).map((option) => option.label);
				let chosen: string[] | undefined;
				if (ui.selectMany) chosen = await ui.selectMany(title, labels);
				else {
					const text = await ui.input(`${title} (comma-separated: ${labels.join(", ")})`);
					chosen =
						text === undefined
							? undefined
							: text
									.split(",")
									.map((part) => part.trim())
									.filter(Boolean);
				}
				if (chosen === undefined) return undefined;
				next = chosen.map((label) => field.options?.find((option) => option.label === label)?.value ?? label);
			} else {
				const placeholder = hasFormValue(current) ? String(current) : field.format;
				const text = await ui.input(title, placeholder);
				if (text === undefined) return undefined;
				// Enter on an empty line keeps what is there (the default).
				const parsed = text === "" && hasFormValue(current) ? { value: current } : parseFormText(field, text);
				if ("error" in parsed) {
					ui.notify(`${field.title}: ${parsed.error}`, "warning");
					continue;
				}
				next = parsed.value;
			}
			const error = formFieldError(field, next);
			if (error !== undefined) {
				ui.notify(`${field.title}: ${error}`, "warning");
				continue;
			}
			if (next === undefined) delete values[field.name];
			else values[field.name] = next;
			break;
		}
	}
	return { action: "submit", values };
}
