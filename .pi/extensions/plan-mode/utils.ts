/**
 * Plan Mode extension — pure utility functions.
 *
 * Extracted from the extension body so the command-safety and todo-parsing
 * logic can be unit-tested without an AgentSession.
 */

// ---------------------------------------------------------------------------
// Bash command safety
// ---------------------------------------------------------------------------

/**
 * Substrings that enable shell command substitution / process substitution /
 * redirection — all of which can bypass the per-subcommand allowlist by
 * embedding arbitrary code. Any match rejects the whole command in plan mode.
 */
const SHELL_ESCAPE_PATTERNS: RegExp[] = [
	/\$\(/, // $(...) command substitution
	/`[^`]*`/, // `...` backtick command substitution
	/>\(/, // >(cmd) process substitution (bash/zsh)
	/<\(/,
	/\beval\b/,
	/\bexec\b/,
	/\bsource\b/,
	/\b\.\s+\S/, // `. file` source shorthand
	/\bsh\s+-c\b/,
	/\bbash\s+-c\b/,
	/\bzsh\s+-c\b/,
	/\bxdg-open\b/,
	/\bopen\s+/,
];

/**
 * Destructive commands that must never run in plan mode, even as a
 * subcommand of a compound command. Any match rejects the whole command.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // single > redirect (not >>)
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|fund|rm)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean|restore|switch|worktree)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

/**
 * Read-only commands allowed in plan mode. A *subcommand* must match one of
 * these to be permitted. `cd <dir>` is always allowed as a chain prefix
 * (handled separately in {@link isSafeCommand}).
 */
const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*egrep\b/,
	/^\s*fgrep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	// read-only git
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)\b/i,
	// read-only package managers
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|run\s+(check|test))\b/i,
	/^\s*npx\s+typescript-bin\b/,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	// network read
	/^\s*curl\s/,
	/^\s*wget\s+-O\s*-/i,
	// text processing
	/^\s*jq\b/,
	/^\s*sed\s+-n/i, // only `sed -n` (no write)
	/^\s*awk\b/,
	// modern rust-based tools
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
	// project-local test runner (pi repo)
	/^\s*\.\/test\.sh\b/,
];

/** Split a shell command into subcommands at `&&`, `||`, `;`, `|`. */
function splitSubcommands(command: string): string[] {
	// Naive split: does not parse quotes, but destructive/escape patterns are
	// checked against the WHOLE command first, so quoted metacharacters inside
	// arguments are still caught before this split runs.
	return command
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Returns true if a bash command may run in plan mode. */
export function isSafeCommand(command: string): boolean {
	// 1. Reject any shell-escape vector across the whole command.
	if (SHELL_ESCAPE_PATTERNS.some((p) => p.test(command))) return false;
	// 2. Reject any destructive pattern across the whole command.
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	// 3. Every subcommand must independently be safe (or a cd prefix).
	for (const sub of splitSubcommands(command)) {
		if (/^cd\b/.test(sub)) continue; // `cd <dir>` has no side effects
		if (!SAFE_PATTERNS.some((p) => p.test(sub))) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Todo item parsing
// ---------------------------------------------------------------------------

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

/** Remove markdown emphasis, leading verb prefix; trim + truncate. */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // bold/italic
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

/**
 * Header forms that introduce a plan section. Matches `Plan:`, `## Plan`,
 * `### Plan`, `Steps:`, `Implementation Plan`, etc. (case-insensitive).
 */
const PLAN_HEADER = /^(?:#{1,6}\s*)?(?:implementation\s+|proposed\s+|action\s+)?(?:plan|steps|tasks)\s*:?\s*\n/i;

/** Strip a leading markdown list/task marker so `1.` and `- [ ]` both work. */
function stripListMarker(s: string): string {
	return s.replace(/^(?:\d+[.)]|[-*])\s*(?:\[[ xX]\]\s*)?/, "");
}

/**
 * Extract numbered/bulleted steps from a plan section of an assistant message.
 * Steps must follow a recognized plan header. Too-short or code/path-like
 * items are skipped.
 */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(PLAN_HEADER);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	// `1.`, `2)`, `- `, `* `, with optional `[ ]` task marker.
	const stepPattern = /^\s*(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s*)?(.+)$/gm;

	for (const match of planSection.matchAll(stepPattern)) {
		const raw = stripListMarker(match[1]).trim();
		const text = raw
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

/** Parse `[DONE:n]` markers (case-insensitive). */
export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/** Mark todo items completed by `[DONE:n]`. Returns count of newly-done steps. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	let newlyDone = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			newlyDone += 1;
		}
	}
	return newlyDone;
}
