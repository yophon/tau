"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // ../../../test-fixtures/quickjs/polyfills.ts
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
  function describeError(value) {
    const outer = toError(value);
    let inner = outer;
    for (let depth = 0; depth < 8; depth++) {
      const next = inner?.cause;
      if (next === void 0 || next === null || next === inner) break;
      inner = next;
    }
    if (inner === outer) return outer.message;
    const innerError = inner;
    const detail = typeof innerError.message === "string" && innerError.message !== "" ? innerError.message : typeof innerError.code === "string" ? innerError.code : String(inner);
    return detail === "" || outer.message.includes(detail) ? outer.message : `${outer.message} (${detail})`;
  }

  // ../../../packages/kernel/src/messages.ts
  function computeUsageCost(usage, pricing) {
    const input = usage.input / 1e6 * pricing.inputPerMTok;
    const output = usage.output / 1e6 * pricing.outputPerMTok;
    const cacheRead = pricing.cacheReadPerMTok === void 0 ? 0 : usage.cacheRead / 1e6 * pricing.cacheReadPerMTok;
    const cacheWrite = pricing.cacheWritePerMTok === void 0 ? 0 : usage.cacheWrite / 1e6 * pricing.cacheWritePerMTok;
    return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
  }
  function userContentText(content) {
    if (typeof content === "string") return content;
    return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }
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
  function contentText(content, separator = "") {
    if (typeof content === "string") return content;
    const parts = [];
    for (const block of content) if (block.type === "text" && block.text !== void 0) parts.push(block.text);
    return parts.join(separator);
  }
  function combineUsage(first, second) {
    return {
      input: first.input + second.input,
      output: first.output + second.output,
      cacheRead: first.cacheRead + second.cacheRead,
      cacheWrite: first.cacheWrite + second.cacheWrite,
      totalTokens: first.totalTokens + second.totalTokens,
      cost: {
        input: first.cost.input + second.cost.input,
        output: first.cost.output + second.cost.output,
        cacheRead: first.cost.cacheRead + second.cost.cacheRead,
        cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
        total: first.cost.total + second.cost.total
      }
    };
  }
  function messageText(message) {
    if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
    return contentText(message.content);
  }
  function toolCallsOf(message) {
    return message.content.filter((block) => block.type === "toolCall");
  }

  // ../../../packages/kernel/src/projection.ts
  function isSystemMessage(message) {
    return message.role === "system";
  }
  function getSystemMessageText(message) {
    const parts = [contentText(message.content, "\n")];
    for (const text of Object.values(message.sections ?? {})) {
      if (text !== null) parts.push(text);
    }
    return parts.filter((part) => part.length > 0).join("\n\n");
  }
  function renderSystemMessageUpdate(message) {
    const parts = [];
    const text = contentText(message.content, "\n");
    if (text.length > 0) parts.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      parts.push(
        value === null ? `Removed system prompt section "${name}".` : `Updated system prompt section "${name}":

${value}`
      );
    }
    return parts.join("\n\n");
  }
  function getCurrentTools(messages) {
    const tools = /* @__PURE__ */ new Map();
    for (const message of messages) {
      if (!isSystemMessage(message)) continue;
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    }
    return [...tools.values()];
  }
  function getCurrentSystemMessage(messages) {
    const content = [];
    const sections = /* @__PURE__ */ new Map();
    let timestamp;
    for (const message of messages) {
      if (!isSystemMessage(message)) continue;
      timestamp ?? (timestamp = message.timestamp);
      const text = contentText(message.content, "\n");
      if (text.length > 0) content.push(text);
      for (const [name, value] of Object.entries(message.sections ?? {})) {
        if (value === null) sections.delete(name);
        else sections.set(name, value);
      }
    }
    const tools = getCurrentTools(messages);
    if (timestamp === void 0 && tools.length === 0) return void 0;
    return {
      role: "system",
      content: content.join("\n\n"),
      ...sections.size > 0 ? { sections: Object.fromEntries(sections) } : {},
      ...tools.length > 0 ? { toolsAdded: tools } : {},
      timestamp: timestamp ?? 0
    };
  }
  function getCurrentSystemPrompt(messages) {
    const message = getCurrentSystemMessage(messages);
    return message ? getSystemMessageText(message) : "";
  }
  function collapseSystemMessages(messages) {
    const head = getCurrentSystemMessage(messages);
    const rest = messages.filter((message) => message.role !== "system");
    return head ? [head, ...rest] : rest;
  }
  function toToolDeclaration(tool) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters))
    };
  }
  function declarationsEqual(left, right) {
    return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
  }
  function getToolStateChanges(previous, current) {
    const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
    const currentTools = new Map(current.map((tool) => [tool.name, tool]));
    return {
      toolsAdded: current.filter((tool) => {
        const previousTool = previousTools.get(tool.name);
        return previousTool === void 0 || !declarationsEqual(previousTool, tool);
      }).map(toToolDeclaration),
      toolsRemoved: previous.filter((tool) => {
        const currentTool = currentTools.get(tool.name);
        return currentTool === void 0 || !declarationsEqual(tool, currentTool);
      }).map((tool) => ({ name: tool.name }))
    };
  }
  function diffSystemPromptSections(previous, current) {
    const patch = {};
    for (const [name, text] of Object.entries(current)) {
      if (previous[name] !== text) patch[name] = text;
    }
    for (const name of Object.keys(previous)) {
      if (current[name] === void 0) patch[name] = null;
    }
    return Object.keys(patch).length > 0 ? patch : void 0;
  }
  function normalizeMessageContent(message) {
    return sessionEntryToContextMessages({ type: "message", id: "", parentId: null, timestamp: "", message })[0];
  }
  function entryTime(entry) {
    return Date.parse(entry.timestamp) || 0;
  }
  function sessionEntryToContextMessages(entry) {
    switch (entry.type) {
      case "message": {
        const message = entry.message;
        if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
        if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") && message.content == null) {
          return [{ ...message, content: [] }];
        }
        return [message];
      }
      case "custom_message":
        return [
          {
            role: "custom",
            customType: entry.customType,
            content: entry.content ?? [],
            display: entry.display,
            details: entry.details,
            timestamp: entryTime(entry)
          }
        ];
      case "branch_summary":
        return entry.summary ? [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: entryTime(entry) }] : [];
      case "compaction": {
        const summary = {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: entryTime(entry)
        };
        return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
      }
      default:
        return [];
    }
  }
  function buildContextEntries(path) {
    let compactionIndex = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "compaction") {
        compactionIndex = i;
        break;
      }
    }
    if (compactionIndex < 0) return [...path];
    const compaction = path[compactionIndex];
    if (compaction.type !== "compaction") return [...path];
    const entries = [compaction];
    let foundFirstKept = false;
    for (let i = 0; i < compactionIndex; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) entries.push(entry);
    }
    entries.push(...path.slice(compactionIndex + 1));
    return entries;
  }
  function applyContextEdit(messages, edit) {
    if (!edit) return messages;
    const replacement = edit.replacement;
    if (replacement === null) return [];
    return messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult" && message.role !== "custom") {
        return message;
      }
      const content = (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string" ? [{ type: "text", text: replacement.content }] : replacement.content;
      return { ...message, content };
    });
  }
  function buildSessionProjection(path) {
    const contextEntries = buildContextEntries(path);
    const edits = /* @__PURE__ */ new Map();
    for (const entry of contextEntries) {
      if (entry.type === "context_edit") edits.set(entry.targetId, entry);
    }
    const entries = contextEntries.map(
      (sourceEntry, index) => ({
        sourceEntry,
        // An older compaction can be retained when its id lies inside the newest kept
        // range; only the newest one (index 0) contributes a checkpoint and summary.
        messages: sourceEntry.type === "compaction" && index > 0 ? [] : applyContextEdit(sessionEntryToContextMessages(sourceEntry), edits.get(sourceEntry.id))
      })
    );
    return { entries, messages: entries.flatMap((entry) => entry.messages) };
  }
  function sumSessionUsage(entries) {
    let total = emptyUsage();
    for (const entry of entries) {
      let usage;
      if (entry.type === "usage") usage = entry.usage;
      else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
      else if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "assistant") usage = message.usage;
        else if (message.role === "toolResult") usage = message.usage;
      }
      if (usage) total = combineUsage(total, usage);
    }
    return total;
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
    "billing",
    // ChatGPT subscription login (D2 excludes it; kept so the table diffs cleanly against pi).
    "subscription_sharing_usage_limit_exceeded"
  ]);
  var RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
    "overloaded",
    "server_busy",
    "servers are currently busy",
    "currently experiencing high demand",
    "model is at capacity",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "520",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    "provider.?returned.?(?:an.?)?error",
    "exceeded request buffer limit while retrying upstream",
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "getaddrinfo",
    "ENOTFOUND",
    "EAI_AGAIN",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    "websocket.?closed",
    "websocket.?error",
    "ended without",
    "stream ended before message_stop",
    "stream ended before a terminal response event",
    "http2 request did not get a response",
    "pending stream has been canceled",
    "retry delay",
    "you can retry your request",
    "try your request again",
    "please retry your request",
    "ResourceExhausted",
    "subscription_sharing_usage_unavailable",
    "subscription_sharing_user_unavailable",
    // tau additions: the kernel's own transport wording. Browsers ("Failed to fetch",
    // Safari "Load failed"), mini-programs and React Native report a dropped
    // connection only as "Network request failed: …" / "Stream read failed: …",
    // which none of pi's patterns match.
    "network request failed",
    "stream read failed"
  ]);
  var OVERFLOW_PATTERNS = [
    /prompt (?:is )?too long/i,
    /prompt exceeds max length/i,
    /request_too_large/i,
    /input is too long for requested model/i,
    /exceeds the context window/i,
    /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
    /input token count.*exceeds the maximum/i,
    /maximum prompt length is \d+/i,
    /reduce the length of the messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
    /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
    /exceeds the limit of \d+/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /too large for model with \d+ maximum context length/i,
    /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
    /model_context_window_exceeded/i,
    /prompt too long; exceeded (?:max )?context length/i,
    /range of input length should be/i,
    /context[_ ]length[_ ]exceeded/i,
    /too many tokens/i,
    /token limit exceeded/i
  ];
  var NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];
  var DEFAULT_RETRY_SETTINGS = { enabled: true, maxRetries: 3, baseDelayMs: 2e3 };
  var DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 6e4;
  function retryDelayMs(settings, attempt) {
    const delay = settings.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
    return Math.min(safeDelay, settings.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
  }
  async function retryAssistantCall(produce, settings, sleep, signal, callbacks) {
    const maxAttempts = settings?.enabled && sleep ? settings.maxRetries : 0;
    let attempt = 0;
    let lastRetry;
    for (; ; ) {
      const response = await produce();
      if (response.stopReason === "aborted") {
        if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
        return response;
      }
      if (response.stopReason !== "error") {
        if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
        return response;
      }
      if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
        if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
        return response;
      }
      attempt++;
      lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
      const delayMs = retryDelayMs(settings, attempt);
      await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);
      try {
        await sleep?.(delayMs, signal);
      } catch {
        await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
        const { errorMessage: _errorMessage, ...rest } = response;
        return { ...rest, stopReason: "aborted" };
      }
      await callbacks?.onRetryAttemptStart?.();
    }
  }
  function isContextOverflowError(message) {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    const text = message.errorMessage;
    if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
  }
  function isRetryableAssistantError(message) {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    if (isContextOverflowError(message)) return false;
    const errorMessage = message.errorMessage;
    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
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
    if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "pending") {
      return void 0;
    }
    return calculateContextTokens(message.usage) > 0 ? message.usage : void 0;
  }
  var ESTIMATED_IMAGE_CHARS = 4800;
  var ESTIMATED_IMAGE_TOKENS = ESTIMATED_IMAGE_CHARS / 4;
  function estimateStringTokens(text) {
    let cjk = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 12288 && code <= 12543 || // CJK punctuation, hiragana, katakana
      code >= 13312 && code <= 19903 || // CJK extension A
      code >= 19968 && code <= 40959 || // CJK unified ideographs
      code >= 44032 && code <= 55215 || // Hangul syllables
      code >= 63744 && code <= 64255 || // CJK compatibility ideographs
      code >= 65280 && code <= 65519) {
        cjk++;
      } else {
        other++;
      }
    }
    return cjk + Math.ceil(other / 4);
  }
  function contentTokens(content) {
    if (typeof content === "string") return estimateStringTokens(content);
    let tokens = 0;
    for (const block of content) {
      if (block.type === "text" && block.text) tokens += estimateStringTokens(block.text);
      else if (block.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
    }
    return tokens;
  }
  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value) ?? "undefined";
    } catch {
      return "[unserializable]";
    }
  }
  function estimateTokens(message) {
    switch (message.role) {
      case "user":
      case "custom":
      case "toolResult":
        return contentTokens(message.content);
      case "assistant": {
        let tokens = 0;
        for (const block of message.content) {
          if (block.type === "text") tokens += estimateStringTokens(block.text);
          else if (block.type === "thinking") tokens += estimateStringTokens(block.thinking);
          else if (block.type === "toolCall")
            tokens += estimateStringTokens(block.name + safeJsonStringify(block.arguments));
        }
        return tokens;
      }
      case "compactionSummary":
      case "branchSummary":
        return estimateStringTokens(message.summary);
      case "system": {
        let tokens = contentTokens(message.content);
        for (const section of Object.values(message.sections ?? {})) {
          if (section) tokens += estimateStringTokens(section);
        }
        if (message.toolsAdded) tokens += estimateStringTokens(safeJsonStringify(message.toolsAdded));
        return tokens;
      }
    }
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
  function estimateProjectedContextTokens(projection, branchEntries) {
    const estimate = estimateContextTokens(projection.messages);
    if (estimate.lastUsageIndex !== null) {
      let projectedMessageIndex = 0;
      let usageEntryId;
      for (const entry of projection.entries) {
        const nextMessageIndex = projectedMessageIndex + entry.messages.length;
        if (estimate.lastUsageIndex < nextMessageIndex) {
          usageEntryId = entry.sourceEntry.id;
          break;
        }
        projectedMessageIndex = nextMessageIndex;
      }
      const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
      let latestInvalidatingEntryIndex = -1;
      for (let i = branchEntries.length - 1; i >= 0; i--) {
        const entry = branchEntries[i];
        if (entry.type === "context_edit" || entry.type === "compaction") {
          latestInvalidatingEntryIndex = i;
          break;
        }
      }
      if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
    }
    const currentSystem = getCurrentSystemMessage(projection.messages);
    let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
    for (const message of projection.messages) {
      if (message.role !== "system") tokens += estimateTokens(message);
    }
    return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
  }
  function compactionSettingsForWindow(settings, contextWindow) {
    if (contextWindow === void 0 || contextWindow <= 0) return settings;
    const cap = Math.floor(contextWindow / 4);
    return {
      ...settings,
      reserveTokens: Math.min(settings.reserveTokens, cap),
      keepRecentTokens: Math.min(settings.keepRecentTokens, cap)
    };
  }
  function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
  }
  function isCutPointMessage(message) {
    switch (message.role) {
      case "user":
      case "assistant":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
        return true;
      default:
        return false;
    }
  }
  function isTurnStartMessage(message) {
    switch (message.role) {
      case "user":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
        return true;
      default:
        return false;
    }
  }
  function isProjectedTurnStart(entry) {
    if (entry.sourceEntry.type === "compaction") return false;
    return entry.messages.some(isTurnStartMessage);
  }
  function findProjectedTurnStartIndex(entries, entryIndex, startIndex) {
    for (let i = entryIndex; i >= startIndex; i--) {
      if (isProjectedTurnStart(entries[i])) return i;
    }
    return -1;
  }
  function findProjectedCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
    const cutPoints = [];
    for (let i = startIndex; i < endIndex; i++) {
      const entry = entries[i];
      if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
    }
    if (cutPoints.length === 0) {
      return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    let accumulatedTokens = 0;
    let exceededBudget = false;
    let cutIndex = cutPoints[0];
    for (let i = endIndex - 1; i >= startIndex; i--) {
      const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      if (messageTokens === 0) continue;
      accumulatedTokens += messageTokens;
      if (accumulatedTokens >= keepRecentTokens) {
        exceededBudget = true;
        cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
        break;
      }
    }
    const suffix = entries.slice(cutIndex + 1, endIndex);
    const isIntrinsicallyVisible = (entry) => entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
    const isOmitted = (entry) => isIntrinsicallyVisible(entry) && entry.messages.length === 0;
    const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
    const hasExternalReplacement = suffix.some(
      (entry) => entry.sourceEntry.type === "context_edit" && entry.sourceEntry.replacement !== null && !omittedSuffixIds.has(entry.sourceEntry.targetId)
    );
    const isRecoveryOmissionSuffix = exceededBudget && !hasExternalReplacement && suffix.some(
      (entry) => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry)
    ) && suffix.every(
      (entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry))
    );
    if (isRecoveryOmissionSuffix) cutIndex++;
    while (cutIndex > startIndex) {
      const previous = entries[cutIndex - 1];
      if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
      cutIndex--;
    }
    const startsTurn = isProjectedTurnStart(entries[cutIndex]);
    const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
    return {
      firstKeptEntryIndex: cutIndex,
      turnStartIndex,
      isSplitTurn: !startsTurn && turnStartIndex !== -1
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

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve all opaque identifiers exactly as written (UUIDs, commit hashes, file paths, URLs, session ids, tokens). Never shorten, reconstruct, or paraphrase them.`;
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

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve all opaque identifiers exactly as written (UUIDs, commit hashes, file paths, URLs, session ids, tokens). Never shorten, reconstruct, or paraphrase them.`;
  var TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;
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
          const toolCalls = [];
          for (const block of message.content) {
            if (block.type === "text") textParts.push(block.text);
            else if (block.type === "toolCall") {
              const argsStr = Object.entries(block.arguments).map(([k, v]) => `${k}=${safeJsonStringify(v)}`).join(", ");
              toolCalls.push(`${block.name}(${argsStr})`);
            }
          }
          if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
          if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
          break;
        }
        case "toolResult": {
          const content = messageText(message);
          if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
          break;
        }
        case "system":
          break;
      }
    }
    return parts.join("\n\n");
  }
  function extractFileOpsFromMessage(message, fileOps) {
    if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
      return;
    }
    if (message.role !== "assistant") return;
    for (const block of message.content) {
      if (block.type === "toolCall") addFileOp(block.name, block.arguments, fileOps);
    }
  }
  function addFileOp(toolName, args, fileOps) {
    const path = typeof args?.path === "string" ? args.path : void 0;
    if (!path) return;
    if (toolName === "read") fileOps.read.add(path);
    else if (toolName === "write") fileOps.written.add(path);
    else if (toolName === "edit") fileOps.edited.add(path);
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
  function extractFileOperations(messages, previousCompaction) {
    const fileOps = { read: /* @__PURE__ */ new Set(), written: /* @__PURE__ */ new Set(), edited: /* @__PURE__ */ new Set() };
    if (previousCompaction?.type === "compaction" && !previousCompaction.fromHook && previousCompaction.details) {
      const details = previousCompaction.details;
      if (Array.isArray(details.readFiles)) {
        for (const file of details.readFiles) if (typeof file === "string") fileOps.read.add(file);
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const file of details.modifiedFiles) if (typeof file === "string") fileOps.edited.add(file);
      }
    }
    for (const message of messages) extractFileOpsFromMessage(message, fileOps);
    return fileOps;
  }
  function messagesForCompaction(entry) {
    if (entry.sourceEntry.type === "compaction") return [];
    return entry.messages.filter((message) => message.role !== "system");
  }
  function prepareCompaction(pathEntries, settings) {
    if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") return void 0;
    const projection = buildSessionProjection(pathEntries);
    const projectedEntries = projection.entries;
    const prevCompactionIndex = projectedEntries.findIndex(
      (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0
    );
    let previousSummary;
    let boundaryStart = 0;
    const previousCompaction = prevCompactionIndex >= 0 ? projectedEntries[prevCompactionIndex].sourceEntry : void 0;
    if (previousCompaction?.type === "compaction") {
      previousSummary = previousCompaction.summary;
      boundaryStart = prevCompactionIndex + 1;
    }
    const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
    const cutPoint = findProjectedCutPoint(
      projectedEntries,
      boundaryStart,
      projectedEntries.length,
      settings.keepRecentTokens
    );
    const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
    if (!firstKeptEntry?.id) return void 0;
    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    const messagesToSummarize = projectedEntries.slice(boundaryStart, historyEnd).flatMap(messagesForCompaction);
    const turnPrefixMessages = cutPoint.isSplitTurn ? projectedEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).flatMap(messagesForCompaction) : [];
    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return void 0;
    const fileOps = extractFileOperations(messagesToSummarize, previousCompaction);
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
  function getSummarizationFailure(response, label) {
    if (response.stopReason === "error") {
      return `${label} failed: ${response.errorMessage || "Unknown error"}`;
    }
    if (response.stopReason === "length") {
      return `${label} failed: generation hit the token cap and the summary is incomplete`;
    }
    return void 0;
  }
  async function requestSummary(transport, systemPrompt, promptText, maxTokens, signal) {
    const now = Date.now();
    try {
      const stream = transport({
        messages: [
          { role: "system", content: systemPrompt, timestamp: now },
          { role: "user", content: promptText, timestamp: now }
        ],
        maxTokens,
        signal
      });
      for await (const event of stream) {
        if (event.type === "response_end") return event.message;
      }
      throw new TauError("stream_error", "Summarization returned no message");
    } catch (error) {
      const failure = error instanceof TauError ? error : new TauError("stream_error", String(error), error);
      return {
        role: "assistant",
        content: [],
        api: "unknown",
        provider: "unknown",
        model: "unknown",
        usage: emptyUsage(),
        stopReason: failure.code === "aborted" || signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: now
      };
    }
  }
  async function completeText(transport, systemPrompt, promptText, maxTokens, signal, options) {
    const retry = options?.retry;
    const response = await retryAssistantCall(
      () => requestSummary(transport, systemPrompt, promptText, maxTokens, signal),
      retry?.settings,
      retry?.sleep,
      signal,
      retry?.callbacks
    );
    if (response.stopReason === "aborted") throw new TauError("aborted", "Summarization aborted");
    const failure = getSummarizationFailure(response, options?.label ?? "Summarization");
    if (failure) throw new TauError("compaction_failed", failure);
    return { text: messageText(response), usage: response.usage };
  }
  async function generateSummaryWithUsage(transport, messages, options) {
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
    return completeText(transport, SUMMARIZATION_SYSTEM_PROMPT, promptText, maxTokens, options.signal, {
      label: "Summarization",
      retry: options.retry
    });
  }
  async function runCompaction(transport, preparation, customInstructions, signal, retry) {
    const { settings, previousSummary } = preparation;
    let summary;
    let usage;
    if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
      let historyText = previousSummary ?? "No prior history.";
      let historyUsage;
      if (preparation.messagesToSummarize.length > 0) {
        const history = await generateSummaryWithUsage(transport, preparation.messagesToSummarize, {
          reserveTokens: settings.reserveTokens,
          customInstructions,
          previousSummary,
          signal,
          retry
        });
        historyText = history.text;
        historyUsage = history.usage;
      }
      const prefixPrompt = `# Conversation
${serializeConversation(preparation.turnPrefixMessages)}

# Instructions
${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
      const turnPrefix = await completeText(
        transport,
        SUMMARIZATION_SYSTEM_PROMPT,
        prefixPrompt,
        Math.floor(0.5 * settings.reserveTokens),
        signal,
        { label: "Turn prefix summarization", retry }
      );
      summary = `${historyText}

---

**Turn Context (split turn):**

${turnPrefix.text}`;
      usage = historyUsage ? combineUsage(historyUsage, turnPrefix.usage) : turnPrefix.usage;
    } else {
      const result = await generateSummaryWithUsage(transport, preparation.messagesToSummarize, {
        reserveTokens: settings.reserveTokens,
        customInstructions,
        previousSummary,
        signal,
        retry
      });
      summary = result.text;
      usage = result.usage;
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
      details: { readFiles, modifiedFiles }
    };
  }

  // ../../../packages/kernel/src/branch.ts
  var BRANCH_SUMMARY_MAX_TOKENS = 4096;
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
      if (entry.type === "message" && entry.message.role === "toolResult") {
        extractFileOpsFromMessage(entry.message, fileOps);
      }
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
  async function generateBranchSummary(transport, entries, options) {
    const reserveTokens = options?.reserveTokens ?? 16384;
    const contextWindow = options?.contextWindow || 128e3;
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
    const generated = await completeText(
      transport,
      SUMMARIZATION_SYSTEM_PROMPT,
      promptText,
      BRANCH_SUMMARY_MAX_TOKENS,
      options?.signal,
      { label: "Branch summarization", retry: options?.retry }
    );
    let summary = BRANCH_SUMMARY_PREAMBLE + generated.text;
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return { summary: summary || "No summary generated", readFiles, modifiedFiles, usage: generated.usage };
  }

  // ../../../packages/kernel/src/utf8.ts
  var REPLACEMENT = "\uFFFD";
  function utf8CodePointLength(codePoint) {
    return codePoint < 128 ? 1 : codePoint < 2048 ? 2 : codePoint < 65536 ? 3 : 4;
  }
  function utf8ByteLength(text) {
    let bytes = 0;
    for (const char of text) bytes += utf8CodePointLength(char.codePointAt(0) ?? 0);
    return bytes;
  }
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

  // ../../../packages/kernel/src/tools.ts
  function toolExposure(tool) {
    return tool.exposure ?? "direct";
  }
  function isDeclarable(tool) {
    const exposure = toolExposure(tool);
    return exposure === "direct" || exposure === "model-only";
  }
  function isActivatedOnRegistration(tool) {
    return isDeclarable(tool) && tool.defaultActive !== false;
  }
  function toToolInfo(tool, source) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...tool.outputSchema ? { outputSchema: tool.outputSchema } : {},
      exposure: toolExposure(tool),
      ...tool.namespace ? { namespace: tool.namespace } : {},
      ...tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {},
      ...tool.promptGuidelines ? { promptGuidelines: [...tool.promptGuidelines] } : {},
      ...tool.reachesTools ? { reachesTools: tool.reachesTools } : {},
      source
    };
  }
  function truncateMiddle(content, maxBytes) {
    const chars = Array.from(content);
    const sizes = chars.map((char) => utf8CodePointLength(char.codePointAt(0) ?? 0));
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    const totalLines = content.split("\n").length;
    if (totalBytes <= maxBytes) return { content, truncated: false, removedChars: 0, totalBytes, totalLines };
    const headBudget = Math.floor(maxBytes / 2);
    let headEnd = 0;
    for (let used = 0; headEnd < chars.length && used + sizes[headEnd] <= headBudget; headEnd++) used += sizes[headEnd];
    const tailBudget = maxBytes - headBudget;
    let tailStart = chars.length;
    for (let used = 0; tailStart > headEnd && used + sizes[tailStart - 1] <= tailBudget; tailStart--)
      used += sizes[tailStart - 1];
    const removedChars = tailStart - headEnd;
    return {
      content: `${chars.slice(0, headEnd).join("")}\u2026${removedChars} chars truncated\u2026${chars.slice(tailStart).join("")}`,
      truncated: true,
      removedChars,
      totalBytes,
      totalLines
    };
  }
  function limitToolText(text, maxBytes, where) {
    const truncation = truncateMiddle(text, maxBytes);
    if (!truncation.truncated) return text;
    const tokens = Math.ceil(truncation.totalBytes / 4);
    return `Warning: truncated output (original token count: ${tokens})
Total output lines: ${truncation.totalLines}

${truncation.content}

${where(text)}`;
  }
  function errorResult(message) {
    return { content: [{ type: "text", text: message }], isError: true };
  }
  function toolResultText(result) {
    return result.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n");
  }
  function schemaTypeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    return "object";
  }
  function typeAccepts(declared, actual) {
    if (declared === actual) return true;
    return declared === "number" && actual === "integer";
  }
  function validateValue(schema, value, path, problems) {
    const label = path === "" ? "arguments" : path;
    const declaredType = schema.type;
    if (typeof declaredType === "string" || Array.isArray(declaredType)) {
      const accepted = (Array.isArray(declaredType) ? declaredType : [declaredType]).filter(
        (entry) => typeof entry === "string"
      );
      const actual = schemaTypeOf(value);
      if (accepted.length > 0 && !accepted.some((entry) => typeAccepts(entry, actual))) {
        problems.push(`${label}: expected ${accepted.join(" | ")}, got ${actual}`);
        return;
      }
    }
    const allowed = schema.enum;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((entry) => entry === value)) {
      problems.push(`${label}: must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`);
      return;
    }
    if (Array.isArray(value)) {
      const items = schema.items;
      if (items !== void 0 && items !== null && typeof items === "object" && !Array.isArray(items)) {
        value.forEach((element, index) => {
          validateValue(items, element, `${label}[${index}]`, problems);
        });
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      const record = value;
      const required = schema.required;
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === "string" && record[key] === void 0) {
            problems.push(`${label}: missing required property "${key}"`);
          }
        }
      }
      const properties = schema.properties;
      if (properties !== void 0 && properties !== null && typeof properties === "object") {
        for (const [key, propertySchema] of Object.entries(properties)) {
          if (record[key] === void 0) continue;
          if (propertySchema === null || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
          validateValue(propertySchema, record[key], path === "" ? key : `${label}.${key}`, problems);
        }
      }
    }
  }
  function hasToolSchema(tool) {
    const schema = tool.parameters;
    return typeof schema === "object" && schema !== null && !Array.isArray(schema);
  }
  function assertToolSchema(tool) {
    if (!hasToolSchema(tool)) {
      throw new TauError("invalid_tool", `Tool "${tool.name}" must declare a JSON Schema object in \`parameters\``);
    }
  }
  function validateToolArgs(schema, args) {
    const problems = [];
    validateValue(schema, args, "", problems);
    return problems;
  }

  // ../../../packages/kernel/src/extensions.ts
  function isValidUserBashResult(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const result = value;
    if (result.cancel !== void 0 && typeof result.cancel !== "boolean") return false;
    if (result.reason !== void 0 && typeof result.reason !== "string") return false;
    if (result.command !== void 0 && typeof result.command !== "string") return false;
    if (result.recordInContext !== void 0 && typeof result.recordInContext !== "boolean") return false;
    return true;
  }
  function sameMessages(left, right) {
    return left.length === right.length && left.every((message, index) => message === right[index]);
  }
  var STALE_EXTENSION_MESSAGE = "This extension api/ctx is stale: its registry was replaced (reload, resume, fork, new session) or its setup failed. Do not keep using a captured api or ctx after that.";
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
      /** Every extension that failed to load so far (rolled back; see add()). */
      __publicField(this, "loadErrors", []);
      /** Registration conflicts so far (first registration kept). */
      __publicField(this, "warnings", []);
      __publicField(this, "flagValues", /* @__PURE__ */ new Map());
      __publicField(this, "toolOwners", /* @__PURE__ */ new Map());
      __publicField(this, "flagOwners", /* @__PURE__ */ new Map());
      __publicField(this, "commandOwners", /* @__PURE__ */ new Map());
      __publicField(this, "commandOccurrences", /* @__PURE__ */ new Map());
      __publicField(this, "extensionCount", 0);
      __publicField(this, "invalidated", false);
      __publicField(this, "hostActions");
      __publicField(this, "errorSink");
      __publicField(this, "handlers", {
        agent_start: [],
        agent_end: [],
        agent_before_settle: [],
        agent_settled: [],
        before_provider_headers: [],
        turn_start: [],
        turn_end: [],
        input: [],
        context: [],
        context_with_system: [],
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
        session_compact_failed: [],
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
    /**
     * Run extensions' setup against this registry (e.g. project extensions after a
     * trust decision), one at a time. Each extension's registrations are staged: a
     * setup that throws is rolled back entirely — no half-registered tool without
     * its guard — and reported in `errors`; the others still load (pi). Same-name
     * tools and flags keep the first registration and report a warning. Never
     * throws; the results also accumulate in `loadErrors` / `warnings`.
     */
    async add(extensions) {
      const errors = [];
      const warnings = [];
      for (const entry of extensions) {
        this.extensionCount++;
        const name = typeof entry === "function" ? `extension #${this.extensionCount}` : entry.name;
        const factory = typeof entry === "function" ? entry : entry.factory;
        const snapshot = this.snapshot();
        const staged = [];
        const live = { active: true };
        try {
          await factory(this.createApi(name, staged, live));
          warnings.push(...staged);
        } catch (cause) {
          this.restore(snapshot);
          live.active = false;
          errors.push({ extension: name, error: toError(cause) });
        }
      }
      this.loadErrors.push(...errors);
      this.warnings.push(...warnings);
      return { errors, warnings };
    }
    /**
     * Mark this registry stale (pi runtime invalidate): every api and ctx it handed
     * out throws from now on. Hosts call it after a replacement registry took over.
     */
    invalidate() {
      this.invalidated = true;
    }
    /** Throw when this registry was invalidated; the Agent checks it before acting on a ctx call. */
    assertActive() {
      if (this.invalidated) throw new TauError("stale_extension", STALE_EXTENSION_MESSAGE);
    }
    /** Register a command; duplicates get pi's occurrence suffixes (`name:1`, `name:2`, …). */
    addCommand(name, options, owner) {
      const occurrences = (this.commandOccurrences.get(name) ?? 0) + 1;
      this.commandOccurrences.set(name, occurrences);
      if (occurrences === 2) {
        const first = this.commands.get(name);
        if (first) {
          this.commands.delete(name);
          this.commands.set(`${name}:1`, { ...first, invocationName: `${name}:1` });
          this.commandOwners.set(`${name}:1`, this.commandOwners.get(name) ?? owner);
          this.commandOwners.delete(name);
        }
      }
      let invocationName = occurrences > 1 ? `${name}:${occurrences}` : name;
      for (let suffix = occurrences; this.commands.has(invocationName); suffix++)
        invocationName = `${name}:${suffix + 1}`;
      this.commands.set(invocationName, { name, ...options, invocationName });
      this.commandOwners.set(invocationName, owner);
    }
    /** Copy of everything an extension's setup can change, for rollback. */
    snapshot() {
      const maps = [
        this.tools,
        this.commands,
        this.shortcuts,
        this.messageRenderers,
        this.entryRenderers,
        this.toolRenderers,
        this.widgets,
        this.headerItems,
        this.footerItems,
        this.diagnostics,
        this.flags,
        this.toolOwners,
        this.flagOwners,
        this.commandOwners
      ];
      const mapCopies = maps.map((map) => new Map(map));
      const occurrences = new Map(this.commandOccurrences);
      const handlerCopies = Object.entries(this.handlers).map(
        ([event, list]) => [event, [...list]]
      );
      return () => {
        maps.forEach((map, index) => {
          map.clear();
          for (const [key, value] of mapCopies[index]) map.set(key, value);
        });
        this.commandOccurrences.clear();
        for (const [key, value] of occurrences) this.commandOccurrences.set(key, value);
        for (const [event, list] of handlerCopies) {
          const target = this.handlers[event];
          target.length = 0;
          target.push(...list);
        }
      };
    }
    restore(snapshot) {
      snapshot();
    }
    /** The api one extension's setup receives; it goes stale with a failed setup or an invalidated registry. */
    createApi(name, warnings, live) {
      const on = (event, handler) => {
        const registered = (...args) => handler(...args);
        this.handlers[event].push(registered);
        return () => {
          const list = this.handlers[event];
          const index = list.indexOf(registered);
          if (index >= 0) list.splice(index, 1);
        };
      };
      const api = {
        on,
        registerTool: (tool, options) => {
          assertToolSchema(tool);
          const owner = this.toolOwners.get(tool.name);
          if (owner !== void 0 && owner !== name) {
            warnings.push(`Tool "${tool.name}" conflicts with ${owner}`);
            return;
          }
          this.toolOwners.set(tool.name, name);
          this.tools.set(tool.name, options?.risk !== void 0 ? { ...tool, risk: options.risk } : tool);
        },
        registerCommand: (commandName, options) => {
          if (typeof commandName !== "string" || commandName === "") {
            throw new TauError(
              "invalid_extension",
              `Command registered by extension "${name}" must have a non-empty string name. Use api.registerCommand("name", { description, handler }).`
            );
          }
          if (typeof options?.handler !== "function") {
            throw new TauError(
              "invalid_extension",
              `Command "/${commandName}" registered by extension "${name}" must define handler().`
            );
          }
          this.addCommand(commandName, options, name);
        },
        registerShortcut: (name2, options) => {
          this.shortcuts.set(name2, { name: name2, ...options });
        },
        registerMessageRenderer: (name2, options) => {
          this.messageRenderers.set(name2, { name: name2, ...options });
        },
        registerEntryRenderer: (name2, options) => {
          this.entryRenderers.set(name2, { name: name2, ...options });
        },
        registerToolRenderer: (name2, options) => {
          this.toolRenderers.set(name2, { name: name2, ...options });
        },
        registerWidget: (name2, options) => {
          this.widgets.set(name2, { name: name2, ...options });
        },
        registerHeaderItem: (name2, options) => {
          this.headerItems.set(name2, { name: name2, ...options });
        },
        registerFooterItem: (name2, options) => {
          this.footerItems.set(name2, { name: name2, ...options });
        },
        registerDiagnostic: (name2, options) => {
          this.diagnostics.set(name2, { name: name2, ...options });
        },
        registerFlag: (flagName, options) => {
          if (options.default !== void 0 && typeof options.default !== options.type) {
            throw new TauError(
              "invalid_extension",
              `Invalid default for flag "${flagName}": expected ${options.type}, got ${typeof options.default}`
            );
          }
          const owner = this.flagOwners.get(flagName);
          if (owner !== void 0) {
            warnings.push(`Flag "--${flagName}" conflicts with ${owner}`);
            return;
          }
          this.flagOwners.set(flagName, name);
          this.flags.set(flagName, { name: flagName, ...options });
        },
        getFlag: (name2) => this.getFlag(name2),
        sendMessage: (message, options) => this.requireHostActions("sendMessage")(message, options),
        sendUserMessage: (content, options) => this.requireHostActions("sendUserMessage")(content, options),
        appendEntry: (customType, data) => this.requireHostActions("appendEntry")(customType, data),
        setSessionName: (sessionName) => this.requireHostActions("setSessionName")(sessionName),
        getSessionName: () => this.requireHostActions("getSessionName")(),
        getCommands: () => [...this.commands.values()].map((command) => ({
          name: command.invocationName ?? command.name,
          description: command.description,
          source: this.commandOwners.get(command.invocationName ?? command.name) ?? "extension"
        })),
        setLabel: (entryId, label) => this.requireHostActions("setLabel")(entryId, label),
        setModel: (model) => this.requireHostActions("setModel")(model),
        getThinkingLevel: () => this.requireHostActions("getThinkingLevel")(),
        setThinkingLevel: (level) => this.requireHostActions("setThinkingLevel")(level),
        getActiveTools: () => this.requireHostActions("getActiveTools")(),
        getAllTools: () => this.requireHostActions("getAllTools")(),
        setActiveTools: (toolNames) => this.requireHostActions("setActiveTools")(toolNames)
      };
      const assertLive = () => {
        if (!live.active) throw new TauError("stale_extension", STALE_EXTENSION_MESSAGE);
        this.assertActive();
      };
      const guarded = {};
      for (const [key, value] of Object.entries(api)) {
        guarded[key] = typeof value === "function" ? (...args) => {
          assertLive();
          return value(...args);
        } : value;
      }
      return guarded;
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
    /** Host-side: isolate notification handlers — their errors go to `sink` instead of the caller (HF-12). */
    setErrorSink(sink) {
      this.errorSink = sink;
    }
    /** Run notification handlers in order; with an error sink, one failing handler does not stop the rest. */
    async dispatch(handlers, event, ctx) {
      for (const handler of [...handlers]) {
        if (!this.errorSink) {
          await handler(event, ctx);
          continue;
        }
        try {
          await handler(event, ctx);
        } catch (error) {
          this.errorSink({ event: event.type, error: toError(error) });
        }
      }
    }
    async notifySessionCompactFailed(event, ctx) {
      await this.dispatch(this.handlers.session_compact_failed, { type: "session_compact_failed", ...event }, ctx);
    }
    /** Host-side: supply parsed CLI flag values. Unknown names are ignored (host validates). */
    setFlagValues(values) {
      for (const [name, value] of Object.entries(values)) this.flagValues.set(name, value);
    }
    getFlag(name) {
      return this.flagValues.get(name) ?? this.flags.get(name)?.default;
    }
    /** Run input handlers. Transforms chain; "handled" short-circuits. */
    async runInput(text, ctx, options = {}) {
      let current = text;
      let images = options.images;
      for (const handler of [...this.handlers.input]) {
        const result = await handler(
          {
            type: "input",
            text: current,
            ...images ? { images } : {},
            source: options.source ?? "interactive",
            ...options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}
          },
          ctx
        );
        if (!result || result.action === "continue") continue;
        if (result.action === "handled") return { handled: true, text: current, ...images ? { images } : {} };
        current = result.text;
        if (result.images !== void 0) images = result.images;
      }
      return { handled: false, text: current, ...images ? { images } : {} };
    }
    /** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits. */
    async runToolCall(event, ctx) {
      for (const handler of [...this.handlers.tool_call]) {
        const result = await handler(event, ctx);
        if (result?.block) return { blocked: true, reason: result.reason, terminate: result.terminate === true };
      }
      return { blocked: false };
    }
    /** Run tool_result handlers. Partial overrides chain onto the event. */
    async runToolResult(event, ctx) {
      for (const handler of [...this.handlers.tool_result]) {
        const result = await handler(event, ctx);
        if (!result) continue;
        if (result.content !== void 0) {
          event.content = result.content;
          if (result.structuredContent === void 0) delete event.structuredContent;
        }
        if (result.structuredContent !== void 0) event.structuredContent = result.structuredContent;
        if (result.details !== void 0) event.details = result.details;
        if (result.isError !== void 0) event.isError = result.isError;
        if (result.usage !== void 0) event.usage = result.usage;
      }
      return {
        content: event.content,
        details: event.details,
        isError: event.isError,
        usage: event.usage,
        ...event.structuredContent !== void 0 ? { structuredContent: event.structuredContent } : {}
      };
    }
    /** Run user_bash handlers. Rewrites chain; cancel short-circuits. */
    async runUserBash(event, ctx) {
      const current = { type: "user_bash", ...event };
      const cancelled = (reason) => ({
        cancel: true,
        reason,
        command: current.command,
        recordInContext: current.recordInContext
      });
      for (const handler of [...this.handlers.user_bash]) {
        let result;
        try {
          result = await handler(current, ctx);
        } catch (error) {
          return cancelled(`user_bash handler failed: ${toError(error).message}`);
        }
        if (result === void 0 || result === null) continue;
        if (!isValidUserBashResult(result)) return cancelled("user_bash handler returned an invalid result");
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
      for (const handler of [...this.handlers.model_select]) {
        const result = await handler(current, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true, reason: result.reason, model: current.selectedModel };
        if (result.model !== void 0) current.selectedModel = result.model;
      }
      return { model: current.selectedModel };
    }
    async notifyModelSelected(event, ctx) {
      for (const handler of [...this.handlers.model_select]) {
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
      for (const handler of [...this.handlers.thinking_level_select]) {
        const result = await handler(current, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true, reason: result.reason, level: current.selectedLevel };
        if (result.level !== void 0) current.selectedLevel = result.level;
      }
      return { level: current.selectedLevel };
    }
    async notifyThinkingLevelSelected(event, ctx) {
      for (const handler of [...this.handlers.thinking_level_select]) {
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
    /**
     * Request-time transforms in two phases (pi ExtensionRunner.emitContext).
     * `context` handlers see the conversation only and the prompt/tool state is
     * restored after each (a changed list is re-headed with the replayed system
     * message); `context_with_system` handlers then see the full transcript and
     * their output is used as returned. Works on a JSON copy, so in-place edits
     * never reach the session log's projection.
     */
    async runContext(messages, ctx) {
      let current = JSON.parse(JSON.stringify(messages));
      for (const handler of [...this.handlers.context]) {
        const visible = current.filter((message) => message.role !== "system");
        const snapshot = visible.slice();
        const result = await handler({ type: "context", messages: visible }, ctx);
        const returned = result?.messages ?? (sameMessages(visible, snapshot) ? void 0 : visible);
        if (!returned || sameMessages(returned, snapshot)) continue;
        const head = getCurrentSystemMessage(current);
        current = head ? [head, ...returned] : returned;
      }
      for (const handler of [...this.handlers.context_with_system]) {
        const hadLeadingSystemMessage = current[0]?.role === "system";
        const result = await handler({ type: "context_with_system", messages: current }, ctx);
        current = result?.messages ?? current;
        if (hadLeadingSystemMessage && current[0]?.role !== "system") {
          this.errorSink?.({
            event: "context_with_system",
            error: new Error(
              "Handler removed the leading system message; the request has no prompt or initial tool declarations"
            )
          });
        }
      }
      return current;
    }
    /** Run before_agent_start handlers. systemPrompt replacements chain; injected messages accumulate. */
    async runBeforeAgentStart(prompt, systemPrompt, ctx) {
      let current = systemPrompt;
      const messages = [];
      for (const handler of [...this.handlers.before_agent_start]) {
        const result = await handler({ type: "before_agent_start", prompt, systemPrompt: current }, ctx);
        if (result?.systemPrompt !== void 0) current = result.systemPrompt;
        if (result?.message) messages.push(result.message);
      }
      return { systemPrompt: current, messages };
    }
    async notifyMessageStart(message, ctx) {
      await this.dispatch(this.handlers.message_start, { type: "message_start", message }, ctx);
    }
    async notifyMessageUpdate(message, event, ctx) {
      await this.dispatch(this.handlers.message_update, { type: "message_update", message, event }, ctx);
    }
    /** Run message_end handlers. Replacements chain; a replacement changing the role is ignored. */
    async runMessageEnd(message, ctx) {
      let current = message;
      for (const handler of [...this.handlers.message_end]) {
        const result = await handler({ type: "message_end", message: current }, ctx);
        if (result?.message && result.message.role === current.role) current = result.message;
      }
      return current;
    }
    async notifyToolExecutionStart(event, ctx) {
      await this.dispatch(this.handlers.tool_execution_start, { type: "tool_execution_start", ...event }, ctx);
    }
    async notifyToolExecutionUpdate(event, ctx) {
      await this.dispatch(this.handlers.tool_execution_update, { type: "tool_execution_update", ...event }, ctx);
    }
    async notifyToolExecutionEnd(event, ctx) {
      await this.dispatch(this.handlers.tool_execution_end, { type: "tool_execution_end", ...event }, ctx);
    }
    /** Run project_trust handlers. The first decisive answer (yes/no) wins. */
    async runProjectTrust(cwd, ctx) {
      for (const handler of [...this.handlers.project_trust]) {
        const result = await handler({ type: "project_trust", cwd }, ctx);
        if (result && result.trusted !== "undecided") return result;
      }
      return { trusted: "undecided" };
    }
    async runResourcesDiscover(cwd, reason, ctx) {
      const discovered = { skillPaths: [], promptPaths: [], themePaths: [] };
      for (const handler of [...this.handlers.resources_discover]) {
        const result = await handler({ type: "resources_discover", cwd, reason }, ctx);
        if (!result) continue;
        if (result.skillPaths) discovered.skillPaths.push(...result.skillPaths);
        if (result.promptPaths) discovered.promptPaths.push(...result.promptPaths);
        if (result.themePaths) discovered.themePaths.push(...result.themePaths);
      }
      return discovered;
    }
    async notifySessionStart(reason, ctx) {
      await this.dispatch(this.handlers.session_start, { type: "session_start", reason }, ctx);
    }
    async notifySessionShutdown(reason, ctx) {
      await this.dispatch(this.handlers.session_shutdown, { type: "session_shutdown", reason }, ctx);
    }
    async notifySessionInfoChanged(name, ctx) {
      await this.dispatch(this.handlers.session_info_changed, { type: "session_info_changed", name }, ctx);
    }
    /** Run session_before_compact handlers: cancel or takeover short-circuits. */
    async runSessionBeforeCompact(event, ctx) {
      for (const handler of [...this.handlers.session_before_compact]) {
        const result = await handler({ type: "session_before_compact", ...event }, ctx);
        if (result?.cancel || result?.result) return result;
      }
      return {};
    }
    async notifySessionCompact(event, ctx) {
      await this.dispatch(this.handlers.session_compact, { type: "session_compact", ...event }, ctx);
    }
    /** Run session_before_fork handlers: a cancel short-circuits. */
    async runSessionBeforeFork(event, ctx) {
      for (const handler of [...this.handlers.session_before_fork]) {
        const result = await handler({ type: "session_before_fork", ...event }, ctx);
        if (result?.cancel) return result;
      }
      return {};
    }
    /** Run session_before_tree handlers: cancel short-circuits; summary/customInstructions merge (later wins). */
    async runSessionBeforeTree(event, ctx) {
      const merged = {};
      for (const handler of [...this.handlers.session_before_tree]) {
        const result = await handler({ type: "session_before_tree", ...event }, ctx);
        if (!result) continue;
        if (result.cancel) return { cancel: true };
        if (result.summary) merged.summary = result.summary;
        if (result.customInstructions !== void 0) merged.customInstructions = result.customInstructions;
      }
      return merged;
    }
    async notifySessionTree(event, ctx) {
      await this.dispatch(this.handlers.session_tree, { type: "session_tree", ...event }, ctx);
    }
    /** Run session_before_switch handlers; the first cancel wins (pi semantics). */
    async runSessionBeforeSwitch(event, ctx) {
      for (const handler of [...this.handlers.session_before_switch]) {
        const result = await handler({ type: "session_before_switch", ...event }, ctx);
        if (result?.cancel) return { cancelled: true };
      }
      return { cancelled: false };
    }
    async notifyAutoRetryStart(event, ctx) {
      await this.dispatch(this.handlers.auto_retry_start, { type: "auto_retry_start", ...event }, ctx);
    }
    async notifyAutoRetryEnd(event, ctx) {
      await this.dispatch(this.handlers.auto_retry_end, { type: "auto_retry_end", ...event }, ctx);
    }
    async notifyAgentStart(ctx) {
      await this.dispatch(this.handlers.agent_start, { type: "agent_start" }, ctx);
    }
    async notifyAgentEnd(messages, ctx) {
      await this.dispatch(this.handlers.agent_end, { type: "agent_end", messages }, ctx);
    }
    async notifyTurnStart(turnIndex, ctx) {
      const event = { type: "turn_start", turnIndex, timestamp: Date.now() };
      await this.dispatch(this.handlers.turn_start, event, ctx);
    }
    /** Report a diagnostic to the host's error sink (dropped without one). */
    reportError(event, message) {
      this.errorSink?.({ event, error: new Error(message) });
    }
    /**
     * Run an actionable boundary (pi emitBoundary): each handler sees the drafts
     * so far; a result's `entries` replaces them, its `continue` overrides the
     * request. Handler errors follow the notification rules (sink or throw).
     */
    async runBoundary(handlers, event, ctx) {
      let entries = [];
      let shouldContinue = false;
      for (const handler of [...handlers]) {
        const current = { ...event, entries: [...entries], continue: shouldContinue };
        let result;
        if (this.errorSink) {
          try {
            result = await handler(current, ctx) ?? void 0;
          } catch (error) {
            this.errorSink({ event: event.type, error: toError(error) });
            continue;
          }
        } else {
          result = await handler(current, ctx) ?? void 0;
        }
        if (!result) continue;
        if (result.entries !== void 0) entries = [...result.entries];
        if (result.continue !== void 0) shouldContinue = result.continue;
      }
      return { entries, continue: shouldContinue };
    }
    async runTurnEnd(event, ctx) {
      return this.runBoundary(this.handlers.turn_end, { type: "turn_end", entries: [], continue: false, ...event }, ctx);
    }
    async runBeforeSettle(outcome, ctx) {
      return this.runBoundary(
        this.handlers.agent_before_settle,
        { type: "agent_before_settle", entries: [], continue: false, outcome },
        ctx
      );
    }
    /** Whether any before_provider_headers handler is registered (the agent checks transport support first). */
    hasProviderHeaderHandlers() {
      return this.handlers.before_provider_headers.length > 0;
    }
    /**
     * Run before_provider_headers: handlers mutate one headers object in turn.
     * Their errors propagate (they change what goes on the wire; never ignored).
     */
    async runBeforeProviderHeaders(ctx) {
      const event = { type: "before_provider_headers", headers: {} };
      for (const handler of [...this.handlers.before_provider_headers]) await handler(event, ctx);
      return event.headers;
    }
    async notifyAgentSettled(aborted2, ctx) {
      await this.dispatch(this.handlers.agent_settled, { type: "agent_settled", aborted: aborted2 }, ctx);
    }
  };

  // ../../../packages/kernel/src/nested-calls.ts
  var NESTED_CALL_LIMITS = {
    maxCalls: 256,
    maxArgumentBytesPerCall: 8 * 1024,
    maxArgumentBytesTotal: 32 * 1024,
    maxErrorChars: 500
  };
  var MAX_KEPT_PATH_CHARS = 4096;
  var PATH_TOOLS = /* @__PURE__ */ new Set(["read", "write", "edit"]);
  function textOf(result) {
    return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }
  var NestedCallRecorder = class {
    constructor() {
      __publicField(this, "calls", []);
      __publicField(this, "startedAt", /* @__PURE__ */ new Map());
      __publicField(this, "complete", true);
      __publicField(this, "argumentBytes", 0);
      __publicField(this, "usage");
    }
    /** Record a call as it starts. Returns undefined when the call is dropped from the record. */
    start(toolCall) {
      if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
        this.complete = false;
        return void 0;
      }
      const record = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
      const json = JSON.stringify(toolCall.arguments ?? {});
      const bytes = utf8ByteLength(json);
      if (bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall || this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal) {
        record.argumentsBytes = bytes;
        this.complete = false;
        const path = toolCall.arguments?.path;
        if (PATH_TOOLS.has(toolCall.name) && typeof path === "string") {
          record.arguments = { path: path.slice(0, MAX_KEPT_PATH_CHARS) };
        }
      } else {
        record.arguments = JSON.parse(json);
        this.argumentBytes += bytes;
      }
      this.calls.push(record);
      this.startedAt.set(record, Date.now());
      return record;
    }
    finish(record, isError, errorText) {
      if (!record) return;
      record.status = isError ? "error" : "ok";
      record.durationMs = Math.max(0, Date.now() - (this.startedAt.get(record) ?? Date.now()));
      this.startedAt.delete(record);
      if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
    }
    addUsage(usage) {
      this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
    }
    get totalUsage() {
      return this.usage;
    }
    /** Copy of the record so far, or undefined when no nested call was made. */
    snapshot() {
      if (this.calls.length === 0 && this.complete) return void 0;
      const calls = this.calls.map((call) => ({ ...call }));
      return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
    }
  };
  var NestedToolCallRunner = class {
    constructor(host2) {
      __publicField(this, "host");
      /** Scopes by the id of the calling tool call. */
      __publicField(this, "scopes", /* @__PURE__ */ new Map());
      /** Serializes nested calls that must not run concurrently. */
      __publicField(this, "queueTail", Promise.resolve());
      this.host = host2;
    }
    /**
     * Run `name` on behalf of the call `callerId`; the nested call gets the id
     * `<callerId>/<n>`. Never rejects for tool failures: they come back as `isError`.
     */
    async execute(callerId, name, args, options = {}) {
      let scope = this.scopes.get(callerId);
      if (!scope) {
        scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };
        this.scopes.set(callerId, scope);
      }
      const toolCall = {
        type: "toolCall",
        id: `${callerId}/${scope.nextId++}`,
        name,
        arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}
      };
      const record = scope.recorder.start(toolCall);
      const tools = this.host.getTools();
      const exclusive = !scope.holdsQueue && (this.host.isSequential() || tools.get(name)?.executionMode === "sequential");
      let release;
      if (exclusive) {
        const previous = this.queueTail;
        this.queueTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
      }
      this.scopes.set(toolCall.id, { recorder: scope.recorder, nextId: 1, holdsQueue: scope.holdsQueue || exclusive });
      let outcome;
      try {
        outcome = await this.host.runToolCall(toolCall, tools, callerId, options.signal, options.onUpdate);
      } catch (cause) {
        outcome = {
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
          isError: true
        };
      } finally {
        this.scopes.delete(toolCall.id);
        release?.();
      }
      const { durationMs, ...result } = outcome;
      const isError = result.isError === true;
      scope.recorder.finish(record, isError, textOf(result));
      if (result.usage) scope.recorder.addUsage(result.usage);
      return { toolCall, result, isError, ...durationMs !== void 0 ? { durationMs } : {} };
    }
    /** Remove and return the record of the nested calls a model-issued call made. */
    takeRecord(toolCallId) {
      const scope = this.scopes.get(toolCallId);
      this.scopes.delete(toolCallId);
      if (!scope) return void 0;
      return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
    }
    clear() {
      this.scopes.clear();
    }
  };

  // ../../../packages/kernel/src/json.ts
  var VALID_JSON_ESCAPES = /* @__PURE__ */ new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  function isControlCharacter(char) {
    const codePoint = char.codePointAt(0);
    return codePoint !== void 0 && codePoint >= 0 && codePoint <= 31;
  }
  function escapeControlCharacter(char) {
    switch (char) {
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "	":
        return "\\t";
      default:
        return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
    }
  }
  function repairJson(json) {
    let repaired = "";
    let inString = false;
    for (let index = 0; index < json.length; index++) {
      const char = json[index];
      if (!inString) {
        repaired += char;
        if (char === '"') inString = true;
        continue;
      }
      if (char === '"') {
        repaired += char;
        inString = false;
        continue;
      }
      if (char === "\\") {
        const nextChar = json[index + 1];
        if (nextChar === void 0) {
          repaired += "\\\\";
          continue;
        }
        if (nextChar === "u") {
          const unicodeDigits = json.slice(index + 2, index + 6);
          if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
            repaired += `\\u${unicodeDigits}`;
            index += 5;
            continue;
          }
        }
        if (VALID_JSON_ESCAPES.has(nextChar)) {
          repaired += `\\${nextChar}`;
          index += 1;
          continue;
        }
        repaired += "\\\\";
        continue;
      }
      repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    }
    return repaired;
  }
  function parseJsonWithRepair(json) {
    try {
      return JSON.parse(json);
    } catch (error) {
      const repaired = repairJson(json);
      if (repaired !== json) return JSON.parse(repaired);
      throw error;
    }
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

  // ../../../packages/kernel/src/transform.ts
  var NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
  var NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
  function replaceImagesWithPlaceholder(content, placeholder) {
    const result = [];
    let previousWasPlaceholder = false;
    for (const block of content) {
      if (block.type === "image") {
        if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
        previousWasPlaceholder = true;
        continue;
      }
      result.push(block);
      previousWasPlaceholder = block.text === placeholder;
    }
    return result;
  }
  function downgradeUnsupportedImages(messages, target) {
    if (target.input === void 0 || target.input.includes("image")) return messages;
    return messages.map((msg) => {
      if ((msg.role === "user" || msg.role === "custom") && Array.isArray(msg.content)) {
        return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER) };
      }
      if (msg.role === "toolResult") {
        return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER) };
      }
      return msg;
    });
  }
  function transformMessages(messages, target) {
    const normalized = messages.map((msg) => {
      const content = msg.content;
      return "content" in msg && (content === null || content === void 0) ? { ...msg, content: [] } : msg;
    });
    const toolCallIdMap = /* @__PURE__ */ new Map();
    const transformed = downgradeUnsupportedImages(normalized, target).map((msg) => {
      if (msg.role === "toolResult") {
        const mapped = toolCallIdMap.get(msg.toolCallId);
        return mapped && mapped !== msg.toolCallId ? { ...msg, toolCallId: mapped } : msg;
      }
      if (msg.role !== "assistant") return msg;
      if (isSameLineage(msg, target)) return msg;
      const content = msg.content.flatMap((block) => {
        if (block.type === "toolCall" && target.normalizeToolCallId) {
          const id = target.normalizeToolCallId(block.id);
          if (id !== block.id) {
            toolCallIdMap.set(block.id, id);
            return [{ ...block, id }];
          }
          return [block];
        }
        if (block.type !== "thinking") return [block];
        if (block.redacted || block.thinking.trim() === "") return [];
        return [{ type: "text", text: block.thinking }];
      });
      return { ...msg, content };
    });
    const result = [];
    let pendingToolCalls = [];
    let seenResultIds = /* @__PURE__ */ new Set();
    const closePendingToolCalls = () => {
      for (const toolCall of pendingToolCalls) {
        if (seenResultIds.has(toolCall.id)) continue;
        result.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now()
        });
      }
      pendingToolCalls = [];
      seenResultIds = /* @__PURE__ */ new Set();
    };
    for (const msg of transformed) {
      if (msg.role === "assistant") {
        closePendingToolCalls();
        if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
        pendingToolCalls = msg.content.filter((block) => block.type === "toolCall");
        result.push(msg);
        continue;
      }
      if (msg.role === "toolResult") {
        seenResultIds.add(msg.toolCallId);
        result.push(msg);
        continue;
      }
      closePendingToolCalls();
      result.push(msg);
    }
    closePendingToolCalls();
    return result;
  }
  function isSameLineage(msg, target) {
    return msg.api === target.api && msg.provider === target.provider && msg.model === target.model;
  }

  // ../../../packages/kernel/src/uuid.ts
  var lastTimestamp = -Infinity;
  var sequence = 0;
  function uuidv7(randomBytes) {
    const random = randomBytes(16);
    const timestamp = Date.now();
    if (timestamp > lastTimestamp) {
      sequence = random[6] * 16777216 + random[7] * 65536 + random[8] * 256 + random[9];
      lastTimestamp = timestamp;
    } else {
      sequence = sequence + 1 >>> 0;
      if (sequence === 0) {
        lastTimestamp++;
      }
    }
    const bytes = new Uint8Array(16);
    bytes[0] = lastTimestamp / 1099511627776 & 255;
    bytes[1] = lastTimestamp / 4294967296 & 255;
    bytes[2] = lastTimestamp / 16777216 & 255;
    bytes[3] = lastTimestamp / 65536 & 255;
    bytes[4] = lastTimestamp / 256 & 255;
    bytes[5] = lastTimestamp & 255;
    bytes[6] = 112 | sequence >>> 28 & 15;
    bytes[7] = sequence >>> 20 & 255;
    bytes[8] = 128 | sequence >>> 14 & 63;
    bytes[9] = sequence >>> 6 & 255;
    bytes[10] = (sequence & 63) << 2 | random[10] & 3;
    bytes[11] = random[11];
    bytes[12] = random[12];
    bytes[13] = random[13];
    bytes[14] = random[14];
    bytes[15] = random[15];
    return formatUuid(bytes);
  }
  function formatUuid(bytes) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }

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
  var REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];
  function isReasoningField(value) {
    return value !== void 0 && REASONING_FIELDS.includes(value);
  }
  function sanitizeSurrogates(text) {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  }
  function userContentToWire(content) {
    if (typeof content === "string") return sanitizeSurrogates(content);
    const parts = content.filter((block) => block.type !== "text" || block.text.length > 0).map(
      (block) => block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
    );
    return parts.length === 0 ? void 0 : parts;
  }
  function toolResultContentToWire(content) {
    const text = content.map((block) => block.type === "text" ? block.text : "[image omitted]").join("\n");
    return text === "" ? "(no tool output)" : sanitizeSurrogates(text);
  }
  function normalizeToolCallId(id, provider) {
    if (id.includes("|")) {
      const separatorIndex = id.indexOf("|");
      const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
      const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
      const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
      if (combinedId.length <= 40) return combinedId;
      const hash = shortHash(id).slice(0, 8);
      const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
      return `${prefix}_${hash}`;
    }
    if (provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
    return id;
  }
  function shortHash(str) {
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }
  function toWireMessage(message, replayEmptyReasoning) {
    switch (message.role) {
      case "user": {
        const content = userContentToWire(message.content);
        return content === void 0 ? void 0 : { role: "user", content };
      }
      case "custom": {
        const content = userContentToWire(message.content);
        return content === void 0 ? void 0 : { role: "user", content };
      }
      case "compactionSummary":
        return {
          role: "user",
          content: sanitizeSurrogates(COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX)
        };
      case "branchSummary":
        return {
          role: "user",
          content: sanitizeSurrogates(BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX)
        };
      case "assistant": {
        const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        const toolCalls = message.content.filter((block) => block.type === "toolCall");
        const wire = {
          role: "assistant",
          content: text === "" ? null : sanitizeSurrogates(text)
        };
        const thinking = message.content.filter((block) => block.type === "thinking" && !block.redacted);
        const reasoningText = thinking.map((block) => block.type === "thinking" ? block.thinking : "").join("");
        if (reasoningText !== "") {
          const first = thinking[0];
          const field = first?.type === "thinking" && isReasoningField(first.thinkingSignature) ? first.thinkingSignature : "reasoning_content";
          wire[field] = sanitizeSurrogates(reasoningText);
        } else if (replayEmptyReasoning) {
          wire.reasoning_content = "";
        }
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
      case "system":
        return { role: "system", content: sanitizeSurrogates(renderSystemMessageUpdate(message)) };
    }
  }
  function resolveTranscript(messages, midConversationSystemMessages) {
    const transcript = midConversationSystemMessages ? [...messages] : collapseSystemMessages(messages);
    const head = transcript[0]?.role === "system" ? transcript[0] : void 0;
    return {
      systemPrompt: head ? getSystemMessageText(head) : "",
      messages: head ? transcript.slice(1) : transcript,
      tools: getCurrentTools(messages)
    };
  }
  function toWireMessages(systemPrompt, messages, replayEmptyReasoning = false) {
    const wire = [];
    if (systemPrompt !== "") wire.push({ role: "system", content: sanitizeSurrogates(systemPrompt) });
    for (const message of messages) {
      const converted = toWireMessage(message, replayEmptyReasoning);
      if (converted) wire.push(converted);
    }
    return wire;
  }
  function toUsage(wire) {
    const promptTokens = wire.prompt_tokens || 0;
    const cacheRead = wire.prompt_tokens_details?.cached_tokens ?? wire.prompt_cache_hit_tokens ?? wire.cached_tokens ?? 0;
    const cacheWrite = wire.prompt_tokens_details?.cache_write_tokens || 0;
    const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
    const output = wire.completion_tokens || 0;
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: wire.completion_tokens_details?.reasoning_tokens || 0,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
  }
  function mapStopReason(reason) {
    switch (reason) {
      case "stop":
      case "end":
        return { stopReason: "stop" };
      case "length":
        return { stopReason: "length" };
      case "function_call":
      case "tool_calls":
        return { stopReason: "toolUse" };
      default:
        return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
    }
  }
  function applyHeaderChanges(headers, changes) {
    if (!changes) return headers;
    const result = { ...headers };
    for (const [name, value] of Object.entries(changes)) {
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
      }
      if (value !== null) result[name] = value;
    }
    return result;
  }
  function hostOf(baseUrl) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(baseUrl);
    return match ? match[1] : "";
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
    const model = options?.model ?? config.model;
    throwIfAborted(options?.signal);
    const startedAt = Date.now();
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const api = config.api ?? OPENAI_COMPLETIONS_API;
    const provider = config.provider ?? "openai-compat";
    const replayEmptyReasoning = config.replayEmptyReasoning ?? /(^|[./])deepseek\.com(?=[:/]|$)/i.test(hostOf(config.baseUrl));
    const transcript = resolveTranscript(messages, config.midConversationSystemMessages);
    const body = {
      model,
      messages: toWireMessages(
        transcript.systemPrompt,
        transformMessages(transcript.messages, {
          api,
          provider,
          model,
          ...config.input ? { input: config.input } : {},
          normalizeToolCallId: (id) => normalizeToolCallId(id, provider)
        }),
        replayEmptyReasoning
      ),
      stream: true,
      ...options?.maxTokens !== void 0 ? { [config.maxTokensField ?? "max_tokens"]: options.maxTokens } : {},
      // The thinking level travels on the request (P23d); extraBody still overrides it.
      ...options?.thinkingLevel !== void 0 ? { reasoning_effort: options.thinkingLevel } : {},
      ...config.extraBody
    };
    if (config.includeUsage !== false) body.stream_options = { include_usage: true };
    if (transcript.tools.length > 0) {
      body.tools = transcript.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
    }
    let headers = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    headers = applyHeaderChanges(headers, config.headers);
    headers = applyHeaderChanges(headers, options?.headers);
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
      throw new TauError("network_error", `Network request failed: ${describeError(cause)}`, cause);
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
    const rawToolCalls = [];
    const rawByIndex = /* @__PURE__ */ new Map();
    const rawById = /* @__PURE__ */ new Map();
    let finishReason;
    let mappedStop;
    let usage;
    let responseId;
    let responseModel;
    let reasoningField;
    const pendingEvents = [];
    let done = false;
    const appendText = (delta) => {
      const last = blocks.at(-1);
      if (last?.type === "text") last.text += delta;
      else blocks.push({ type: "text", text: delta });
    };
    const appendThinking = (delta, field) => {
      const last = blocks.at(-1);
      if (last?.type === "thinking") last.thinking += delta;
      else blocks.push({ type: "thinking", thinking: delta, thinkingSignature: field });
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
      if (typeof chunk.id === "string" && chunk.id !== "") responseId ?? (responseId = chunk.id);
      if (typeof chunk.model === "string" && chunk.model !== "") responseModel ?? (responseModel = chunk.model);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (!chunk.usage && choice.usage) usage = toUsage(choice.usage);
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        mappedStop = mapStopReason(choice.finish_reason);
      }
      const delta = choice.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content !== "") {
        appendText(delta.content);
        pendingEvents.push({ type: "text_delta", delta: delta.content });
      }
      const field = REASONING_FIELDS.find((name) => typeof delta[name] === "string" && delta[name] !== "");
      if (field) {
        const reasoningDelta = delta[field];
        reasoningField ?? (reasoningField = field);
        appendThinking(reasoningDelta, reasoningField);
        pendingEvents.push({ type: "reasoning_delta", delta: reasoningDelta });
      }
      for (const wireToolCall of delta.tool_calls ?? []) {
        const index = typeof wireToolCall.index === "number" ? wireToolCall.index : void 0;
        const id = wireToolCall.id || void 0;
        const name = wireToolCall.function?.name || void 0;
        let entry = index !== void 0 ? rawByIndex.get(index) : void 0;
        if (!entry && id) entry = rawById.get(id);
        if (!entry && index === void 0 && !id && !name) entry = rawToolCalls.at(-1);
        if (!entry) {
          entry = { id: "", name: "", argumentsText: "" };
          rawToolCalls.push(entry);
        }
        if (index !== void 0 && !rawByIndex.has(index)) rawByIndex.set(index, entry);
        if (id && !entry.id) {
          entry.id = id;
          rawById.set(id, entry);
        }
        if (name && !entry.name) entry.name = name;
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
          throw new TauError("stream_error", `Stream read failed: ${describeError(cause)}`, cause);
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
    throwIfAborted(options?.signal);
    if (mappedStop?.stopReason === "error") {
      throw new TauError("stream_error", mappedStop.errorMessage ?? "Provider returned an error stop reason");
    }
    if (mappedStop === void 0 && config.supportsFinishReason !== false) {
      throw new TauError("stream_error", "Stream ended without finish_reason");
    }
    const seenIds = /* @__PURE__ */ new Set();
    const toolCalls = rawToolCalls.filter((raw) => raw.name !== "").map((raw) => {
      let parsedArguments = {};
      try {
        const parsed = raw.argumentsText === "" ? {} : parseJsonWithRepair(raw.argumentsText);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArguments = parsed;
        }
      } catch {
      }
      let id = raw.id;
      if (id === "" || seenIds.has(id)) id = `call_${uuidv7(platform2.randomBytes).replace(/-/g, "").slice(-12)}`;
      seenIds.add(id);
      return { type: "toolCall", id, name: raw.name, arguments: parsedArguments };
    });
    for (const toolCall of toolCalls) {
      blocks.push(toolCall);
      yield { type: "tool_call", toolCall };
    }
    const message = {
      role: "assistant",
      content: blocks,
      api,
      provider,
      model,
      usage: usage ?? emptyUsage(),
      stopReason: mappedStop?.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop"),
      ...finishReason !== void 0 ? { rawStopReason: finishReason } : {},
      ...responseId !== void 0 ? { responseId } : {},
      ...responseModel !== void 0 ? { responseModel } : {},
      timestamp: startedAt
    };
    yield { type: "response_end", message };
  }
  function createOpenAICompatTransport(platform2, config) {
    const transport = (request) => streamChatCompletion(platform2, config, request.messages, {
      signal: request.signal,
      maxTokens: request.maxTokens,
      headers: request.headers,
      thinkingLevel: request.thinkingLevel,
      model: request.model
    });
    transport.supportsHeaders = true;
    return transport;
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

  // ../../../packages/kernel/src/policy.ts
  function resolvePolicyAction(mode, risk) {
    switch (mode) {
      case "bypass":
        return "allow";
      case "read-only":
        return risk === "low" ? "allow" : "deny";
      case "supervised":
        return risk === "low" ? "allow" : "ask";
      case "autonomous":
        return risk === "high" ? "ask" : "allow";
    }
  }
  var DEFAULT_PROTECTED_PATHS = [
    ".git",
    ".ssh",
    ".env*",
    "~/.tau/trust.json",
    "~/.tau/permissions.json"
  ];
  var DEFAULT_DANGEROUS_PATTERNS = [
    {
      pattern: /\brm\s+(?:[^|;&>]*\s)?-(?:[a-z]*[rf][a-z]*|-recursive|-force|-no-preserve-root)\b/i,
      label: "rm with recursive/force flags"
    },
    { pattern: /\bsudo\b/, label: "sudo" },
    {
      pattern: /\bch(?:mod|own)\b[^|;&]*\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b[^|;&]*\s\/(?:\s|$)/,
      label: "recursive chmod/chown on /"
    },
    {
      pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/i,
      label: "pipes a downloaded script into a shell"
    },
    { pattern: /\bgit\s+push\b[^|;&]*(?:--force\b(?!-)|\s-f\b)/, label: "git push --force" },
    {
      pattern: /(?:>\s*|\bdd\b[^|;&]*\bof=)\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b)\w/i,
      label: "writes to a raw device"
    },
    { pattern: /\bmkfs\b/i, label: "mkfs" },
    {
      pattern: /:\(\)\s*\{\s*:\s*\|\s*:|(\w+)\s*\(\)\s*\{[^}]*\b\1\s*\|\s*\1\b/,
      label: "fork bomb"
    },
    // Windows: the Node host routes native commands to cmd.exe, so these run for real there.
    { pattern: /\b(?:rd|rmdir)\b[^|&\r\n]*\s\/s\b/i, label: "recursive directory removal (rd /s)" },
    { pattern: /\b(?:del|erase)\b[^|&\r\n]*\s\/[sqf]\b/i, label: "recursive/forced delete (del /s, /q, /f)" },
    { pattern: /\bformat(?:\.com)?\s+[a-z]:/i, label: "format drive" },
    { pattern: /\bdiskpart\b/i, label: "diskpart" },
    { pattern: /\breg(?:\.exe)?\s+delete\b/i, label: "registry delete" },
    {
      pattern: /\b(?:Remove-Item|ri)\b[^|;\r\n]*\s-(?:Recurse|Force|r|fo)\b/i,
      label: "PowerShell Remove-Item -Recurse/-Force"
    }
  ];
  var PATH_PROBE_KEYS = ["path", "file_path", "file", "filename", "dest", "target"];
  var COMMAND_PROBE_KEYS = ["command", "cmd", "script"];
  var READ_TOOLS = /* @__PURE__ */ new Set(["read", "listDir"]);
  var WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
  var BASH_TOOLS = /* @__PURE__ */ new Set(["bash"]);
  function pathSegments(path) {
    return path.replace(/\\/g, "/").toLowerCase().split("/").filter((segment) => segment !== "" && segment !== "." && segment !== "~");
  }
  function segmentMatches(pattern, segment) {
    if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
    return segment === pattern;
  }
  function pathHitsEntry(segments, entrySegments) {
    if (entrySegments.length === 0) return false;
    outer: for (let start = 0; start + entrySegments.length <= segments.length; start++) {
      for (let offset = 0; offset < entrySegments.length; offset++) {
        if (!segmentMatches(entrySegments[offset], segments[start + offset])) continue outer;
      }
      return true;
    }
    return false;
  }
  function probeStrings(args, keys) {
    const found = [];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value !== "") found.push(value);
    }
    return found;
  }
  function createDefaultPolicy(options) {
    const protectedEntries = [...DEFAULT_PROTECTED_PATHS, ...options?.protectedPaths ?? []].map((entry) => ({
      entry,
      segments: pathSegments(entry)
    }));
    const dangerousPatterns = [
      ...DEFAULT_DANGEROUS_PATTERNS,
      ...(options?.dangerousPatterns ?? []).map((pattern) => ({ pattern, label: "custom dangerous pattern" }))
    ];
    const classify = (call) => {
      if (READ_TOOLS.has(call.toolName)) return { risk: "low" };
      if (WRITE_TOOLS.has(call.toolName)) {
        for (const target of probeStrings(call.args, PATH_PROBE_KEYS)) {
          const segments = pathSegments(target);
          for (const { entry, segments: entrySegments } of protectedEntries) {
            if (pathHitsEntry(segments, entrySegments)) {
              return { risk: "high", reason: `"${target}" touches protected path "${entry}"` };
            }
          }
        }
        return { risk: "medium" };
      }
      if (BASH_TOOLS.has(call.toolName)) {
        for (const command of probeStrings(call.args, COMMAND_PROBE_KEYS)) {
          for (const { pattern, label } of dangerousPatterns) {
            if (pattern.test(command)) return { risk: "high", reason: `command matches: ${label}` };
          }
        }
        return { risk: "medium" };
      }
      return { risk: call.declaredRisk ?? "medium" };
    };
    return {
      assess(call, mode) {
        const { risk, reason } = classify(call);
        return { risk, action: resolvePolicyAction(mode, risk), reason };
      }
    };
  }

  // ../../../packages/kernel/src/session.ts
  function generateEntryId(randomBytes, has) {
    for (let i = 0; i < 100; i++) {
      const id = [...randomBytes(4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!has(id)) return id;
    }
    return uuidv7(randomBytes);
  }
  function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }
  var EntryTree = class {
    constructor() {
      __publicField(this, "entries", []);
      __publicField(this, "byId", /* @__PURE__ */ new Map());
      __publicField(this, "leafId", null);
    }
    /**
     * Entries are append-only and deep-frozen on the way in (P22): the agent's
     * projection shares their message objects, so an in-place edit of a logged
     * message throws instead of silently rewriting history.
     */
    add(entry) {
      deepFreeze(entry);
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      if (entry.type === "leaf") this.leafId = entry.leafId;
      else this.leafId = entry.id;
    }
    pathToRoot(leafId) {
      const path = [];
      let currentId = leafId;
      while (currentId !== null) {
        const entry = this.byId.get(currentId);
        if (!entry) throw new SessionError("invalid_entry", `Entry ${currentId} not found while walking to root`);
        path.push(entry);
        currentId = entry.parentId;
      }
      return path.reverse();
    }
  };
  var InMemorySessionStore = class {
    constructor(metadata, randomBytes) {
      __publicField(this, "metadata");
      __publicField(this, "tree", new EntryTree());
      __publicField(this, "randomBytes");
      this.metadata = metadata;
      this.randomBytes = randomBytes;
    }
    async getMetadata() {
      return { ...this.metadata, name: lastSessionName(this.tree.entries) ?? this.metadata.name };
    }
    async getLeafId() {
      return this.tree.leafId;
    }
    async setLeafId(leafId) {
      this.tree.add({
        type: "leaf",
        id: generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id)),
        parentId: null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        leafId
      });
    }
    async createEntryId() {
      return generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id));
    }
    async appendEntry(entry) {
      this.tree.add(entry);
    }
    async getEntry(id) {
      return this.tree.byId.get(id);
    }
    async getPathToRoot(leafId) {
      return this.tree.pathToRoot(leafId);
    }
    async getEntries() {
      return [...this.tree.entries];
    }
  };
  function lastSessionName(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "session_info") return entry.name;
    }
    return void 0;
  }
  var SessionRecorder = class _SessionRecorder {
    constructor(store, leafId) {
      __publicField(this, "store");
      __publicField(this, "leafId");
      this.store = store;
      this.leafId = leafId;
    }
    static async open(store) {
      return new _SessionRecorder(store, await store.getLeafId());
    }
    /** Recorder over a store whose leaf is already known (a fresh store: null). */
    static attach(store, leafId) {
      return new _SessionRecorder(store, leafId);
    }
    get currentLeafId() {
      return this.leafId;
    }
    /** Append an entry at the current leaf and return it as stored. */
    async append(draft) {
      const id = await this.store.createEntryId();
      const entry = JSON.parse(
        JSON.stringify({ ...draft, id, parentId: this.leafId, timestamp: (/* @__PURE__ */ new Date()).toISOString() })
      );
      await this.store.appendEntry(entry);
      this.leafId = id;
      return entry;
    }
    async recordCompaction(result) {
      return this.append({ type: "compaction", ...result });
    }
    /** Record a message; custom messages become custom_message entries (pi). Returns the entry. */
    async recordMessage(message) {
      if (message.role === "custom") {
        return this.append({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details
        });
      }
      return this.append({ type: "message", message });
    }
    /** Omit (null) or replace the content of an entry in future context; the entry itself stays (pi 0.87.0). */
    async appendContextEdit(targetId, replacement) {
      return this.append({ type: "context_edit", targetId, replacement });
    }
    /** Bookmark an entry; an undefined label clears it (pi LabelEntry). */
    async appendLabel(targetId, label) {
      return this.append({ type: "label", targetId, label });
    }
    async appendCustom(customType, data) {
      return this.append({ type: "custom", customType, data });
    }
    async setName(name) {
      return this.append({ type: "session_info", name });
    }
    /**
     * Move the active leaf to another entry (session-tree navigation),
     * optionally recording a branch_summary of the abandoned branch at the new
     * position. Mirrors pi's Session.moveTo. Deviation: pi's implementation
     * writes fromId = destination id (redundant with parentId); tau records the
     * abandoned branch's old leaf, matching pi's session-format.md ("Entry we
     * branched from") whose example has fromId ≠ parentId.
     */
    async moveTo(entryId, summary) {
      if (entryId !== null && !await this.store.getEntry(entryId)) {
        throw new SessionError("not_found", `Entry ${entryId} not found`);
      }
      const fromId = this.leafId ?? "root";
      await this.store.setLeafId(entryId);
      this.leafId = entryId;
      if (!summary) return void 0;
      const id = await this.store.createEntryId();
      const entry = {
        type: "branch_summary",
        id,
        parentId: entryId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        fromId,
        summary: summary.summary,
        details: summary.details,
        ...summary.usage ? { usage: summary.usage } : {},
        fromHook: summary.fromHook
      };
      await this.store.appendEntry(entry);
      this.leafId = id;
      return entry;
    }
  };

  // ../../../packages/kernel/src/tool-batch.ts
  var PreflightLock = class {
    constructor() {
      __publicField(this, "tail", Promise.resolve());
    }
    async run(work) {
      const previous = this.tail;
      let release = () => {
      };
      this.tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
  var ToolBatchRunner = class {
    constructor(host2) {
      __publicField(this, "host");
      this.host = host2;
    }
    /** Sequential batch: the pre-P18 behavior — full hook chain, execute, result, one tool at a time. */
    async *runSequential(toolCalls, tools, ctx, signal, batch) {
      for (const toolCall of toolCalls) {
        yield { type: "tool_start", toolCall };
        const updates = [];
        let wakeUpdate;
        let executionDone = false;
        const execution = this.executeToolCall(toolCall, tools, ctx, signal, (update) => {
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
        yield await this.host.commit(toolCall, result, ctx, batch);
      }
    }
    /**
     * Parallel batch (P18, structure mirrors pi executeToolCallsParallel):
     * phase 1 — preflight serially in source order (tool_call hook, validation,
     * policy/approval, tool_execution_start; immediate outcomes settle here);
     * phase 2 — execute prepared tools concurrently, tool_execution_end and
     * tool_update stream in completion/arrival order; phase 3 — tool results
     * commit to messages/session in assistant source order (stable wire order).
     * Deviation from pi: no break on abort mid-preflight — every tool call gets
     * a result (existing tau sequential semantics; tools observe the signal and
     * settle fast), keeping the wire's call/result pairing always complete.
     */
    async *runParallel(toolCalls, tools, ctx, signal, batch) {
      const preps = [];
      for (const toolCall of toolCalls) {
        yield { type: "tool_start", toolCall };
        preps.push(await this.preflightToolCall(toolCall, tools, ctx, signal));
      }
      const pump = [];
      let wake;
      const push = (item) => {
        pump.push(item);
        wake?.();
        wake = void 0;
      };
      const outcomes = new Array(preps.length);
      let running = 0;
      preps.forEach((prep, index) => {
        if (prep.kind === "immediate") {
          outcomes[index] = prep.result;
          return;
        }
        running++;
        this.executePreparedToolCall(prep, ctx, signal, (update) => {
          push({ kind: "update", toolCall: prep.toolCall, update });
        }).then(
          (result) => {
            outcomes[index] = result;
            running--;
            push({ kind: "done" });
          },
          (cause) => {
            outcomes[index] = errorResult(toError(cause).message);
            running--;
            push({ kind: "done" });
          }
        );
      });
      while (running > 0 || pump.length > 0) {
        const item = pump.shift();
        if (item) {
          if (item.kind === "update") {
            yield {
              type: "tool_update",
              toolCall: item.toolCall,
              partialOutput: item.update.partialOutput,
              stream: item.update.stream
            };
          }
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      for (let index = 0; index < preps.length; index++) {
        yield await this.host.commit(preps[index].toolCall, outcomes[index], ctx, batch);
      }
    }
    async executeToolCall(toolCall, tools, ctx, signal, onUpdate) {
      const prep = await this.preflightToolCall(toolCall, tools, ctx, signal);
      if (prep.kind === "immediate") return { result: prep.result };
      return { result: await this.executePreparedToolCall(prep, ctx, signal, onUpdate) };
    }
    /**
     * A call another tool made (ctx.executeTool): the same preflight and execution as
     * a model-issued call, with `parentToolCallId` on its events and approval request.
     */
    async runNested(toolCall, tools, ctx, parentToolCallId, signal, onUpdate) {
      const prep = await this.preflightToolCall(toolCall, tools, ctx, signal, parentToolCallId);
      if (prep.kind === "immediate") return prep.result;
      return this.executePreparedToolCall(
        prep,
        ctx,
        signal,
        onUpdate ? (update) => onUpdate(update.partialOutput, update.stream) : void 0
      );
    }
    /**
     * Serial preflight of one tool call: tool_call hook (block/rewrite),
     * argument validation, policy gate, approval, and — for calls that will
     * execute — the tool_execution_start notification. Immediate outcomes
     * (unknown tool, block, invalid args, deny) never see execution hooks.
     */
    preflightToolCall(toolCall, tools, ctx, signal, parentToolCallId) {
      return this.host.preflightLock.run(() => this.preflightLocked(toolCall, tools, ctx, signal, parentToolCallId));
    }
    async preflightLocked(toolCall, tools, ctx, signal, parentToolCallId) {
      const parent = parentToolCallId !== void 0 ? { parentToolCallId } : {};
      const tool = tools.get(toolCall.name);
      if (!tool) {
        return { kind: "immediate", toolCall, result: errorResult(`Unknown tool: ${toolCall.name}`) };
      }
      let args = JSON.parse(JSON.stringify(toolCall.arguments));
      if (this.host.extensions) {
        const event = {
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args,
          ...parent
        };
        const decision = await this.host.extensions.runToolCall(event, ctx);
        if (decision.blocked) {
          const blocked = errorResult(`Tool call blocked: ${decision.reason ?? "blocked by extension"}`);
          return { kind: "immediate", toolCall, result: decision.terminate ? { ...blocked, terminate: true } : blocked };
        }
        args = event.input;
      }
      if (signal?.aborted) return { kind: "immediate", toolCall, result: abortedResult() };
      if (!hasToolSchema(tool)) {
        return {
          kind: "immediate",
          toolCall,
          result: errorResult(`Tool ${toolCall.name} has no parameters schema and cannot be called`)
        };
      }
      const problems = validateToolArgs(tool.parameters, args);
      if (problems.length > 0) {
        return {
          kind: "immediate",
          toolCall,
          result: errorResult(`Invalid arguments for ${toolCall.name}: ${problems.join("; ")}`)
        };
      }
      const policyDecision = this.host.policy.assess(
        { toolName: toolCall.name, args, declaredRisk: tool.risk },
        this.host.permissionMode
      );
      const riskText = policyDecision.reason ?? `${policyDecision.risk}-risk tool call in ${this.host.permissionMode} mode`;
      if (policyDecision.action === "deny") {
        return { kind: "immediate", toolCall, result: errorResult(`Denied by policy: ${riskText}`) };
      }
      if (policyDecision.action === "ask") {
        const handler = this.host.onApproval ?? this.uiApprovalHandler();
        if (!handler) {
          return {
            kind: "immediate",
            toolCall,
            result: errorResult(
              `Denied by policy: approval required (${riskText}), but no approval handler is available`
            )
          };
        }
        const request = {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args,
          risk: policyDecision.risk,
          reason: policyDecision.reason,
          ...parent
        };
        let approved;
        try {
          approved = await this.awaitApproval(handler, request, signal);
        } catch (cause) {
          return {
            kind: "immediate",
            toolCall,
            result: errorResult(`Denied by policy: approval failed (${toError(cause).message})`)
          };
        }
        if (!approved) {
          return {
            kind: "immediate",
            toolCall,
            result: errorResult(`Denied by policy: approval declined (${riskText})`)
          };
        }
      }
      await this.host.extensions?.notifyToolExecutionStart(
        { toolCallId: toolCall.id, toolName: toolCall.name, args, ...parent },
        ctx
      );
      return { kind: "prepared", toolCall, tool, args, ...parent };
    }
    /** Execute a prepared tool call: updates stream, tool_execution_end, tool_result hook. */
    async executePreparedToolCall(prep, ctx, signal, onUpdate) {
      const { toolCall, tool, args } = prep;
      const parent = prep.parentToolCallId !== void 0 ? { parentToolCallId: prep.parentToolCallId } : {};
      const updateNotifications = [];
      let acceptingUpdates = true;
      const emitUpdate = (partialOutput, stream) => {
        if (!acceptingUpdates) return;
        if (this.host.extensions) {
          const notification = this.host.extensions.notifyToolExecutionUpdate(
            { toolCallId: toolCall.id, toolName: toolCall.name, args, partialOutput, stream, ...parent },
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
      let durationMs;
      if (signal?.aborted) {
        result = abortedResult();
      } else {
        const startedAt = Date.now();
        try {
          result = await tool.execute(args, signal, emitUpdate, this.host.toolContext(ctx, toolCall.id, signal));
        } catch (cause) {
          result = errorResult(cause instanceof Error ? cause.message : String(cause));
        }
        durationMs = Math.max(0, Date.now() - startedAt);
      }
      acceptingUpdates = false;
      await Promise.all(updateNotifications);
      await this.host.extensions?.notifyToolExecutionEnd(
        {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result,
          ...durationMs !== void 0 ? { durationMs } : {},
          ...parent
        },
        ctx
      );
      if (this.host.extensions) {
        result = normalizeToolOutcome(toolCall.name, result);
        const finalResult = await this.host.extensions.runToolResult(
          {
            type: "tool_result",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ...parent,
            input: args,
            content: result.content,
            ...result.details !== void 0 ? { details: result.details } : {},
            isError: result.isError === true,
            ...result.usage ? { usage: result.usage } : {},
            ...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {}
          },
          ctx
        );
        result = {
          content: finalResult.content,
          ...finalResult.details !== void 0 ? { details: finalResult.details } : {},
          isError: finalResult.isError,
          ...finalResult.usage ? { usage: finalResult.usage } : {},
          ...finalResult.structuredContent !== void 0 ? { structuredContent: finalResult.structuredContent } : {},
          ...result.terminate ? { terminate: true } : {}
        };
      }
      return durationMs !== void 0 ? { ...result, durationMs } : result;
    }
    /** Default approval handler over the host UI; no UI means no handler (ask degrades to deny). */
    uiApprovalHandler() {
      const ui = this.host.ui();
      if (!ui) return void 0;
      return (request) => {
        const summary = JSON.stringify(request.args) ?? "{}";
        const detail = summary.length > 400 ? `${summary.slice(0, 400)}\u2026` : summary;
        return ui.confirm(
          `Allow ${request.toolName}? (${request.risk} risk${request.parentToolCallId === void 0 ? "" : ", called by another tool"})`,
          request.reason ? `${request.reason}
${detail}` : detail
        );
      };
    }
    /** Wait for an approval decision; an abort while waiting counts as a rejection. */
    awaitApproval(handler, request, signal) {
      if (signal?.aborted) return Promise.resolve(false);
      const decision = handler(request);
      if (!signal) return decision;
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        decision.then(
          (value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (cause) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(cause);
          }
        );
      });
    }
  };
  function abortedResult() {
    return errorResult("Operation aborted");
  }
  function normalizeToolOutcome(toolName, outcome) {
    if (Array.isArray(outcome?.content)) return outcome;
    const legacy = typeof outcome?.output === "string";
    return {
      ...errorResult(
        legacy ? `Tool ${toolName} returned { output } \u2014 tools return { content: [{ type: "text", text }] } since P23` : `Tool ${toolName} returned an invalid result (expected { content })`
      ),
      ...outcome?.durationMs !== void 0 ? { durationMs: outcome.durationMs } : {}
    };
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
    /** Put messages polled but never committed back at the front (an abort between poll and commit). */
    restore(messages) {
      this.items.unshift(...messages);
    }
    /** Empty the queue and return what was in it (pi clearQueue: hosts restore it to the editor). */
    clear() {
      return this.items.splice(0);
    }
  };
  var DEFAULT_MAX_TURNS = 50;
  function lastPromptText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user") return userContentText(message.content);
      if (message.role === "custom") {
        return typeof message.content === "string" ? message.content : userContentText(message.content);
      }
    }
    return "";
  }
  var Agent = class _Agent {
    constructor(options) {
      /** Projection of the session log (frozen; replaced after every write). */
      __publicField(this, "projection", Object.freeze([]));
      /** Source entry of each projected message (pi _entryIdsByMessage). */
      __publicField(this, "entryIds", /* @__PURE__ */ new WeakMap());
      /** The active path and its projection as of the last refresh (for sync estimates). */
      __publicField(this, "activePath", []);
      __publicField(this, "activeProjection", { entries: [], messages: [] });
      /** Session-wide billed usage as of the last refresh (sumSessionUsage). */
      __publicField(this, "sessionUsage", emptyUsage());
      /** Every entry and the store metadata as of the last refresh (backs ctx.sessionManager). */
      __publicField(this, "allEntries", []);
      __publicField(this, "entriesById", /* @__PURE__ */ new Map());
      __publicField(this, "sessionMetadata");
      __publicField(this, "readonlySessionManager");
      __publicField(this, "platform");
      __publicField(this, "config");
      __publicField(this, "transport");
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
      __publicField(this, "pricing");
      /** Model of this agent's requests (Agent.setModel; starts as config.model). */
      __publicField(this, "currentModel");
      __publicField(this, "currentThinkingLevel");
      __publicField(this, "permissionMode");
      __publicField(this, "policy");
      __publicField(this, "onApproval");
      __publicField(this, "toolExecution");
      __publicField(this, "verifyTranscript");
      /** Custom instructions of a requested compaction, or null when none is pending. */
      __publicField(this, "pendingCompaction", null);
      /** Custom messages held for the next run's context (sendMessage deliverAs:"nextTurn"). */
      __publicField(this, "pendingNextTurn", []);
      /**
       * The single writer: every log append (and the projection refresh after it)
       * runs here in order. Sync extension actions enqueue without awaiting; their
       * failure is held in `writeFailure` and rethrown at the next flushWrites().
       */
      __publicField(this, "writes", Promise.resolve());
      __publicField(this, "writeFailure");
      /** The operation holding the agent, if any (prompt/resume/compact/navigateTo). */
      __publicField(this, "operation");
      /** Extension sendMessage calls made while a compaction or navigation holds the agent; appended when it ends. */
      __publicField(this, "heldMessages", []);
      /** Custom messages sent with triggerTurn:false while the loop runs; committed after the current turn_end (pi 0.84.4). */
      __publicField(this, "afterTurnMessages", []);
      /** Whether the current prompt reached the turn loop (agent_settled fires only then). */
      __publicField(this, "runEntered", false);
      /** True while agent_settled handlers run; runs they start wait until all returned (pi 0.87.1). */
      __publicField(this, "settling", false);
      __publicField(this, "deferredStarts", []);
      __publicField(this, "finishTurn");
      __publicField(this, "isProjectTrusted");
      /** Runs tool batches: preflight (hooks, validation, policy, approval), execution, result hooks. */
      __publicField(this, "toolRunner");
      __publicField(this, "preflightLock");
      /** Calls tools make through ctx.executeTool(), and their record per model-issued call. */
      __publicField(this, "nestedCalls");
      /** The active tools by name: declared to the model (pi agent.state.tools). */
      __publicField(this, "activeNames", /* @__PURE__ */ new Set());
      /** Each registered tool as last seen, to activate new registrations (pi _refreshToolRegistry). */
      __publicField(this, "seenTools", /* @__PURE__ */ new Map());
      /** Active tools restored from the transcript that are not registered yet (pi _pendingToolNames). */
      __publicField(this, "pendingTools", /* @__PURE__ */ new Set());
      /** Set once a host or extension chose the active tools; the initial transcript restore then yields to it. */
      __publicField(this, "toolsChosen", false);
      /** Declared tools that prepareLoadout hooks leave out of requests (pi _hiddenDeclarations). */
      __publicField(this, "hiddenDeclarations", /* @__PURE__ */ new Set());
      /**
       * True only while the LLM turn loop is in flight — pi's isStreaming. Hooks
       * that fire before the loop (input, before_agent_start) see false, so their
       * sendMessage lands immediately instead of being queued as steering.
       */
      __publicField(this, "looping", false);
      /** Abort handle of the operation in flight; abort() and ctx.abort() fire it. */
      __publicField(this, "activeAbort");
      this.platform = options.platform ?? defaultPlatform();
      this.config = options.config;
      this.transport = options.transport ?? createOpenAICompatTransport(this.platform, this.config);
      this.systemPrompt = options.systemPrompt;
      this.baseTools = [...options.tools ?? []];
      for (const tool of this.baseTools) assertToolSchema(tool);
      this.extensions = options.extensions;
      this.ui = options.ui;
      this.capabilities = { ...options.capabilities, platform: this.platform };
      const seed = (options.initialMessages ?? []).map(normalizeMessageContent);
      this.projection = Object.freeze(seed);
      if (options.session) {
        this.session = options.session;
        this.enqueueBackground(async () => {
          await this.refresh();
          this.restoreToolsFromTranscript({ initial: true });
        });
      } else {
        const store = new InMemorySessionStore(
          { id: uuidv7(this.platform.randomBytes), cwd: "/", timestamp: (/* @__PURE__ */ new Date()).toISOString() },
          this.platform.randomBytes
        );
        this.session = SessionRecorder.attach(store, null);
        if (seed.length > 0) {
          this.enqueueBackground(async () => {
            for (const message of seed) await this.session.recordMessage(message);
            await this.refresh();
            this.restoreToolsFromTranscript({ initial: true });
          });
        }
      }
      this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
      this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
      this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
      this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
      this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options.retry };
      this.pricing = options.pricing;
      this.currentModel = options.config.model;
      this.currentThinkingLevel = options.thinkingLevel;
      this.permissionMode = options.permissionMode ?? "autonomous";
      this.policy = options.policy ?? createDefaultPolicy();
      this.onApproval = options.onApproval;
      this.toolExecution = options.toolExecution ?? "parallel";
      this.verifyTranscript = options.verifyTranscript ?? true;
      this.finishTurn = options.finishTurn;
      this.isProjectTrusted = options.isProjectTrusted;
      this.preflightLock = options.preflightLock ?? new PreflightLock();
      const currentPermissionMode = () => this.permissionMode;
      this.toolRunner = new ToolBatchRunner({
        extensions: this.extensions,
        policy: this.policy,
        // Read on every preflight: setPermissionMode() applies to the next tool call.
        get permissionMode() {
          return currentPermissionMode();
        },
        onApproval: this.onApproval,
        ui: () => this.ui,
        preflightLock: this.preflightLock,
        toolContext: (ctx, toolCallId, signal) => this.toolContext(ctx, toolCallId, signal),
        commit: (toolCall, outcome, ctx, batch) => this.commitToolResult(toolCall, outcome, ctx, batch)
      });
      this.nestedCalls = new NestedToolCallRunner({
        getTools: () => this.callableTools(),
        isSequential: () => this.toolExecution === "sequential",
        runToolCall: (toolCall, tools, parentToolCallId, signal, onUpdate) => this.toolRunner.runNested(toolCall, tools, this.extensionContext(), parentToolCallId, signal, onUpdate)
      });
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
            if (sendOptions?.triggerTurn === false) this.afterTurnMessages.push(message);
            else if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
            else this.steeringQueue.enqueue(message);
            return;
          }
          if (this.operation === "compact" || this.operation === "navigate") {
            this.heldMessages.push({ message, triggerTurn: sendOptions?.triggerTurn === true });
            return;
          }
          this.enqueueBackground(() => this.appendAndRefresh(message));
          if (sendOptions?.triggerTurn) {
            const resume = this.extensions?.hostAction("resumeTurn");
            if (resume && this.settling) this.deferredStarts.push(resume);
            else resume?.();
          }
        },
        sendUserMessage: (content, sendOptions) => {
          if (this.looping) {
            const behavior = sendOptions?.deliverAs === "followUp" ? "followUp" : "steer";
            this.enqueueBackground(() => this.queueUserInput(content, behavior, "extension"));
            return;
          }
          if (this.operation === "prompt" || this.operation === "resume") {
            throw new TauError("busy", "sendUserMessage() before the agent loop started; use sendMessage({ deliverAs })");
          }
          if (this.operation !== void 0) {
            throw new TauError(
              "busy",
              `sendUserMessage() while ${this.operation === "compact" ? "compacting" : "navigating"}; use sendMessage({ deliverAs })`
            );
          }
          const submit = this.extensions?.hostAction("submitPrompt");
          if (!submit) {
            throw new TauError("no_host", "sendUserMessage() while idle requires a host that provides submitPrompt");
          }
          if (this.settling) this.deferredStarts.push(() => submit(content));
          else submit(content);
        },
        appendEntry: (customType, data) => {
          this.enqueueBackground(async () => {
            await this.session.appendCustom(customType, data);
            await this.refresh();
          });
        },
        setSessionName: (name) => {
          this.enqueueBackground(async () => {
            await this.session.setName(name);
            await this.refresh();
          });
          void this.extensions?.notifySessionInfoChanged(name, this.extensionContext());
        },
        setLabel: (entryId, label) => {
          if (!this.entriesById.has(entryId)) throw new SessionError("not_found", `Entry ${entryId} not found`);
          this.enqueueBackground(async () => {
            await this.session.appendLabel(entryId, label);
            await this.refresh();
          });
        },
        abort: () => {
          this.abort("Aborted by extension");
        },
        getActiveTools: () => this.getActiveTools(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveTools(toolNames),
        getSessionName: () => this.sessionMetadata?.name,
        setModel: (model) => this.switchModelForExtension(model),
        getThinkingLevel: () => this.currentThinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level)
      });
    }
    /** Every registered tool: base tools, then extension tools (which override same-name base tools, as in pi). */
    currentTools() {
      const tools = new Map(this.baseTools.map((tool) => [tool.name, tool]));
      for (const [name, tool] of this.extensions?.tools ?? []) tools.set(name, tool);
      return tools;
    }
    /**
     * Take new registrations into the active set (pi _refreshToolRegistry): a tool
     * restored from the transcript becomes active once registered; a new tool that is
     * activated on registration joins; a re-registered tool keeps its state unless it
     * newly became activated on registration (e.g. from `hidden` back to `direct`).
     */
    syncRegistrations() {
      const tools = this.currentTools();
      for (const [name, tool] of tools) {
        const previous = this.seenTools.get(name);
        if (previous === tool) continue;
        this.seenTools.set(name, tool);
        if (this.pendingTools.has(name) && toolExposure(tool) !== "hidden") {
          this.pendingTools.delete(name);
          this.activeNames.add(name);
        } else if (isActivatedOnRegistration(tool) && !(previous && isActivatedOnRegistration(previous))) {
          this.activeNames.add(name);
        }
      }
      for (const name of this.seenTools.keys()) {
        if (!tools.has(name)) {
          this.seenTools.delete(name);
          this.activeNames.delete(name);
        }
      }
      return tools;
    }
    /** The active tools (declared to the model, in registration order); `hidden` tools never are (pi). */
    activeTools() {
      const active = /* @__PURE__ */ new Map();
      for (const [name, tool] of this.syncRegistrations()) {
        if (this.activeNames.has(name) && toolExposure(tool) !== "hidden") active.set(name, tool);
      }
      return active;
    }
    /** Names of the active tools, the ones declared to the model (pi getActiveTools). */
    getActiveTools() {
      return [...this.activeTools().keys()];
    }
    toolInfo(tool) {
      return toToolInfo(tool, this.extensions?.tools.get(tool.name) === tool ? "extension" : "builtin");
    }
    /** Every registered tool, active or not (pi getAllTools). */
    getAllTools() {
      return [...this.syncRegistrations().values()].map((tool) => this.toolInfo(tool));
    }
    /**
     * Tools callable through `ctx.executeTool()` (pi _getCallableTools): the active
     * `direct` tools and every registered `codemode` or `deferred` tool.
     */
    callableTools(active = new Set(this.activeTools().keys())) {
      const callable = /* @__PURE__ */ new Map();
      for (const [name, tool] of this.syncRegistrations()) {
        const exposure = toolExposure(tool);
        if (exposure === "codemode" || exposure === "deferred" || exposure === "direct" && active.has(name)) {
          callable.set(name, tool);
        }
      }
      return callable;
    }
    /** Tools callable through `ctx.executeTool()`, without `execute`. */
    getCallableTools() {
      return [...this.callableTools().values()].map((tool) => this.toolInfo(tool));
    }
    /**
     * The context one tool call's execute receives (pi ExtensionToolContext): the
     * shared context plus executeTool/tools bound to this call. Only tools get it —
     * handlers keep the plain context, so a tool_call handler cannot recurse.
     */
    toolContext(ctx, toolCallId, signal) {
      const toolCtx = Object.create(ctx);
      Object.defineProperty(toolCtx, "tools", { get: () => this.getCallableTools(), enumerable: true });
      Object.defineProperty(toolCtx, "executeTool", {
        value: (name, args, options = {}) => this.nestedCalls.execute(toolCallId, name, args, {
          signal: options.signal ?? signal,
          onUpdate: options.onUpdate
        }),
        enumerable: true
      });
      return toolCtx;
    }
    /**
     * Set the active tools by name (pi setActiveTools): unknown and `hidden` tools are
     * ignored, and the change applies from the next request. Only registered tools can
     * be activated, so a permission mode that never registered a tool keeps it out
     * (D20). Deactivating any tool drops the names still pending from the transcript;
     * a change that only adds tools (tool_search loading some) keeps them (pi).
     */
    setActiveTools(toolNames) {
      this.toolsChosen = true;
      const previous = this.getActiveTools();
      this.applyActiveTools(toolNames);
      const active = new Set(this.getActiveTools());
      if (previous.some((name) => !active.has(name))) this.pendingTools.clear();
    }
    applyActiveTools(toolNames) {
      const tools = this.syncRegistrations();
      const wanted = new Set(toolNames);
      this.activeNames = new Set(
        [...tools.values()].filter((tool) => wanted.has(tool.name) && toolExposure(tool) !== "hidden").map((tool) => tool.name)
      );
      for (const name of this.activeNames) this.pendingTools.delete(name);
    }
    /**
     * Restore the active tools the transcript declares, if it declares any (pi
     * _restoreToolsFromTranscript). Names not registered yet stay pending until their
     * tool registers (MCP servers still connecting) or the next run starts.
     */
    restoreToolsFromTranscript(options = {}) {
      if (options.initial && this.toolsChosen) return;
      this.pendingTools.clear();
      const current = getCurrentSystemMessage(this.messages);
      if (!current) return;
      const names = (current.toolsAdded ?? []).map((tool) => tool.name);
      this.pendingTools = new Set(names);
      this.applyActiveTools(names);
    }
    /**
     * The declarations a request carries (pi _applyToolLoadout): the active tools with
     * the descriptions their prepareLoadout hooks set, and the names whose declarations
     * requests leave out. Hooks run in registration order; one that throws is reported
     * and skipped.
     */
    computeLoadout() {
      const active = this.activeTools();
      const tools = [...active.values()];
      const hooks = tools.filter((tool) => tool.prepareLoadout);
      const hidden = /* @__PURE__ */ new Set();
      if (hooks.length === 0) return { declared: tools, hidden };
      const registered = this.syncRegistrations();
      const loadout = {
        declared: tools.map((tool) => this.toolInfo(tool)),
        callable: [...this.callableTools(new Set(active.keys())).values()].map((tool) => this.toolInfo(tool)),
        registered: [...registered.values()].map((tool) => this.toolInfo(tool)),
        getExposure: (name) => {
          const tool = registered.get(name);
          return tool ? toolExposure(tool) : "direct";
        },
        getNamespace: (name) => registered.get(name)?.namespace,
        getPromptGuidelines: (name) => registered.get(name)?.promptGuidelines ?? []
      };
      const descriptions = /* @__PURE__ */ new Map();
      for (const tool of hooks) {
        try {
          const changes = tool.prepareLoadout?.(loadout);
          for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
            descriptions.set(name, description);
          }
          for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
        } catch (error) {
          this.extensions?.reportError(
            "prepare_loadout",
            `prepareLoadout of tool "${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const declared = tools.map((tool) => {
        const description = descriptions.get(tool.name);
        return description === void 0 ? tool : { ...tool, description };
      });
      return { declared, hidden };
    }
    /**
     * The tools the model sees in the next request: active, with loadout descriptions,
     * without hidden declarations. Hosts build their system prompt's tool list from it.
     */
    getDeclaredTools() {
      const { declared, hidden } = this.computeLoadout();
      return declared.filter((tool) => !hidden.has(tool.name)).map((tool) => this.toolInfo(tool));
    }
    /** The model-visible conversation: the session log's projection (read-only; P22). */
    get messages() {
      return this.projection;
    }
    /** Run a log write after every earlier one; its failure goes to the caller. */
    enqueueWrite(write) {
      const run = this.writes.then(write);
      this.writes = run.then(
        () => void 0,
        () => void 0
      );
      return run;
    }
    /** Enqueue a write nobody awaits (sync extension actions); a failure surfaces at the next flushWrites(). */
    enqueueBackground(write) {
      this.enqueueWrite(write).catch((error) => {
        this.writeFailure ?? (this.writeFailure = toError(error));
      });
    }
    /** Wait for every queued write; rethrow a background write's failure. */
    async flushWrites() {
      await this.writes;
      const failure = this.writeFailure;
      if (failure) {
        this.writeFailure = void 0;
        throw failure;
      }
    }
    /** Rebuild `messages` from the log's active path (pi _refreshFinalizedContext). */
    async refresh() {
      const path = await this.session.store.getPathToRoot(this.session.currentLeafId);
      const projection = buildSessionProjection(path);
      const entryIds = /* @__PURE__ */ new WeakMap();
      for (const entry of projection.entries) {
        for (const message of entry.messages) entryIds.set(message, entry.sourceEntry.id);
      }
      this.entryIds = entryIds;
      this.activePath = path;
      this.activeProjection = projection;
      this.projection = Object.freeze(projection.messages);
      const entries = await this.session.store.getEntries();
      this.allEntries = entries;
      this.entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      this.sessionUsage = sumSessionUsage(entries);
      this.sessionMetadata = await this.session.store.getMetadata();
    }
    /** Append a message to the log and refresh the projection; returns its entry id. Call inside the writer. */
    async appendAndRefresh(message) {
      const entry = await this.session.recordMessage(message);
      await this.refresh();
      return entry.id;
    }
    /** Log a message after every queued write; returns its entry id. */
    record(message) {
      return this.enqueueWrite(() => this.appendAndRefresh(message));
    }
    /**
     * Append a message the host produced outside the loop (e.g. the TUI's `!`
     * user bash) to the log. Replaces pushing onto `messages`, which is now a
     * read-only projection.
     */
    async appendMessage(message) {
      if (this.looping) throw new TauError("busy", "appendMessage() while the agent loop is running");
      await this.flushWrites();
      await this.record(normalizeMessageContent(message));
    }
    /**
     * Log a system message when the prompt or the tool set differs from what the
     * transcript replays to (pi _preparePromptAndToolLoadout + declareToolChanges).
     * The kernel has one section, `prompt`, holding the effective prompt text, so
     * the folded wire prompt equals the plain prompt byte for byte.
     */
    async declareLoadout(promptText) {
      await this.flushWrites();
      const current = getCurrentSystemMessage(this.messages);
      const sections = diffSystemPromptSections(current?.sections ?? {}, promptText === "" ? {} : { prompt: promptText });
      const loadout = this.computeLoadout();
      this.hiddenDeclarations = loadout.hidden;
      const tools = getToolStateChanges(
        getCurrentTools(this.messages),
        // A schemaless tool that slipped past registration cannot be declared; the
        // preflight guard still answers a call to it with a paired error result (HF-8).
        loadout.declared.filter(hasToolSchema).map(toToolDeclaration)
      );
      if (!sections && tools.toolsAdded.length === 0 && tools.toolsRemoved.length === 0) return;
      const update = {
        role: "system",
        content: "",
        ...sections ? { sections } : {},
        ...tools.toolsAdded.length > 0 ? { toolsAdded: tools.toolsAdded } : {},
        ...tools.toolsRemoved.length > 0 ? { toolsRemoved: tools.toolsRemoved } : {},
        timestamp: Date.now()
      };
      await this.record(update);
    }
    /** The verifyTranscript check: projection of a JSON replay of the log === `messages`. */
    async assertTranscriptMatchesLog() {
      const path = await this.session.store.getPathToRoot(this.session.currentLeafId);
      const replayed = buildSessionProjection(JSON.parse(JSON.stringify(path))).messages;
      if (JSON.stringify(replayed) !== JSON.stringify(this.messages)) {
        throw new TauError(
          "invalid_state",
          "Model context diverged from the session log: the request would contain something the log does not (kernel bug)"
        );
      }
    }
    /** The read-only session view handed to extensions as ctx.sessionManager (pi ReadonlySessionManager). */
    sessionManager() {
      if (this.readonlySessionManager) return this.readonlySessionManager;
      const branch = (fromId) => {
        const path = [];
        let id = fromId;
        while (id !== null) {
          const entry = this.entriesById.get(id);
          if (!entry) break;
          path.push(entry);
          id = entry.parentId;
        }
        return path.reverse();
      };
      this.readonlySessionManager = {
        getCwd: () => this.sessionMetadata?.cwd ?? "",
        getSessionId: () => this.sessionMetadata?.id ?? "",
        getSessionFile: () => this.sessionMetadata?.filePath,
        getSessionName: () => this.sessionMetadata?.name,
        getLeafId: () => this.session.currentLeafId,
        getLeafEntry: () => {
          const leafId = this.session.currentLeafId;
          return leafId === null ? void 0 : this.entriesById.get(leafId);
        },
        getEntry: (id) => this.entriesById.get(id),
        getLabel: (id) => {
          let label;
          for (const entry of this.allEntries) if (entry.type === "label" && entry.targetId === id) label = entry.label;
          return label;
        },
        getBranch: (fromId) => branch(fromId ?? this.session.currentLeafId),
        getEntries: () => [...this.allEntries],
        buildContextEntries: () => buildContextEntries(this.activePath),
        buildSessionProjection: () => this.activeProjection
      };
      return this.readonlySessionManager;
    }
    /**
     * Wait until every queued log write has landed in `messages`. Extension
     * actions such as an idle `sendMessage` append asynchronously (the store is
     * async); a host that renders new messages after running an extension command
     * awaits this first. Rethrows a failed background write.
     */
    async flush() {
      await this.flushWrites();
    }
    /** Session entry id a projected message came from (undefined for messages not in `messages`). */
    entryIdOf(message) {
      return this.entryIds.get(message);
    }
    /** Fire message_start/message_end for a non-streamed message, then log it. */
    async commitMessage(message, ctx) {
      return (await this.commitMessageWithId(message, ctx)).message;
    }
    /** commitMessage, also returning the session entry id. */
    async commitMessageWithId(message, ctx) {
      let final = message;
      if (this.extensions) {
        await this.extensions.notifyMessageStart(final, ctx);
        final = await this.extensions.runMessageEnd(final, ctx);
      }
      const entryId = await this.record(final);
      return { message: final, entryId };
    }
    /** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
    extensionContext() {
      const agent2 = this;
      return {
        ui: this.ui,
        get messages() {
          return agent2.messages;
        },
        capabilities: this.capabilities,
        getContextUsage: () => this.getContextUsage(),
        compact: (customInstructions) => {
          this.extensions?.assertActive();
          this.pendingCompaction = customInstructions ?? "";
        },
        runSubagent: (prompt, options, signal) => this.runSubagent(prompt, options, signal),
        abort: () => {
          this.extensions?.assertActive();
          const hostAbort = this.extensions?.hostAction("abort");
          if (hostAbort) hostAbort();
          else this.abort("Aborted by extension");
        },
        isIdle: () => this.isIdle,
        get signal() {
          return agent2.signal;
        },
        hasPendingMessages: () => this.hasQueuedMessages(),
        shutdown: () => {
          this.extensions?.assertActive();
          this.extensions?.hostAction("shutdown")?.();
        },
        isProjectTrusted: () => this.isProjectTrusted?.() === true,
        cwd: this.capabilities.paths?.cwd ?? this.capabilities.fs?.cwd ?? "",
        get model() {
          return agent2.currentModel;
        },
        get thinkingLevel() {
          return agent2.currentThinkingLevel;
        },
        sessionManager: this.sessionManager(),
        getSystemPrompt: () => getCurrentSystemPrompt(this.messages),
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
      const parent = this.extensions;
      const guards = parent ? await ExtensionRegistry.load([
        (api) => {
          api.on("tool_call", async (event, ctx) => {
            const decision = await parent.runToolCall(event, ctx);
            return decision.blocked ? { block: true, reason: decision.reason, terminate: decision.terminate } : void 0;
          });
          api.on("tool_result", (event, ctx) => parent.runToolResult(event, ctx));
        }
      ]) : void 0;
      const child = new _Agent({
        extensions: guards,
        retry: this.retrySettings,
        isProjectTrusted: this.isProjectTrusted,
        config: this.config,
        transport: this.transport,
        platform: this.platform,
        systemPrompt: options.systemPrompt ?? this.systemPrompt,
        tools: options.tools ?? this.baseTools,
        ui: this.ui,
        capabilities: this.capabilities,
        initialMessages: options.initialMessages,
        maxTurnsPerPrompt: options.maxTurnsPerPrompt ?? this.maxTurnsPerPrompt,
        steeringMode: this.steeringQueue.mode,
        followUpMode: this.followUpQueue.mode,
        compaction: this.compactionSettings,
        // Subagents inherit the permission stance — spawning a child must not
        // be a policy escape hatch.
        permissionMode: this.permissionMode,
        policy: this.policy,
        onApproval: this.onApproval,
        // The child's calls are billed like the parent's (D19).
        pricing: this.pricing,
        thinkingLevel: this.currentThinkingLevel,
        toolExecution: this.toolExecution,
        preflightLock: this.preflightLock
      });
      let text = "";
      let lastAssistantText = "";
      for await (const event of child.prompt(prompt, signal)) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "assistant_message") lastAssistantText = messageText(event.message);
      }
      return {
        text: text === "" ? lastAssistantText : text,
        messages: [...child.messages],
        usage: child.getSessionUsage()
      };
    }
    /** A usage with its cost filled from the host pricing, when there is one (D19-3). */
    priced(usage) {
      const pricing = this.pricingFor(this.currentModel);
      return pricing ? { ...usage, cost: computeUsageCost(usage, pricing) } : usage;
    }
    /** Prices for a model: the fixed pricing, or what the host's resolver says for it. */
    pricingFor(model) {
      return typeof this.pricing === "function" ? this.pricing(model) : this.pricing;
    }
    /** The model this agent's requests use. */
    get model() {
      return this.currentModel;
    }
    /**
     * Use another model from the next request on and log a model_change entry
     * (pi). No events: hosts run model_select around it; the extension-facing
     * `api.setModel` does that itself.
     */
    setModel(model) {
      if (model === this.currentModel) return;
      this.currentModel = model;
      const provider = this.config.provider ?? "openai-compat";
      this.enqueueBackground(async () => {
        await this.session.append({ type: "model_change", provider, modelId: model });
        await this.refresh();
      });
    }
    /** The thinking level sent with requests; undefined = the endpoint's default. */
    get thinkingLevel() {
      return this.currentThinkingLevel;
    }
    /** Change the thinking level from the next request on; logs a thinking_level_change entry (pi words: "none" → "off"). */
    setThinkingLevel(level) {
      if (level === this.currentThinkingLevel) return;
      this.currentThinkingLevel = level;
      if (level === void 0) return;
      this.enqueueBackground(async () => {
        await this.session.append({ type: "thinking_level_change", thinkingLevel: level === "none" ? "off" : level });
        await this.refresh();
      });
    }
    /** The permission mode tool calls are checked against (D20). */
    getPermissionMode() {
      return this.permissionMode;
    }
    /**
     * Change the permission mode from the next tool call on; subagents spawned
     * afterwards inherit it (tau, P25: the TUI's Shift+Tab). Not recorded in the
     * session: a resumed session takes its mode from the host again, so a
     * session never comes back more permissive than the host started it.
     */
    setPermissionMode(mode) {
      this.permissionMode = mode;
    }
    /** The extension-facing model switch: model_select before, the switch, model_select after (pi setModel). */
    async switchModelForExtension(requested) {
      const ctx = this.extensionContext();
      const previous = this.currentModel;
      const decision = this.extensions ? await this.extensions.runModelSelectBefore({ currentModel: previous, requestedModel: requested }, ctx) : { model: requested };
      if ("cancel" in decision && decision.cancel) return false;
      this.setModel(decision.model);
      await this.extensions?.notifyModelSelected(
        { previousModel: previous, requestedModel: requested, selectedModel: decision.model },
        ctx
      );
      return true;
    }
    /**
     * Header changes from before_provider_headers for one request (P23d). A
     * transport that does not apply headers cannot honor them, so registering a
     * handler with it is an error, not a silent no-op (D15 supplement).
     */
    async providerHeaders(ctx) {
      if (!this.extensions?.hasProviderHeaderHandlers()) return void 0;
      if (!this.transport.supportsHeaders) {
        throw new TauError(
          "unsupported",
          "before_provider_headers handlers are registered, but the transport does not declare supportsHeaders"
        );
      }
      const headers = await this.extensions.runBeforeProviderHeaders(ctx);
      return Object.keys(headers).length > 0 ? headers : void 0;
    }
    /**
     * The transport for summary requests (compaction, turn prefix, branch summary):
     * the agent's model and thinking level, no prompt-cache write (pi 0.82.0), and
     * the before_provider_headers changes — pi runs the hook for every provider call.
     */
    summaryTransport() {
      const inner = this.transport;
      const agent2 = this;
      const transport = (request) => (async function* () {
        const headers = await agent2.providerHeaders(agent2.extensionContext());
        yield* inner({
          ...request,
          model: agent2.currentModel,
          cacheRetention: "none",
          ...agent2.currentThinkingLevel !== void 0 ? { thinkingLevel: agent2.currentThinkingLevel } : {},
          ...headers ? { headers } : {}
        });
      })();
      transport.supportsHeaders = inner.supportsHeaders;
      return transport;
    }
    /** Current context-token estimate (pi semantics: last assistant usage + trailing heuristic). */
    getContextUsage() {
      return {
        ...estimateProjectedContextTokens(this.activeProjection, this.activePath),
        contextWindow: this.config.contextWindow
      };
    }
    /**
     * Everything this session was billed for, all branches, compaction-proof
     * (D19): assistant turns, summaries and tool-reported usage. Hosts show it as
     * the session cost; the context estimate is getContextUsage().
     */
    getSessionUsage() {
      return this.sessionUsage;
    }
    /** Compaction settings for the configured window (small windows scale the budgets down). */
    effectiveCompactionSettings() {
      return compactionSettingsForWindow(this.compactionSettings, this.config.contextWindow);
    }
    /** Claim the agent for one operation; a second one throws busy (D14: a programming error). */
    beginOperation(operation, signal) {
      if (this.operation !== void 0) {
        throw new TauError("busy", `${operation}() while ${this.operation} holds the agent`);
      }
      this.operation = operation;
      const handle = new AbortHandle();
      handle.follow(signal);
      this.activeAbort = handle;
      return handle;
    }
    /** Release the agent; extension messages held during a compaction or navigation land now. */
    endOperation() {
      this.operation = void 0;
      this.activeAbort = void 0;
      const held = this.heldMessages.splice(0);
      for (const { message } of held) this.enqueueBackground(() => this.appendAndRefresh(message));
      if (held.some((entry) => entry.triggerTurn)) this.extensions?.hostAction("resumeTurn")?.();
    }
    /** Summarization retry for this agent: its RetrySettings, the host sleep, events through emit. */
    summarizationRetry(source, emit2) {
      return {
        settings: this.retrySettings,
        sleep: this.platform.sleep,
        callbacks: emit2 && {
          onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => emit2({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage }),
          onRetryAttemptStart: () => emit2({ type: "summarization_retry_attempt_start", ...source }),
          onRetryFinished: () => emit2({ type: "summarization_retry_finished" })
        }
      };
    }
    /**
     * Compact the conversation now: summarize old history (session_before_compact
     * may cancel or take over) and append a compaction entry; the projection
     * becomes [summary, ...kept]. Holds the agent: throws busy while a run,
     * compaction or navigation is in flight, and abort() cancels it.
     *
     * Resolves undefined when there is nothing to compact. A failure reports
     * session_compact_failed first, then rejects (pi manual semantics):
     * TauError("cancelled") when a session_before_compact handler cancelled,
     * TauError("aborted") on abort, TauError("compaction_failed") otherwise.
     */
    async compact(customInstructions, reason = "manual", signal, onEvent) {
      const handle = this.beginOperation("compact", signal);
      try {
        const outcome = await this.runCompactionOperation(customInstructions, reason, handle.signal, onEvent);
        if (outcome.kind === "none") return void 0;
        if (outcome.kind === "done") return outcome.result;
        if (outcome.cancelledByExtension) throw new TauError("cancelled", "Compaction cancelled");
        if (outcome.aborted) throw new TauError("aborted", "Compaction aborted");
        throw new TauError("compaction_failed", outcome.error.message, outcome.error);
      } finally {
        this.endOperation();
      }
    }
    /**
     * The compaction itself, shared by compact() and the loop (pi
     * _runAutoCompaction / compact): never throws. Aborts are checked around every
     * asynchronous step, and a failure — abort, extension cancel, summary error —
     * is reported as session_compact_failed and leaves the log untouched.
     */
    async runCompactionOperation(customInstructions, reason, signal, onEvent) {
      const ctx = this.extensionContext();
      const hookSignal = signal ?? new AbortHandle().signal;
      let fromExtension = false;
      let cancelledByExtension = false;
      try {
        await this.flushWrites();
        const pathEntries = await this.session.store.getPathToRoot(this.session.currentLeafId);
        const preparation = prepareCompaction(pathEntries, this.effectiveCompactionSettings());
        if (!preparation) return { kind: "none" };
        throwIfAborted2(signal);
        const decision = this.extensions ? await this.extensions.runSessionBeforeCompact(
          { preparation, customInstructions, reason, signal: hookSignal },
          ctx
        ) : {};
        if (decision.cancel) {
          cancelledByExtension = true;
          throw new TauError("cancelled", "Compaction cancelled");
        }
        throwIfAborted2(signal);
        fromExtension = decision.result !== void 0;
        const result = decision.result ?? await runCompaction(
          this.summaryTransport(),
          preparation,
          customInstructions,
          signal,
          this.summarizationRetry({ source: "compaction", reason }, onEvent)
        );
        throwIfAborted2(signal);
        if (result.usage) result.usage = this.priced(result.usage);
        await this.enqueueWrite(async () => {
          const systemMessage = getCurrentSystemMessage(this.messages);
          await this.session.recordCompaction({
            ...result,
            fromHook: fromExtension || void 0,
            ...systemMessage ? { systemMessage } : {}
          });
          await this.refresh();
        });
        await this.extensions?.notifySessionCompact({ result, fromExtension, reason }, ctx);
        return { kind: "done", result };
      } catch (cause) {
        const error = toError(cause);
        const aborted2 = signal?.aborted === true || cancelledByExtension;
        const errorMessage = aborted2 ? void 0 : `${reason === "manual" ? "Compaction" : "Auto-compaction"} failed: ${error.message}`;
        await this.extensions?.notifySessionCompactFailed(
          { reason, errorMessage, aborted: aborted2, willRetry: false, fromExtension },
          ctx
        );
        return { kind: "failed", errorMessage, aborted: aborted2, cancelledByExtension, error };
      }
    }
    /**
     * Queue input for the running prompt: committed after the current turn, before
     * the next request. Input handlers see it first (pi 0.86.0, streamingBehavior
     * "steer") and may transform or consume it; the result says which (pi 0.99.0).
     */
    steer(content) {
      return this.queueUserInput(content, "steer", "interactive");
    }
    /** Queue input consumed when the prompt would otherwise end; the loop then continues. Same input rules as steer(). */
    followUp(content) {
      return this.queueUserInput(content, "followUp", "interactive");
    }
    /** Run input handlers on queued input, then enqueue what survives (pi _queueUserInput). */
    async queueUserInput(content, behavior, source) {
      const queue = behavior === "steer" ? this.steeringQueue : this.followUpQueue;
      if (!this.extensions) {
        queue.enqueue({ role: "user", content, timestamp: Date.now() });
        return "queued";
      }
      const text = userContentText(content);
      const images = typeof content === "string" ? void 0 : content.filter((block) => block.type === "image");
      const result = await this.extensions.runInput(text, this.extensionContext(), {
        source,
        streamingBehavior: behavior,
        ...images && images.length > 0 ? { images } : {}
      });
      if (result.handled) return "handled";
      queue.enqueue({ role: "user", content: rewrittenInput(content, text, result), timestamp: Date.now() });
      return "queued";
    }
    hasQueuedMessages() {
      return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
    }
    /**
     * Empty both queues and return what they held (pi AgentSession.clearQueue).
     * Queues survive an abort by design; hosts call this when a run ends to restore
     * the user's queued text to the editor instead of replaying it later.
     */
    clearQueue() {
      return { steering: this.steeringQueue.clear(), followUp: this.followUpQueue.clear() };
    }
    /** True when no operation holds the agent (pi isIdle). */
    get isIdle() {
      return this.operation === void 0;
    }
    /** Abort signal of the operation in flight; undefined when idle (pi ctx.signal). */
    get signal() {
      return this.activeAbort?.signal;
    }
    /**
     * Abort whatever holds the agent — a run with its retry backoff, a compaction,
     * a branch summary (pi AgentSession.abort). No-op when idle.
     */
    abort(reason = "Aborted") {
      this.activeAbort?.abort(new TauError("aborted", reason));
    }
    clearSteeringQueue() {
      this.steeringQueue.clear();
    }
    clearFollowUpQueue() {
      this.followUpQueue.clear();
    }
    async *prompt(input, signal) {
      const handle = this.beginOperation("prompt", signal);
      this.runEntered = false;
      let finished = false;
      try {
        await this.flushWrites();
        yield* this.runPrompt(input, handle.signal);
        finished = true;
      } finally {
        this.endOperation();
        if (!finished && this.runEntered) await this.notifySettled(handle.signal.aborted);
      }
      if (this.runEntered) yield* this.settle(handle.signal.aborted);
    }
    /** agent_settled once the agent is idle; runs started from its handlers go to the host afterwards. */
    async *settle(aborted2) {
      await this.notifySettled(aborted2);
      yield { type: "agent_settled", aborted: aborted2 };
      for (const start of this.deferredStarts.splice(0)) start();
    }
    async notifySettled(aborted2) {
      this.runEntered = false;
      this.settling = true;
      try {
        await this.extensions?.notifyAgentSettled(aborted2, this.extensionContext());
      } finally {
        this.settling = false;
      }
    }
    /**
     * Run the agent loop without committing new user input — the continuation
     * behind sendMessage({triggerTurn:true}) while idle (pi's _runAgentPrompt
     * for app messages). The conversation must already end in something the
     * model should answer (a user/custom message).
     */
    async *resume(signal) {
      const handle = this.beginOperation("resume", signal);
      this.runEntered = false;
      let finished = false;
      try {
        await this.flushWrites();
        const ctx = this.extensionContext();
        const systemPrompt = await this.applyBeforeAgentStart(lastPromptText(this.messages), ctx);
        await this.extensions?.notifyAgentStart(ctx);
        yield* this.runLoop(ctx, systemPrompt, handle.signal);
        finished = true;
      } finally {
        this.endOperation();
        if (!finished && this.runEntered) await this.notifySettled(handle.signal.aborted);
      }
      if (this.runEntered) yield* this.settle(handle.signal.aborted);
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
      const handle = this.beginOperation("navigate", options?.signal);
      try {
        return await this.runNavigation(entryId, handle.signal, options);
      } finally {
        this.endOperation();
      }
    }
    async runNavigation(entryId, signal, options) {
      await this.flushWrites();
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
      const hook = this.extensions ? await this.extensions.runSessionBeforeTree({ preparation, signal }, ctx) : {};
      if (hook.cancel || signal.aborted) return { cancelled: true };
      let summaryText = hook.summary?.summary;
      let summaryDetails = hook.summary?.details;
      let summaryUsage = hook.summary?.usage;
      if (!summaryText && options?.summarize !== false && entries.length > 0) {
        try {
          const generated = await generateBranchSummary(this.summaryTransport(), entries, {
            customInstructions: hook.customInstructions ?? options?.customInstructions,
            contextWindow: this.config.contextWindow,
            reserveTokens: this.effectiveCompactionSettings().reserveTokens,
            signal,
            retry: this.summarizationRetry({ source: "branchSummary" }, options?.onEvent)
          });
          summaryText = generated.summary;
          summaryDetails = { readFiles: generated.readFiles, modifiedFiles: generated.modifiedFiles };
          summaryUsage = generated.usage;
        } catch (error) {
          if (error instanceof TauError && error.code === "aborted") return { cancelled: true };
          throw error;
        }
      }
      if (signal.aborted) return { cancelled: true };
      const fromExtension = hook.summary !== void 0;
      const summaryEntry = await this.enqueueWrite(async () => {
        const entry = await this.session.moveTo(
          entryId,
          summaryText ? {
            summary: summaryText,
            details: summaryDetails,
            usage: summaryUsage && this.priced(summaryUsage),
            fromHook: fromExtension || void 0
          } : void 0
        );
        await this.refresh();
        this.restoreToolsFromTranscript();
        return entry;
      });
      const newLeafId = await store.getLeafId();
      await this.extensions?.notifySessionTree({ newLeafId, oldLeafId, summaryEntry, fromExtension }, ctx);
      return { cancelled: false };
    }
    async *runPrompt(input, signal) {
      const ctx = this.extensionContext();
      let finalInput = input;
      if (this.extensions) {
        const inputText = userContentText(input);
        const images = typeof input === "string" ? void 0 : input.filter((block) => block.type === "image");
        const inputResult = await this.extensions.runInput(inputText, ctx, {
          source: "interactive",
          ...images && images.length > 0 ? { images } : {}
        });
        if (inputResult.handled) {
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        finalInput = rewrittenInput(input, inputText, inputResult);
      }
      const systemPrompt = await this.applyBeforeAgentStart(userContentText(finalInput), ctx);
      await this.commitMessage({ role: "user", content: finalInput, timestamp: Date.now() }, ctx);
      await this.extensions?.notifyAgentStart(ctx);
      yield* this.runLoop(ctx, systemPrompt, signal);
    }
    /**
     * before_agent_start for a run: extensions rewrite the system prompt and may
     * inject custom messages. Shared by prompt() and resume() — resume() used the
     * base prompt, dropping e.g. injected skills and the provider's prompt cache (HF-10).
     */
    async applyBeforeAgentStart(promptText, ctx) {
      const base = this.systemPrompt ?? "";
      if (!this.extensions) {
        this.pendingTools.clear();
        await this.declareLoadout(base);
        return base;
      }
      const beforeStart = await this.extensions.runBeforeAgentStart(promptText, base, ctx);
      this.pendingTools.clear();
      await this.declareLoadout(beforeStart.systemPrompt);
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
      return beforeStart.systemPrompt;
    }
    /**
     * A prompt's runs (pi _runAgentPrompt). The turn loop ends with agent_end;
     * messages queued meanwhile — e.g. by agent_end handlers — start a
     * continuation run in the same generator (pi _handlePostAgentRun, no timers);
     * then agent_before_settle may append drafts and ask for one more run. The
     * turn budget spans all runs of the prompt.
     */
    async *runLoop(ctx, systemPrompt, signal) {
      for (const held of this.pendingNextTurn.splice(0)) {
        await this.commitMessage(held, ctx);
      }
      this.looping = true;
      this.runEntered = true;
      const state = { turnIndex: 0 };
      try {
        for (let run = 0; ; run++) {
          if (run > 0) await this.extensions?.notifyAgentStart(ctx);
          const outcome = yield* this.runTurns(ctx, systemPrompt, signal, state);
          if (signal?.aborted || outcome === "aborted") break;
          if (this.hasQueuedMessages()) continue;
          const settle = this.extensions ? await this.extensions.runBeforeSettle(outcome, ctx) : { entries: [], continue: false };
          await this.commitBoundaryDrafts(settle.entries, "agent_before_settle", ctx);
          if (signal?.aborted) break;
          if (!settle.continue && !this.hasQueuedMessages()) break;
          if (!this.canContinue()) {
            if (settle.continue) {
              this.extensions?.reportError(
                "agent_before_settle",
                "agent_before_settle requested continuation without runnable model context"
              );
            }
            break;
          }
        }
      } finally {
        this.looping = false;
        for (const held of this.afterTurnMessages.splice(0)) await this.commitMessage(held, ctx);
      }
    }
    /** Whether a request now has something to answer: the context does not end with the assistant, or messages are queued. */
    canContinue() {
      let last;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].role !== "system") {
          last = this.messages[i];
          break;
        }
      }
      return last !== void 0 && last.role !== "assistant" || this.hasQueuedMessages();
    }
    /** Append a boundary handler's drafts in order (custom entries and custom messages). */
    async commitBoundaryDrafts(drafts, event, ctx) {
      for (const draft of drafts) {
        if (draft.type === "custom") {
          await this.enqueueWrite(async () => {
            await this.session.appendCustom(draft.customType, draft.data);
            await this.refresh();
          });
        } else if (draft.type === "custom_message") {
          await this.commitMessage(
            {
              role: "custom",
              customType: draft.customType,
              content: draft.content,
              display: draft.display ?? true,
              details: draft.details,
              timestamp: Date.now()
            },
            ctx
          );
        } else {
          this.extensions?.reportError(event, `Unsupported boundary draft type: ${draft.type}`);
        }
      }
    }
    /**
     * One run's turns, in pi runLoop order: steering is polled at the start;
     * each turn prepares (compaction) → polls steering again if none was pending →
     * turn_start → commits pending messages → requests → runs the tool batch →
     * finishTurn → turn_end; steering is polled after turn_end, follow-ups when
     * the run would stop. Returns how the run ended; agent_end has fired.
     */
    async *runTurns(ctx, systemPrompt, signal, state) {
      let retryAttempt = 0;
      let lengthStreak = 0;
      let explicitContinue = false;
      let pending = this.steeringQueue.drain();
      while (true) {
        let hasMoreToolCalls = true;
        while (hasMoreToolCalls || pending.length > 0) {
          if (signal?.aborted) {
            yield* this.endRun(ctx, retryAttempt, pending);
            return "aborted";
          }
          if (state.turnIndex >= this.maxTurnsPerPrompt) {
            throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
          }
          let compactionReason;
          let customInstructions;
          if (this.pendingCompaction !== null) {
            compactionReason = "manual";
            customInstructions = this.pendingCompaction === "" ? void 0 : this.pendingCompaction;
            this.pendingCompaction = null;
          } else if (this.config.contextWindow !== void 0 && shouldCompact(this.getContextUsage().tokens, this.config.contextWindow, this.effectiveCompactionSettings())) {
            compactionReason = "threshold";
          }
          if (compactionReason !== void 0) {
            const reason = compactionReason;
            const outcome = yield* pumpEvents(
              (emit2) => this.runCompactionOperation(customInstructions, reason, signal, emit2)
            );
            if (outcome.kind === "done") yield { type: "compaction", result: outcome.result };
            if (outcome.kind === "failed") {
              yield {
                type: "compaction_failed",
                reason,
                ...outcome.errorMessage !== void 0 ? { errorMessage: outcome.errorMessage } : {},
                aborted: outcome.aborted
              };
            }
            if (signal?.aborted) {
              yield* this.endRun(ctx, retryAttempt, pending);
              return "aborted";
            }
          }
          if (pending.length === 0) pending = this.steeringQueue.drain();
          const turnIndex = state.turnIndex;
          await this.extensions?.notifyTurnStart(turnIndex, ctx);
          for (const message of pending) {
            const committed = await this.commitMessage(message, ctx);
            yield { type: "user_message", message: committed };
          }
          pending = [];
          if (signal?.aborted) {
            yield* this.endRun(ctx, retryAttempt);
            return "aborted";
          }
          await this.declareLoadout(systemPrompt);
          const toolSnapshot = this.activeTools();
          await this.flushWrites();
          if (this.verifyTranscript) await this.assertTranscriptMatchesLog();
          let request = [...this.messages];
          if (this.extensions) {
            request = await this.extensions.runContext(request, ctx);
          }
          request = withoutHiddenDeclarations(request, this.hiddenDeclarations);
          const partial = {
            role: "assistant",
            content: [],
            api: this.config.api ?? OPENAI_COMPLETIONS_API,
            provider: this.config.provider ?? "openai-compat",
            model: this.currentModel,
            usage: emptyUsage(),
            // A streaming partial is unfinished (pi 0.83.0); the final message lands a concrete reason.
            stopReason: "pending",
            timestamp: Date.now()
          };
          const requestStart = partial.timestamp;
          await this.extensions?.notifyMessageStart(partial, ctx);
          let assistantMessage;
          let streamFailure;
          let streamEnded = false;
          const headers = await this.providerHeaders(ctx);
          const stream = this.transport({
            messages: request,
            signal,
            model: this.currentModel,
            ...this.currentThinkingLevel !== void 0 ? { thinkingLevel: this.currentThinkingLevel } : {},
            ...headers ? { headers } : {}
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
            if (streamEnded) break;
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
                assistantMessage.durationMs = Math.max(0, Date.now() - requestStart);
                {
                  const pricing = this.pricingFor(assistantMessage.model);
                  if (pricing) assistantMessage.usage.cost = computeUsageCost(assistantMessage.usage, pricing);
                }
                streamEnded = true;
                break;
            }
          }
          if (streamFailure) {
            partial.stopReason = streamFailure.code === "aborted" ? "aborted" : "error";
            partial.errorMessage = streamFailure.message;
            partial.durationMs = Math.max(0, Date.now() - requestStart);
            let finalMessage = partial;
            if (this.extensions) {
              finalMessage = await this.extensions.runMessageEnd(finalMessage, ctx);
            }
            const failedEntryId = await this.record(finalMessage);
            yield { type: "assistant_message", message: finalMessage };
            await this.finishTurn?.({ message: finalMessage, toolResults: [] }, signal);
            await this.runTurnEndBoundary(turnIndex, finalMessage, failedEntryId, [], [], ctx);
            const retryEligible = finalMessage.stopReason === "error" && this.retrySettings.enabled && this.platform.sleep !== void 0 && isRetryableAssistantError(finalMessage);
            if (retryEligible && retryAttempt < this.retrySettings.maxRetries) {
              retryAttempt++;
              const delayMs = retryDelayMs(this.retrySettings, retryAttempt);
              const startEvent = {
                attempt: retryAttempt,
                maxAttempts: this.retrySettings.maxRetries,
                delayMs,
                errorMessage: finalMessage.errorMessage ?? "Unknown error"
              };
              await this.extensions?.notifyAutoRetryStart(startEvent, ctx);
              yield { type: "auto_retry_start", ...startEvent };
              await this.enqueueWrite(async () => {
                await this.session.appendContextEdit(failedEntryId, null);
                await this.refresh();
              });
              try {
                await this.platform.sleep?.(delayMs, signal);
              } catch {
                yield* this.endRun(ctx, retryAttempt, pending);
                return "aborted";
              }
              hasMoreToolCalls = true;
              continue;
            }
            state.turnIndex++;
            if (finalMessage.stopReason === "aborted") {
              yield* this.endRun(ctx, retryAttempt, pending);
              return "aborted";
            }
            if (retryAttempt > 0) {
              const endEvent = { success: false, attempt: retryAttempt, finalError: finalMessage.errorMessage };
              await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
              yield { type: "auto_retry_end", ...endEvent };
            }
            await this.flushWrites();
            await this.extensions?.notifyAgentEnd(this.messages, ctx);
            yield { type: "agent_end", messages: this.messages };
            return "error";
          }
          if (!assistantMessage) {
            throw new TauError("stream_error", "Stream ended without a final message");
          }
          if (this.extensions) {
            assistantMessage = await this.extensions.runMessageEnd(assistantMessage, ctx);
          }
          const messageEntryId = await this.record(assistantMessage);
          yield { type: "assistant_message", message: assistantMessage };
          if (retryAttempt > 0) {
            const endEvent = { success: true, attempt: retryAttempt };
            await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
            yield { type: "auto_retry_end", ...endEvent };
            retryAttempt = 0;
          }
          const toolCalls = toolCallsOf(assistantMessage);
          const batch = { messages: [], entryIds: [], terminate: [] };
          const toolResults = batch.messages;
          const toolResultEntryIds = batch.entryIds;
          if (toolCalls.length > 0 && assistantMessage.stopReason === "length") {
            for (const toolCall of toolCalls) {
              yield { type: "tool_start", toolCall };
              yield await this.commitToolResult(toolCall, errorResult(truncatedToolCallText(toolCall.name)), ctx, batch);
            }
          } else {
            const forceSequential = this.toolExecution === "sequential" || toolCalls.some((tc) => toolSnapshot.get(tc.name)?.executionMode === "sequential");
            if (forceSequential || toolCalls.length <= 1) {
              yield* this.toolRunner.runSequential(toolCalls, toolSnapshot, ctx, signal, batch);
            } else {
              yield* this.toolRunner.runParallel(toolCalls, toolSnapshot, ctx, signal, batch);
            }
          }
          const terminate = batch.terminate.length > 0 && batch.terminate.every(Boolean);
          hasMoreToolCalls = toolCalls.length > 0 && !terminate;
          lengthStreak = assistantMessage.stopReason === "length" && toolCalls.length > 0 ? lengthStreak + 1 : 0;
          const decision = await this.finishTurn?.({ message: assistantMessage, toolResults }, signal);
          const boundaryContinue = await this.runTurnEndBoundary(
            turnIndex,
            assistantMessage,
            messageEntryId,
            toolResults,
            toolResultEntryIds,
            ctx
          );
          state.turnIndex++;
          for (const held of this.afterTurnMessages.splice(0)) await this.commitMessage(held, ctx);
          const truncatedOut = lengthStreak >= MAX_LENGTH_TRUNCATED_TURNS;
          if (decision?.action === "end" || truncatedOut) {
            await this.flushWrites();
            await this.extensions?.notifyAgentEnd(this.messages, ctx);
            yield { type: "agent_end", messages: this.messages };
            return "completed";
          }
          explicitContinue = boundaryContinue;
          pending = this.steeringQueue.drain();
          if (hasMoreToolCalls || pending.length > 0) explicitContinue = false;
        }
        const followUps = this.followUpQueue.drain();
        if (followUps.length > 0) {
          pending = followUps;
          explicitContinue = false;
          continue;
        }
        if (explicitContinue) {
          explicitContinue = false;
          continue;
        }
        break;
      }
      await this.flushWrites();
      await this.extensions?.notifyAgentEnd(this.messages, ctx);
      yield { type: "agent_end", messages: this.messages };
      return "completed";
    }
    /**
     * Run the actionable turn_end boundary: drafts land in order, and a continue
     * request is honored only for a completed turn with runnable context.
     */
    async runTurnEndBoundary(turnIndex, message, messageEntryId, toolResults, toolResultEntryIds, ctx) {
      if (!this.extensions) return false;
      const outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
      const boundary = await this.extensions.runTurnEnd(
        { turnIndex, message, toolResults, messageEntryId, toolResultEntryIds, outcome },
        ctx
      );
      await this.commitBoundaryDrafts(boundary.entries, "turn_end", ctx);
      if (!boundary.continue || outcome !== "completed") return false;
      if (!this.canContinue()) {
        this.extensions.reportError("turn_end", "turn_end requested continuation without runnable model context");
        return false;
      }
      return true;
    }
    /**
     * End a run early (abort): a retry cycle in progress closes as cancelled (pi
     * _finishCancelledRetry), then agent_end — never a throw (D14).
     */
    async *endRun(ctx, retryAttempt, pending = []) {
      this.steeringQueue.restore(pending);
      this.nestedCalls.clear();
      if (retryAttempt > 0) {
        const endEvent = { success: false, attempt: retryAttempt, finalError: "Retry cancelled" };
        await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
        yield { type: "auto_retry_end", ...endEvent };
      }
      await this.flushWrites();
      await this.extensions?.notifyAgentEnd(this.messages, ctx);
      yield { type: "agent_end", messages: this.messages };
    }
    /** Commit one tool result to messages/session and produce the AgentEvent pair tail. */
    async commitToolResult(toolCall, outcome, ctx, batch) {
      const { durationMs, usage: ownUsage, terminate, ...result } = normalizeToolOutcome(toolCall.name, outcome);
      const nested = this.nestedCalls.takeRecord(toolCall.id);
      const usage = nested?.usage ? ownUsage ? combineUsage(ownUsage, nested.usage) : nested.usage : ownUsage;
      const toolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        isError: result.isError === true,
        timestamp: Date.now(),
        ...result.details !== void 0 ? { details: result.details } : {},
        ...durationMs !== void 0 ? { durationMs } : {},
        ...usage ? { usage } : {},
        ...nested?.calls ? { nestedCalls: nested.calls } : {}
      };
      const committed = await this.commitMessageWithId(toolResultMessage, ctx);
      batch.messages.push(committed.message);
      batch.entryIds.push(committed.entryId);
      batch.terminate.push(terminate === true);
      return {
        type: "tool_result",
        toolCall,
        result: terminate ? { ...result, terminate } : result,
        ...durationMs !== void 0 ? { durationMs } : {}
      };
    }
  };
  function throwIfAborted2(signal) {
    if (signal?.aborted) throw new TauError("aborted", "Aborted");
  }
  async function* pumpEvents(work) {
    const queue = [];
    let wake;
    let done = false;
    let value;
    let failure;
    const notify = () => {
      wake?.();
      wake = void 0;
    };
    work((event) => {
      queue.push(event);
      notify();
    }).then(
      (result) => {
        value = result;
        done = true;
        notify();
      },
      (error) => {
        failure = { error };
        done = true;
        notify();
      }
    );
    while (!done || queue.length > 0) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure.error;
    return value;
  }
  var MAX_LENGTH_TRUNCATED_TURNS = 3;
  function truncatedToolCallText(toolName) {
    return `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
  }
  function rewrittenInput(original, originalText, result) {
    const originalImages = typeof original === "string" ? [] : original.filter((block) => block.type === "image");
    const images = result.images ?? originalImages;
    if (result.text === originalText && images === originalImages) return original;
    if (images.length === 0) return result.text;
    return [{ type: "text", text: result.text }, ...images];
  }
  function withoutHiddenDeclarations(messages, hidden) {
    if (hidden.size === 0) return messages;
    return messages.map((message) => {
      if (message.role !== "system" || !message.toolsAdded && !message.toolsRemoved) return message;
      const { toolsAdded, toolsRemoved, ...rest } = message;
      const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
      const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
      return {
        ...rest,
        ...added.length > 0 ? { toolsAdded: added } : {},
        ...removed.length > 0 ? { toolsRemoved: removed } : {}
      };
    });
  }

  // ../../../packages/kernel/src/coding-tools.ts
  var BASH_STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

  // ../../../packages/ext-mcp-http/src/jsonrpc.ts
  var JSON_RPC_ERROR_CODES = {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603
  };
  var McpError = class extends Error {
    constructor(code, message, data) {
      super(message);
      __publicField(this, "code");
      __publicField(this, "data");
      this.name = "McpError";
      this.code = code;
      this.data = data;
    }
  };
  var McpConnectionClosedError = class extends Error {
    constructor(message = "MCP connection closed") {
      super(message);
      this.name = "McpConnectionClosedError";
    }
  };
  var McpTimeoutError = class extends Error {
    constructor(timeoutMs) {
      super(`MCP request timed out after ${timeoutMs}ms`);
      __publicField(this, "timeoutMs");
      this.name = "McpTimeoutError";
      this.timeoutMs = timeoutMs;
    }
  };
  var McpAbortError = class extends Error {
    constructor(message = "MCP request aborted") {
      super(message);
      this.name = "AbortError";
    }
  };
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function toError2(value) {
    return value instanceof Error ? value : new Error(String(value));
  }
  function isJsonRpcId(value) {
    return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
  }
  function isJsonRpcRequest(message) {
    return isObject(message) && message.jsonrpc === "2.0" && isJsonRpcId(message.id) && typeof message.method === "string";
  }
  function isJsonRpcNotification(message) {
    return isObject(message) && message.jsonrpc === "2.0" && !("id" in message) && typeof message.method === "string";
  }
  function isJsonRpcResponse(message) {
    if (!isObject(message) || message.jsonrpc !== "2.0" || !isJsonRpcId(message.id)) return false;
    if ("result" in message) return !("error" in message);
    if (!("error" in message) || !isObject(message.error)) return false;
    return typeof message.error.code === "number" && typeof message.error.message === "string";
  }
  function parseJsonRpcMessage(value) {
    if (isJsonRpcRequest(value) || isJsonRpcNotification(value) || isJsonRpcResponse(value)) return value;
    throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
  }

  // ../../../packages/ext-mcp-http/src/transport.ts
  var TransportEvents = class {
    constructor() {
      __publicField(this, "messageListeners", /* @__PURE__ */ new Set());
      __publicField(this, "errorListeners", /* @__PURE__ */ new Set());
      __publicField(this, "closeListeners", /* @__PURE__ */ new Set());
      __publicField(this, "closeEmitted", false);
    }
    onMessage(listener) {
      this.messageListeners.add(listener);
      return () => this.messageListeners.delete(listener);
    }
    onError(listener) {
      this.errorListeners.add(listener);
      return () => this.errorListeners.delete(listener);
    }
    onClose(listener) {
      this.closeListeners.add(listener);
      return () => this.closeListeners.delete(listener);
    }
    emitMessage(message) {
      for (const listener of this.messageListeners) listener(message);
    }
    emitError(error) {
      const normalized = toError2(error);
      for (const listener of this.errorListeners) listener(normalized);
    }
    emitClose() {
      if (this.closeEmitted) return;
      this.closeEmitted = true;
      for (const listener of this.closeListeners) listener();
    }
  };

  // ../../../packages/ext-mcp-http/src/http.ts
  var McpHttpError = class extends Error {
    constructor(status, message) {
      super(message);
      __publicField(this, "status");
      this.name = "McpHttpError";
      this.status = status;
    }
  };
  var McpSessionExpiredError = class extends McpHttpError {
    constructor() {
      super(404, "MCP session expired");
      this.name = "McpSessionExpiredError";
    }
  };
  var GET_STREAM_RETRY_DELAYS_MS = [1e3, 2e3, 4e3];
  function contentType(response) {
    return response.headers?.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  }
  var StreamableHttpTransport = class extends TransportEvents {
    constructor(options) {
      super();
      __publicField(this, "options");
      __publicField(this, "lifetime", new AbortHandle());
      __publicField(this, "started", false);
      __publicField(this, "closed", false);
      __publicField(this, "sessionIdValue");
      __publicField(this, "protocolVersion");
      this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : void 0 });
    }
    get sessionId() {
      return this.sessionIdValue;
    }
    async start() {
      if (this.started) throw new Error("MCP Streamable HTTP transport already started");
      if (this.closed) throw new McpConnectionClosedError();
      this.started = true;
    }
    setProtocolVersion(version) {
      this.protocolVersion = version;
    }
    async send(message, { signal } = {}) {
      if (!this.started || this.closed) throw new McpConnectionClosedError();
      if (signal?.aborted) return;
      const isInitialize = isJsonRpcRequest(message) && message.method === "initialize";
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.options.headers
      };
      if (!isInitialize) {
        if (this.protocolVersion !== void 0) headers["mcp-protocol-version"] = this.protocolVersion;
        if (this.sessionIdValue !== void 0) headers["mcp-session-id"] = this.sessionIdValue;
      }
      const request = new AbortHandle();
      request.follow(signal);
      request.follow(this.lifetime.signal);
      let response;
      try {
        response = await this.options.platform.fetch(this.options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: request.signal
        });
      } catch (error) {
        request.abort("settled");
        throw error;
      }
      if (!response.ok) {
        request.abort("settled");
        if (response.status === 404 && this.sessionIdValue !== void 0 && !isInitialize) {
          throw new McpSessionExpiredError();
        }
        throw new McpHttpError(response.status, `MCP server responded HTTP ${response.status}`);
      }
      const sessionId = response.headers?.get("mcp-session-id");
      if (sessionId) this.sessionIdValue = sessionId;
      if (!isJsonRpcRequest(message)) {
        request.abort("settled");
        if ("method" in message && message.method === "notifications/initialized" && this.options.openGetStream) {
          void this.runGetStream();
        }
        return;
      }
      const type = contentType(response);
      if (type === "text/event-stream") {
        void this.consumeSse(response, message.id, request);
        return;
      }
      try {
        const text = await response.text();
        if (type === "application/json" || !this.emitSse(text)) this.emitJson(text);
      } finally {
        request.abort("settled");
      }
    }
    /** Keep the GET stream open, reopening it with backoff when it drops (pi runGetStream). */
    async runGetStream() {
      for (let attempt = 0; !this.closed; attempt++) {
        let delivered = false;
        try {
          const headers = { accept: "text/event-stream", ...this.options.headers };
          if (this.protocolVersion !== void 0) headers["mcp-protocol-version"] = this.protocolVersion;
          if (this.sessionIdValue !== void 0) headers["mcp-session-id"] = this.sessionIdValue;
          const response = await this.options.platform.fetch(this.options.url, {
            method: "GET",
            headers,
            signal: this.lifetime.signal
          });
          if (response.status === 405 || !response.ok || contentType(response) !== "text/event-stream") return;
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = this.options.platform.createUtf8Decoder();
          const parser = new SseParser();
          while (!this.closed) {
            const { done, value } = await reader.read();
            const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
            for (const event of events) if (this.emitEventData(event.data)) delivered = true;
            if (done) break;
          }
        } catch {
        }
        if (this.closed) return;
        if (delivered) attempt = 0;
        const delay = GET_STREAM_RETRY_DELAYS_MS[attempt];
        const sleep = this.options.platform.sleep;
        if (delay === void 0 || !sleep) return;
        try {
          await sleep(delay, this.lifetime.signal);
        } catch {
          return;
        }
      }
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      this.lifetime.abort("closed");
      this.emitClose();
    }
    /** Emit every JSON-RPC message of a JSON body (one message or a batch). */
    emitJson(text) {
      const body = JSON.parse(text);
      for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
    }
    /**
     * A body without a content type (adapters without response headers): JSON first,
     * then SSE framing. Returns false when the text is JSON, so the caller parses it.
     */
    emitSse(text) {
      try {
        JSON.parse(text);
        return false;
      } catch {
      }
      const parser = new SseParser();
      for (const event of [...parser.push(text), ...parser.flush()]) this.emitEventData(event.data);
      return true;
    }
    emitEventData(data) {
      if (!data.trim()) return false;
      let message;
      try {
        message = parseJsonRpcMessage(JSON.parse(data));
      } catch (error) {
        this.emitError(error);
        return false;
      }
      this.emitMessage(message);
      return true;
    }
    /** Read the SSE reply to one request; a stream that ends unanswered fails only that request. */
    async consumeSse(response, requestId, request) {
      let answered = false;
      let stoppedEarly = false;
      let failure;
      const reader = response.body?.getReader();
      try {
        if (!reader) throw new Error("MCP SSE response had no readable body");
        const decoder = this.options.platform.createUtf8Decoder();
        const parser = new SseParser();
        while (!answered) {
          if (request.signal.aborted) {
            stoppedEarly = true;
            break;
          }
          const { done, value } = await reader.read();
          const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
          for (const event of events) {
            if (!this.emitEventData(event.data)) continue;
            if (answersRequest(event.data, requestId)) answered = true;
          }
          if (done) break;
        }
      } catch (error) {
        if (request.signal.aborted) stoppedEarly = true;
        else failure = error;
      } finally {
        try {
          reader?.cancel("done");
        } catch {
        }
        request.abort("settled");
      }
      if (answered || stoppedEarly || this.closed) return;
      const reason = failure === void 0 ? "stream ended without a response" : toError2(failure).message;
      this.emitMessage({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` }
      });
    }
  };
  function answersRequest(data, requestId) {
    try {
      const message = JSON.parse(data);
      return message.id === requestId && message.method === void 0;
    } catch {
      return false;
    }
  }

  // ../../../packages/ext-mcp-http/src/client.ts
  var MCP_PROTOCOL_VERSION = "2025-06-18";
  var MAX_LIST_PAGES = 1e3;
  function invalid(message) {
    return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
  }
  function validateInitializeResult(value) {
    if (!isObject(value) || typeof value.protocolVersion !== "string") throw invalid("Invalid MCP initialize result");
    return {
      protocolVersion: value.protocolVersion,
      capabilities: isObject(value.capabilities) ? value.capabilities : {},
      ...isObject(value.serverInfo) && typeof value.serverInfo.name === "string" ? { serverInfo: value.serverInfo } : {},
      ...typeof value.instructions === "string" ? { instructions: value.instructions } : {}
    };
  }
  function validateCallToolResult(value) {
    if (!isObject(value) || value.content !== void 0 && !Array.isArray(value.content)) {
      throw invalid("Invalid MCP tools/call result");
    }
    return value.content === void 0 ? { ...value, content: [] } : value;
  }
  var McpClient = class {
    constructor(options) {
      __publicField(this, "options");
      __publicField(this, "state", "idle");
      __publicField(this, "transport");
      __publicField(this, "nextRequestId", 1);
      __publicField(this, "instructionsValue");
      __publicField(this, "protocolVersionValue");
      __publicField(this, "pending", /* @__PURE__ */ new Map());
      __publicField(this, "requestHandlers", /* @__PURE__ */ new Map());
      __publicField(this, "notificationListeners", /* @__PURE__ */ new Map());
      __publicField(this, "errorListeners", /* @__PURE__ */ new Set());
      __publicField(this, "closeListeners", /* @__PURE__ */ new Set());
      __publicField(this, "disposers", []);
      this.options = Object.freeze({ ...options });
      this.requestHandlers.set("ping", () => ({}));
    }
    get connectionState() {
      return this.state;
    }
    /** Server instructions from `initialize`, describing its tools as a group. */
    get instructions() {
      return this.instructionsValue;
    }
    get protocolVersion() {
      return this.protocolVersionValue;
    }
    async connect(transport, options = {}) {
      if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
      this.state = "connecting";
      this.transport = transport;
      this.disposers = [
        transport.onMessage((message) => this.handleMessage(message)),
        // Transport errors are reported only; pending requests fail when the transport closes.
        transport.onError((error) => this.emitError(error)),
        transport.onClose(() => this.markClosed(new McpConnectionClosedError()))
      ];
      try {
        await transport.start();
        const result = validateInitializeResult(
          await this.requestInternal(
            "initialize",
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: this.options.name, version: this.options.version }
            },
            options,
            true
          )
        );
        this.protocolVersionValue = result.protocolVersion;
        this.instructionsValue = result.instructions?.trim() || void 0;
        transport.setProtocolVersion?.(result.protocolVersion);
        await this.notifyInternal("notifications/initialized", void 0, true);
        this.state = "connected";
        return result;
      } catch (error) {
        await this.close().catch(() => {
        });
        throw error;
      }
    }
    request(method, params, options = {}) {
      return this.requestInternal(method, params, options, false);
    }
    notify(method, params) {
      return this.notifyInternal(method, params, false);
    }
    onNotification(method, listener) {
      const listeners = this.notificationListeners.get(method) ?? /* @__PURE__ */ new Set();
      this.notificationListeners.set(method, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.notificationListeners.delete(method);
      };
    }
    onError(listener) {
      this.errorListeners.add(listener);
      return () => this.errorListeners.delete(listener);
    }
    /** Called once when the connection closes, whether the transport dropped or `close()` was called. */
    onClose(listener) {
      this.closeListeners.add(listener);
      return () => this.closeListeners.delete(listener);
    }
    /** Every tool, following `nextCursor` through all pages. */
    async listTools(options = {}) {
      const tools = [];
      const cursors = /* @__PURE__ */ new Set();
      let cursor;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const value = await this.request("tools/list", cursor === void 0 ? void 0 : { cursor }, options);
        const items = isObject(value) ? value.tools : void 0;
        if (!isObject(value) || !Array.isArray(items)) throw invalid("Invalid MCP tools/list result");
        for (const item of items) {
          if (!isObject(item) || typeof item.name !== "string") throw invalid("Invalid entry in MCP tools/list result");
          tools.push({
            ...item,
            inputSchema: isObject(item.inputSchema) ? item.inputSchema : { type: "object", properties: {} }
          });
        }
        const next = value.nextCursor === null || value.nextCursor === "" ? void 0 : value.nextCursor;
        if (next === void 0) return tools;
        if (typeof next !== "string") throw invalid("Invalid MCP tools/list cursor");
        if (cursors.has(next)) throw new Error(`MCP tools/list returned duplicate cursor: ${next}`);
        cursors.add(next);
        cursor = next;
      }
      throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
    }
    async callTool(name, args, options = {}) {
      return validateCallToolResult(
        await this.request("tools/call", { name, ...args === void 0 ? {} : { arguments: args } }, options)
      );
    }
    async close() {
      const transport = this.transport;
      this.transport = void 0;
      for (const dispose of this.disposers.splice(0)) dispose();
      this.markClosed(new McpConnectionClosedError());
      await transport?.close();
    }
    requestInternal(method, params, options, allowConnecting) {
      let transport;
      try {
        transport = this.requireTransport(allowConnecting);
      } catch (error) {
        return Promise.reject(error);
      }
      if (options.signal?.aborted) return Promise.reject(new McpAbortError());
      const id = this.nextRequestId++;
      const message = { jsonrpc: "2.0", id, method, ...params === void 0 ? {} : { params } };
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal: options.signal,
          onAbort: () => this.failPending(id, new McpAbortError()),
          settle: new AbortHandle()
        };
        this.pending.set(id, entry);
        options.signal?.addEventListener("abort", entry.onAbort);
        const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
        const sleep = this.options.platform?.sleep;
        if (timeoutMs !== void 0 && Number.isFinite(timeoutMs) && timeoutMs > 0 && sleep) {
          sleep(timeoutMs, entry.settle.signal).then(
            () => this.failPending(id, new McpTimeoutError(timeoutMs)),
            () => {
            }
          );
        }
        transport.send(message, { signal: entry.settle.signal }).catch((error) => this.failPending(id, error));
      });
    }
    async notifyInternal(method, params, allowConnecting) {
      await this.requireTransport(allowConnecting).send({
        jsonrpc: "2.0",
        method,
        ...params === void 0 ? {} : { params }
      });
    }
    requireTransport(allowConnecting) {
      if (this.transport && (this.state === "connected" || allowConnecting && this.state === "connecting")) {
        return this.transport;
      }
      throw new McpConnectionClosedError(`MCP client is ${this.state}`);
    }
    handleMessage(message) {
      if (isJsonRpcResponse(message)) this.handleResponse(message);
      else if (isJsonRpcRequest(message)) void this.handleRequest(message);
      else if (isJsonRpcNotification(message)) this.handleNotification(message.method, message.params);
      else this.emitError(invalid("Received invalid JSON-RPC message"));
    }
    handleResponse(message) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
        return;
      }
      this.removePending(message.id, entry);
      if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
      else entry.resolve(message.result);
    }
    /** Answer a server request: `ping`, or method-not-found so the server never waits forever. */
    async handleRequest(message) {
      const transport = this.transport;
      if (!transport) return;
      const handler = this.requestHandlers.get(message.method);
      let reply;
      if (!handler) {
        reply = {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` }
        };
      } else {
        try {
          reply = { jsonrpc: "2.0", id: message.id, result: await handler(message.params) ?? {} };
        } catch (error) {
          reply = {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: JSON_RPC_ERROR_CODES.internalError, message: toError2(error).message }
          };
        }
      }
      await transport.send(reply).catch((error) => this.emitError(error));
    }
    handleNotification(method, params) {
      for (const listener of this.notificationListeners.get(method) ?? []) {
        try {
          listener(params);
        } catch (error) {
          this.emitError(error);
        }
      }
    }
    failPending(id, error) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.removePending(id, entry);
      entry.reject(error);
    }
    removePending(id, entry) {
      this.pending.delete(id);
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.settle.abort("settled");
    }
    /** Idempotent: rejects in-flight requests and flips the state. */
    markClosed(error) {
      const wasClosed = this.state === "closed";
      this.state = "closed";
      for (const [id, entry] of this.pending) {
        this.removePending(id, entry);
        entry.reject(error);
      }
      if (wasClosed) return;
      for (const listener of [...this.closeListeners]) {
        try {
          listener();
        } catch (listenerError) {
          this.emitError(listenerError);
        }
      }
    }
    emitError(error) {
      const normalized = toError2(error);
      for (const listener of this.errorListeners) listener(normalized);
    }
  };

  // ../../../packages/ext-mcp-http/src/naming.ts
  var MAX_TOOL_NAME_LENGTH = 64;
  function mcpNamespace(server) {
    return `mcp__${server.replace(/-/g, "_")}`;
  }
  function createMcpToolName(server, tool, isTaken = () => false) {
    const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
    if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
    const hash = sha256Hex(`${server}\0${tool}`).slice(0, 8);
    return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
  }
  function utf8Bytes(text) {
    const bytes = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 128) bytes.push(code);
      else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
      else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      else
        bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
    }
    return bytes;
  }
  var K = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  function sha256Hex(text) {
    const bytes = utf8Bytes(text);
    const bitLength = bytes.length * 8;
    bytes.push(128);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(
      0,
      0,
      0,
      0,
      bitLength >>> 24 & 255,
      bitLength >>> 16 & 255,
      bitLength >>> 8 & 255,
      bitLength & 255
    );
    const h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
    const w = new Array(64);
    const rotr = (x, n) => x >>> n | x << 32 - n;
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        const j = offset + i * 4;
        w[i] = (bytes[j] << 24 | bytes[j + 1] << 16 | bytes[j + 2] << 8 | bytes[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] >>> 0;
        const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    return h.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  // ../../../packages/ext-mcp-http/src/exposure.ts
  function toolPatternRegExp(pattern) {
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${source}$`);
  }
  function getMcpToolExposure(config, toolName) {
    const overrides = config.toolExposure ?? {};
    const exact = overrides[toolName];
    if (exact !== void 0) return exact;
    for (const [pattern, exposure] of Object.entries(overrides)) {
      if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
    }
    return config.exposure ?? "direct";
  }
  function toToolExposure(exposure) {
    return exposure === "codemode" ? "deferred" : exposure;
  }
  function configuredExposures(config) {
    return /* @__PURE__ */ new Set([config.exposure ?? "direct", ...Object.values(config.toolExposure ?? {})]);
  }
  var CONTENT_BLOCK_SCHEMA = {
    type: "object",
    properties: {
      type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
      text: { type: "string" },
      data: { type: "string" },
      mimeType: { type: "string" }
    },
    required: ["type"],
    additionalProperties: true
  };
  var SCHEMA_DATA_KEYWORDS = /* @__PURE__ */ new Set(["const", "enum", "default", "examples"]);
  var SCHEMA_MAP_KEYWORDS = /* @__PURE__ */ new Set([
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
    "$defs",
    "definitions"
  ]);
  function relocateSchema(schema, pointer) {
    if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
    if (typeof schema !== "object" || schema === null) return schema;
    const relocated = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
        relocated[key] = `${pointer}${value.slice(1)}`;
      } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
        relocated[key] = value;
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
        relocated[key] = Object.fromEntries(
          Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)])
        );
      } else {
        relocated[key] = relocateSchema(value, pointer);
      }
    }
    return relocated;
  }
  function createMcpResultSchema(structuredContentSchema) {
    return {
      type: "object",
      properties: {
        content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
        structuredContent: structuredContentSchema ? relocateSchema(structuredContentSchema, "#/properties/structuredContent") : {},
        isError: { type: "boolean" }
      },
      required: ["content"],
      // Fields newer protocol versions add.
      additionalProperties: true
    };
  }
  var MAX_SERVER_DESCRIPTION_CHARS = 250;
  var MAX_SERVERS_SECTION_CHARS = 4096;
  function hasIndirectTools(config) {
    const exposures = configuredExposures(config);
    return exposures.has("codemode") || exposures.has("deferred");
  }
  function serversSectionIntro(reaches) {
    let intro = "MCP servers whose tools are not declared to you.";
    if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
    if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
    return intro;
  }
  function truncate(text, max) {
    if (text.length <= max) return text;
    return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}\u2026`;
  }
  function serverSummary(server) {
    const text = server.config.description?.trim() || server.instructions || "";
    return (text.split("\n", 1)[0] ?? "").trim();
  }
  function renderServersSection(servers) {
    const listed = servers.filter((server) => hasIndirectTools(server.config)).sort((a, b) => a.name.localeCompare(b.name));
    if (listed.length === 0) return void 0;
    const reaches = listed.map(
      (server) => configuredExposures(server.config).has("codemode") ? "codemode" : "tool_search"
    );
    const intro = serversSectionIntro(new Set(reaches));
    const heads = listed.map((server, index) => `- ${mcpNamespace(server.name)} (${reaches[index]})`);
    const omitted = (count) => count > 0 ? [`- \u2026 ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
    const size = (kept2) => [intro, ...heads.slice(0, kept2), ...omitted(listed.length - kept2)].join("\n").length;
    let kept = listed.length;
    while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
    const perServer = kept === 0 ? 0 : Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
    const lines = listed.slice(0, kept).map((server, index) => {
      const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
      return summary ? `${heads[index]}: ${summary}` : heads[index];
    });
    return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
  }
  function reachesServer(reach, server) {
    if (reach === "all") return true;
    const namespace = mcpNamespace(server);
    return reach.some((word) => word.includes(namespace));
  }

  // ../../../packages/ext-mcp-http/src/result.ts
  var MCP_OUTPUT_MAX_BYTES = 20 * 1024;
  function toolOutput(result) {
    const parts = [];
    for (const block of result.content) {
      if (block.type === "text" && block.text !== void 0) {
        parts.push(block.text);
      } else if (block.type === "resource" && block.resource?.text !== void 0) {
        parts.push(`[resource ${block.resource.uri ?? ""}]
${block.resource.text}`);
      } else if (block.type === "resource_link") {
        parts.push(`[resource link ${block.uri ?? ""}${block.name ? ` ${block.name}` : ""}]`);
      } else if (block.type === "image" || block.type === "audio" || block.resource?.blob !== void 0) {
        parts.push(binaryPlaceholder(block));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    if (result.structuredContent !== void 0 && parts.length === 0)
      parts.push(JSON.stringify(result.structuredContent));
    return parts.join("\n").trim() || "(empty MCP tool result)";
  }
  function binaryPlaceholder(block) {
    const data = block.data ?? block.resource?.blob ?? "";
    const mimeType = block.mimeType ?? block.resource?.mimeType ?? "application/octet-stream";
    const kib = Math.max(1, Math.round(data.length * 3 / 4 / 1024));
    const uri = block.resource?.uri ? ` ${block.resource.uri}` : "";
    return `[${block.type === "resource" ? "binary resource" : block.type}${uri} ${mimeType}, ~${kib} KiB omitted]`;
  }

  // ../../../packages/ext-mcp-http/src/servers.ts
  var DEFAULT_HANDSHAKE_TIMEOUT_MS = 1e4;
  var DEFAULT_STARTUP_WAIT_MS = 1e4;
  var CONNECT_RETRY_DELAYS_MS = [250, 1e3];
  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  function isTransientError(error) {
    if (error instanceof McpHttpError) {
      return error.status === 408 || error.status === 429 || error.status >= 500 && error.status !== 501;
    }
    return !(error instanceof McpError || error instanceof McpTimeoutError || error instanceof McpAbortError || error instanceof McpConnectionClosedError);
  }
  function aborted(signal) {
    return new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
  }
  function createMcpServers(options) {
    const states = [];
    for (const config of options.servers) {
      const clash = states.find((state) => mcpNamespace(state.config.name) === mcpNamespace(config.name));
      states.push({
        config,
        tools: /* @__PURE__ */ new Set(),
        ...clash ? { conflict: `server "${config.name}" conflicts with "${clash.config.name}"` } : {}
      });
    }
    const toolOwners = /* @__PURE__ */ new Map();
    const definitions = /* @__PURE__ */ new Map();
    const clients = /* @__PURE__ */ new Set();
    let generation = 0;
    let api;
    let sessionCtx;
    let waitedForStartup = false;
    const report = (status) => {
      options.onStatus?.(status);
      return status;
    };
    const reportUnavailable = (server, error) => {
      const message = `MCP server "${server}" unavailable: ${error}`;
      if (sessionCtx?.ui) sessionCtx.ui.notify(message, "warning");
      else options.reportUnavailable?.(message);
    };
    const namespaceOf = (state) => {
      const description = state.config.description?.trim();
      return {
        name: mcpNamespace(state.config.name),
        // describeNamespace("docs") finds mcp__docs.
        aliases: [state.config.name],
        ...description ? { description } : {},
        ...state.instructions ? { instructions: state.instructions } : {}
      };
    };
    const openOnce = async (state, list) => {
      const client = new McpClient({ ...options.clientInfo, platform: options.platform });
      clients.add(client);
      client.onClose(() => {
        clients.delete(client);
        if (state.client === client) state.client = void 0;
      });
      try {
        const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        await client.connect(options.createTransport(state.config), { timeoutMs });
        client.onNotification("notifications/tools/list_changed", () => {
          void refreshTools(state, client);
        });
        state.instructions = client.instructions;
        const tools = list ? await client.listTools({ timeoutMs }) : [];
        return { client, tools };
      } catch (error) {
        await client.close().catch(() => {
        });
        throw error;
      }
    };
    const openClient = async (state, list) => {
      const retries = state.config.url && options.platform.sleep ? CONNECT_RETRY_DELAYS_MS : [];
      const startedIn = generation;
      for (let attempt = 0; ; attempt++) {
        try {
          return await openOnce(state, list);
        } catch (error) {
          const delay = retries[attempt];
          if (delay === void 0 || startedIn !== generation || !isTransientError(error)) throw error;
          await options.platform.sleep?.(delay);
        }
      }
    };
    const clientFor = async (state) => {
      if (state.client?.connectionState === "connected") return state.client;
      const { client } = await openClient(state, false);
      state.client = client;
      return client;
    };
    const refreshTools = async (state, client) => {
      await state.connecting;
      if (state.client !== client || !api) return;
      try {
        const tools = await client.listTools({ timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS });
        if (state.client === client) registerTools(api, state, tools);
      } catch {
      }
    };
    const activateReachingTools = (target, state) => {
      const exposures = configuredExposures(state.config);
      if (!exposures.has("codemode") && !exposures.has("deferred")) return;
      const registered = new Set(target.getAllTools().map((tool) => tool.name));
      const active = target.getActiveTools();
      const wanted = [
        ...exposures.has("codemode") && registered.has("codemode") ? ["codemode"] : [],
        ...exposures.has("deferred") && registered.has("tool_search") ? ["tool_search"] : []
      ].filter((name) => !active.includes(name));
      if (wanted.length > 0) target.setActiveTools([...active, ...wanted]);
    };
    const registerTools = (target, state, tools) => {
      const server = state.config.name;
      const namespace = namespaceOf(state);
      const previous = state.tools;
      const current = /* @__PURE__ */ new Set();
      const plain = [...new Set(tools.map((tool) => tool.name))].map((tool) => createMcpToolName(server, tool));
      for (const info of tools) {
        const owner = `${server}\0${info.name}`;
        const name = createMcpToolName(server, info.name, (candidate) => {
          const existing = toolOwners.get(candidate);
          return existing !== void 0 && existing !== owner || current.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate);
        });
        current.add(name);
        toolOwners.set(name, owner);
        const definition = createTauTool(state, name, info, namespace);
        definitions.set(name, definition);
        const destructive = state.config.riskFromAnnotations === true && info.annotations?.destructiveHint === true;
        target.registerTool(definition, destructive ? { risk: "high" } : void 0);
      }
      state.tools = current;
      for (const name of previous) {
        const definition = definitions.get(name);
        if (!current.has(name) && definition) target.registerTool({ ...definition, exposure: "hidden" });
      }
      activateReachingTools(target, state);
    };
    const createTauTool = (state, name, info, namespace) => ({
      name,
      description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
      parameters: info.inputSchema,
      outputSchema: createMcpResultSchema(info.outputSchema),
      exposure: toToolExposure(getMcpToolExposure(state.config, info.name)),
      namespace,
      execute: async (args, signal) => {
        if (signal?.aborted) return { content: [{ type: "text", text: "MCP tool call aborted" }], isError: true };
        if (!state.tools.has(name)) {
          return {
            content: [{ type: "text", text: `MCP tool "${state.config.name}/${info.name}" is no longer available.` }],
            isError: true
          };
        }
        try {
          let result;
          try {
            result = await (await clientFor(state)).callTool(info.name, args, { signal });
          } catch (cause) {
            if (!(cause instanceof McpSessionExpiredError)) throw cause;
            await state.client?.close();
            result = await (await clientFor(state)).callTool(info.name, args, { signal });
          }
          const text = limitToolText(
            toolOutput(result),
            MCP_OUTPUT_MAX_BYTES,
            options.saveFullOutput ?? (() => "[Full output not saved: this MCP client has no file access]")
          );
          const { _meta: _ignored, ...scriptResult } = result;
          return {
            content: [{ type: "text", text }],
            structuredContent: scriptResult,
            isError: result.isError === true
          };
        } catch (cause) {
          const text = cause instanceof McpAbortError ? "MCP tool call aborted" : messageOf(cause);
          return { content: [{ type: "text", text }], isError: true };
        }
      }
    });
    const connectOne = (state) => {
      const server = state.config.name;
      if (state.conflict) return Promise.resolve(report({ server, state: "offline", error: state.conflict }));
      if (state.client?.connectionState === "connected") {
        return Promise.resolve({ server, state: "connected", toolCount: state.tools.size });
      }
      if (state.connecting) return state.connecting;
      const startedIn = generation;
      report({ server, state: "connecting" });
      const attempt = (async () => {
        try {
          const { client, tools } = await openClient(state, true);
          if (startedIn !== generation) {
            await client.close();
            return { server, state: "offline", error: "shut down while connecting" };
          }
          state.client = client;
          if (api) registerTools(api, state, tools);
          return report({ server, state: "connected", toolCount: tools.length });
        } catch (cause) {
          const status = report({ server, state: "offline", error: messageOf(cause) });
          if (startedIn === generation) reportUnavailable(server, status.error ?? "");
          return status;
        }
      })().finally(() => {
        state.connecting = void 0;
      });
      state.connecting = attempt;
      return attempt;
    };
    const connect2 = async () => {
      if (!api) {
        throw new Error(
          "connect() called before the extension was loaded \u2014 pass it through ExtensionRegistry.load first"
        );
      }
      return Promise.all(states.map(connectOne));
    };
    const close = async () => {
      generation++;
      const closing = [...clients];
      clients.clear();
      for (const state of states) state.client = void 0;
      await Promise.allSettled(closing.map((client) => client.close()));
    };
    const waitFor = async (waiting, signal) => {
      const pending = waiting.flatMap((state) => state.connecting ? [state.connecting] : []);
      if (pending.length > 0) await Promise.race([Promise.all(pending), aborted(signal)]);
    };
    const extension = (extensionApi) => {
      api = extensionApi;
      extensionApi.on("session_start", (_event, ctx) => {
        sessionCtx = ctx;
        waitedForStartup = false;
        for (const state of states) if (!state.conflict) activateReachingTools(extensionApi, state);
        void connect2();
      });
      extensionApi.on("before_agent_start", async (event, ctx) => {
        if (!waitedForStartup) {
          waitedForStartup = true;
          const direct = states.filter((state) => state.connecting && configuredExposures(state.config).has("direct"));
          const sleep = options.platform.sleep;
          if (direct.length > 0 && sleep) {
            const finished = await Promise.race([
              Promise.all(direct.map((state) => state.connecting)).then(() => true),
              sleep(options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS).then(
                () => false,
                () => false
              )
            ]);
            if (!finished) {
              ctx.ui?.notify("MCP servers are still connecting; their tools become available once connected.", "info");
            }
          }
        }
        const section = renderServersSection(
          states.filter((state) => !state.conflict).map((state) => ({ name: state.config.name, config: state.config, instructions: state.instructions }))
        );
        return section ? { systemPrompt: `${event.systemPrompt}

${section}` } : void 0;
      });
      extensionApi.on("tool_call", async (event, ctx) => {
        const tool = extensionApi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool) return void 0;
        const reach = tool.reachesTools?.(event.input);
        const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
        const waiting = reach !== void 0 ? states.filter((state) => reachesServer(reach, state.config.name)) : states.filter((state) => state.config.name === owner);
        await waitFor(waiting, ctx.signal);
        return void 0;
      });
      extensionApi.on("session_shutdown", async () => {
        sessionCtx = void 0;
        await close();
      });
    };
    return { extension, connect: connect2, close };
  }

  // ../../../packages/ext-mcp-http/src/index.ts
  var CLIENT_INFO = { name: "tau-ext-mcp-http", version: "0.4.0" };
  function createHttpMcpExtension(options) {
    const { platform: platform2 } = options;
    const handle = createMcpServers({
      servers: options.servers,
      platform: platform2,
      clientInfo: CLIENT_INFO,
      onStatus: options.onStatus,
      createTransport: (config) => {
        if (!config.url) throw new Error(`MCP server "${config.name}" must define url`);
        return new StreamableHttpTransport({
          url: config.url,
          platform: platform2,
          headers: config.headers,
          openGetStream: options.serverNotifications === true
        });
      }
    });
    return {
      extension: handle.extension,
      connect: async () => {
        await handle.connect();
      }
    };
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
            output: toolResultText(event.result),
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
      const leftover = agent.clearQueue();
      const dropped = leftover.steering.length + leftover.followUp.length;
      if (dropped > 0) emit("tau_event", { type: "queue_dropped", count: dropped });
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
      void agent?.steer(text);
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
