/**
 * Ink draws nothing but the final frame when it believes it runs in CI
 * (is-in-ci: a `CI` or `CI_*` variable, read once when Ink is first imported).
 * The TUI only starts on a real terminal, so a shell that exports CI must not
 * leave it blank: load Ink with detection off (is-in-ci honors CI=false), then
 * restore the variable for the commands tools run.
 */
export async function loadInk(): Promise<void> {
	const had = Object.hasOwn(process.env, "CI");
	const saved = process.env.CI;
	process.env.CI = "false";
	try {
		await import("ink");
	} finally {
		if (had) process.env.CI = saved;
		else delete process.env.CI;
	}
}
