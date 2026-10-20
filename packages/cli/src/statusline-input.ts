/**
 * The JSON a custom status line reads (P37c), in Claude Code statusLine field names.
 * No dependencies, so the TUI can build it without the runner (pack-smoke layout).
 */

/** What tau knows about the session, in Claude Code's statusLine field names. */
export interface StatusLineFacts {
	sessionId?: string;
	sessionName?: string;
	transcriptPath?: string;
	cwd: string;
	projectDir: string;
	addedDirs: readonly string[];
	model: string;
	provider?: string;
	version?: string;
	costUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	contextWindow?: number;
	currentUsage?: { input: number; output: number; cacheWrite: number; cacheRead: number };
	thinking?: string;
	permissionMode: string;
	worktree?: { name: string; path: string; branch: string; originalCwd: string; originalBranch?: string };
}

/** The JSON a status line command reads (Claude Code's fields, plus permission_mode and provider). */
export function statusLineInput(facts: StatusLineFacts): Record<string, unknown> {
	const size = facts.contextWindow;
	const used = size ? Math.round((facts.contextTokens / size) * 1000) / 10 : null;
	return {
		...(facts.sessionId ? { session_id: facts.sessionId } : {}),
		...(facts.sessionName ? { session_name: facts.sessionName } : {}),
		...(facts.transcriptPath ? { transcript_path: facts.transcriptPath } : {}),
		cwd: facts.cwd,
		model: { id: facts.model, display_name: facts.model },
		workspace: {
			current_dir: facts.cwd,
			project_dir: facts.projectDir,
			added_dirs: [...facts.addedDirs],
			...(facts.worktree ? { git_worktree: facts.worktree.name } : {}),
		},
		...(facts.version ? { version: facts.version } : {}),
		cost: { total_cost_usd: facts.costUsd > 0 ? facts.costUsd : null, total_duration_ms: facts.durationMs },
		context_window: {
			total_input_tokens: facts.inputTokens,
			total_output_tokens: facts.outputTokens,
			context_window_size: size ?? null,
			used_percentage: used,
			remaining_percentage: used === null ? null : Math.round((100 - used) * 10) / 10,
			current_usage: facts.currentUsage
				? {
						input_tokens: facts.currentUsage.input,
						output_tokens: facts.currentUsage.output,
						cache_creation_input_tokens: facts.currentUsage.cacheWrite,
						cache_read_input_tokens: facts.currentUsage.cacheRead,
					}
				: null,
		},
		exceeds_200k_tokens: facts.contextTokens > 200_000,
		...(facts.thinking !== undefined
			? { thinking: { enabled: facts.thinking !== "none" }, effort: { level: facts.thinking } }
			: {}),
		...(facts.worktree
			? {
					worktree: {
						name: facts.worktree.name,
						path: facts.worktree.path,
						branch: facts.worktree.branch,
						original_cwd: facts.worktree.originalCwd,
						...(facts.worktree.originalBranch ? { original_branch: facts.worktree.originalBranch } : {}),
					},
				}
			: {}),
		permission_mode: facts.permissionMode,
		...(facts.provider ? { provider: facts.provider } : {}),
	};
}
