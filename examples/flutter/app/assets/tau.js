"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // test-fixtures/quickjs/polyfills.ts
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

  // packages/kernel/src/abort.ts
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

  // packages/kernel/src/errors.ts
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

  // packages/kernel/src/messages.ts
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

  // packages/kernel/src/projection.ts
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

  // packages/kernel/src/compaction.ts
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
  async function completeText(transport, systemPrompt, promptText, maxTokens, signal) {
    const now = Date.now();
    const stream = transport({
      messages: [
        { role: "system", content: systemPrompt, timestamp: now },
        { role: "user", content: promptText, timestamp: now }
      ],
      maxTokens,
      signal
    });
    let final;
    for await (const event of stream) {
      if (event.type === "response_end") final = event.message;
    }
    if (!final) throw new TauError("compaction_failed", "Summarization returned no message");
    return { text: messageText(final), usage: final.usage };
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
    return completeText(transport, SUMMARIZATION_SYSTEM_PROMPT, promptText, maxTokens, options.signal);
  }
  async function runCompaction(transport, preparation, customInstructions, signal) {
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
          signal
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
        signal
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
        signal
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

  // packages/kernel/src/branch.ts
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
    const generated = await completeText(transport, SUMMARIZATION_SYSTEM_PROMPT, promptText, 2048, options?.signal);
    let summary = BRANCH_SUMMARY_PREAMBLE + generated.text;
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    return { summary: summary || "No summary generated", readFiles, modifiedFiles, usage: generated.usage };
  }

  // packages/kernel/src/json.ts
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

  // packages/kernel/src/sse.ts
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

  // packages/kernel/src/transform.ts
  function transformMessages(messages, target) {
    const transformed = messages.map((msg) => {
      if (msg.role !== "assistant") return msg;
      if (isSameLineage(msg, target)) return msg;
      const content = msg.content.flatMap((block) => {
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

  // packages/kernel/src/openai.ts
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
  function userContentToWire(content) {
    if (typeof content === "string") return content;
    return content.map(
      (block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
    );
  }
  function toolResultContentToWire(content) {
    return content.map((block) => block.type === "text" ? block.text : "[image omitted]").join("\n");
  }
  function toWireMessage(message, replayEmptyReasoning) {
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
        const thinking = message.content.filter((block) => block.type === "thinking" && !block.redacted);
        const reasoningText = thinking.map((block) => block.type === "thinking" ? block.thinking : "").join("");
        if (reasoningText !== "") {
          const first = thinking[0];
          const field = first?.type === "thinking" && isReasoningField(first.thinkingSignature) ? first.thinkingSignature : "reasoning_content";
          wire[field] = reasoningText;
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
        return { role: "system", content: renderSystemMessageUpdate(message) };
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
    if (systemPrompt !== "") wire.push({ role: "system", content: systemPrompt });
    for (const message of messages) wire.push(toWireMessage(message, replayEmptyReasoning));
    return wire;
  }
  function toUsage(wire) {
    const prompt = wire.prompt_tokens ?? 0;
    const cacheRead = wire.prompt_tokens_details?.cached_tokens ?? 0;
    const input = Math.max(0, prompt - cacheRead);
    const output = wire.completion_tokens ?? 0;
    return {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: wire.total_tokens ?? prompt + output,
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
    throwIfAborted(options?.signal);
    const startedAt = Date.now();
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const api = config.api ?? OPENAI_COMPLETIONS_API;
    const provider = config.provider ?? "openai-compat";
    const replayEmptyReasoning = config.replayEmptyReasoning ?? /(^|[./])deepseek\.com(?=[:/]|$)/i.test(hostOf(config.baseUrl));
    const transcript = resolveTranscript(messages, config.midConversationSystemMessages);
    const body = {
      model: config.model,
      messages: toWireMessages(
        transcript.systemPrompt,
        transformMessages(transcript.messages, { api, provider, model: config.model }),
        replayEmptyReasoning
      ),
      stream: true,
      ...options?.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
      ...config.extraBody
    };
    if (config.includeUsage !== false) body.stream_options = { include_usage: true };
    if (transcript.tools.length > 0) {
      body.tools = transcript.tools.map((tool) => ({
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
    const rawToolCalls = [];
    const rawByIndex = /* @__PURE__ */ new Map();
    const rawById = /* @__PURE__ */ new Map();
    let finishReason;
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
      if (choice.finish_reason) finishReason = choice.finish_reason;
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
    const toolCalls = rawToolCalls.map((raw, index) => [index, raw]).filter(([, raw]) => raw.name !== "").map(([index, raw]) => {
      let parsedArguments = {};
      try {
        const parsed = raw.argumentsText === "" ? {} : parseJsonWithRepair(raw.argumentsText);
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
      api,
      provider,
      model: config.model,
      usage: usage ?? emptyUsage(),
      stopReason: toStopReason(finishReason, toolCalls.length > 0),
      ...finishReason !== void 0 ? { rawStopReason: finishReason } : {},
      ...responseId !== void 0 ? { responseId } : {},
      ...responseModel !== void 0 ? { responseModel } : {},
      timestamp: startedAt
    };
    yield { type: "response_end", message };
  }
  function createOpenAICompatTransport(platform2, config) {
    return (request) => streamChatCompletion(platform2, config, request.messages, {
      signal: request.signal,
      maxTokens: request.maxTokens
    });
  }

  // packages/kernel/src/platform.ts
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

  // packages/kernel/src/policy.ts
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

  // packages/kernel/src/retry.ts
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

  // packages/kernel/src/uuid.ts
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

  // packages/kernel/src/session.ts
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

  // packages/kernel/src/tools.ts
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

  // packages/kernel/src/agent.ts
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
        this.enqueueBackground(() => this.refresh());
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
          });
        }
      }
      this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
      this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
      this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
      this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
      this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options.retry };
      this.pricing = options.pricing;
      this.permissionMode = options.permissionMode ?? "autonomous";
      this.policy = options.policy ?? createDefaultPolicy();
      this.onApproval = options.onApproval;
      this.toolExecution = options.toolExecution ?? "parallel";
      this.verifyTranscript = options.verifyTranscript ?? true;
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
          this.enqueueBackground(() => this.appendAndRefresh(message));
          if (sendOptions?.triggerTurn) this.extensions?.hostAction("resumeTurn")?.();
        },
        sendUserMessage: (content, sendOptions) => {
          if (this.looping) {
            const message = { role: "user", content, timestamp: Date.now() };
            if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
            else this.steeringQueue.enqueue(message);
            return;
          }
          if (this.running) {
            throw new TauError("busy", "sendUserMessage() before the agent loop started; use sendMessage({ deliverAs })");
          }
          const submit = this.extensions?.hostAction("submitPrompt");
          if (!submit) {
            throw new TauError("no_host", "sendUserMessage() while idle requires a host that provides submitPrompt");
          }
          submit(content);
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
          this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
        }
      });
    }
    currentTools() {
      const tools = new Map(this.baseTools.map((tool) => [tool.name, tool]));
      for (const [name, tool] of this.extensions?.tools ?? []) tools.set(name, tool);
      return tools;
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
      const tools = getToolStateChanges(
        getCurrentTools(this.messages),
        // A schemaless tool that slipped past registration cannot be declared; the
        // preflight guard still answers a call to it with a paired error result (HF-8).
        [...this.currentTools().values()].filter(hasToolSchema).map(toToolDeclaration)
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
    /** Session entry id a projected message came from (undefined for messages not in `messages`). */
    entryIdOf(message) {
      return this.entryIds.get(message);
    }
    /** Fire message_start/message_end for a non-streamed message, then log it. */
    async commitMessage(message, ctx) {
      let final = message;
      if (this.extensions) {
        await this.extensions.notifyMessageStart(final, ctx);
        final = await this.extensions.runMessageEnd(final, ctx);
      }
      await this.record(final);
      return final;
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
          this.pendingCompaction = customInstructions ?? "";
        },
        runSubagent: (prompt, options, signal) => this.runSubagent(prompt, options, signal),
        abort: () => {
          const hostAbort = this.extensions?.hostAction("abort");
          if (hostAbort) hostAbort();
          else this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
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
      const child = new _Agent({
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
        toolExecution: this.toolExecution
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
      return this.pricing ? { ...usage, cost: computeUsageCost(usage, this.pricing) } : usage;
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
    /**
     * Compact the conversation now: summarize old history (session_before_compact
     * may cancel or take over) and append a compaction entry; the projection
     * becomes [summary, ...kept].
     */
    async compact(customInstructions, reason = "manual", signal) {
      const ctx = this.extensionContext();
      await this.flushWrites();
      const pathEntries = await this.session.store.getPathToRoot(this.session.currentLeafId);
      const preparation = prepareCompaction(pathEntries, this.compactionSettings);
      if (!preparation) return void 0;
      const decision = this.extensions ? await this.extensions.runSessionBeforeCompact({ preparation, customInstructions, reason }, ctx) : {};
      if (decision.cancel) return void 0;
      const fromExtension = decision.result !== void 0;
      const result = decision.result ?? await runCompaction(this.transport, preparation, customInstructions, signal);
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
        await this.flushWrites();
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
        await this.flushWrites();
        const ctx = this.extensionContext();
        const systemPrompt = await this.applyBeforeAgentStart(lastPromptText(this.messages), ctx);
        await this.extensions?.notifyAgentStart(ctx);
        yield* this.runLoop(ctx, systemPrompt, handle.signal);
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
      if (this.running) throw new TauError("busy", "navigateTo() requires an idle agent");
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
      const hook = this.extensions ? await this.extensions.runSessionBeforeTree({ preparation, signal: options?.signal }, ctx) : {};
      if (hook.cancel) return { cancelled: true };
      let summaryText = hook.summary?.summary;
      let summaryDetails = hook.summary?.details;
      let summaryUsage = hook.summary?.usage;
      if (!summaryText && options?.summarize !== false && entries.length > 0) {
        try {
          const generated = await generateBranchSummary(this.transport, entries, {
            customInstructions: hook.customInstructions ?? options?.customInstructions,
            contextWindow: this.config.contextWindow,
            signal: options?.signal
          });
          summaryText = generated.summary;
          summaryDetails = { readFiles: generated.readFiles, modifiedFiles: generated.modifiedFiles };
          summaryUsage = generated.usage;
        } catch (error) {
          if (error instanceof TauError && error.code === "aborted") return { cancelled: true };
          throw error;
        }
      }
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
        const inputResult = await this.extensions.runInput(inputText, ctx);
        if (inputResult.handled) {
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        if (typeof input === "string") finalInput = inputResult.text;
        else if (inputResult.text !== inputText) {
          finalInput = [{ type: "text", text: inputResult.text }, ...input.filter((block) => block.type === "image")];
        }
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
        await this.declareLoadout(base);
        return base;
      }
      const beforeStart = await this.extensions.runBeforeAgentStart(promptText, base, ctx);
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
          await this.flushWrites();
          await this.extensions?.notifyAgentEnd(this.messages, ctx);
          yield { type: "agent_end", messages: this.messages };
          return;
        }
        await this.extensions?.notifyTurnStart(turnIndex, ctx);
        let compactionReason;
        let customInstructions;
        if (this.pendingCompaction !== null) {
          compactionReason = "manual";
          customInstructions = this.pendingCompaction === "" ? void 0 : this.pendingCompaction;
          this.pendingCompaction = null;
        } else if (this.config.contextWindow !== void 0 && shouldCompact(this.getContextUsage().tokens, this.config.contextWindow, this.compactionSettings)) {
          compactionReason = "threshold";
        }
        if (compactionReason !== void 0) {
          let result;
          let failure;
          try {
            result = await this.compact(customInstructions, compactionReason, signal);
          } catch (error) {
            failure = toError(error);
          }
          if (result) yield { type: "compaction", result };
          if (failure) {
            await this.extensions?.notifySessionCompactFailed(
              { reason: compactionReason, errorMessage: failure.message },
              ctx
            );
            yield { type: "compaction_failed", reason: compactionReason, errorMessage: failure.message };
          }
        }
        await this.declareLoadout(systemPrompt);
        await this.flushWrites();
        if (this.verifyTranscript) await this.assertTranscriptMatchesLog();
        let request = [...this.messages];
        if (this.extensions) {
          request = await this.extensions.runContext(request, ctx);
        }
        const partial = {
          role: "assistant",
          content: [],
          api: this.config.api ?? OPENAI_COMPLETIONS_API,
          provider: this.config.provider ?? "openai-compat",
          model: this.config.model,
          usage: emptyUsage(),
          // A streaming partial is unfinished (pi 0.83.0); the final message lands a concrete reason.
          stopReason: "pending",
          timestamp: Date.now()
        };
        const requestStart = partial.timestamp;
        await this.extensions?.notifyMessageStart(partial, ctx);
        let assistantMessage;
        let streamFailure;
        const stream = this.transport({ messages: request, signal });
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
              assistantMessage.durationMs = Math.max(0, Date.now() - requestStart);
              if (this.pricing) assistantMessage.usage.cost = computeUsageCost(assistantMessage.usage, this.pricing);
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
            await this.enqueueWrite(async () => {
              await this.session.appendContextEdit(failedEntryId, null);
              await this.refresh();
            });
            try {
              await this.platform.sleep?.(delayMs, signal);
            } catch {
              const endEvent = { success: false, attempt: retryAttempt, finalError: "Retry cancelled" };
              await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
              yield { type: "auto_retry_end", ...endEvent };
              await this.flushWrites();
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
          await this.flushWrites();
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
        await this.record(assistantMessage);
        yield { type: "assistant_message", message: assistantMessage };
        if (retryAttempt > 0) {
          const endEvent = { success: true, attempt: retryAttempt };
          await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
          yield { type: "auto_retry_end", ...endEvent };
          retryAttempt = 0;
        }
        const toolCalls = toolCallsOf(assistantMessage);
        const toolResults = [];
        const forceSequential = this.toolExecution === "sequential" || toolCalls.some((tc) => this.currentTools().get(tc.name)?.executionMode === "sequential");
        if (forceSequential || toolCalls.length <= 1) {
          yield* this.runToolBatchSequential(toolCalls, ctx, signal, toolResults);
        } else {
          yield* this.runToolBatchParallel(toolCalls, ctx, signal, toolResults);
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
          await this.flushWrites();
          await this.extensions?.notifyAgentEnd(this.messages, ctx);
          yield { type: "agent_end", messages: this.messages };
          return;
        }
      }
      throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
    }
    /** Commit one tool result to messages/session and produce the AgentEvent pair tail. */
    async commitToolResult(toolCall, outcome, ctx, toolResults) {
      const { durationMs, usage, ...result } = outcome;
      const toolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: result.output }],
        isError: result.isError === true,
        timestamp: Date.now(),
        ...durationMs !== void 0 ? { durationMs } : {},
        ...usage ? { usage } : {}
      };
      const committedToolResult = await this.commitMessage(toolResultMessage, ctx);
      toolResults.push(committedToolResult);
      return { type: "tool_result", toolCall, result };
    }
    /** Sequential batch: the pre-P18 behavior — full hook chain, execute, result, one tool at a time. */
    async *runToolBatchSequential(toolCalls, ctx, signal, toolResults) {
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
        yield await this.commitToolResult(toolCall, result, ctx, toolResults);
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
    async *runToolBatchParallel(toolCalls, ctx, signal, toolResults) {
      const preps = [];
      for (const toolCall of toolCalls) {
        yield { type: "tool_start", toolCall };
        preps.push(await this.preflightToolCall(toolCall, ctx, signal));
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
            outcomes[index] = { output: toError(cause).message, isError: true };
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
        yield await this.commitToolResult(preps[index].toolCall, outcomes[index], ctx, toolResults);
      }
    }
    async executeToolCall(toolCall, ctx, signal, onUpdate) {
      const prep = await this.preflightToolCall(toolCall, ctx, signal);
      if (prep.kind === "immediate") return { result: prep.result };
      return { result: await this.executePreparedToolCall(prep, ctx, signal, onUpdate) };
    }
    /**
     * Serial preflight of one tool call: tool_call hook (block/rewrite),
     * argument validation, policy gate, approval, and — for calls that will
     * execute — the tool_execution_start notification. Immediate outcomes
     * (unknown tool, block, invalid args, deny) never see execution hooks.
     */
    async preflightToolCall(toolCall, ctx, signal) {
      const tool = this.currentTools().get(toolCall.name);
      if (!tool) {
        return { kind: "immediate", toolCall, result: { output: `Unknown tool: ${toolCall.name}`, isError: true } };
      }
      let args = JSON.parse(JSON.stringify(toolCall.arguments));
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
            kind: "immediate",
            toolCall,
            result: { output: `Tool call blocked: ${decision.reason ?? "blocked by extension"}`, isError: true }
          };
        }
        args = event.input;
      }
      if (signal?.aborted) return { kind: "immediate", toolCall, result: abortedResult() };
      if (!hasToolSchema(tool)) {
        return {
          kind: "immediate",
          toolCall,
          result: { output: `Tool ${toolCall.name} has no parameters schema and cannot be called`, isError: true }
        };
      }
      const problems = validateToolArgs(tool.parameters, args);
      if (problems.length > 0) {
        return {
          kind: "immediate",
          toolCall,
          result: { output: `Invalid arguments for ${toolCall.name}: ${problems.join("; ")}`, isError: true }
        };
      }
      const policyDecision = this.policy.assess(
        { toolName: toolCall.name, args, declaredRisk: tool.risk },
        this.permissionMode
      );
      const riskText = policyDecision.reason ?? `${policyDecision.risk}-risk tool call in ${this.permissionMode} mode`;
      if (policyDecision.action === "deny") {
        return { kind: "immediate", toolCall, result: { output: `Denied by policy: ${riskText}`, isError: true } };
      }
      if (policyDecision.action === "ask") {
        const handler = this.onApproval ?? this.uiApprovalHandler();
        if (!handler) {
          return {
            kind: "immediate",
            toolCall,
            result: {
              output: `Denied by policy: approval required (${riskText}), but no approval handler is available`,
              isError: true
            }
          };
        }
        const request = {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args,
          risk: policyDecision.risk,
          reason: policyDecision.reason
        };
        let approved;
        try {
          approved = await this.awaitApproval(handler, request, signal);
        } catch (cause) {
          return {
            kind: "immediate",
            toolCall,
            result: { output: `Denied by policy: approval failed (${toError(cause).message})`, isError: true }
          };
        }
        if (!approved) {
          return {
            kind: "immediate",
            toolCall,
            result: { output: `Denied by policy: approval declined (${riskText})`, isError: true }
          };
        }
      }
      await this.extensions?.notifyToolExecutionStart({ toolCallId: toolCall.id, toolName: toolCall.name, args }, ctx);
      return { kind: "prepared", toolCall, tool, args };
    }
    /** Execute a prepared tool call: updates stream, tool_execution_end, tool_result hook. */
    async executePreparedToolCall(prep, ctx, signal, onUpdate) {
      const { toolCall, tool, args } = prep;
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
      let durationMs;
      if (signal?.aborted) {
        result = abortedResult();
      } else {
        const startedAt = Date.now();
        try {
          result = await tool.execute(args, signal, emitUpdate, ctx);
        } catch (cause) {
          result = { output: cause instanceof Error ? cause.message : String(cause), isError: true };
        }
        durationMs = Math.max(0, Date.now() - startedAt);
      }
      await Promise.all(updateNotifications);
      await this.extensions?.notifyToolExecutionEnd(
        { toolCallId: toolCall.id, toolName: toolCall.name, result, ...durationMs !== void 0 ? { durationMs } : {} },
        ctx
      );
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
      return durationMs !== void 0 ? { ...result, durationMs } : result;
    }
    /** Default approval handler over the host UI; no UI means no handler (ask degrades to deny). */
    uiApprovalHandler() {
      const ui = this.ui;
      if (!ui) return void 0;
      return (request) => {
        const summary = JSON.stringify(request.args) ?? "{}";
        const detail = summary.length > 400 ? `${summary.slice(0, 400)}\u2026` : summary;
        return ui.confirm(
          `Allow ${request.toolName}? (${request.risk} risk)`,
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
    return { output: "Operation aborted", isError: true };
  }

  // packages/kernel/src/extensions.ts
  function sameMessages(left, right) {
    return left.length === right.length && left.every((message, index) => message === right[index]);
  }
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
      __publicField(this, "errorSink");
      __publicField(this, "handlers", {
        agent_start: [],
        agent_end: [],
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
    /** Run additional extensions' setup against this registry (e.g. project extensions after a trust decision). */
    async add(extensions) {
      const on = (event, handler) => {
        this.handlers[event].push(handler);
      };
      const api = {
        on,
        registerTool: (tool, options) => {
          assertToolSchema(tool);
          this.tools.set(tool.name, options?.risk !== void 0 ? { ...tool, risk: options.risk } : tool);
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
        setSessionName: (name) => this.requireHostActions("setSessionName")(name),
        setLabel: (entryId, label) => this.requireHostActions("setLabel")(entryId, label)
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
    /** Host-side: isolate notification handlers — their errors go to `sink` instead of the caller (HF-12). */
    setErrorSink(sink) {
      this.errorSink = sink;
    }
    /** Run notification handlers in order; with an error sink, one failing handler does not stop the rest. */
    async dispatch(handlers, event, ctx) {
      for (const handler of handlers) {
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
      for (const handler of this.handlers.context) {
        const visible = current.filter((message) => message.role !== "system");
        const snapshot = visible.slice();
        const result = await handler({ type: "context", messages: visible }, ctx);
        const returned = result?.messages ?? (sameMessages(visible, snapshot) ? void 0 : visible);
        if (!returned || sameMessages(returned, snapshot)) continue;
        const head = getCurrentSystemMessage(current);
        current = head ? [head, ...returned] : returned;
      }
      for (const handler of this.handlers.context_with_system) {
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
      for (const handler of this.handlers.before_agent_start) {
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
      for (const handler of this.handlers.message_end) {
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
      for (const handler of this.handlers.session_before_compact) {
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
      await this.dispatch(this.handlers.session_tree, { type: "session_tree", ...event }, ctx);
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
    async notifyTurnEnd(turnIndex, message, toolResults, ctx) {
      const event = { type: "turn_end", turnIndex, message, toolResults };
      await this.dispatch(this.handlers.turn_end, event, ctx);
    }
  };

  // packages/kernel/src/utf8.ts
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

  // packages/ext-mcp-http/src/index.ts
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

  // examples/flutter/app/js/tau-entry.ts
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
