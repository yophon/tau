/** Chat-facing text (P30): what people in WeChat or Feishu read. Kept in one place. */

/** Split a reply at paragraph, line or space boundaries, at most `limit` characters each. */
export function chunkText(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		let cut = window.lastIndexOf("\n\n");
		if (cut < limit / 2) cut = window.lastIndexOf("\n");
		if (cut < limit / 2) cut = window.lastIndexOf(" ");
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
}

/** One line describing a tool call's arguments. */
export function summarizeArgs(toolName: string, args: Record<string, unknown>, max = 160): string {
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value.trim() !== "") return value;
		}
		return undefined;
	};
	const specific =
		toolName === "bash"
			? pick("command")
			: toolName === "web_fetch"
				? pick("url")
				: toolName === "web_search"
					? pick("query")
					: pick("path", "file_path", "pattern", "url", "query", "command");
	const text = (specific ?? JSON.stringify(args)).replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const TEXT = {
	notAllowed: "你还没有获得使用授权。请向主人要配对码，然后发送：配对 <码>",
	paired: "配对成功，现在可以直接和我对话了。",
	pairWrong: "配对码不正确，请向主人确认后重发：配对 <码>",
	ownerClaimed: "认主成功，你现在是这个账号的主人。",
	ownerWrong: "认主码不正确。",
	ownerTaken: "这个账号已经有主人了，认主码无效。",
	tooManyTries: "尝试次数过多，本次运行内不再受理。",
	stopped: "已停止。",
	nothingToStop: "现在没有在运行的任务。",
	noPermission: "只有主人可以用这个命令。",
	modeBypass: "聊天里不能切到 bypass。",
	help: (owner: boolean) =>
		[
			"可用命令：",
			"/stop 停止当前任务",
			"/new 开始新会话",
			...(owner
				? [
						"/mode [档位] 查看或切换权限档位（read-only、supervised、accept-edits、autonomous）",
						"/model [名字] 查看或切换模型",
						"/compact 压缩上下文",
						"/status 网关状态",
						"/schedules 定时任务（/schedules cancel <编号> 取消）",
						"/goals 目标（/goals all 含已结束的；/goals done|drop <编号> 结束）",
						"/runs [n] 最近几轮做了什么（触发者、工具、审批、花费）",
						"/tasks 后台命令（/tasks <编号> 看输出，/tasks stop <编号> 结束）",
					]
				: []),
			"/help 显示这条帮助",
		].join("\n"),
	noTasks: "这个对话没有后台命令。",
	runFailed: (message: string) => `这一轮出错了：${message}`,
	approval: (options: {
		id: string;
		toolName: string;
		risk: string;
		summary: string;
		from?: string;
		timeoutMin: number;
	}) =>
		[
			`需要批准：${options.toolName}（${options.risk} 风险）`,
			...(options.from ? [`来自对话：${options.from}`] : []),
			`内容：${options.summary}`,
			`回复「批准 ${options.id}」放行一次，「拒绝 ${options.id}」拒绝；${options.timeoutMin} 分钟内不回复按拒绝。`,
		].join("\n"),
	approved: (id: string) => `已批准 ${id}。`,
	denied: (id: string) => `已拒绝 ${id}。`,
	approvalAmbiguous: "有多个待批请求，请带上编号回复，例如：批准 <编号>",
	approvalUnknown: (id: string) => `没有编号为 ${id} 的待批请求（可能已超时）。`,
	needsOwner: "需要主人批准，这个对话不能执行这项操作",
	approvalTimeout: (min: number) => `主人没有在 ${min} 分钟内批准`,
	question: (options: { title: string; options: string[]; many: boolean; free: boolean; input: boolean }) =>
		options.input
			? `✏️ ${options.title}`
			: [
					`❓ ${options.title}`,
					...options.options.map((option, index) => `${index + 1}. ${option}`),
					`${options.many ? "可多选，回复编号，比如 1 3" : "回复编号"}${options.free ? "，或直接写你的回答" : ""}。`,
				].join("\n"),
	questionBadNumber: (count: number, many: boolean) =>
		many ? `请回复 1–${count} 之间的编号，可以写几个，比如 1 3。` : `请回复 1–${count} 之间的一个编号。`,
	scheduleCreated: (options: { id: string; title: string; timing: string; next?: string; recurring: boolean }) =>
		[
			`⏰ 已设置 #${options.id}：${options.recurring ? `${options.timing} ` : ""}${options.title}`,
			options.next ? (options.recurring ? `下一次：${options.next}` : `时间：${options.next}`) : "",
			`取消发 /schedules cancel ${options.id}`,
		]
			.filter(Boolean)
			.join("\n"),
	scheduleCancelled: (id: string, title: string) => `已取消 #${id}「${title}」。`,
	scheduleUnknown: (id: string) => `本对话没有进行中的定时任务 #${id}。`,
	schedulesUsage: "用法：/schedules 列出定时任务，/schedules cancel <编号> 取消。",
	schedulesHint: "取消发 /schedules cancel <编号>",
	noSchedules: "本对话没有进行中的定时任务。",
	goalUnknown: (id: string) => `本对话没有目标 #${id}。`,
	goalEnded: (id: string, title: string, state: string, ended: string[]) =>
		`目标 #${id}「${title}」已${state === "done" ? "完成" : "放弃"}。${ended.length > 0 ? `同时结束了定时任务 ${ended.map((entry) => `#${entry}`).join("、")}。` : ""}`,
	goalsUsage: "用法：/goals 列出进行中的目标，/goals all 含已结束的，/goals done <编号> 或 /goals drop <编号> 结束。",
	noGoals: "本对话没有进行中的目标。",
	noAudit: "没有运行记录。",
	/** What the model is handed when a schedule fires. */
	scheduledTask: (options: {
		id: string;
		title: string;
		prompt: string;
		planned: string;
		late?: string;
		goal?: { id: string; title: string; state: string; notes: string[] };
		recurring: boolean;
	}) =>
		[
			options.late
				? `[定时任务 #${options.id}「${options.title}」，本应在 ${options.planned} 执行，网关当时没有运行，晚了 ${options.late}]`
				: `[定时任务 #${options.id}「${options.title}」，计划 ${options.planned} 执行]`,
			options.prompt,
			...(options.goal
				? [
						`[目标 #${options.goal.id}「${options.goal.title}」${options.goal.state === "active" ? "进行中" : options.goal.state}${options.goal.notes.length > 0 ? `；最近进度：${options.goal.notes.join("；")}` : ""}]`,
					]
				: []),
			...(options.recurring
				? [
						"这是无人值守的执行：能用只读工具（read、ls、find、grep）就不用 bash，需要批准的操作每次执行都会打扰主人。",
						"如果这次没有需要告诉用户的内容，只回复「[静默]」。",
					]
				: []),
		].join("\n"),
};
