// When a scheduled task runs, for people (P44). Apart from scheduler.ts, which loads the
// cron code: /tasks formats times without loading it.

/** A time for people: HH:MM today, else the date too (local time). */
export function formatRunTime(at: number | undefined, now = Date.now()): string {
	if (at === undefined) return "never";
	const date = new Date(at);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	return sameDay
		? time
		: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}
