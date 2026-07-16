// tau RN (Expo) demo：@yophon/tau-host-rn 的 createRnPlatform + expo/fetch 流式对话。
// 仅内存对话（无 fs/shell 能力）；模型可用工具只有静态扩展注册的 get_time（D8）。
import { createRnPlatform } from "@yophon/tau-host-rn";
import { AbortHandle, Agent, ExtensionRegistry } from "@yophon/tau-kernel";
import { fetch as expoFetch } from "expo/fetch";
import { useRef, useState } from "react";
import {
	Button,
	KeyboardAvoidingView,
	Platform as RnPlatform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";

const demoExtension = (api) => {
	api.registerTool({
		name: "get_time",
		description: "获取当前设备时间",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: new Date().toString() }),
	});
};

async function createChatAgent(config) {
	return new Agent({
		config: {
			baseUrl: config.baseUrl,
			apiKey: config.apiKey || undefined,
			model: config.model,
			stallTimeoutMs: config.stallTimeoutMs,
		},
		// RN 全局 fetch 不支持流式 body，必须用 expo/fetch（SDK 52+）。
		platform: createRnPlatform({ fetch: expoFetch }),
		extensions: await ExtensionRegistry.load([demoExtension]),
	});
}

export default function App() {
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");
	const [input, setInput] = useState("");
	const [running, setRunning] = useState(false);
	const [messages, setMessages] = useState([]);
	const agentRef = useRef(null);
	const agentKeyRef = useRef("");
	const abortRef = useRef(null);
	const scrollRef = useRef(null);

	// messagesRef 是同步事实源（setState 是异步批处理的，流式回调里读不到最新 index）。
	const messagesRef = useRef([]);
	const append = (message) => {
		const index = messagesRef.current.length;
		messagesRef.current = [...messagesRef.current, message];
		setMessages(messagesRef.current);
		return index;
	};
	const patch = (index, patcher) => {
		messagesRef.current = messagesRef.current.map((message, i) => (i === index ? patcher(message) : message));
		setMessages(messagesRef.current);
	};

	const onSend = async () => {
		if (running || !baseUrl || !model || !input) return;
		const key = `${baseUrl}\n${apiKey}\n${model}`;
		if (!agentRef.current || agentKeyRef.current !== key) {
			agentRef.current = await createChatAgent({ baseUrl, apiKey, model });
			agentKeyRef.current = key;
		}
		const prompt = input;
		setInput("");
		setRunning(true);
		append({ role: "user", text: prompt });
		let assistantIndex = -1;
		const bubble = () => {
			if (assistantIndex < 0) assistantIndex = append({ role: "assistant", text: "", status: "" });
			return assistantIndex;
		};
		abortRef.current = new AbortHandle();
		try {
			for await (const event of agentRef.current.prompt(prompt, abortRef.current.signal)) {
				if (event.type === "text_delta") {
					patch(bubble(), (m) => ({ ...m, text: m.text + event.delta }));
				} else if (event.type === "tool_start") {
					append({ role: "tool", text: `⚙ ${event.toolCall.name}` });
				} else if (event.type === "tool_result") {
					append({ role: "tool", text: `→ ${event.result.output || ""}`, status: event.result.isError ? "error" : "" });
				} else if (event.type === "assistant_message") {
					// D14 失败语义：流失败不抛出，渲染 stopReason error/aborted 终态。
					const message = event.message;
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						patch(bubble(), (m) => ({
							...m,
							status: message.stopReason,
							text: m.text || (message.stopReason === "aborted" ? "（已中止）" : "（请求失败）"),
							errorMessage: message.errorMessage || "",
						}));
					}
					if (message.stopReason === "toolUse") assistantIndex = -1;
				}
				scrollRef.current?.scrollToEnd({ animated: false });
			}
		} finally {
			abortRef.current = null;
			setRunning(false);
		}
	};

	return (
		<KeyboardAvoidingView style={styles.page} behavior={RnPlatform.OS === "ios" ? "padding" : undefined}>
			<View style={styles.config}>
				<TextInput style={styles.field} placeholder="baseUrl（https://…/v1）" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" />
				<TextInput style={styles.field} placeholder="apiKey（可空）" value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" />
				<TextInput style={styles.field} placeholder="model" value={model} onChangeText={setModel} autoCapitalize="none" />
			</View>
			<ScrollView ref={scrollRef} style={styles.messages}>
				{messages.map((message, index) => (
					<View key={index} style={[styles.msg, styles[message.role], message.status ? styles[message.status] : null]}>
						<Text style={message.role === "user" ? styles.userText : null}>{message.text}</Text>
						{message.errorMessage ? <Text style={styles.errorDetail}>{message.errorMessage}</Text> : null}
					</View>
				))}
			</ScrollView>
			<View style={styles.composer}>
				<TextInput style={[styles.field, styles.prompt]} placeholder="输入消息…" value={input} onChangeText={setInput} onSubmitEditing={onSend} />
				<Button title="发送" onPress={onSend} disabled={running} />
				<Button title="中止" onPress={() => abortRef.current?.abort()} disabled={!running} />
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, padding: 12, paddingTop: 60, backgroundColor: "#f5f5f7" },
	config: { marginBottom: 8 },
	field: { backgroundColor: "#fff", borderRadius: 6, padding: 10, marginBottom: 6 },
	messages: { flex: 1, marginVertical: 8 },
	msg: { maxWidth: "85%", borderRadius: 8, padding: 10, marginBottom: 6 },
	user: { alignSelf: "flex-end", backgroundColor: "#1a1a2e" },
	userText: { color: "#fff" },
	assistant: { backgroundColor: "#fff" },
	tool: { backgroundColor: "transparent" },
	error: { borderWidth: 1, borderColor: "#e0245e" },
	aborted: { borderWidth: 1, borderColor: "#e6a23c" },
	errorDetail: { marginTop: 6, color: "#e0245e", fontSize: 12 },
	composer: { flexDirection: "row", alignItems: "center", gap: 6 },
	prompt: { flex: 1, marginBottom: 0 },
});
