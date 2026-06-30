# Plan Mode Extension

Two-phase workflow: read-only exploration, then tracked execution.

Project-local extension for this repo. Loaded automatically from `.pi/extensions/plan-mode/`.

## Commands

| Command | Description |
|---|---|
| `/plan` | Cycle plan mode: normal -> plan -> execute -> normal (see [Mode cycling](#mode-cycling)). Also bound to `Ctrl+Alt+P`. |
| `/plan <text>` | Enter plan mode and immediately send `<text>` as the prompt. |
| `/plan-exec` | Execute the current plan with full tool access. |
| `/plan-stop` | Abort execution / exit plan mode entirely. |
| `/todos` | Show current plan steps. |

Flag: `--plan` starts pi in plan mode.

## Mode cycling

`Ctrl+Alt+P` (or `/plan` with no arguments) cycles three states:

```
normal -- enter --> plan -- has plan --> execute -- exit --> normal
                         no plan ----- exit -----^
```

- **normal -> plan**: enter plan mode. If a plan already exists from a prior run it is cleared.
- **plan -> execute**: start execution when a plan exists.
- **plan -> normal**: if no plan has been produced yet, the cycle leaves plan mode (every press advances; it never blocks).
- **execute -> normal**: abort execution and restore full tool access.

`/plan <text>` bypasses the cycle: it enters plan mode (or stays in it) and sends `<text>` as the prompt immediately. When the agent is busy, the prompt is queued as a follow-up.

Explicit commands `/plan-exec` and `/plan-stop` always jump to execute / normal regardless of current state.

## Workflow

1. `/plan` - enter plan mode. `edit`/`write` tools removed; `bash` restricted to a read-only allowlist.
2. Describe the task. The model explores and produces a numbered plan under a `Plan:` header.
3. When the run ends, choose: **Execute / Stay / Refine**.
4. During execution, the model emits `[DONE:n]` markers; the footer widget tracks `x / total`.
5. When all steps complete, the plan is auto-closed. `/plan-stop` aborts early.

## Safety

- **Plan phase**: `edit`/`write` tools removed from the toolset; `bash` commands must pass a read-only allowlist. Execute phase restores full tool access.
- **Compound commands**: the command is split on `&&`, `||`, `;`, and `|`; *every* subcommand must independently match the allowlist (or be a `cd <dir>` prefix, which is side-effect-free). Examples:
  - Allowed: `cd packages/ai && rg "foo" src`, `npm run check && ./test.sh`, `git status && git diff`.
  - Rejected: `cd .pi && rm x` (destructive subcommand), `rg foo; echo done > out.txt` (redirect).
- **Shell-escape vectors** reject the whole command regardless of position: `$(` command substitution, backticks, `>(` process substitution, `eval`, `exec`, `source`, `sh -c`, `xdg-open`/`open`, and any destructive pattern (`rm`, `git commit`, `npm install`, `sudo`, editors, redirects, ...).
- The allowlist includes read-only `git`, `npm list/view/audit`, `npm run check`/`npm run test`, `./test.sh`, `rg`, `fd`, `cat`, `grep`, etc.

## Note on `questionnaire`

The upstream example extension forces a `questionnaire` tool into the plan-mode toolset. That tool ships as a separate example that may not be installed, so this extension omits it. The plan prompt asks the model to surface clarifications as plain text instead.

## Persistence

State (mode, todos, completion) is written to the session as custom `plan-mode` entries and rebuilt on resume. On resume of an executing plan, only messages after the last `plan-mode-execute` marker are scanned for `[DONE:n]`, so prior plan runs do not leak completion state.

To avoid session-file bloat, a `plan-mode` entry is only appended when mode or todo completion actually changes, not on every turn.

## Internal message customTypes

This extension injects custom messages that are filtered out of context once plan/execution mode ends:

- `plan-mode-context` — plan-mode constraints injected before each plan run.
- `plan-execution-context` — execution reminder injected before each execution run.
- `plan-mode-execute` — the message that kicks off execution.
- `plan-todo-list` — displayed plan steps.
- `plan-complete` — completion summary.

## Files

- `index.ts` - extension body (state machine, commands, event handlers).
- `utils.ts` - pure helpers (command safety, todo parsing) - separated for testability.
