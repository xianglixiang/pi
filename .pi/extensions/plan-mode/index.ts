/**
 * Plan Mode Extension
 *
 * Two-phase workflow: read-only exploration, then tracked execution.
 *
 * - /plan            toggle plan mode (also Ctrl+Alt+P, or --plan flag)
 * - /plan-exec       execute the current plan (full tool access)
 * - /plan-stop       abort execution / clear plan, return to normal
 * - /todos           show current plan steps
 *
 * Plan phase: edit/write removed from the toolset; bash restricted to a
 * read-only allowlist. Execute phase: tools restored, progress tracked via
 * [DONE:n] markers emitted by the model.
 *
 * State is persisted to the session as custom entries and rebuilt on resume.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { BashToolInput, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// Tools managed by plan mode. `questionnaire` is a separate example extension
// that may not be installed, so it is not forced here. The plan prompt asks the
// model to surface clarifications as plain text instead of a specific tool.
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	todos: TodoItem[];
	toolsBeforePlanMode?: string[];
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function getPlanModeTools(activeToolNames: string[]): string[] {
	return uniqueToolNames([
		...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
		...PLAN_MODE_TOOLS,
	]);
}

function getNormalModeTools(activeToolNames: string[]): string[] {
	return uniqueToolNames([
		...NORMAL_MODE_TOOLS,
		...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
	]);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	// --plan flag: start in plan mode
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `PLAN ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "PLAN"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "x ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "[ ] ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			todos: todoItems,
			toolsBeforePlanMode,
		});
	}

	function enterPlanMode(ctx: ExtensionContext, prompt?: string): void {
		if (planModeEnabled) {
			// Already in plan mode: if a prompt was supplied, send it now.
			if (prompt && prompt.trim()) sendPrompt(ctx, prompt.trim());
			return;
		}
		if (executionMode) exitPlanMode(ctx);
		planModeEnabled = true;
		enablePlanModeTools();
		ctx.ui.notify(
			"Plan mode enabled. Write tools disabled; bash restricted to read-only. Ctrl+Alt+P again to execute.",
		);
		updateStatus(ctx);
		persistState();
		if (prompt && prompt.trim()) sendPrompt(ctx, prompt.trim());
	}

	/** Send a prompt as a user message, queueing as followUp when the agent is busy. */
	function sendPrompt(ctx: ExtensionContext, text: string): void {
		const opts = ctx.isIdle() ? undefined : ({ deliverAs: "followUp" } as const);
		pi.sendUserMessage(text, opts);
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		restoreNormalModeTools();
		ctx.ui.notify("Plan mode disabled. Full access restored.");
		updateStatus(ctx);
		persistState();
	}

	/**
	 * Single-key cycle. Every press advances the state, never blocks:
	 *
	 *   normal -- enter --> plan -- (has plan) --> execute -- exit --> normal
	 *                               (no plan) ------ exit ------^
	 *
	 * - normal -> plan: enter plan mode.
	 * - plan -> execute: if a plan exists; otherwise fall through to normal.
	 * - execute -> normal: abort and restore full tool access.
	 *
	 * Use `/plan-exec` to force execution and `/plan-stop` to force exit.
	 */
	function cyclePlanMode(ctx: ExtensionContext): void {
		if (executionMode) {
			exitPlanMode(ctx);
		} else if (planModeEnabled) {
			if (todoItems.length > 0) {
				startExecution(ctx);
			} else {
				ctx.ui.notify("No plan yet - leaving plan mode. Describe a task first, then /plan-exec.", "info");
				exitPlanMode(ctx);
			}
		} else {
			enterPlanMode(ctx);
		}
	}

	function startExecution(ctx: ExtensionContext): void {
		if (todoItems.length === 0) {
			ctx.ui.notify("No plan to execute. Enter plan mode and create a plan first.", "warning");
			return;
		}
		planModeEnabled = false;
		executionMode = true;
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();

		const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
		const first = todoItems[0];
		pi.sendMessage(
			{
				customType: "plan-mode-execute",
				content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${remainingList}

Execute each step in order. After completing a step, include a [DONE:${first?.step}] tag in your response.

Start with: ${first?.text}`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// -------------------------------------------------------------------------
	// Commands & shortcut
	// -------------------------------------------------------------------------

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or enter plan mode and send <text> as the prompt",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text) {
				enterPlanMode(ctx, text);
			} else {
				cyclePlanMode(ctx);
			}
		},
	});

	pi.registerCommand("plan-exec", {
		description: "Execute the current plan with full tool access",
		handler: async (_args, ctx) => startExecution(ctx),
	});

	pi.registerCommand("plan-stop", {
		description: "Abort plan execution / exit plan mode entirely",
		handler: async (_args, ctx) => exitPlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan steps",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No plan steps. Enter plan mode (/plan) and create one.", "info");
				return;
			}
			const list = todoItems
				.map((item) => `${item.step}. ${item.completed ? "x" : "[ ]"} ${item.text}`)
				.join("\n");
			ctx.ui.notify(`Plan:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Cycle plan mode: normal -> plan -> execute -> normal",
		handler: async (ctx) => cyclePlanMode(ctx),
	});

	// -------------------------------------------------------------------------
	// Event handlers
	// -------------------------------------------------------------------------

	// Block unsafe bash while in plan mode.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = (event.input as BashToolInput).command;
		if (isSafeCommand(command)) return;
		return {
			block: true,
			reason: `Plan mode: command rejected by read-only allowlist (no command substitution, no writes, each subcommand must be allowlisted). Exit plan mode with /plan or /plan-stop first.\nCommand: ${command}`,
		};
	});

	// Drop stale plan/execution context produced by this extension once we
	// are no longer in plan or execution mode, so internal scaffolding does not
	// leak into normal conversation history.
	const PLAN_INTERNAL_CUSTOMTYPES = new Set([
		"plan-mode-context",
		"plan-execution-context",
		"plan-mode-execute",
		"plan-todo-list",
		"plan-complete",
	]);
	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType && PLAN_INTERNAL_CUSTOMTYPES.has(msg.customType)) return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before each agent run.
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode.

Restrictions:
- Built-in edit and write tools are disabled.
- Bash is restricted to read-only commands.
- Other active tools remain available.

Ask clarifying questions as plain text if requirements are ambiguous.

Produce a numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT make changes - only describe what you would do.`,
					display: false,
				},
			};
		}
		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN]

Remaining steps:
${todoList}

After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track [DONE:n] progress after each turn.
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		const text = getTextContent(event.message);
		const newlyDone = markCompletedSteps(text, todoItems);
		if (newlyDone > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	// Handle run end: detect plan, offer execution; detect completion.
	pi.on("agent_end", async (event, ctx) => {
		// Execution complete?
		if (executionMode && todoItems.length > 0 && todoItems.every((t) => t.completed)) {
			const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
			pi.sendMessage(
				{ customType: "plan-complete", content: `Plan complete.\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			todoItems = [];
			updateStatus(ctx);
			persistState();
			return;
		}

		// Plan phase: extract todos from the latest assistant message.
		if (!planModeEnabled || !ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		const extracted = extractTodoItems(getTextContent(lastAssistant));
		if (extracted.length === 0) return;
		todoItems = extracted;
		persistState();

		const todoListText = todoItems.map((t, i) => `${i + 1}. [ ] ${t.text}`).join("\n");
		const choice = await ctx.ui.select("Plan created - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (choice === "Execute the plan") {
			startExecution(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(
					{ customType: "plan-todo-list", content: `Plan steps:\n\n${todoListText}`, display: true },
					{ deliverAs: "followUp" },
				);
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore persisted state + rebuild completion on session start/resume.
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			executionMode = planModeEntry.data.executing ?? executionMode;
			todoItems = planModeEntry.data.todos ?? todoItems;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume of an executing plan, re-scan messages after the last
		// "plan-mode-execute" marker so [DONE:n] only counts for this run.
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
