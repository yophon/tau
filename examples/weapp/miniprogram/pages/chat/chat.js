// tau weapp demo：流式对话 + 工具调用 + 中止 + D14 失败终态渲染。
// 先运行 `npm run demo:weapp` 生成 lib/tau.js，再用微信开发者工具导入 examples/weapp。
const tau = require("../../lib/tau.js");

Page({
	data: {
		baseUrl: "",
		apiKey: "",
		model: "",
		stallTimeoutMs: "",
		input: "",
		running: false,
		messages: [],
	},

	onLoad() {
		this.agent = null;
		this.agentKey = "";
		this.abortHandle = null;
		this.assistantIndex = -1;
	},

	bindField(e) {
		this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
	},

	appendMessage(message) {
		const messages = this.data.messages.concat([message]);
		this.setData({ messages });
		return messages.length - 1;
	},

	patchMessage(index, patch) {
		const merged = Object.assign({}, this.data.messages[index], patch);
		this.setData({ [`messages[${index}]`]: merged });
	},

	// 同一轮的 text_delta 进同一个 assistant 气泡；工具轮结束后下一轮开新气泡。
	ensureAssistantBubble() {
		if (this.assistantIndex < 0) {
			this.assistantIndex = this.appendMessage({ role: "assistant", text: "", status: "", errorMessage: "" });
		}
		return this.assistantIndex;
	},

	async ensureAgent() {
		const { baseUrl, apiKey, model, stallTimeoutMs } = this.data;
		const key = [baseUrl, apiKey, model, stallTimeoutMs].join("\n");
		if (!this.agent || this.agentKey !== key) {
			this.agent = await tau.createChatAgent(wx, {
				baseUrl,
				apiKey: apiKey || undefined,
				model,
				stallTimeoutMs: Number(stallTimeoutMs) > 0 ? Number(stallTimeoutMs) : undefined,
			});
			this.agentKey = key;
		}
		return this.agent;
	},

	onAbort() {
		if (this.abortHandle) this.abortHandle.abort();
	},

	async onSend() {
		if (this.data.running) return;
		const { baseUrl, model, input } = this.data;
		if (!baseUrl || !model || !input) {
			wx.showToast({ title: "请填写 baseUrl、model 和消息", icon: "none" });
			return;
		}
		let agent;
		try {
			agent = await this.ensureAgent();
		} catch (error) {
			wx.showToast({ title: String((error && error.message) || error), icon: "none" });
			return;
		}

		this.appendMessage({ role: "user", text: input, status: "", errorMessage: "" });
		this.assistantIndex = -1;
		this.abortHandle = new tau.AbortHandle();
		this.setData({ running: true, input: "" });

		// 手动驱动 async generator（避免依赖 for-await 的编译支持）。
		const iterator = agent.prompt(input, this.abortHandle.signal);
		try {
			for (;;) {
				const step = await iterator.next();
				if (step.done) break;
				const event = step.value;
				if (event.type === "text_delta") {
					const index = this.ensureAssistantBubble();
					this.patchMessage(index, { text: this.data.messages[index].text + event.delta });
				} else if (event.type === "tool_start") {
					this.appendMessage({ role: "tool", text: `⚙ ${event.toolCall.name}`, status: "", errorMessage: "" });
				} else if (event.type === "tool_result") {
					this.appendMessage({
						role: "tool",
						text: `→ ${event.result.output || ""}`,
						status: event.result.isError ? "error" : "",
						errorMessage: "",
					});
				} else if (event.type === "assistant_message") {
					// D14 失败语义：流失败不抛出，而是 stopReason error/aborted 的消息终态。
					const message = event.message;
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						const index = this.ensureAssistantBubble();
						this.patchMessage(index, {
							status: message.stopReason,
							text: this.data.messages[index].text || (message.stopReason === "aborted" ? "（已中止）" : "（请求失败）"),
							errorMessage: message.errorMessage || "",
						});
					}
					// 工具轮之后的下一轮回复开新气泡。
					if (message.stopReason === "toolUse") this.assistantIndex = -1;
				} else if (event.type === "auto_retry_start") {
					this.appendMessage({
						role: "system",
						text: `自动重试 ${event.attempt}/${event.maxAttempts}（${Math.round(event.delayMs / 1000)}s 后）`,
						status: "",
						errorMessage: event.errorMessage,
					});
				}
			}
		} catch (error) {
			// D14 下 prompt() 不应抛出；这里兜底宿主侧缺陷，便于 e2e 发现问题。
			const index = this.ensureAssistantBubble();
			this.patchMessage(index, { status: "error", errorMessage: String((error && error.message) || error) });
		} finally {
			this.abortHandle = null;
			this.setData({ running: false });
		}
	},
});
