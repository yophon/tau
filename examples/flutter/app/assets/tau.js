"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // js/polyfills.ts
  function define(target, name, value) {
    if (!(name in target)) {
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    }
  }
  define(Array.prototype, "at", function(index) {
    const len = this.length;
    const i = index < 0 ? len + index : index;
    return i >= 0 && i < len ? this[i] : void 0;
  });
  define(String.prototype, "at", function(index) {
    const len = this.length;
    const i = index < 0 ? len + index : index;
    return i >= 0 && i < len ? this[i] : void 0;
  });
  var rawHasOwnProperty = Object.prototype.hasOwnProperty;
  define(Object, "hasOwn", (obj, key) => rawHasOwnProperty.call(obj, key));
  define(
    Array.prototype,
    "findLastIndex",
    function(predicate) {
      for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return i;
      return -1;
    }
  );
  define(
    Array.prototype,
    "findLast",
    function(predicate) {
      for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return this[i];
      return void 0;
    }
  );
  define(String.prototype, "replaceAll", function(search, replacement) {
    return this.split(search).join(replacement);
  });

  // ../../../packages/kernel/src/abort.ts
  var AbortHandle = class {
    constructor() {
      __publicField(this, "signal");
      __publicField(this, "aborted", false);
      __publicField(this, "reason");
      __publicField(this, "listeners", /* @__PURE__ */ new Set());
      const self = this;
      this.signal = {
        get aborted() {
          return self.aborted;
        },
        get reason() {
          return self.reason;
        },
        addEventListener: (_type, listener) => {
          if (self.aborted) listener();
          else self.listeners.add(listener);
        },
        removeEventListener: (_type, listener) => {
          self.listeners.delete(listener);
        }
      };
    }
    get isAborted() {
      return this.aborted;
    }
    abort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason;
      for (const listener of [...this.listeners]) listener();
      this.listeners.clear();
    }
    /** Propagate aborts from an upstream (host) signal into this handle. */
    follow(upstream) {
      if (!upstream) return;
      if (upstream.aborted) {
        this.abort(upstream.reason);
        return;
      }
      upstream.addEventListener("abort", () => this.abort(upstream.reason), { once: true });
    }
  };

  // ../../../packages/kernel/src/errors.ts
  var TauError = class extends Error {
    constructor(code, message, cause) {
      super(message, cause === void 0 ? void 0 : { cause });
      __publicField(this, "code");
      this.name = "TauError";
      this.code = code;
    }
  };
  var HttpError = class extends TauError {
    constructor(status, bodyText) {
      super("http_error", `HTTP ${status}: ${bodyText.slice(0, 2e3)}`);
      __publicField(this, "status");
      __publicField(this, "bodyText");
      this.name = "HttpError";
      this.status = status;
      this.bodyText = bodyText;
    }
  };
  var SessionError = class extends Error {
    constructor(code, message, cause) {
      super(message, cause === void 0 ? void 0 : { cause });
      __publicField(this, "code");
      this.name = "SessionError";
      this.code = code;
    }
  };
  function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
  }

  // ../../../packages/kernel/src/messages.ts
  function emptyUsage() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
  }
  function messageText(message) {
    if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
    if (message.role === "user" || message.role === "custom") {
      if (typeof message.content === "string") return message.content;
      return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  function toolCallsOf(message) {
    return message.content.filter((block) => block.type === "toolCall");
  }

  // ../../../packages/kernel/src/sse.ts
  var DEFAULT_MAX_BUFFER_LENGTH = 4 * 1024 * 1024;
  var SseParser = class {
    constructor(options) {
      __publicField(this, "buffer", "");
      __publicField(this, "dataLines", []);
      __publicField(this, "eventName");
      __publicField(this, "maxBufferLength");
      this.maxBufferLength = options?.maxBufferLength ?? DEFAULT_MAX_BUFFER_LENGTH;
    }
    push(text) {
      this.buffer += text;
      const events = [];
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const event = this.handleLine(line);
        if (event) events.push(event);
        newlineIndex = this.buffer.indexOf("\n");
      }
      if (this.buffer.length > this.maxBufferLength) {
        throw new TauError("stream_error", `SSE line exceeded ${this.maxBufferLength} bytes without a newline`);
      }
      return events;
    }
    /** Emit any event still buffered when the stream ends without a trailing blank line. */
    flush() {
      const events = [];
      if (this.buffer.length > 0) {
        const event = this.handleLine(this.buffer.replace(/\r$/, ""));
        this.buffer = "";
        if (event) events.push(event);
      }
      const pending = this.dispatch();
      if (pending) events.push(pending);
      return events;
    }
    handleLine(line) {
      if (line === "") return this.dispatch();
      if (line.startsWith(":")) return void 0;
      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.dataLines.push(value);
      else if (field === "event") this.eventName = value;
      return void 0;
    }
    dispatch() {
      if (this.dataLines.length === 0 && this.eventName === void 0) return void 0;
      const event = { data: this.dataLines.join("\n") };
      if (this.eventName !== void 0) event.event = this.eventName;
      this.dataLines = [];
      this.eventName = void 0;
      return event;
    }
  };

  // ../../../packages/kernel/src/openai.ts
  var COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
  var COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
  var BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
  var BRANCH_SUMMARY_SUFFIX = `</summary>`;
  var OPENAI_COMPLETIONS_API = "openai-completions";
  function userContentToWire(content) {
    if (typeof content === "string") return content;
    return content.map(
      (block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
    );
  }
  function toolResultContentToWire(content) {
    return content.map((block) => block.type === "text" ? block.text : "[image omitted]").join("\n");
  }
  function toWireMessage(message) {
    switch (message.role) {
      case "user":
        return { role: "user", content: userContentToWire(message.content) };
      case "custom":
        return { role: "user", content: userContentToWire(message.content) };
      case "compactionSummary":
        return { role: "user", content: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX };
      case "branchSummary":
        return { role: "user", content: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX };
      case "assistant": {
        const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        const toolCalls = message.content.filter((block) => block.type === "toolCall");
        const wire = { role: "assistant", content: text === "" ? null : text };
        if (toolCalls.length > 0) {
          wire.tool_calls = toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }
          }));
        }
        return wire;
      }
      case "toolResult":
        return { role: "tool", tool_call_id: message.toolCallId, content: toolResultContentToWire(message.content) };
    }
  }
  function toWireMessages(systemPrompt, messages) {
    const wire = [];
    if (systemPrompt !== void 0 && systemPrompt !== "") {
      wire.push({ role: "system", content: systemPrompt });
    }
    for (const message of messages) wire.push(toWireMessage(message));
    return wire;
  }
  function toUsage(wire) {
    const input = wire.prompt_tokens ?? 0;
    const output = wire.completion_tokens ?? 0;
    return {
      input,
      output,
      cacheRead: wire.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
      totalTokens: wire.total_tokens ?? input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
  }
  function toStopReason(finishReason, hasToolCalls) {
    if (hasToolCalls) return "toolUse";
    switch (finishReason) {
      case "length":
        return "length";
      default:
        return "stop";
    }
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) throw new TauError("aborted", "Request aborted");
  }
  var DEFAULT_STALL_TIMEOUT_MS = 12e4;
  async function withStallTimeout(step, platform2, stallTimeoutMs, what) {
    const timeoutMs = stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const sleep = platform2.sleep;
    if (!sleep || timeoutMs <= 0) return step;
    const stallClock = new AbortHandle();
    const guarded = step.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
    const clock = sleep(timeoutMs, stallClock.signal).then(
      () => "timeout",
      () => "cancelled"
    );
    const winner = await Promise.race([guarded, clock]);
    if (winner === "timeout") {
      throw new TauError("timeout", `${what} timed out: no data for ${timeoutMs}ms`);
    }
    stallClock.abort();
    if (winner === "cancelled") {
      throw new TauError("timeout", `${what} stall clock cancelled unexpectedly`);
    }
    if (!winner.ok) throw winner.error;
    return winner.value;
  }
  async function* streamChatCompletion(platform2, config, messages, options) {
    throwIfAborted(options?.signal);
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: config.model,
      messages: toWireMessages(options?.systemPrompt, messages),
      stream: true,
      ...config.extraBody
    };
    if (config.includeUsage !== false) body.stream_options = { include_usage: true };
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
    }
    const headers = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    Object.assign(headers, config.headers);
    let response;
    try {
      response = await withStallTimeout(
        platform2.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal
        }),
        platform2,
        config.stallTimeoutMs,
        "Waiting for response headers"
      );
    } catch (cause) {
      throwIfAborted(options?.signal);
      if (cause instanceof TauError && cause.code === "timeout") throw cause;
      throw new TauError("network_error", `Network request failed: ${toError(cause).message}`, cause);
    }
    if (!response.ok) {
      throw new HttpError(response.status, await response.text());
    }
    if (!response.body) {
      throw new TauError("stream_error", "Response has no body stream");
    }
    const reader = response.body.getReader();
    const decoder = platform2.createUtf8Decoder();
    const parser = new SseParser();
    const blocks = [];
    const rawToolCalls = /* @__PURE__ */ new Map();
    let finishReason;
    let usage;
    const pendingEvents = [];
    let done = false;
    const appendText = (delta) => {
      const last = blocks.at(-1);
      if (last?.type === "text") last.text += delta;
      else blocks.push({ type: "text", text: delta });
    };
    const appendThinking = (delta) => {
      const last = blocks.at(-1);
      if (last?.type === "thinking") last.thinking += delta;
      else blocks.push({ type: "thinking", thinking: delta });
    };
    const processData = (data) => {
      if (data === "" || data === "[DONE]") {
        if (data === "[DONE]") done = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch (cause) {
        throw new TauError("invalid_response", `Failed to parse stream chunk: ${data.slice(0, 200)}`, cause);
      }
      if (chunk.error) {
        throw new TauError("stream_error", chunk.error.message ?? "Provider returned an error in the stream");
      }
      if (chunk.usage) usage = toUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content !== "") {
        appendText(delta.content);
        pendingEvents.push({ type: "text_delta", delta: delta.content });
      }
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningDelta === "string" && reasoningDelta !== "") {
        appendThinking(reasoningDelta);
        pendingEvents.push({ type: "reasoning_delta", delta: reasoningDelta });
      }
      for (const wireToolCall of delta.tool_calls ?? []) {
        const index = wireToolCall.index ?? 0;
        let entry = rawToolCalls.get(index);
        if (!entry) {
          entry = { id: "", name: "", argumentsText: "" };
          rawToolCalls.set(index, entry);
        }
        if (wireToolCall.id) entry.id = wireToolCall.id;
        if (wireToolCall.function?.name) entry.name += wireToolCall.function.name;
        if (wireToolCall.function?.arguments) entry.argumentsText += wireToolCall.function.arguments;
      }
    };
    try {
      while (!done) {
        throwIfAborted(options?.signal);
        let readResult;
        try {
          readResult = await withStallTimeout(reader.read(), platform2, config.stallTimeoutMs, "Response stream");
        } catch (cause) {
          throwIfAborted(options?.signal);
          if (cause instanceof TauError && cause.code === "timeout") throw cause;
          throw new TauError("stream_error", `Stream read failed: ${toError(cause).message}`, cause);
        }
        const { done: readerDone, value } = readResult;
        if (readerDone) break;
        if (!value) continue;
        for (const event of parser.push(decoder.decode(value))) {
          processData(event.data);
          if (done) break;
        }
        yield* pendingEvents.splice(0);
      }
      const tail = decoder.flush();
      if (!done && tail.length > 0) {
        for (const event of parser.push(tail)) processData(event.data);
      }
      if (!done) {
        for (const event of parser.flush()) processData(event.data);
      }
      yield* pendingEvents.splice(0);
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    const toolCalls = [...rawToolCalls.entries()].sort(([a], [b]) => a - b).filter(([, raw]) => raw.name !== "").map(([index, raw]) => {
      let parsedArguments = {};
      try {
        const parsed = raw.argumentsText === "" ? {} : JSON.parse(raw.argumentsText);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArguments = parsed;
        }
      } catch {
      }
      return {
        type: "toolCall",
        id: raw.id === "" ? `call_${index}` : raw.id,
        name: raw.name,
        arguments: parsedArguments
      };
    });
    for (const toolCall of toolCalls) {
      blocks.push(toolCall);
      yield { type: "tool_call", toolCall };
    }
    const message = {
      role: "assistant",
      content: blocks,
      api: OPENAI_COMPLETIONS_API,
      provider: config.provider ?? "openai-compat",
      model: config.model,
      usage: usage ?? emptyUsage(),
      stopReason: toStopReason(finishReason, toolCalls.length > 0),
      timestamp: Date.now()
    };
    yield { type: "response_end", message };
  }

  // ../../../packages/kernel/src/compaction.ts
  var DEFAULT_COMPACTION_SETTINGS = {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 2e4
  };
  function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  function getAssistantUsage(message) {
    if (message.role !== "assistant") return void 0;
    if (message.stopReason === "aborted" || message.stopReason === "error") return void 0;
    return calculateContextTokens(message.usage) > 0 ? message.usage : void 0;
  }
  var ESTIMATED_IMAGE_CHARS = 4800;
  function contentChars(content) {
    if (typeof content === "string") return content.length;
    let chars = 0;
    for (const block of content) {
      if (block.type === "text" && block.text) chars += block.text.length;
      else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
    }
    return chars;
  }
  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value) ?? "undefined";
    } catch {
      return "[unserializable]";
    }
  }
  function estimateTokens(message) {
    let chars = 0;
    switch (message.role) {
      case "user":
      case "custom":
      case "toolResult":
        chars = contentChars(message.content);
        break;
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text") chars += block.text.length;
          else if (block.type === "thinking") chars += block.thinking.length;
          else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
        }
        break;
      case "compactionSummary":
      case "branchSummary":
        chars = message.summary.length;
        break;
    }
    return Math.ceil(chars / 4);
  }
  function estimateContextTokens(messages) {
    let usageInfo;
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = getAssistantUsage(messages[i]);
      if (usage) {
        usageInfo = { usage, index: i };
        break;
      }
    }
    if (!usageInfo) {
      let estimated = 0;
      for (const message of messages) estimated += estimateTokens(message);
      return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
    }
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
  }
  function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
  }
  function entryMessage(entry) {
    if (entry.type === "message") return entry.message;
    if (entry.type === "branch_summary") {
      return {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: Date.parse(entry.timestamp) || 0
      };
    }
    if (entry.type === "custom_message") {
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: Date.parse(entry.timestamp) || 0
      };
    }
    return void 0;
  }
  function findValidCutPoints(entries, startIndex, endIndex) {
    const cutPoints = [];
    for (let i = startIndex; i < endIndex; i++) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message.role !== "toolResult") cutPoints.push(i);
      else if (entry.type === "custom_message" || entry.type === "branch_summary") cutPoints.push(i);
    }
    return cutPoints;
  }
  function findTurnStartIndex(entries, entryIndex, startIndex) {
    for (let i = entryIndex; i >= startIndex; i--) {
      const entry = entries[i];
      if (entry.type === "custom_message" || entry.type === "branch_summary") return i;
      if (entry.type === "message" && entry.message.role === "user") return i;
    }
    return -1;
  }
  function findCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
    const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
    if (cutPoints.length === 0) {
      return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    let accumulatedTokens = 0;
    let cutIndex = cutPoints[0];
    for (let i = endIndex - 1; i >= startIndex; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      accumulatedTokens += estimateTokens(entry.message);
      if (accumulatedTokens >= keepRecentTokens) {
        for (const candidate of cutPoints) {
          if (candidate >= i) {
            cutIndex = candidate;
            break;
          }
        }
        break;
      }
    }
    while (cutIndex > startIndex) {
      const prevEntry = entries[cutIndex - 1];
      if (prevEntry.type === "compaction" || prevEntry.type === "message") break;
      cutIndex--;
    }
    const cutEntry = entries[cutIndex];
    const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
    const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
    return {
      firstKeptEntryIndex: cutIndex,
      turnStartIndex,
      isSplitTurn: !isUserMessage && turnStartIndex !== -1
    };
  }
  var SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
  var SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
  var UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
  var TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
  var TOOL_RESULT_MAX_CHARS = 2e3;
  function truncateForSummary(text, maxChars) {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}

[... ${text.length - maxChars} more characters truncated]`;
  }
  function serializeConversation(messages) {
    const parts = [];
    for (const message of messages) {
      switch (message.role) {
        case "user":
        case "custom": {
          const content = messageText(message);
          if (content) parts.push(`[User]: ${content}`);
          break;
        }
        case "compactionSummary":
        case "branchSummary":
          parts.push(`[User]: ${message.summary}`);
          break;
        case "assistant": {
          const textParts = [];
          const thinkingParts = [];
          const toolCalls = [];
          for (const block of message.content) {
            if (block.type === "text") textParts.push(block.text);
            else if (block.type === "thinking") thinkingParts.push(block.thinking);
            else if (block.type === "toolCall") {
              const argsStr = Object.entries(block.arguments).map(([k, v]) => `${k}=${safeJsonStringify(v)}`).join(", ");
              toolCalls.push(`${block.name}(${argsStr})`);
            }
          }
          if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
          if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
          if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
          break;
        }
        case "toolResult": {
          const content = messageText(message);
          if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
          break;
        }
      }
    }
    return parts.join("\n\n");
  }
  function extractFileOpsFromMessage(message, fileOps) {
    if (message.role !== "assistant") return;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = typeof block.arguments.path === "string" ? block.arguments.path : void 0;
      if (!path) continue;
      if (block.name === "read") fileOps.read.add(path);
      else if (block.name === "write") fileOps.written.add(path);
      else if (block.name === "edit") fileOps.edited.add(path);
    }
  }
  function computeFileLists(fileOps) {
    const modified = /* @__PURE__ */ new Set([...fileOps.edited, ...fileOps.written]);
    const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
    return { readFiles, modifiedFiles: [...modified].sort() };
  }
  function formatFileOperations(readFiles, modifiedFiles) {
    const sections = [];
    if (readFiles.length > 0) sections.push(`<read-files>
${readFiles.join("\n")}
</read-files>`);
    if (modifiedFiles.length > 0) sections.push(`<modified-files>
${modifiedFiles.join("\n")}
</modified-files>`);
    return sections.length === 0 ? "" : `

${sections.join("\n\n")}`;
  }
  function prepareCompaction(pathEntries, settings, currentMessages) {
    if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
      return void 0;
    }
    let prevCompactionIndex = -1;
    for (let i = pathEntries.length - 1; i >= 0; i--) {
      if (pathEntries[i].type === "compaction") {
        prevCompactionIndex = i;
        break;
      }
    }
    let previousSummary;
    let boundaryStart = 0;
    if (prevCompactionIndex >= 0) {
      const prevCompaction = pathEntries[prevCompactionIndex];
      if (prevCompaction.type === "compaction") {
        previousSummary = prevCompaction.summary;
        const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
        boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
      }
    }
    const boundaryEnd = pathEntries.length;
    const tokensBefore = estimateContextTokens(currentMessages).tokens;
    const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
    const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
    if (!firstKeptEntry?.id) return void 0;
    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    const messagesToSummarize = [];
    for (let i = boundaryStart; i < historyEnd; i++) {
      const message = entryMessage(pathEntries[i]);
      if (message) messagesToSummarize.push(message);
    }
    const turnPrefixMessages = [];
    if (cutPoint.isSplitTurn) {
      for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
        const message = entryMessage(pathEntries[i]);
        if (message) turnPrefixMessages.push(message);
      }
    }
    const fileOps = { read: /* @__PURE__ */ new Set(), written: /* @__PURE__ */ new Set(), edited: /* @__PURE__ */ new Set() };
    for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
    for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);
    return {
      firstKeptEntryId: firstKeptEntry.id,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn: cutPoint.isSplitTurn,
      tokensBefore,
      previousSummary,
      fileOps,
      settings
    };
  }
  async function completeText(platform2, config, systemPrompt, promptText, maxTokens, signal) {
    const stream = streamChatCompletion(
      platform2,
      { ...config, extraBody: { ...config.extraBody, max_tokens: maxTokens } },
      [{ role: "user", content: promptText, timestamp: Date.now() }],
      { systemPrompt, signal }
    );
    let final;
    for await (const event of stream) {
      if (event.type === "response_end") final = event.message;
    }
    if (!final) throw new TauError("compaction_failed", "Summarization returned no message");
    return messageText(final);
  }
  async function generateSummary(platform2, config, messages, options) {
    const maxTokens = Math.floor(0.8 * options.reserveTokens);
    let basePrompt = options.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    if (options.customInstructions) {
      basePrompt = `${basePrompt}

Additional focus: ${options.customInstructions}`;
    }
    let promptText = `<conversation>
${serializeConversation(messages)}
</conversation>

`;
    if (options.previousSummary) {
      promptText += `<previous-summary>
${options.previousSummary}
</previous-summary>

`;
    }
    promptText += basePrompt;
    return completeText(platform2, config, SUMMARIZATION_SYSTEM_PROMPT, promptText, maxTokens, options.signal);
  }
  async function runCompaction(platform2, config, preparation, customInstructions, signal) {
    const { settings, previousSummary } = preparation;
    let summary;
    if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
      const historySummary = preparation.messagesToSummarize.length > 0 ? await generateSummary(platform2, config, preparation.messagesToSummarize, {
        reserveTokens: settings.reserveTokens,
        customInstructions,
        previousSummary,
        signal
      }) : "No prior history.";
      const prefixPrompt = `<conversation>
${serializeConversation(preparation.turnPrefixMessages)}
</conversation>

${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
      const turnPrefixSummary = await completeText(
        platform2,
        config,
        SUMMARIZATION_SYSTEM_PROMPT,
        prefixPrompt,
        Math.floor(0.5 * settings.reserveTokens),
        signal
      );
      summary = `${historySummary}

---

**Turn Context (split turn):**

${turnPrefixSummary}`;
    } else {
      summary = await generateSummary(platform2, config, preparation.messagesToSummarize, {
        reserveTokens: settings.reserveTokens,
        customInstructions,
        previousSummary,
        signal
      });
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { readFiles, modifiedFiles }
    };
  }

  // ../../../packages/kernel/src/branch.ts
  async function collectEntriesForBranchSummary(store, oldLeafId, targetId) {
    if (!oldLeafId) {
      return { entries: [], commonAncestorId: null };
    }
    const oldPath = new Set((await store.getPathToRoot(oldLeafId)).map((entry) => entry.id));
    const targetPath = await store.getPathToRoot(targetId);
    let commonAncestorId = null;
    for (let i = targetPath.length - 1; i >= 0; i--) {
      if (oldPath.has(targetPath[i].id)) {
        commonAncestorId = targetPath[i].id;
        break;
      }
    }
    const entries = [];
    let current = oldLeafId;
    while (current && current !== commonAncestorId) {
      const entry = await store.getEntry(current);
      if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
      entries.push(entry);
      current = entry.parentId;
    }
    entries.reverse();
    return { entries, commonAncestorId };
  }
  function getMessageFromEntry(entry) {
    switch (entry.type) {
      case "message":
        if (entry.message.role === "toolResult") return void 0;
        return entry.message;
      case "custom_message":
        return {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: Date.parse(entry.timestamp) || 0
        };
      case "branch_summary":
        return {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: Date.parse(entry.timestamp) || 0
        };
      case "compaction":
        return {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: Date.parse(entry.timestamp) || 0
        };
      case "custom":
      case "session_info":
      case "leaf":
        return void 0;
    }
  }
  function prepareBranchEntries(entries, tokenBudget = 0) {
    const messages = [];
    const fileOps = { read: /* @__PURE__ */ new Set(), written: /* @__PURE__ */ new Set(), edited: /* @__PURE__ */ new Set() };
    let totalTokens = 0;
    for (const entry of entries) {
      if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
        const details = entry.details;
        if (Array.isArray(details.readFiles)) {
          for (const file of details.readFiles) fileOps.read.add(file);
        }
        if (Array.isArray(details.modifiedFiles)) {
          for (const file of details.modifiedFiles) fileOps.edited.add(file);
        }
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const message = getMessageFromEntry(entry);
      if (!message) continue;
      extractFileOpsFromMessage(message, fileOps);
      const tokens = estimateTokens(message);
      if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
        if (entry.type === "compaction" || entry.type === "branch_summary") {
          if (totalTokens < tokenBudget * 0.9) {
            messages.unshift(message);
            totalTokens += tokens;
          }
        }
        break;
      }
      messages.unshift(message);
      totalTokens += tokens;
    }
    return { messages, fileOps, totalTokens };
  }
  var BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;
  var BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
  async function generateBranchSummary(platform2, config, entries, options) {
    const reserveTokens = options?.reserveTokens ?? 16384;
    const contextWindow = config.contextWindow || 128e3;
    const tokenBudget = contextWindow - reserveTokens;
    const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);
    if (messages.length === 0) {
      return { summary: "No content to summarize", readFiles: [], modifiedFiles: [] };
    }
    const conversationText = serializeConversation(messages);
    let instructions;
    if (options?.replaceInstructions && options.customInstructions) {
      instructions = options.customInstructions;
    } else if (options?.customInstructions) {
      instructions = `${BRANCH_SUMMARY_PROMPT}

Additional focus: ${options.customInstructions}`;
    } else {
      instructions = BRANCH_SUMMARY_PROMPT;
    }
    const promptText = `<conversation>
${conversationText}
</conversation>

${instructions}`;
    let summary = await completeText(platform2, config, SUMMARIZATION_SYSTEM_PROMPT, promptText, 2048, options?.signal);
    summary = BRANCH_SUMMARY_PREAMBLE + summary;
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return { summary: summary || "No summary generated", readFiles, modifiedFiles };
  }

  // ../../../packages/kernel/src/platform.ts
  function defaultPlatform() {
    const g = globalThis;
    const globalFetch = g.fetch;
    const GlobalTextDecoder = g.TextDecoder;
    if (typeof globalFetch !== "function") {
      throw new TauError(
        "platform_missing",
        "globalThis.fetch is not available. Provide a Platform with a fetch implementation (e.g. a wx.request or XHR adapter)."
      );
    }
    if (typeof GlobalTextDecoder !== "function") {
      throw new TauError(
        "platform_missing",
        "globalThis.TextDecoder is not available. Provide a Platform with a createUtf8Decoder implementation."
      );
    }
    const globalSetTimeout = g.setTimeout;
    const globalClearTimeout = g.clearTimeout;
    const GlobalAbortController = g.AbortController;
    const GlobalAbortSignal = g.AbortSignal;
    const bridgeSignal = (signal) => {
      if (!signal || !GlobalAbortController) return signal;
      if (GlobalAbortSignal && signal instanceof GlobalAbortSignal) return signal;
      const controller = new GlobalAbortController();
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      return controller.signal;
    };
    return {
      fetch: (url, init) => globalFetch(url, init && { ...init, signal: bridgeSignal(init.signal) }),
      createUtf8Decoder: () => {
        const decoder = new GlobalTextDecoder("utf-8");
        return {
          decode: (chunk) => decoder.decode(chunk, { stream: true }),
          flush: () => decoder.decode()
        };
      },
      // Mirrors pi's fillRandomBytes: crypto when present, Math.random fallback.
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        if (g.crypto?.getRandomValues) {
          g.crypto.getRandomValues(bytes);
          return bytes;
        }
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return bytes;
      },
      // Timers exist on every WinterTC host; omitted when absent so exotic hosts
      // simply run without retry/stall features instead of crashing.
      sleep: typeof globalSetTimeout === "function" ? (ms, signal) => new Promise((resolve, reject) => {
        let handle;
        const fail = () => {
          if (handle !== void 0) globalClearTimeout?.(handle);
          reject(new TauError("aborted", "Sleep aborted"));
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        handle = globalSetTimeout(() => {
          signal?.removeEventListener("abort", fail);
          resolve();
        }, ms);
        signal?.addEventListener("abort", fail, { once: true });
      }) : void 0
    };
  }

  // ../../../packages/kernel/src/retry.ts
  function buildProviderErrorPattern(patterns) {
    return new RegExp(patterns.join("|"), "i");
  }
  var NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing"
  ]);
  var RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
    "overloaded",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    "provider.?returned.?error",
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "timed? out",
    "timeout",
    "terminated",
    "websocket.?closed",
    "websocket.?error",
    "ended without",
    "stream ended before message_stop",
    "http2 request did not get a response",
    "retry delay",
    "you can retry your request",
    "try your request again",
    "please retry your request"
    // tau 追加:本内核自己的失败措辞(Network request failed / Stream read failed /
    // connection reset)已被上面的 network/connection 模式覆盖,无需新增。
  ]);
  var OVERFLOW_PATTERNS = [
    /prompt is too long/i,
    /request_too_large/i,
    /exceeds the context window/i,
    /exceeds (?:the )?(?:model'?s )?maximum context length/i,
    /input token count.*exceeds the maximum/i,
    /maximum prompt length is \d+/i,
    /reduce the length of the messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /context[_ ]length[_ ]exceeded/i,
    /too many tokens/i,
    /token limit exceeded/i
  ];
  var DEFAULT_RETRY_SETTINGS = { enabled: true, maxRetries: 3, baseDelayMs: 2e3 };
  function isContextOverflowError(message) {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    const text = message.errorMessage;
    return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
  }
  function isRetryableAssistantError(message) {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    if (isContextOverflowError(message)) return false;
    const errorMessage = message.errorMessage;
    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
  }

  // ../../../packages/kernel/src/session.ts
  function messagesFromPath(path) {
    let compactionIndex = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "compaction") {
        compactionIndex = i;
        break;
      }
    }
    let selected = path;
    let summaryMessage;
    if (compactionIndex >= 0) {
      const compaction = path[compactionIndex];
      if (compaction.type === "compaction") {
        summaryMessage = {
          role: "compactionSummary",
          summary: compaction.summary,
          tokensBefore: compaction.tokensBefore,
          timestamp: Date.parse(compaction.timestamp) || 0
        };
        let firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
        if (firstKeptIndex < 0) firstKeptIndex = compactionIndex + 1;
        selected = [...path.slice(firstKeptIndex, compactionIndex), ...path.slice(compactionIndex + 1)];
      }
    }
    const restored = collectMessages(selected);
    const name = lastSessionNameFromPath(path) ?? restored.name;
    if (summaryMessage) restored.messages.unshift(summaryMessage);
    return { messages: restored.messages, name };
  }
  function lastSessionNameFromPath(path) {
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      if (entry.type === "session_info") return entry.name;
    }
    return void 0;
  }
  function collectMessages(path) {
    const messages = [];
    let name;
    for (const entry of path) {
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          break;
        case "custom_message": {
          const message = {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp) || 0
          };
          messages.push(message);
          break;
        }
        case "session_info":
          name = entry.name;
          break;
        case "branch_summary":
          messages.push({
            role: "branchSummary",
            summary: entry.summary,
            fromId: entry.fromId,
            timestamp: Date.parse(entry.timestamp) || 0
          });
          break;
        case "custom":
        case "leaf":
        case "compaction":
          break;
      }
    }
    return { messages, name };
  }

  // ../../../packages/kernel/src/agent.ts
  var PendingMessageQueue = class {
    constructor(mode) {
      __publicField(this, "items", []);
      __publicField(this, "mode");
      this.mode = mode;
    }
    enqueue(message) {
      this.items.push(message);
    }
    hasItems() {
      return this.items.length > 0;
    }
    drain() {
      if (this.items.length === 0) return [];
      if (this.mode === "all") return this.items.splice(0);
      return this.items.splice(0, 1);
    }
    clear() {
      this.items.length = 0;
    }
  };
  var DEFAULT_MAX_TURNS = 50;
  var Agent = class _Agent {
    constructor(options) {
      __publicField(this, "messages", []);
      __publicField(this, "platform");
      __publicField(this, "config");
      __publicField(this, "systemPrompt");
      __publicField(this, "baseTools");
      __publicField(this, "extensions");
      __publicField(this, "ui");
      __publicField(this, "capabilities");
      __publicField(this, "maxTurnsPerPrompt");
      __publicField(this, "steeringQueue");
      __publicField(this, "followUpQueue");
      __publicField(this, "session");
      __publicField(this, "compactionSettings");
      __publicField(this, "retrySettings");
      /** Custom instructions of a requested compaction, or null when none is pending. */
      __publicField(this, "pendingCompaction", null);
      /** Custom messages held for the next run's context (sendMessage deliverAs:"nextTurn"). */
      __publicField(this, "pendingNextTurn", []);
      /** Serializes session writes triggered by sync extension actions. */
      __publicField(this, "pendingRecording", Promise.resolve());
      /** True while a prompt() generator is being consumed (guards navigateTo). */
      __publicField(this, "running", false);
      /**
       * True only while the LLM turn loop is in flight — pi's isStreaming. Hooks
       * that fire before the loop (input, before_agent_start) see false, so their
       * sendMessage lands immediately instead of being queued as steering.
       */
      __publicField(this, "looping", false);
      /** Abort handle of the run in flight; ctx.abort() fires it. */
      __publicField(this, "activeAbort");
      this.platform = options.platform ?? defaultPlatform();
      this.config = options.config;
      this.systemPrompt = options.systemPrompt;
      this.baseTools = [...options.tools ?? []];
      this.extensions = options.extensions;
      this.ui = options.ui;
      this.capabilities = { ...options.capabilities, platform: this.platform };
      if (options.initialMessages) this.messages.push(...options.initialMessages);
      this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
      this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
      this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
      this.session = options.session;
      this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
      this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options.retry };
      const session = options.session;
      options.extensions?.attachHostActions({
        sendMessage: (input, sendOptions) => {
          const message = {
            role: "custom",
            customType: input.customType,
            content: input.content,
            display: input.display ?? true,
            details: input.details,
            timestamp: Date.now()
          };
          if (sendOptions?.deliverAs === "nextTurn") {
            this.pendingNextTurn.push(message);
            return;
          }
          if (this.looping) {
            if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
            else this.steeringQueue.enqueue(message);
            return;
          }
          this.messages.push(message);
          if (session) this.pendingRecording = this.pendingRecording.then(() => session.recordMessage(message));
          if (sendOptions?.triggerTurn) this.extensions?.hostAction("resumeTurn")?.();
        },
        sendUserMessage: (content, sendOptions) => {
          if (this.looping) {
            const message = { role: "user", content, timestamp: Date.now() };
            if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
            else this.steeringQueue.enqueue(message);
            return;
          }
          const submit = this.extensions?.hostAction("submitPrompt");
          if (!submit) {
            throw new TauError("no_host", "sendUserMessage() while idle requires a host that provides submitPrompt");
          }
          submit(content);
        },
        appendEntry: (customType, data) => {
          if (session) this.pendingRecording = this.pendingRecording.then(() => session.appendCustom(customType, data));
        },
        setSessionName: (name) => {
          if (session) this.pendingRecording = this.pendingRecording.then(() => session.setName(name));
          void this.extensions?.notifySessionInfoChanged(name, this.extensionContext());
        },
        abort: () => {
          this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
        }
      });
    }
    currentTools() {
      const tools = new Map(this.baseTools.map((tool) => [tool.name, tool]));
      for (const [name, tool] of this.extensions?.tools ?? []) tools.set(name, tool);
      return tools;
    }
    /** Persist a message, after any queued extension-triggered writes. */
    async recordMessage(message) {
      if (!this.session) return;
      await this.pendingRecording;
      await this.session.recordMessage(message);
    }
    /** Fire message_start/message_end for a non-streamed message, then store and persist it. */
    async commitMessage(message, ctx) {
      let final = message;
      if (this.extensions) {
        await this.extensions.notifyMessageStart(final, ctx);
        final = await this.extensions.runMessageEnd(final, ctx);
      }
      this.messages.push(final);
      await this.recordMessage(final);
      return final;
    }
    /** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
    extensionContext() {
      return {
        ui: this.ui,
        messages: this.messages,
        capabilities: this.capabilities,
        getContextUsage: () => this.getContextUsage(),
        compact: (customInstructions) => {
          this.pendingCompaction = customInstructions ?? "";
        },
        runSubagent: (prompt, options, signal) => this.runSubagent(prompt, options, signal),
        abort: () => {
          const hostAbort = this.extensions?.hostAction("abort");
          if (hostAbort) hostAbort();
          else this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
        },
        discoverResources: (reason) => {
          const cwd = this.capabilities.paths?.cwd ?? this.capabilities.fs?.cwd ?? "";
          return this.extensions?.runResourcesDiscover(cwd, reason, this.extensionContext()) ?? Promise.resolve({ skillPaths: [], promptPaths: [], themePaths: [] });
        }
      };
    }
    setUi(ui) {
      this.ui = ui;
    }
    async runSubagent(prompt, options = {}, signal) {
      const child = new _Agent({
        config: this.config,
        platform: this.platform,
        systemPrompt: options.systemPrompt ?? this.systemPrompt,
        tools: options.tools ?? this.baseTools,
        ui: this.ui,
        capabilities: this.capabilities,
        initialMessages: options.initialMessages,
        maxTurnsPerPrompt: options.maxTurnsPerPrompt ?? this.maxTurnsPerPrompt,
        steeringMode: this.steeringQueue.mode,
        followUpMode: this.followUpQueue.mode,
        compaction: this.compactionSettings
      });
      let text = "";
      let lastAssistantText = "";
      for await (const event of child.prompt(prompt, signal)) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "assistant_message") lastAssistantText = messageText(event.message);
      }
      return { text: text === "" ? lastAssistantText : text, messages: [...child.messages] };
    }
    /** Current context-token estimate (pi semantics: last assistant usage + trailing heuristic). */
    getContextUsage() {
      return { ...estimateContextTokens(this.messages), contextWindow: this.config.contextWindow };
    }
    /**
     * Compact the conversation now: summarize old history (session_before_compact
     * may cancel or take over), record a compaction entry when a session is
     * attached, and rewrite messages to [summary, ...kept].
     */
    async compact(customInstructions, reason = "manual", signal) {
      const ctx = this.extensionContext();
      let pathEntries;
      if (this.session) {
        await this.pendingRecording;
        pathEntries = await this.session.store.getPathToRoot(await this.session.store.getLeafId());
      } else {
        pathEntries = this.messages.map((message, i) => ({
          type: "message",
          id: String(i + 1),
          parentId: i === 0 ? null : String(i),
          timestamp: "",
          message
        }));
      }
      const preparation = prepareCompaction(pathEntries, this.compactionSettings, this.messages);
      if (!preparation) return void 0;
      const decision = this.extensions ? await this.extensions.runSessionBeforeCompact({ preparation, customInstructions, reason }, ctx) : {};
      if (decision.cancel) return void 0;
      const fromExtension = decision.result !== void 0;
      const result = decision.result ?? await runCompaction(this.platform, this.config, preparation, customInstructions, signal);
      if (this.session) {
        await this.session.recordCompaction({ ...result, fromHook: fromExtension || void 0 });
        const path = await this.session.store.getPathToRoot(await this.session.store.getLeafId());
        this.messages.length = 0;
        this.messages.push(...messagesFromPath(path).messages);
      } else {
        const keptStart = Number(result.firstKeptEntryId) - 1;
        const kept = Number.isInteger(keptStart) && keptStart >= 0 ? this.messages.slice(keptStart) : [];
        this.messages.length = 0;
        this.messages.push(
          {
            role: "compactionSummary",
            summary: result.summary,
            tokensBefore: result.tokensBefore,
            timestamp: Date.now()
          },
          ...kept
        );
      }
      await this.extensions?.notifySessionCompact({ result, fromExtension, reason }, ctx);
      return result;
    }
    /** Queue a message consumed after the current turn's tools, before the next LLM call. */
    steer(text) {
      this.steeringQueue.enqueue({ role: "user", content: text, timestamp: Date.now() });
    }
    /** Queue a message consumed when the prompt would otherwise end; the loop then continues. */
    followUp(text) {
      this.followUpQueue.enqueue({ role: "user", content: text, timestamp: Date.now() });
    }
    hasQueuedMessages() {
      return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
    }
    clearSteeringQueue() {
      this.steeringQueue.clear();
    }
    clearFollowUpQueue() {
      this.followUpQueue.clear();
    }
    async *prompt(input, signal) {
      if (this.running) throw new TauError("busy", "prompt() is already running");
      this.running = true;
      const handle = new AbortHandle();
      handle.follow(signal);
      this.activeAbort = handle;
      try {
        yield* this.runPrompt(input, handle.signal);
      } finally {
        this.running = false;
        this.activeAbort = void 0;
      }
    }
    /**
     * Run the agent loop without committing new user input — the continuation
     * behind sendMessage({triggerTurn:true}) while idle (pi's _runAgentPrompt
     * for app messages). The conversation must already end in something the
     * model should answer (a user/custom message).
     */
    async *resume(signal) {
      if (this.running) throw new TauError("busy", "resume() requires an idle agent");
      this.running = true;
      const handle = new AbortHandle();
      handle.follow(signal);
      this.activeAbort = handle;
      try {
        const ctx = this.extensionContext();
        await this.extensions?.notifyAgentStart(ctx);
        yield* this.runLoop(ctx, this.systemPrompt ?? "", handle.signal);
      } finally {
        this.running = false;
        this.activeAbort = void 0;
      }
    }
    /**
     * Navigate the session tree to another entry (pi's navigateTree): summarize
     * the branch being abandoned (unless summarize: false or an extension
     * supplies/cancels via session_before_tree), move the leaf, record a
     * branch_summary entry at the new position, and rebuild the conversation
     * from the new path. Deviation from pi: tau moves the leaf to the target
     * entry itself — pi moves to a user-message target's parent and refills the
     * editor with its text, an interaction that needs a TUI (P8).
     */
    async navigateTo(entryId, options) {
      if (!this.session) throw new TauError("no_session", "navigateTo() requires a session");
      if (this.running) throw new TauError("busy", "navigateTo() requires an idle agent");
      await this.pendingRecording;
      const store = this.session.store;
      const oldLeafId = await store.getLeafId();
      if (oldLeafId === entryId) return { cancelled: false };
      const targetEntry = await store.getEntry(entryId);
      if (!targetEntry) throw new SessionError("not_found", `Entry ${entryId} not found`);
      const ctx = this.extensionContext();
      const { entries, commonAncestorId } = await collectEntriesForBranchSummary(store, oldLeafId, entryId);
      const preparation = {
        targetId: entryId,
        oldLeafId,
        commonAncestorId,
        entriesToSummarize: entries,
        customInstructions: options?.customInstructions
      };
      const hook = this.extensions ? await this.extensions.runSessionBeforeTree({ preparation, signal: options?.signal }, ctx) : {};
      if (hook.cancel) return { cancelled: true };
      let summaryText = hook.summary?.summary;
      let summaryDetails = hook.summary?.details;
      if (!summaryText && options?.summarize !== false && entries.length > 0) {
        try {
          const generated = await generateBranchSummary(this.platform, this.config, entries, {
            customInstructions: hook.customInstructions ?? options?.customInstructions,
            signal: options?.signal
          });
          summaryText = generated.summary;
          summaryDetails = { readFiles: generated.readFiles, modifiedFiles: generated.modifiedFiles };
        } catch (error) {
          if (error instanceof TauError && error.code === "aborted") return { cancelled: true };
          throw error;
        }
      }
      const fromExtension = hook.summary !== void 0;
      const summaryEntry = await this.session.moveTo(
        entryId,
        summaryText ? { summary: summaryText, details: summaryDetails, fromHook: fromExtension || void 0 } : void 0
      );
      const newLeafId = await store.getLeafId();
      const path = await store.getPathToRoot(newLeafId);
      this.messages.length = 0;
      this.messages.push(...messagesFromPath(path).messages);
      await this.extensions?.notifySessionTree({ newLeafId, oldLeafId, summaryEntry, fromExtension }, ctx);
      return { cancelled: false };
    }
    async *runPrompt(input, signal) {
      const ctx = this.extensionContext();
      let finalInput = input;
      if (this.extensions) {
        const inputResult = await this.extensions.runInput(input, ctx);
        if (inputResult.handled) {
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        finalInput = inputResult.text;
      }
      let systemPrompt = this.systemPrompt ?? "";
      if (this.extensions) {
        const beforeStart = await this.extensions.runBeforeAgentStart(finalInput, systemPrompt, ctx);
        systemPrompt = beforeStart.systemPrompt;
        for (const injected of beforeStart.messages) {
          await this.commitMessage(
            {
              role: "custom",
              customType: injected.customType,
              content: injected.content,
              display: injected.display ?? true,
              details: injected.details,
              timestamp: Date.now()
            },
            ctx
          );
        }
      }
      await this.commitMessage({ role: "user", content: finalInput, timestamp: Date.now() }, ctx);
      await this.extensions?.notifyAgentStart(ctx);
      yield* this.runLoop(ctx, systemPrompt, signal);
    }
    /** The turn loop shared by prompt() and resume(). */
    async *runLoop(ctx, systemPrompt, signal) {
      for (const held of this.pendingNextTurn.splice(0)) {
        await this.commitMessage(held, ctx);
      }
      this.looping = true;
      try {
        yield* this.runTurns(ctx, systemPrompt, signal);
      } finally {
        this.looping = false;
      }
    }
    async *runTurns(ctx, systemPrompt, signal) {
      let retryAttempt = 0;
      for (let turnIndex = 0; turnIndex < this.maxTurnsPerPrompt; turnIndex++) {
        if (signal?.aborted) {
          await this.pendingRecording;
          await this.extensions?.notifyAgentEnd(this.messages, ctx);
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        await this.extensions?.notifyTurnStart(turnIndex, ctx);
        if (this.pendingCompaction !== null) {
          const customInstructions = this.pendingCompaction;
          this.pendingCompaction = null;
          const result = await this.compact(customInstructions === "" ? void 0 : customInstructions, "manual", signal);
          if (result) yield { type: "compaction", result };
        } else if (this.config.contextWindow !== void 0 && shouldCompact(estimateContextTokens(this.messages).tokens, this.config.contextWindow, this.compactionSettings)) {
          const result = await this.compact(void 0, "threshold", signal);
          if (result) yield { type: "compaction", result };
        }
        let request = [...this.messages];
        if (this.extensions) {
          request = await this.extensions.runContext(request, ctx);
        }
        const partial = {
          role: "assistant",
          content: [],
          api: OPENAI_COMPLETIONS_API,
          provider: this.config.provider ?? "openai-compat",
          model: this.config.model,
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: Date.now()
        };
        await this.extensions?.notifyMessageStart(partial, ctx);
        let assistantMessage;
        let streamFailure;
        const tools = this.currentTools();
        const stream = streamChatCompletion(this.platform, this.config, request, {
          systemPrompt: systemPrompt === "" ? void 0 : systemPrompt,
          tools: tools.size > 0 ? [...tools.values()] : void 0,
          signal
        });
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          let iteration;
          try {
            iteration = await iterator.next();
          } catch (error) {
            streamFailure = error instanceof TauError ? error : new TauError("stream_error", toError(error).message, error);
            break;
          }
          if (iteration.done) break;
          const event = iteration.value;
          switch (event.type) {
            case "text_delta": {
              const last = partial.content.at(-1);
              if (last?.type === "text") last.text += event.delta;
              else partial.content.push({ type: "text", text: event.delta });
              await this.extensions?.notifyMessageUpdate(partial, event, ctx);
              yield { type: "text_delta", delta: event.delta };
              break;
            }
            case "reasoning_delta": {
              const last = partial.content.at(-1);
              if (last?.type === "thinking") last.thinking += event.delta;
              else partial.content.push({ type: "thinking", thinking: event.delta });
              await this.extensions?.notifyMessageUpdate(partial, event, ctx);
              yield { type: "reasoning_delta", delta: event.delta };
              break;
            }
            case "tool_call":
              partial.content.push(event.toolCall);
              await this.extensions?.notifyMessageUpdate(partial, event, ctx);
              break;
            case "response_end":
              assistantMessage = event.message;
              break;
          }
        }
        if (streamFailure) {
          partial.stopReason = streamFailure.code === "aborted" ? "aborted" : "error";
          partial.errorMessage = streamFailure.message;
          partial.timestamp = Date.now();
          let finalMessage = partial;
          if (this.extensions) {
            finalMessage = await this.extensions.runMessageEnd(finalMessage, ctx);
          }
          this.messages.push(finalMessage);
          await this.recordMessage(finalMessage);
          yield { type: "assistant_message", message: finalMessage };
          await this.extensions?.notifyTurnEnd(turnIndex, finalMessage, [], ctx);
          const retryEligible = finalMessage.stopReason === "error" && this.retrySettings.enabled && this.platform.sleep !== void 0 && isRetryableAssistantError(finalMessage);
          if (retryEligible && retryAttempt < this.retrySettings.maxRetries) {
            retryAttempt++;
            const delayMs = this.retrySettings.baseDelayMs * 2 ** (retryAttempt - 1);
            const startEvent = {
              attempt: retryAttempt,
              maxAttempts: this.retrySettings.maxRetries,
              delayMs,
              errorMessage: finalMessage.errorMessage ?? "Unknown error"
            };
            await this.extensions?.notifyAutoRetryStart(startEvent, ctx);
            yield { type: "auto_retry_start", ...startEvent };
            if (this.messages.at(-1) === finalMessage) this.messages.pop();
            try {
              await this.platform.sleep?.(delayMs, signal);
            } catch {
              const endEvent = { success: false, attempt: retryAttempt, finalError: "Retry cancelled" };
              await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
              yield { type: "auto_retry_end", ...endEvent };
              await this.pendingRecording;
              await this.extensions?.notifyAgentEnd(this.messages, ctx);
              yield { type: "agent_end", messages: this.messages };
              return;
            }
            turnIndex--;
            continue;
          }
          if (finalMessage.stopReason === "error" && retryAttempt > 0) {
            const endEvent = { success: false, attempt: retryAttempt, finalError: finalMessage.errorMessage };
            await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
            yield { type: "auto_retry_end", ...endEvent };
          }
          await this.pendingRecording;
          await this.extensions?.notifyAgentEnd(this.messages, ctx);
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        if (!assistantMessage) {
          throw new TauError("stream_error", "Stream ended without a final message");
        }
        if (this.extensions) {
          assistantMessage = await this.extensions.runMessageEnd(assistantMessage, ctx);
        }
        this.messages.push(assistantMessage);
        await this.recordMessage(assistantMessage);
        yield { type: "assistant_message", message: assistantMessage };
        if (retryAttempt > 0) {
          const endEvent = { success: true, attempt: retryAttempt };
          await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
          yield { type: "auto_retry_end", ...endEvent };
          retryAttempt = 0;
        }
        const toolCalls = toolCallsOf(assistantMessage);
        const toolResults = [];
        for (const toolCall of toolCalls) {
          yield { type: "tool_start", toolCall };
          const updates = [];
          let wakeUpdate;
          let executionDone = false;
          const execution = this.executeToolCall(toolCall, ctx, signal, (update) => {
            updates.push(update);
            wakeUpdate?.();
            wakeUpdate = void 0;
          });
          execution.then(
            () => {
              executionDone = true;
              wakeUpdate?.();
              wakeUpdate = void 0;
            },
            () => {
              executionDone = true;
              wakeUpdate?.();
              wakeUpdate = void 0;
            }
          );
          while (!executionDone || updates.length > 0) {
            const update = updates.shift();
            if (update) {
              yield { type: "tool_update", toolCall, partialOutput: update.partialOutput, stream: update.stream };
              continue;
            }
            await new Promise((resolve) => {
              wakeUpdate = resolve;
            });
          }
          const { result } = await execution;
          const toolResultMessage = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: result.output }],
            isError: result.isError === true,
            timestamp: Date.now()
          };
          const committedToolResult = await this.commitMessage(toolResultMessage, ctx);
          toolResults.push(committedToolResult);
          yield { type: "tool_result", toolCall, result };
        }
        for (const steered of this.steeringQueue.drain()) {
          const committed = await this.commitMessage(steered, ctx);
          yield { type: "user_message", message: committed };
        }
        await this.extensions?.notifyTurnEnd(turnIndex, assistantMessage, toolResults, ctx);
        const hasPendingWork = toolCalls.length > 0 || this.messages.at(-1)?.role === "user";
        if (!hasPendingWork) {
          const followUps = this.followUpQueue.drain();
          if (followUps.length > 0) {
            for (const followUp of followUps) {
              const committed = await this.commitMessage(followUp, ctx);
              yield { type: "user_message", message: committed };
            }
            continue;
          }
          await this.pendingRecording;
          await this.extensions?.notifyAgentEnd(this.messages, ctx);
          yield { type: "agent_end", messages: this.messages };
          return;
        }
      }
      throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
    }
    async executeToolCall(toolCall, ctx, signal, onUpdate) {
      const tool = this.currentTools().get(toolCall.name);
      if (!tool) {
        return { result: { output: `Unknown tool: ${toolCall.name}`, isError: true } };
      }
      let args = { ...toolCall.arguments };
      if (this.extensions) {
        const event = {
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args
        };
        const decision = await this.extensions.runToolCall(event, ctx);
        if (decision.blocked) {
          return {
            result: { output: `Tool call blocked: ${decision.reason ?? "blocked by extension"}`, isError: true }
          };
        }
        args = event.input;
      }
      await this.extensions?.notifyToolExecutionStart({ toolCallId: toolCall.id, toolName: toolCall.name, args }, ctx);
      const updateNotifications = [];
      const emitUpdate = (partialOutput, stream) => {
        if (this.extensions) {
          const notification = this.extensions.notifyToolExecutionUpdate(
            { toolCallId: toolCall.id, toolName: toolCall.name, args, partialOutput, stream },
            ctx
          ).then(() => {
            onUpdate?.({ partialOutput, stream });
          });
          updateNotifications.push(notification);
        } else {
          onUpdate?.({ partialOutput, stream });
        }
      };
      let result;
      try {
        result = await tool.execute(args, signal, emitUpdate, ctx);
      } catch (cause) {
        result = { output: cause instanceof Error ? cause.message : String(cause), isError: true };
      }
      await Promise.all(updateNotifications);
      await this.extensions?.notifyToolExecutionEnd({ toolCallId: toolCall.id, toolName: toolCall.name, result }, ctx);
      if (this.extensions) {
        const finalResult = await this.extensions.runToolResult(
          {
            type: "tool_result",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: args,
            output: result.output,
            isError: result.isError === true
          },
          ctx
        );
        result = { output: finalResult.output, isError: finalResult.isError };
      }
      return { result };
    }
  };

  // ../../../packages/kernel/src/extensions.ts
  var ExtensionRegistry = class _ExtensionRegistry {
    constructor() {
      __publicField(this, "tools", /* @__PURE__ */ new Map());
      __publicField(this, "commands", /* @__PURE__ */ new Map());
      __publicField(this, "shortcuts", /* @__PURE__ */ new Map());
      __publicField(this, "messageRenderers", /* @__PURE__ */ new Map());
      __publicField(this, "entryRenderers", /* @__PURE__ */ new Map());
      __publicField(this, "toolRenderers", /* @__PURE__ */ new Map());
      __publicField(this, "widgets", /* @__PURE__ */ new Map());
      __publicField(this, "headerItems", /* @__PURE__ */ new Map());
      __publicField(this, "footerItems", /* @__PURE__ */ new Map());
      __publicField(this, "diagnostics", /* @__PURE__ */ new Map());
      __publicField(this, "flags", /* @__PURE__ */ new Map());
      __publicField(this, "flagValues", /* @__PURE__ */ new Map());
      __publicField(this, "hostActions");
      __publicField(this, "handlers", {
        agent_start: [],
        agent_end: [],
        turn_start: [],
        turn_end: [],
        input: [],
        context: [],
        before_agent_start: [],
        message_start: [],
        message_update: [],
        message_end: [],
        tool_call: [],
        tool_execution_start: [],
        tool_execution_update: [],
        tool_execution_end: [],
        tool_result: [],
        user_bash: [],
        model_select: [],
        thinking_level_select: [],
        project_trust: [],
        resources_discover: [],
        session_start: [],
        session_shutdown: [],
        session_info_changed: [],
        session_before_compact: [],
        session_compact: [],
        session_before_fork: [],
        session_before_tree: [],
        session_tree: [],
        session_before_switch: [],
        auto_retry_start: [],
        auto_retry_end: []
      });
    }
    static async load(extensions) {
      const registry = new _ExtensionRegistry();
      await registry.add(extensions);
      return registry;
    }
    /** Run additional extensions' setup against this registry (e.g. project extensions after a trust decision). */
    async add(extensions) {
      const on = (event, handler) => {
        this.handlers[event].push(handler);
      };
      const api = {
        on,
        registerTool: (tool) => {
          this.tools.set(tool.name, tool);
        },
        registerCommand: (name, options) => {
          this.commands.set(name, { name, ...options });
        },
        registerShortcut: (name, options) => {
          this.shortcuts.set(name, { name, ...options });
        },
        registerMessageRenderer: (name, options) => {
          this.messageRenderers.set(name, { name, ...options });
        },
        registerEntryRenderer: (name, options) => {
          this.entryRenderers.set(name, { name, ...options });
        },
        registerToolRenderer: (name, options) => {
          this.toolRenderers.set(name, { name, ...options });
        },
        registerWidget: (name, options) => {
          this.widgets.set(name, { name, ...options });
        },
        registerHeaderItem: (name, options) => {
          this.headerItems.set(name, { name, ...options });
        },
        registerFooterItem: (name, options) => {
          this.footerItems.set(name, { name, ...options });
        },
        registerDiagnostic: (name, options) => {
          this.diagnostics.set(name, { name, ...options });
        },
        registerFlag: (name, options) => {
          this.flags.set(name, { name, ...options });
        },
        getFlag: (name) => this.getFlag(name),
        sendMessage: (message, options) => this.requireHostActions("sendMessage")(message, options),
        sendUserMessage: (content, options) => this.requireHostActions("sendUserMessage")(content, options),
        appendEntry: (customType, data) => this.requireHostActions("appendEntry")(customType, data),
        setSessionName: (name) => this.requireHostActions("setSessionName")(name)
      };
      for (const extension of extensions) {
        await extension(api);
      }
    }
    /**
     * Back the extension action methods. Merges: the Agent attaches the core
     * actions on construction, and the host may attach more (submitPrompt,
     * resumeTurn, abort) before or after — later attachments override same-name
     * actions without clobbering the rest.
     */
    attachHostActions(actions) {
      this.hostActions = { ...this.hostActions, ...actions };
    }
    /** Look up a host action if any host attached it (Agent-internal helper). */
    hostAction(name) {
      return this.hostActions?.[name];
    }
    requireHostActions(action) {
      const found = this.hostActions?.[action];
      if (!found) {
        throw new TauError("no_host", `${String(action)}() requires a host that provides this action`);
      }
      return found;
    }
    /** Host-side: supply parsed CLI flag values. Unknown names are ignored (host validates). */
    setFlagValues(values) {
      for (const [name, value] of Object.entries(values)) this.flagValues.set(name, value);
    }
    getFlag(name) {
      return this.flagValues.get(name) ?? this.flags.get(name)?.default;
    }
    /** Run input handlers. Transforms chain; "handled" short-circuits. */
    async runInput(text, ctx) {
      let current = text;
      for (const handler of this.handlers.input) {
        const result = await handler({ type: "input", text: current }, ctx);
        if (!result || result.action === "continue") continue;
        if (result.action === "handled") return { handled: true, text: current };
        current = result.text;
      }
      return { handled: false, text: current };
    }
    /** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits. */
    async runToolCall(event, ctx) {
      for (const handler of this.handlers.tool_call) {
        const result = await handler(event, ctx);
        if (result?.block) return { blocked: true, reason: result.reason };
      }
      return { blocked: false };
    }
    /** Run tool_result handlers. Partial overrides chain onto the event. */
    async runToolResult(event, ctx) {
      for (const handler of this.handlers.tool_result) {
        const result = await handler(event, ctx);
        if (!result) continue;
        if (result.output !== void 0) event.output = result.output;
        if (result.isError !== void 0) event.isError = result.isError;
      }
      return { output: event.output, isError: event.isError };
    }
    /** Run user_bash handlers. Rewrites chain; cancel short-circuits. */
    async runUserBash(event, ctx) {
      const current = { type: "user_bash", ...event };
      for (const handler of this.handlers.user_bash) {
        const result = await handler(current, ctx);
        if (!result) continue;
        if (result.cancel)
          return {
            cancel: true,
            reason: result.reason,
            command: current.command,
            recordInContext: current.recordInContext
          };
        if (result.command !== void 0) current.command = result.command;
        if (result.recordInContext !== void 0) current.recordInContext = result.recordInContext;
      }
      return { command: current.command, recordInContext: current.recordInContext };
    }
    /** Run model_select before handlers. Rewrites chain; cancel short-circuits. */
    async runModelSelectBefore(event, ctx) {
      const current = {
        type: "model_select",
        phase: "before",
        currentModel: event.currentModel,
        requestedModel: event.requestedModel,
        selectedModel: event.requestedModel
      };
      for (const handler of this.handlers.model_select) {
        const result = await handler(current, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true, reason: result.reason, model: current.selectedModel };
        if (result.model !== void 0) current.selectedModel = result.model;
      }
      return { model: current.selectedModel };
    }
    async notifyModelSelected(event, ctx) {
      for (const handler of this.handlers.model_select) {
        await handler(
          {
            type: "model_select",
            phase: "after",
            currentModel: event.previousModel,
            requestedModel: event.requestedModel,
            selectedModel: event.selectedModel
          },
          ctx
        );
      }
    }
    /** Run thinking_level_select before handlers. Rewrites chain; cancel short-circuits. */
    async runThinkingLevelSelectBefore(event, ctx) {
      const current = {
        type: "thinking_level_select",
        phase: "before",
        currentLevel: event.currentLevel,
        requestedLevel: event.requestedLevel,
        selectedLevel: event.requestedLevel
      };
      for (const handler of this.handlers.thinking_level_select) {
        const result = await handler(current, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true, reason: result.reason, level: current.selectedLevel };
        if (result.level !== void 0) current.selectedLevel = result.level;
      }
      return { level: current.selectedLevel };
    }
    async notifyThinkingLevelSelected(event, ctx) {
      for (const handler of this.handlers.thinking_level_select) {
        await handler(
          {
            type: "thinking_level_select",
            phase: "after",
            currentLevel: event.previousLevel,
            requestedLevel: event.requestedLevel,
            selectedLevel: event.selectedLevel
          },
          ctx
        );
      }
    }
    /** Run context handlers. Replacements chain: each handler sees the previous replacement. */
    async runContext(messages, ctx) {
      let current = messages;
      for (const handler of this.handlers.context) {
        const result = await handler({ type: "context", messages: current }, ctx);
        if (result?.messages) current = result.messages;
      }
      return current;
    }
    /** Run before_agent_start handlers. systemPrompt replacements chain; injected messages accumulate. */
    async runBeforeAgentStart(prompt, systemPrompt, ctx) {
      let current = systemPrompt;
      const messages = [];
      for (const handler of this.handlers.before_agent_start) {
        const result = await handler({ type: "before_agent_start", prompt, systemPrompt: current }, ctx);
        if (result?.systemPrompt !== void 0) current = result.systemPrompt;
        if (result?.message) messages.push(result.message);
      }
      return { systemPrompt: current, messages };
    }
    async notifyMessageStart(message, ctx) {
      for (const handler of this.handlers.message_start) await handler({ type: "message_start", message }, ctx);
    }
    async notifyMessageUpdate(message, event, ctx) {
      for (const handler of this.handlers.message_update) {
        await handler({ type: "message_update", message, event }, ctx);
      }
    }
    /** Run message_end handlers. Replacements chain; a replacement changing the role is ignored. */
    async runMessageEnd(message, ctx) {
      let current = message;
      for (const handler of this.handlers.message_end) {
        const result = await handler({ type: "message_end", message: current }, ctx);
        if (result?.message && result.message.role === current.role) current = result.message;
      }
      return current;
    }
    async notifyToolExecutionStart(event, ctx) {
      for (const handler of this.handlers.tool_execution_start) {
        await handler({ type: "tool_execution_start", ...event }, ctx);
      }
    }
    async notifyToolExecutionUpdate(event, ctx) {
      for (const handler of this.handlers.tool_execution_update) {
        await handler({ type: "tool_execution_update", ...event }, ctx);
      }
    }
    async notifyToolExecutionEnd(event, ctx) {
      for (const handler of this.handlers.tool_execution_end) {
        await handler({ type: "tool_execution_end", ...event }, ctx);
      }
    }
    /** Run project_trust handlers. The first decisive answer (yes/no) wins. */
    async runProjectTrust(cwd, ctx) {
      for (const handler of this.handlers.project_trust) {
        const result = await handler({ type: "project_trust", cwd }, ctx);
        if (result && result.trusted !== "undecided") return result;
      }
      return { trusted: "undecided" };
    }
    async runResourcesDiscover(cwd, reason, ctx) {
      const discovered = { skillPaths: [], promptPaths: [], themePaths: [] };
      for (const handler of this.handlers.resources_discover) {
        const result = await handler({ type: "resources_discover", cwd, reason }, ctx);
        if (!result) continue;
        if (result.skillPaths) discovered.skillPaths.push(...result.skillPaths);
        if (result.promptPaths) discovered.promptPaths.push(...result.promptPaths);
        if (result.themePaths) discovered.themePaths.push(...result.themePaths);
      }
      return discovered;
    }
    async notifySessionStart(reason, ctx) {
      for (const handler of this.handlers.session_start) await handler({ type: "session_start", reason }, ctx);
    }
    async notifySessionShutdown(reason, ctx) {
      for (const handler of this.handlers.session_shutdown) await handler({ type: "session_shutdown", reason }, ctx);
    }
    async notifySessionInfoChanged(name, ctx) {
      for (const handler of this.handlers.session_info_changed) {
        await handler({ type: "session_info_changed", name }, ctx);
      }
    }
    /** Run session_before_compact handlers: cancel or takeover short-circuits. */
    async runSessionBeforeCompact(event, ctx) {
      for (const handler of this.handlers.session_before_compact) {
        const result = await handler({ type: "session_before_compact", ...event }, ctx);
        if (result?.cancel || result?.result) return result;
      }
      return {};
    }
    async notifySessionCompact(event, ctx) {
      for (const handler of this.handlers.session_compact) {
        await handler({ type: "session_compact", ...event }, ctx);
      }
    }
    /** Run session_before_fork handlers: a cancel short-circuits. */
    async runSessionBeforeFork(event, ctx) {
      for (const handler of this.handlers.session_before_fork) {
        const result = await handler({ type: "session_before_fork", ...event }, ctx);
        if (result?.cancel) return result;
      }
      return {};
    }
    /** Run session_before_tree handlers: cancel short-circuits; summary/customInstructions merge (later wins). */
    async runSessionBeforeTree(event, ctx) {
      const merged = {};
      for (const handler of this.handlers.session_before_tree) {
        const result = await handler({ type: "session_before_tree", ...event }, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true };
        if (result.summary) merged.summary = result.summary;
        if (result.customInstructions !== void 0) merged.customInstructions = result.customInstructions;
      }
      return merged;
    }
    async notifySessionTree(event, ctx) {
      for (const handler of this.handlers.session_tree) {
        await handler({ type: "session_tree", ...event }, ctx);
      }
    }
    /** Run session_before_switch handlers; the first cancel wins (pi semantics). */
    async runSessionBeforeSwitch(event, ctx) {
      for (const handler of this.handlers.session_before_switch) {
        const result = await handler({ type: "session_before_switch", ...event }, ctx);
        if (result?.cancel) return { cancelled: true };
      }
      return { cancelled: false };
    }
    async notifyAutoRetryStart(event, ctx) {
      for (const handler of this.handlers.auto_retry_start) {
        await handler({ type: "auto_retry_start", ...event }, ctx);
      }
    }
    async notifyAutoRetryEnd(event, ctx) {
      for (const handler of this.handlers.auto_retry_end) {
        await handler({ type: "auto_retry_end", ...event }, ctx);
      }
    }
    async notifyAgentStart(ctx) {
      for (const handler of this.handlers.agent_start) await handler({ type: "agent_start" }, ctx);
    }
    async notifyAgentEnd(messages, ctx) {
      for (const handler of this.handlers.agent_end) await handler({ type: "agent_end", messages }, ctx);
    }
    async notifyTurnStart(turnIndex, ctx) {
      const event = { type: "turn_start", turnIndex, timestamp: Date.now() };
      for (const handler of this.handlers.turn_start) await handler(event, ctx);
    }
    async notifyTurnEnd(turnIndex, message, toolResults, ctx) {
      const event = { type: "turn_end", turnIndex, message, toolResults };
      for (const handler of this.handlers.turn_end) await handler(event, ctx);
    }
  };

  // ../../../packages/kernel/src/utf8.ts
  var REPLACEMENT = "\uFFFD";
  var MIN_CODE_POINT = [0, 0, 128, 2048, 65536];
  function createIncrementalUtf8Decoder() {
    let pending = [];
    const drain = (final) => {
      let out = "";
      let i = 0;
      while (i < pending.length) {
        const lead = pending[i];
        if (lead < 128) {
          out += String.fromCharCode(lead);
          i += 1;
          continue;
        }
        const length = lead >> 5 === 6 ? 2 : lead >> 4 === 14 ? 3 : lead >> 3 === 30 ? 4 : 0;
        if (length === 0) {
          out += REPLACEMENT;
          i += 1;
          continue;
        }
        if (i + length > pending.length) {
          let plausible = true;
          for (let j = i + 1; j < pending.length; j++) {
            if (pending[j] >> 6 !== 2) {
              plausible = false;
              break;
            }
          }
          if (plausible) {
            if (!final) break;
            out += REPLACEMENT;
            i = pending.length;
            break;
          }
          out += REPLACEMENT;
          i += 1;
          continue;
        }
        let codePoint = lead & 255 >> length + 1;
        let valid = true;
        for (let j = 1; j < length; j++) {
          const byte = pending[i + j];
          if (byte >> 6 !== 2) {
            valid = false;
            break;
          }
          codePoint = codePoint << 6 | byte & 63;
        }
        if (!valid) {
          out += REPLACEMENT;
          i += 1;
          continue;
        }
        if (codePoint < MIN_CODE_POINT[length] || codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111) {
          out += REPLACEMENT;
          i += length;
          continue;
        }
        out += String.fromCodePoint(codePoint);
        i += length;
      }
      pending = pending.slice(i);
      return out;
    };
    return {
      decode(chunk) {
        for (const byte of chunk) pending.push(byte);
        return drain(false);
      },
      flush() {
        const out = drain(true);
        pending = [];
        return out;
      }
    };
  }

  // ../../../packages/ext-mcp-http/src/index.ts
  var MCP_PROTOCOL_VERSION = "2025-06-18";
  var CLIENT_INFO = { name: "tau-ext-mcp-http", version: "0.1.0" };
  var DEFAULT_HANDSHAKE_TIMEOUT_MS = 1e4;
  var HttpStatusError = class extends Error {
    constructor(status, message) {
      super(message);
      __publicField(this, "status");
      this.status = status;
    }
  };
  function sanitizeToolPart(value) {
    const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return sanitized === "" ? "mcp" : sanitized;
  }
  function tauToolName(server, mcpToolName) {
    return `${sanitizeToolPart(server)}_${sanitizeToolPart(mcpToolName)}`;
  }
  function toolOutput(result) {
    const parts = [];
    for (const block of result.content ?? []) {
      if (block.type === "text" && block.text !== void 0) {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push(`[image ${block.mimeType ?? "unknown"}]`);
      } else if (block.type === "resource" && block.resource?.text !== void 0) {
        parts.push(`[resource ${block.resource.uri ?? ""}]
${block.resource.text}`);
      } else if (block.type === "resource_link") {
        parts.push(`[resource link ${block.uri ?? ""}${block.name ? ` ${block.name}` : ""}]`);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    return parts.join("\n").trim() || "(empty MCP tool result)";
  }
  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  function abortError() {
    return new Error("MCP request aborted");
  }
  async function postMessage(platform2, state, message, options) {
    const handle = new AbortHandle();
    handle.follow(options.signal);
    let timedOut = false;
    if (options.timeoutMs !== void 0 && platform2.sleep) {
      platform2.sleep(options.timeoutMs, handle.signal).then(
        () => {
          timedOut = true;
          handle.abort("timeout");
        },
        () => {
        }
      );
    }
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...state.config.headers
    };
    if (!options.isInitialize) {
      headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
      if (state.sessionId !== void 0) headers["mcp-session-id"] = state.sessionId;
    }
    try {
      const response = await platform2.fetch(state.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: handle.signal
      });
      if (!response.ok) {
        throw new HttpStatusError(response.status, `MCP server responded HTTP ${response.status}`);
      }
      const sessionId = response.headers?.get("mcp-session-id") ?? void 0;
      if (options.expectId === void 0) return { sessionId };
      const result = await readRpcResult(platform2, response, options.expectId, handle.signal);
      return { result, sessionId };
    } catch (cause) {
      if (timedOut) throw new Error(`MCP request timed out after ${options.timeoutMs}ms`);
      if (options.signal?.aborted) throw abortError();
      throw cause;
    } finally {
      handle.abort("settled");
    }
  }
  function extractResponse(message, expectId) {
    if (message.id !== expectId) return void 0;
    if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
    return { result: message.result };
  }
  async function readRpcResult(platform2, response, expectId, signal) {
    const contentType = response.headers?.get("content-type");
    if (contentType?.includes("text/event-stream")) {
      return readSseResult(platform2, response, expectId, signal);
    }
    if (contentType?.includes("application/json")) {
      const found = extractResponse(JSON.parse(await response.text()), expectId);
      if (!found) throw new Error("MCP JSON response did not answer the request");
      return found.result;
    }
    const text = await response.text();
    try {
      const found = extractResponse(JSON.parse(text), expectId);
      if (found) return found.result;
    } catch {
    }
    const parser = new SseParser();
    for (const event of [...parser.push(text), ...parser.flush()]) {
      const found = tryExtractFromSseData(event.data, expectId);
      if (found) return found.result;
    }
    throw new Error("MCP response contained no answer for the request");
  }
  function tryExtractFromSseData(data, expectId) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return void 0;
    }
    return extractResponse(message, expectId);
  }
  async function readSseResult(platform2, response, expectId, signal) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MCP SSE response had no readable body");
    const decoder = platform2.createUtf8Decoder();
    const parser = new SseParser();
    try {
      while (true) {
        if (signal.aborted) throw abortError();
        const { done, value } = await reader.read();
        const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
        for (const event of events) {
          const found = tryExtractFromSseData(event.data, expectId);
          if (found) return found.result;
        }
        if (done) throw new Error("MCP SSE stream ended without answering the request");
      }
    } finally {
      try {
        reader.cancel("done");
      } catch {
      }
    }
  }
  async function rpcRequest(platform2, state, method, params, options = {}) {
    const id = state.nextRequestId++;
    return postMessage(platform2, state, { jsonrpc: "2.0", id, method, params }, { ...options, expectId: id });
  }
  async function initializeServer(platform2, state, signal) {
    state.sessionId = void 0;
    const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const { sessionId } = await rpcRequest(
      platform2,
      state,
      "initialize",
      // The negotiated (possibly older) protocolVersion in the result is accepted as-is.
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      { signal, timeoutMs, isInitialize: true }
    );
    state.sessionId = sessionId;
    await postMessage(platform2, state, { jsonrpc: "2.0", method: "notifications/initialized" }, { signal, timeoutMs });
  }
  async function listAllTools(platform2, state, signal) {
    const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const tools = [];
    let cursor;
    do {
      const { result } = await rpcRequest(platform2, state, "tools/list", cursor ? { cursor } : {}, {
        signal,
        timeoutMs
      });
      const page = result;
      tools.push(...page.tools ?? []);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
  async function callTool(platform2, state, mcpToolName, args, signal) {
    const params = { name: mcpToolName, arguments: args };
    try {
      const { result } = await rpcRequest(platform2, state, "tools/call", params, { signal });
      return result;
    } catch (cause) {
      if (cause instanceof HttpStatusError && cause.status === 404 && state.sessionId !== void 0) {
        await initializeServer(platform2, state, signal);
        const { result } = await rpcRequest(platform2, state, "tools/call", params, { signal });
        return result;
      }
      throw cause;
    }
  }
  function createTauTool(platform2, state, info) {
    return {
      name: tauToolName(state.config.name, info.name),
      description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
      parameters: info.inputSchema ?? { type: "object", properties: {} },
      execute: async (args, signal) => {
        if (signal?.aborted) return { output: "MCP tool call aborted", isError: true };
        try {
          const result = await callTool(platform2, state, info.name, args, signal);
          return { output: toolOutput(result), isError: result.isError === true };
        } catch (cause) {
          return { output: messageOf(cause), isError: true };
        }
      }
    };
  }
  function createHttpMcpExtension(options) {
    const { platform: platform2 } = options;
    const states = options.servers.map((config) => ({
      config,
      connected: false,
      nextRequestId: 1
    }));
    let api;
    let connecting;
    const connectAll = async () => {
      const target = api;
      if (!target) {
        throw new Error(
          "connect() called before the extension was loaded \u2014 pass it through ExtensionRegistry.load first"
        );
      }
      for (const state of states) {
        if (state.connected) continue;
        options.onStatus?.({ server: state.config.name, state: "connecting" });
        try {
          await initializeServer(platform2, state);
          const tools = await listAllTools(platform2, state);
          for (const info of tools) target.registerTool(createTauTool(platform2, state, info));
          state.connected = true;
          options.onStatus?.({ server: state.config.name, state: "connected", toolCount: tools.length });
        } catch (cause) {
          state.sessionId = void 0;
          options.onStatus?.({ server: state.config.name, state: "offline", error: messageOf(cause) });
        }
      }
    };
    const connect2 = () => {
      if (!connecting) {
        connecting = connectAll().finally(() => {
          connecting = void 0;
        });
      }
      return connecting;
    };
    const extension = (extensionApi) => {
      api = extensionApi;
      extensionApi.on("session_start", async () => {
        await connect2();
      });
      extensionApi.on("session_shutdown", () => {
        for (const state of states) {
          state.connected = false;
          state.sessionId = void 0;
        }
      });
    };
    return { extension, connect: connect2 };
  }

  // js/tau-entry.ts
  var host = globalThis.sendMessage;
  function emit(channel, payload) {
    if (host) host(channel, JSON.stringify(payload));
  }
  var httpStates = /* @__PURE__ */ new Map();
  var nextHttpId = 1;
  function settleRead(state) {
    const pending = state.pendingRead;
    if (!pending) return;
    if (state.error !== void 0) {
      state.pendingRead = void 0;
      pending.reject(new Error(state.error));
      return;
    }
    const chunk = state.chunks.shift();
    if (chunk) {
      state.pendingRead = void 0;
      pending.resolve({ done: false, value: chunk });
      return;
    }
    if (state.done) {
      state.pendingRead = void 0;
      pending.resolve({ done: true });
    }
  }
  function makeReader(id, state) {
    return {
      read: () => new Promise((resolve, reject) => {
        if (state.pendingRead) {
          reject(new Error("concurrent read on a bridged body"));
          return;
        }
        state.pendingRead = { resolve, reject };
        settleRead(state);
      }),
      cancel: (reason) => {
        state.done = true;
        emit("tau_http", { op: "abort", id, reason: String(reason ?? "cancel") });
        return void 0;
      }
    };
  }
  function makeResponse(id, state) {
    const status = state.status ?? 0;
    const headers = state.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      body: { getReader: () => makeReader(id, state) },
      text: async () => {
        const reader = makeReader(id, state);
        const decoder = createIncrementalUtf8Decoder();
        let text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (value) text += decoder.decode(value);
          if (done) return text + decoder.flush();
        }
      }
    };
  }
  var bridgedFetch = (url, init) => new Promise((resolve, reject) => {
    const id = nextHttpId++;
    const state = { chunks: [], done: false, respond: { resolve, reject } };
    httpStates.set(id, state);
    const signal = init?.signal;
    const onAbort = () => {
      state.error = "aborted";
      emit("tau_http", { op: "abort", id, reason: "abort" });
      const respond = state.respond;
      state.respond = void 0;
      respond?.reject(new Error("aborted"));
      settleRead(state);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    emit("tau_http", {
      op: "start",
      id,
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body
    });
  });
  function base64ToBytes(b64) {
    const binary = atobPolyfill(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function atobPolyfill(input) {
    const clean = input.replace(/=+$/, "");
    let output = "";
    let buffer = 0;
    let bits = 0;
    for (const ch of clean) {
      const index = B64_ALPHABET.indexOf(ch);
      if (index === -1) continue;
      buffer = buffer << 6 | index;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output += String.fromCharCode(buffer >> bits & 255);
      }
    }
    return output;
  }
  var sleepStates = /* @__PURE__ */ new Map();
  var nextSleepId = 1;
  var bridgedSleep = (ms, signal) => new Promise((resolve, reject) => {
    const id = nextSleepId++;
    sleepStates.set(id, { resolve, reject });
    const onAbort = () => {
      if (sleepStates.delete(id)) {
        emit("tau_sleep", { op: "cancel", id });
        reject(new Error("sleep aborted"));
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    emit("tau_sleep", { op: "start", id, ms });
  });
  var platform = {
    fetch: bridgedFetch,
    createUtf8Decoder: createIncrementalUtf8Decoder,
    randomBytes: (length) => {
      const entropy = globalThis.__ENTROPY;
      const bytes = new Uint8Array(length);
      if (entropy && entropy.length >= length) {
        for (let i = 0; i < length; i++) bytes[i] = entropy.shift() ?? 0;
        return bytes;
      }
      let state = length * 2654435761;
      for (let i = 0; i < length; i++) {
        state = state * 1103515245 + 12345 & 2147483647;
        bytes[i] = state & 255;
      }
      return bytes;
    },
    sleep: bridgedSleep
  };
  var uiStates = /* @__PURE__ */ new Map();
  var nextUiId = 1;
  var bridgedUi = {
    confirm: (title, message) => new Promise((resolve) => {
      const id = nextUiId++;
      uiStates.set(id, { resolve });
      emit("tau_ui", { op: "confirm", id, title, message: message ?? "" });
    }),
    input: async () => void 0,
    select: async () => void 0,
    notify: (message, level) => emit("tau_ui", { op: "notify", message, level: level ?? "info" })
  };
  var SENSITIVE = /(run_command|write_file)$/;
  var guardExtension = (api) => {
    api.on("tool_call", async (event, ctx) => {
      if (!SENSITIVE.test(event.toolName)) return void 0;
      const ok = await ctx.ui?.confirm(`\u5141\u8BB8\u6267\u884C ${event.toolName}\uFF1F`, JSON.stringify(event.input));
      if (ok === false) return { block: true, reason: "\u7528\u6237\u62D2\u7EDD\u4E86\u8BE5\u5DE5\u5177\u8C03\u7528" };
      return void 0;
    });
  };
  var agent;
  var currentAbort;
  var mcpConnect;
  async function configure(config) {
    const extensions = [guardExtension];
    if (config.mcpUrl) {
      const mcp = createHttpMcpExtension({
        servers: [
          {
            name: "computer",
            url: config.mcpUrl,
            headers: config.mcpToken ? { authorization: `Bearer ${config.mcpToken}` } : void 0
          }
        ],
        platform,
        onStatus: (status) => emit("tau_event", { type: "mcp_status", status })
      });
      extensions.push(mcp.extension);
      mcpConnect = mcp.connect;
    } else {
      mcpConnect = void 0;
    }
    agent = new Agent({
      config: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        stallTimeoutMs: config.stallTimeoutMs
      },
      platform,
      ui: bridgedUi,
      extensions: await ExtensionRegistry.load(extensions)
    });
    emit("tau_event", { type: "configured" });
  }
  async function connect() {
    if (mcpConnect) await mcpConnect();
  }
  async function runPrompt(text) {
    if (!agent) {
      emit("tau_event", { type: "error", message: "agent not configured" });
      return;
    }
    currentAbort = new AbortHandle();
    try {
      for await (const event of agent.prompt(text, currentAbort.signal)) {
        if (event.type === "text_delta") emit("tau_event", { type: "text_delta", delta: event.delta });
        else if (event.type === "reasoning_delta") emit("tau_event", { type: "reasoning_delta", delta: event.delta });
        else if (event.type === "tool_start")
          emit("tau_event", { type: "tool_start", name: event.toolCall.name, input: event.toolCall.arguments });
        else if (event.type === "tool_result")
          emit("tau_event", {
            type: "tool_result",
            name: event.toolCall.name,
            output: event.result.output,
            isError: event.result.isError === true
          });
        else if (event.type === "assistant_message")
          emit("tau_event", {
            type: "assistant_message",
            stopReason: event.message.stopReason,
            error: event.message.errorMessage
          });
        else if (event.type === "agent_end") emit("tau_event", { type: "agent_end" });
      }
    } catch (cause) {
      emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      currentAbort = void 0;
    }
  }
  var tau = {
    configure: (json) => {
      configure(JSON.parse(json)).catch(
        (cause) => emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) })
      );
    },
    connect: () => {
      connect().catch(
        (cause) => emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) })
      );
    },
    prompt: (text) => {
      runPrompt(text);
    },
    steer: (text) => {
      agent?.steer(text);
    },
    abort: () => {
      currentAbort?.abort("user");
    },
    resolveHttp: (id, kind, json) => {
      const state = httpStates.get(id);
      if (!state) return;
      const payload = json ? JSON.parse(json) : {};
      if (kind === "response") {
        state.status = payload.status;
        state.headers = payload.headers ?? {};
        const respond = state.respond;
        state.respond = void 0;
        respond?.resolve(makeResponse(id, state));
      } else if (kind === "chunk") {
        state.chunks.push(base64ToBytes(payload.b64));
        settleRead(state);
      } else if (kind === "end") {
        state.done = true;
        settleRead(state);
        if (state.done && state.chunks.length === 0 && !state.pendingRead) httpStates.delete(id);
      } else if (kind === "error") {
        state.error = String(payload.message ?? "request failed");
        const respond = state.respond;
        state.respond = void 0;
        respond?.reject(new Error(state.error));
        settleRead(state);
      }
    },
    resolveSleep: (id) => {
      const state = sleepStates.get(id);
      if (state && sleepStates.delete(id)) state.resolve();
    },
    resolveUi: (id, ok) => {
      const state = uiStates.get(id);
      if (state && uiStates.delete(id)) state.resolve(ok);
    }
  };
  globalThis.__tau = tau;
  emit("tau_event", { type: "ready" });
})();
