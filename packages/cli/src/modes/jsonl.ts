/**
 * Strict JSONL framing for the JSON, RPC and ACP modes (pi json.md): one JSON
 * value per LF-terminated record, an optional CR before the LF stripped. Records
 * are split on the LF byte only — U+2028/U+2029 inside strings are not
 * boundaries (which is why node:readline is not used).
 */

export interface RecordWriter {
	write(record: unknown): void;
}

export function stdoutWriter(out: NodeJS.WritableStream = process.stdout): RecordWriter {
	return { write: (record) => void out.write(`${JSON.stringify(record)}\n`) };
}

/**
 * Feed bytes in, get records out. `onRecord` receives the parsed value, or an
 * Error with the raw line when it is not JSON.
 */
export function createRecordReader(onRecord: (value: unknown, raw: string) => void): {
	push(chunk: Uint8Array | string): void;
	end(): void;
} {
	const decoder = new TextDecoder();
	let buffer = "";
	const flushLines = (final: boolean): void => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			emit(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
		if (final && buffer !== "") {
			emit(buffer);
			buffer = "";
		}
	};
	const emit = (line: string): void => {
		const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (raw.trim() === "") return;
		try {
			onRecord(JSON.parse(raw), raw);
		} catch (error) {
			onRecord(error instanceof Error ? error : new Error(String(error)), raw);
		}
	};
	return {
		push(chunk) {
			buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			flushLines(false);
		},
		end() {
			buffer += decoder.decode();
			flushLines(true);
		},
	};
}

/** Read records from a stream until it ends. */
export function readRecords(
	input: NodeJS.ReadableStream,
	onRecord: (value: unknown, raw: string) => void,
	onEnd: () => void,
): void {
	const reader = createRecordReader(onRecord);
	input.on("data", (chunk: Buffer | string) => reader.push(typeof chunk === "string" ? chunk : new Uint8Array(chunk)));
	input.on("end", () => {
		reader.end();
		onEnd();
	});
}
