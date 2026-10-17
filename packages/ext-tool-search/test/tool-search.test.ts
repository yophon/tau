import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent, ExtensionRegistry, type Tool, textResult } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { Bm25Ranker, createToolSearchDocument, createToolSearchExtension, tokenize } from "../src/index.ts";

function tool(name: string, description: string, properties: Record<string, unknown> = {}): Tool {
	return {
		name,
		description,
		parameters: { type: "object", properties },
		execute: async () => textResult(`${name} ran`),
	};
}

// Fixtures and expectations copied from pi's tool-search.test.ts.
test("tokenize splits camelCase and snake_case, drops stop words, and folds plurals", () => {
	assert.deepEqual(tokenize("listIssues for the GitHub_repo"), ["list", "issue", "git", "hub", "repo"]);
	assert.deepEqual(tokenize("searches queries HTTPServer"), ["search", "query", "http", "server"]);
});

const tools = [
	tool("mcp__github__list_issues", "List issues in a repository.", {
		state: { type: "string", description: "open or closed" },
	}),
	tool("mcp__github__create_pull_request", "Open a pull request."),
	tool("mcp__linear__search_issues", "Search Linear issues by text."),
	tool("mcp__docs__search", "Search the documentation."),
];
const documents = tools.map((entry) => createToolSearchDocument(entry));

test("Bm25Ranker ranks by term relevance and respects the limit", () => {
	const ranker = new Bm25Ranker();
	assert.deepEqual(
		ranker.rank("issue", documents, 8).map((match) => match.name),
		["mcp__linear__search_issues", "mcp__github__list_issues"],
	);
	assert.equal(ranker.rank("pull requests", documents, 8)[0].name, "mcp__github__create_pull_request");
	assert.equal(ranker.rank("search", documents, 1).length, 1);
	assert.deepEqual(
		ranker.rank("closed", documents, 8).map((match) => match.name),
		["mcp__github__list_issues"],
	);
});

test("Bm25Ranker returns nothing for unknown or empty queries", () => {
	const ranker = new Bm25Ranker();
	assert.deepEqual(ranker.rank("kubernetes", documents, 8), []);
	assert.deepEqual(ranker.rank("the", documents, 8), []);
	assert.deepEqual(ranker.rank("tickets", documents, 8), []);
});

test("the namespace is part of the search text", () => {
	const document = createToolSearchDocument(tool("mcp__x__run", "Run it."), {
		name: "mcp__x",
		description: "Kubernetes cluster tools",
	});
	const matches = new Bm25Ranker().rank("kubernetes", [document], 8);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].name, "mcp__x__run");
});

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

test("tool_search loads deferred tools for the next request; it registers inactive", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createToolSearchExtension(),
		(api) => {
			for (const entry of tools.slice(0, 3)) api.registerTool({ ...entry, exposure: "deferred" });
			api.registerTool(tool("plain", "A direct tool."));
		},
	]);
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: fakePlatform(
			[
				makeSseResponse(textTurn("no search yet")),
				makeSseResponse(toolCallTurn("tool_search", { query: "issues" })),
				makeSseResponse(toolCallTurn("tool_search", { query: "kubernetes" })),
				makeSseResponse(textTurn("done")),
			],
			requests,
		),
		extensions: registry,
	});
	const names = (index: number) =>
		((requests[index] as { tools?: { function: { name: string } }[] }).tools ?? []).map((entry) => entry.function.name);
	await drain(agent.prompt("first"));
	assert.deepEqual(names(0), ["plain"], "tool_search is registered inactive");

	agent.setActiveTools([...agent.getActiveTools(), "tool_search"]);
	await drain(agent.prompt("find issue tools"));
	assert.deepEqual(names(1).sort(), ["plain", "tool_search"]);
	assert.deepEqual(names(2).sort(), ["mcp__github__list_issues", "mcp__linear__search_issues", "plain", "tool_search"]);
	const results = agent.messages.filter((message) => message.role === "toolResult");
	assert.ok(results[0]?.role === "toolResult");
	assert.match(
		(results[0].content[0] as { text: string }).text,
		/^Loaded 2 tools\. They are available from your next call:/,
	);
	assert.deepEqual(results[0].details, { loaded: ["mcp__linear__search_issues", "mcp__github__list_issues"] });
	assert.ok(results[1]?.role === "toolResult");
	assert.equal((results[1].content[0] as { text: string }).text, "No matching tools found.");
});

test("tool_search rejects an empty query and a bad limit", async () => {
	const registry = await ExtensionRegistry.load([createToolSearchExtension()]);
	const search = registry.tools.get("tool_search");
	assert.ok(search);
	await assert.rejects(search.execute({ query: "  " }), /query must not be empty/);
	await assert.rejects(search.execute({ query: "x", limit: 0 }), /limit must be a positive integer/);
});
