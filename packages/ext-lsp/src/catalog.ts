// The servers Claude Code's official code-intelligence plugins configure, copied
// from anthropics/claude-plugins-official .claude-plugin/marketplace.json (commit
// af59ee3a, 2026-10-21; Apache-2.0) with the install commands from their READMEs.
// tau offers one when the model edits a file it handles and its program is on PATH
// (Claude Code's LSP plugin recommendation).
import type { LspServerConfig } from "./config.ts";

export interface LspCatalogEntry {
	/** Claude Code's plugin name. */
	plugin: string;
	/** Server name in its .lsp.json, used as the key in ~/.tau/lsp.json. */
	server: string;
	config: LspServerConfig;
	/** How the plugin's README installs the program. */
	install: string;
}

export const LSP_CATALOG: readonly LspCatalogEntry[] = [
	{
		plugin: "clangd-lsp",
		server: "clangd",
		config: {
			command: "clangd",
			args: ["--background-index"],
			extensionToLanguage: {
				".c": "c",
				".h": "c",
				".cpp": "cpp",
				".cc": "cpp",
				".cxx": "cpp",
				".hpp": "cpp",
				".hxx": "cpp",
				".C": "cpp",
				".H": "cpp",
			},
		},
		install: "Install clangd (LLVM) from your package manager or https://clangd.llvm.org",
	},
	{
		plugin: "csharp-lsp",
		server: "csharp-ls",
		config: { command: "csharp-ls", extensionToLanguage: { ".cs": "csharp" } },
		install: "dotnet tool install --global csharp-ls",
	},
	{
		plugin: "gopls-lsp",
		server: "gopls",
		config: { command: "gopls", extensionToLanguage: { ".go": "go" } },
		install: "go install golang.org/x/tools/gopls@latest",
	},
	{
		plugin: "jdtls-lsp",
		server: "jdtls",
		config: { command: "jdtls", extensionToLanguage: { ".java": "java" }, startupTimeout: 120000 },
		install: "Install Eclipse JDT Language Server (JDK 17+) and put a `jdtls` launcher on PATH",
	},
	{
		plugin: "kotlin-lsp",
		server: "kotlin-lsp",
		config: {
			command: "kotlin-lsp",
			args: ["--stdio"],
			extensionToLanguage: { ".kt": "kotlin", ".kts": "kotlin" },
			startupTimeout: 120000,
		},
		install: "Install JetBrains kotlin-lsp and put it on PATH",
	},
	{
		plugin: "lua-lsp",
		server: "lua",
		config: { command: "lua-language-server", extensionToLanguage: { ".lua": "lua" } },
		install: "Install lua-language-server from your package manager",
	},
	{
		plugin: "php-lsp",
		server: "intelephense",
		config: { command: "intelephense", args: ["--stdio"], extensionToLanguage: { ".php": "php" } },
		install: "npm install -g intelephense",
	},
	{
		plugin: "pyright-lsp",
		server: "pyright",
		config: {
			command: "pyright-langserver",
			args: ["--stdio"],
			extensionToLanguage: { ".py": "python", ".pyi": "python" },
		},
		install: "npm install -g pyright",
	},
	{
		plugin: "ruby-lsp",
		server: "ruby-lsp",
		config: {
			command: "ruby-lsp",
			extensionToLanguage: { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".ru": "ruby", ".erb": "erb" },
		},
		install: "gem install ruby-lsp",
	},
	{
		plugin: "rust-analyzer-lsp",
		server: "rust-analyzer",
		config: { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } },
		install: "rustup component add rust-analyzer",
	},
	{
		plugin: "swift-lsp",
		server: "sourcekit-lsp",
		config: { command: "sourcekit-lsp", extensionToLanguage: { ".swift": "swift" } },
		install: "sourcekit-lsp ships with the Swift toolchain",
	},
	{
		plugin: "typescript-lsp",
		server: "typescript",
		config: {
			command: "typescript-language-server",
			args: ["--stdio"],
			extensionToLanguage: {
				".ts": "typescript",
				".tsx": "typescriptreact",
				".js": "javascript",
				".jsx": "javascriptreact",
				".mts": "typescript",
				".cts": "typescript",
				".mjs": "javascript",
				".cjs": "javascript",
			},
		},
		install: "npm install -g typescript-language-server typescript",
	},
];

/** The catalog entry for a file extension (lowercase, with the dot). */
export function catalogEntryFor(extension: string): LspCatalogEntry | undefined {
	return LSP_CATALOG.find((entry) =>
		Object.keys(entry.config.extensionToLanguage).some((key) => key.toLowerCase() === extension),
	);
}
