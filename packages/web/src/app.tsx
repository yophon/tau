// tau on a phone (P59): pair once, then the sessions the resident server holds (the terminal's
// among them) and the recent ones; inside a session the conversation as it streams, approvals and
// dialogs as cards, a composer that steers while a turn runs, and a menu for the model, the
// permission mode and compaction. A dropped connection comes back by itself and picks up where it
// was (thread/resume afterSeq).
import type { InputBlock, TauClient, ThreadInfo } from "@yophon/tau-protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Connection, type ConnectionStatus, pairDevice, savedToken } from "./connection.ts";
import { Conversation, inputText } from "./conversation.ts";
import { Composer, EntryView, type PendingRequest, RequestCard } from "./views.tsx";

const MODES = ["read-only", "supervised", "ci", "accept-edits", "autonomous", "bypass"];

/** Changes outside Preact's state (notifications, the connection) draw the page again. */
function useRedraw(): () => void {
	const [, setTick] = useState(0);
	return () => setTick((tick) => tick + 1);
}

const shortPath = (path: string): string => {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
};

const ago = (iso: string | undefined): string => {
	if (!iso) return "";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export function App() {
	const [token, setToken] = useState(savedToken());
	if (!token) return <Pairing onPaired={setToken} />;
	return <Main token={token} onUnpaired={() => setToken(undefined)} />;
}

function Pairing({ onPaired }: { onPaired: (token: string) => void }) {
	const fromLink = /(?:^|[#&])pair=(\d{6})/.exec(location.hash)?.[1];
	const [code, setCode] = useState(fromLink ?? "");
	const [name, setName] = useState(
		/iPhone|iPad/.test(navigator.userAgent)
			? "iPhone"
			: /Android/.test(navigator.userAgent)
				? "Android phone"
				: "browser",
	);
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const pair = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const token = await pairDevice(code, name);
			history.replaceState(null, "", location.pathname);
			onPaired(token);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};
	// A pairing link pairs at once.
	useEffect(() => {
		if (fromLink) void pair();
	}, []);
	return (
		<div class="screen center">
			<h1>tau</h1>
			<p class="muted">
				On the computer, run <code>tau serve pair</code> and enter the code, or scan its QR code.
			</p>
			<label class="field">
				<span>Pairing code</span>
				<input
					inputMode="numeric"
					autoComplete="one-time-code"
					maxLength={6}
					value={code}
					onInput={(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
				/>
			</label>
			<label class="field">
				<span>This device's name</span>
				<input value={name} onInput={(event) => setName(event.currentTarget.value)} />
			</label>
			{error ? <div class="notice error">{error}</div> : null}
			<button type="button" class="primary wide" disabled={busy || code.length !== 6} onClick={() => void pair()}>
				{busy ? "Pairing…" : "Pair"}
			</button>
		</div>
	);
}

interface Lists {
	loaded: ThreadInfo[];
	recent: ThreadInfo[];
}

function Main({ token, onUnpaired }: { token: string; onUnpaired: () => void }) {
	const redraw = useRedraw();
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [lists, setLists] = useState<Lists>({ loaded: [], recent: [] });
	const [error, setError] = useState<string | undefined>();
	const conversation = useRef<Conversation | undefined>(undefined);
	const pending = useRef<PendingRequest[]>([]);

	const refresh = async (client: TauClient | undefined = connection.current) => {
		if (!client) return;
		const [loaded, recent] = await Promise.all([
			client.call("thread/loaded/list", {}),
			client.call("thread/list", { allDirectories: true, limit: 30 }).catch(() => ({ threads: [] })),
		]);
		setLists({ loaded: loaded.threads, recent: recent.threads.filter((thread) => !thread.loaded) });
	};

	const settle = (requestId: string) => {
		const request = pending.current.find((candidate) => candidate.requestId === requestId);
		if (!request) return;
		pending.current = pending.current.filter((candidate) => candidate !== request);
		// Answered elsewhere: this answer is ignored by the server; the handler still has to end.
		if (request.method === "item/tool/requestApproval") request.resolve({ decision: "deny" });
		else request.resolve({ cancelled: true });
		redraw();
	};

	const connection = useMemo(
		() =>
			new Connection(token, {
				onStatus: (next) => {
					setStatus(next);
					if (next === "unpaired") onUnpaired();
				},
				onClient: async (client) => {
					// Requests of the connection that dropped are void; the server sends the waiting ones again.
					for (const request of pending.current) settle(request.requestId);
					client.on("*", (params, method) => {
						if (method === "serverRequest/resolved") {
							settle((params as { requestId: string }).requestId);
							return;
						}
						const current = conversation.current;
						if (current) {
							const before = current.version;
							current.apply({ method, params } as Parameters<Conversation["apply"]>[0]);
							if (current.version !== before) redraw();
						}
					});
					const ask = <R,>(request: Omit<PendingRequest, "resolve">) =>
						new Promise<R>((resolve) => {
							pending.current = [...pending.current, { ...request, resolve } as PendingRequest];
							redraw();
						});
					client.handle("item/tool/requestApproval", (params) =>
						ask({ requestId: params.requestId, method: "item/tool/requestApproval", params } as Omit<
							PendingRequest,
							"resolve"
						>),
					);
					client.handle("ui/request", (params) =>
						ask({ requestId: params.requestId, method: "ui/request", params } as Omit<PendingRequest, "resolve">),
					);
					const current = conversation.current;
					if (current) {
						try {
							// After a restart the session is on disk only: say which directory holds it.
							current.reset(
								await client.call("thread/resume", {
									threadId: current.threadId,
									afterSeq: current.seq,
									cwd: current.info.cwd,
								}),
							);
						} catch {
							conversation.current = undefined;
						}
					}
					await refresh(client).catch(() => undefined);
					redraw();
				},
			}),
		[token],
	);

	useEffect(() => {
		connection.start();
		return () => connection.stop();
	}, [connection]);

	const open = async (join: () => Promise<Parameters<Conversation["reset"]>[0]>) => {
		setError(undefined);
		try {
			conversation.current = new Conversation(await join());
			redraw();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	const leave = async () => {
		const current = conversation.current;
		conversation.current = undefined;
		pending.current = [];
		redraw();
		if (current) await connection.current?.unsubscribe(current.threadId).catch(() => undefined);
		await refresh().catch(() => undefined);
	};

	const client = connection.current;
	const banner =
		status === "open" ? null : (
			<div class={`banner ${status}`}>
				{status === "connecting" ? "Connecting…" : "Connection lost — reconnecting…"}
			</div>
		);

	if (!conversation.current) {
		return (
			<Sessions
				lists={lists}
				requests={pending.current}
				banner={banner}
				error={error}
				onRefresh={() => void refresh().catch((failure) => setError(String(failure)))}
				onOpen={(thread) => void open(() => client!.call("thread/resume", { threadId: thread.id, cwd: thread.cwd }))}
				onNew={(cwd) => void open(() => client!.call("thread/start", { cwd }))}
			/>
		);
	}
	return (
		<ConversationScreen
			conversation={conversation.current}
			requests={pending.current.filter(
				(request) => request.params.threadId === conversation.current?.threadId || request.params.threadId === "",
			)}
			banner={banner}
			client={client}
			onBack={() => void leave()}
		/>
	);
}

function Sessions({
	lists,
	requests,
	banner,
	error,
	onRefresh,
	onOpen,
	onNew,
}: {
	lists: Lists;
	/** Asked while a session opens (the project trust question) or of a session not shown. */
	requests: PendingRequest[];
	banner: preact.ComponentChildren;
	error: string | undefined;
	onRefresh: () => void;
	onOpen: (thread: ThreadInfo) => void;
	onNew: (cwd: string) => void;
}) {
	const [choosing, setChoosing] = useState(false);
	const [path, setPath] = useState("");
	const directories = [...new Set([...lists.loaded, ...lists.recent].map((thread) => thread.cwd))];
	const row = (thread: ThreadInfo, live: boolean) => {
		const state = !live
			? ago(thread.updatedAt)
			: thread.waiting
				? "waiting for an answer"
				: thread.status === "running"
					? "running"
					: "idle";
		return (
			<button type="button" class="session" key={thread.id} onClick={() => onOpen(thread)}>
				<span class={`badge ${live ? (thread.waiting ? "waiting" : thread.status) : "saved"}`} />
				<span class="session-main">
					<span class="session-title">{thread.name ?? thread.preview ?? thread.id.slice(0, 8)}</span>
					<span class="session-sub">
						{shortPath(thread.cwd)} · {state}
						{live && thread.clients ? ` · ${thread.clients} connected` : ""}
					</span>
				</span>
			</button>
		);
	};
	return (
		<div class="screen">
			<header class="bar">
				<span class="title">tau</span>
				<button type="button" onClick={onRefresh} aria-label="Refresh">
					⟳
				</button>
			</header>
			{banner}
			<main class="list">
				{error ? <div class="notice error">{error}</div> : null}
				{requests.map((request) => (
					<RequestCard key={request.requestId} request={request} />
				))}
				<h2>Running now</h2>
				{lists.loaded.length === 0 ? (
					<p class="muted">No session is open on the computer.</p>
				) : (
					lists.loaded.map((thread) => row(thread, true))
				)}
				<h2>Recent</h2>
				{lists.recent.length === 0 ? (
					<p class="muted">No saved sessions.</p>
				) : (
					lists.recent.map((thread) => row(thread, false))
				)}
				{choosing ? (
					<div class="card">
						<div class="card-title">New session in…</div>
						<div class="choices">
							{directories.map((dir) => (
								<button type="button" key={dir} onClick={() => onNew(dir)}>
									{shortPath(dir)}
								</button>
							))}
						</div>
						<input
							placeholder="Another directory (full path)"
							value={path}
							onInput={(event) => setPath(event.currentTarget.value)}
						/>
						<div class="actions">
							<button type="button" class="primary" disabled={path.trim() === ""} onClick={() => onNew(path.trim())}>
								Start
							</button>
							<button type="button" onClick={() => setChoosing(false)}>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button type="button" class="primary wide" onClick={() => setChoosing(true)}>
						New session
					</button>
				)}
			</main>
		</div>
	);
}

function ConversationScreen({
	conversation,
	requests,
	banner,
	client,
	onBack,
}: {
	conversation: Conversation;
	requests: PendingRequest[];
	banner: preact.ComponentChildren;
	client: TauClient | undefined;
	onBack: () => void;
}) {
	const [menu, setMenu] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const list = useRef<HTMLElement>(null);
	const stick = useRef(true);
	const { state, info } = conversation;
	// An unnamed session goes by its first message, as in the list.
	const first = conversation.entries.find((entry) => entry.kind === "item" && entry.item.type === "userMessage");
	const firstText = first?.kind === "item" && first.item.type === "userMessage" ? inputText(first.item).text : "";
	const title = info.name ?? state?.name ?? (firstText !== "" ? firstText : "New session");
	useEffect(() => {
		const element = list.current;
		if (element && stick.current) element.scrollTop = element.scrollHeight;
	});
	const call = async (run: (client: TauClient) => Promise<unknown>) => {
		if (!client) return;
		setProblem(undefined);
		try {
			await run(client);
		} catch (failure) {
			setProblem(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const threadId = conversation.threadId;
	const send = (input: string | InputBlock[], how: "turn" | "steer" | "followUp") =>
		void call((c) =>
			how === "turn"
				? c.startTurn(threadId, input)
				: c.call(how === "steer" ? "turn/steer" : "turn/followUp", { threadId, input }),
		);
	const context = state?.contextUsage as { tokens?: number; contextWindow?: number } | undefined;
	return (
		<div class="screen">
			<header class="bar">
				<button type="button" onClick={onBack} aria-label="Back to sessions">
					‹
				</button>
				<span class="title">
					<span class="ellipsis">{title}</span>
					{conversation.running ? <span class="spinner" role="img" aria-label="Working" /> : null}
				</span>
				<button type="button" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>
					⋯
				</button>
			</header>
			{banner}
			<div class="sub">
				{state?.model ?? info.model} · {state?.permissionMode ?? ""}
				{context?.tokens
					? ` · ctx ${Math.round(context.tokens / 1000)}k${context.contextWindow ? `/${Math.round(context.contextWindow / 1000)}k` : ""}`
					: ""}
				{" · "}
				{shortPath(info.cwd)}
			</div>
			{menu ? (
				<div class="sheet">
					<div class="sheet-title">Model</div>
					<div class="choices">
						{(state?.modelChoices ?? []).map((model) => (
							<button
								type="button"
								key={model}
								aria-pressed={model === state?.model}
								onClick={() =>
									void call((c) => c.call("thread/setModel", { threadId, model })).then(() => setMenu(false))
								}
							>
								{model}
							</button>
						))}
					</div>
					<div class="sheet-title">Permission mode</div>
					<div class="choices">
						{MODES.map((mode) => (
							<button
								type="button"
								key={mode}
								aria-pressed={mode === state?.permissionMode}
								onClick={() =>
									void call((c) => c.call("thread/setPermissionMode", { threadId, mode })).then(() => setMenu(false))
								}
							>
								{mode}
							</button>
						))}
					</div>
					<div class="actions">
						<button
							type="button"
							disabled={conversation.running}
							onClick={() => void call((c) => c.call("thread/compact", { threadId })).then(() => setMenu(false))}
						>
							Compact
						</button>
						<button
							type="button"
							onClick={() => {
								const name = prompt("Name this session", info.name ?? "");
								if (name) void call((c) => c.call("thread/setName", { threadId, name })).then(() => setMenu(false));
							}}
						>
							Rename
						</button>
					</div>
				</div>
			) : null}
			<main
				class="conversation"
				ref={list}
				onScroll={(event) => {
					const element = event.currentTarget;
					stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				}}
			>
				{conversation.entries.map((entry) => (
					<EntryView key={entry.kind === "item" ? entry.item.id : entry.id} entry={entry} />
				))}
				{problem ? <div class="notice error">{problem}</div> : null}
			</main>
			{requests.map((request) => (
				<RequestCard key={request.requestId} request={request} />
			))}
			<Composer running={conversation.running} onSend={send} onStop={() => void call((c) => c.interrupt(threadId))} />
		</div>
	);
}
