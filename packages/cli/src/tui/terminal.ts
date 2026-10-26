// The terminal Ink draws on, for the views (P62: Ink 8 types useStdout's stream as any writable).
import { useStdout } from "ink";

/** Its size and whether it shows colors; the defaults when it is not a terminal. */
export function useTerminal(): { columns: number; rows: number; colors: boolean } {
	const { stdout } = useStdout();
	// When Ink draws on a terminal, the stream is a tty.WriteStream (or tau's proxy of one).
	const tty = stdout as Partial<Pick<NodeJS.WriteStream, "columns" | "rows" | "hasColors">>;
	return { columns: tty.columns ?? 80, rows: tty.rows ?? 24, colors: tty.hasColors?.() === true };
}
