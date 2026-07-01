# pi-agent-core 技术细节

`@earendil-works/pi-agent-core` — 通用 Agent 运行时，提供传输抽象、状态管理、附件支持、工具调用循环、会话管理、上下文压缩、Skills/Prompt 模板。它是协议无关的，不包含任何具体工具实现。

## 顶层结构

```
packages/agent/src/
├── index.ts          # 全部导出
├── agent.ts          # Agent 类（高层 API）
├── agent-loop.ts     # 核心循环实现
├── proxy.ts          # 代理工具
├── node.ts           # Node.js 环境适配
├── types.ts          # 核心类型：StreamFn、Tool、AgentMessage、AgentEvent、AgentLoopConfig
└── harness/
    ├── agent-harness.ts        # AgentHarness：session 生命周期 + loop 编排
    ├── types.ts                # Skill、PromptTemplate、ExecutionEnv、Result<T,E>、事件类型
    ├── messages.ts             # convertToLlm（AgentMessage → LLM Message）
    ├── system-prompt.ts        # 系统提示词组装（含 skills 块）
    ├── prompt-templates.ts     # Prompt 模板格式化
    ├── skills.ts               # Skills 格式化（agentskills.io 兼容）
    ├── env/nodejs.ts           # Node.js 执行环境
    ├── compaction/             # 上下文压缩
    │   ├── compaction.ts       # 主压缩流程、token 估算、cut-point
    │   ├── branch-summarization.ts # 分支总结
    │   └── utils.ts
    ├── session/                # 会话持久化
    │   ├── session.ts          # Session 抽象
    │   ├── jsonl-repo.ts       # JSONL 文件仓库
    │   ├── jsonl-storage.ts
    │   ├── memory-repo.ts      # 内存仓库（测试用）
    │   ├── memory-storage.ts
    │   ├── repo-utils.ts
    │   └── uuid.ts             # uuidv7
    └── utils/
        ├── shell-output.ts
        └── truncate.ts
```

## 核心抽象

### `AgentLoopConfig` 与 `StreamFn`（`types.ts`）
- `StreamFn = (model, context, options?) => AssistantMessageEventStream | Promise<...>`，结构性定义，`Models.streamSimple` 满足它。
  - 契约：**不能抛错或返回 rejected promise**；失败必须编码在流的协议事件 + 最终 `stopReason: "error"|"aborted"` 的 `AssistantMessage` 里。
- `ToolExecutionMode = "sequential" | "parallel"`：顺序（逐个准备+执行+收尾）或并行（顺序准备，允许的工具并发执行，`tool_execution_end` 按完成序发出，但 tool-result 消息按 assistant 源序发出）。
- `QueueMode = "all" | "one-at-a-time"`：drain 点注入多少排队用户消息。
- `AgentLoopConfig extends SimpleStreamOptions`：含 `model`、`convertToLlm`、`tools`、`beforeToolCall`/`afterToolCall` 钩子、`shouldStopAfterTurn`、`prepareNextTurn`、`queueMode` 等。
- `BeforeToolCallResult { block?: boolean; reason?: string }` — 阻止工具执行并发出 error tool result。
- `AfterToolCallResult` — 字段级覆盖（content/details/isError/terminate），无深合并；`terminate` 仅当批次内所有结果都设 true 时触发早停。

### `AgentTool`（`types.ts`）
- 协议无关的工具接口：定义入参 schema（TypeBox）、prepare/execute/finalize 阶段、详情（details）渲染。
- 不包含具体工具实现——coding-agent 才提供 read/bash/edit/write。

### `AgentMessage`
- 内部统一消息类型（比 LLM 的 `Message` 更丰富，含 UI-only 通知、状态、附件）。
- `convertToLlm(AgentMessage[]): Message[]`（`harness/messages.ts`）在 LLM 调用边界才转换；无法转换的（UI 通知等）被过滤。

## Agent 循环（`agent-loop.ts`）

- `agentLoop(prompts, context, config, signal?, streamFn?)` — 用新 prompt 启动，返回 `EventStream<AgentEvent, AgentMessage[]>`。
- `continueAgentLoop(...)` — 从当前 context 继续（重试场景），要求最后一条消息可转成 `user`/`toolResult`。
- `runAgentLoop(...)` — 内部驱动函数，把事件推给 sink，结束时 resolve 消息数组。
- 设计：循环内部全程用 `AgentMessage`，**只在 LLM 调用边界**转成 `Message[]`。
- 工具执行：解析 assistant 消息里的 `toolCall` 块 → `validateToolArguments` → `beforeToolCall` 钩子 → prepare/execute/finalize → `afterToolCall` 覆盖 → 生成 `ToolResultMessage`。
- 队列消息在 drain 点（turn 结束、压缩前等）按 `QueueMode` 注入。

## AgentHarness（`harness/agent-harness.ts`）

- 高层编排器，绑定一个 `Session`，管理完整 session 生命周期：prompt 提交、loop 执行、压缩、分支总结、会话持久化、中止/恢复。
- 依赖：`Models`（来自 pi-ai）、`Session`、`AgentHarnessResources`（skills + promptTemplates）、`ExecutionEnv`（执行环境抽象，如 Node.js）。
- 事件系统：`AgentHarnessEvent` / `AgentHarnessEventResultMap`（可被事件处理器拦截/修改的结果类型），事件可被扩展系统消费。
- 流选项快照：`AgentHarnessStreamOptions`（transport/timeoutMs/maxRetries/headers/cacheRetention）按 turn 快照；provider 钩子可返回 `AgentHarnessStreamOptionsPatch`。
- 失败处理：`createFailureMessage` 生成 `stopReason: "error"|"aborted"` 的占位 assistant 消息，保证循环契约。
- 错误类型：`AgentHarnessError`、`BranchSummaryError`、`CompactionError`、`SessionError`。

## 会话系统（`harness/session/`）

- `Session` — 抽象会话，持有消息与元数据。
- `jsonl-repo.ts` / `jsonl-storage.ts` — 生产用 JSONL 文件仓库（追加写、流式读）。
- `memory-repo.ts` / `memory-storage.ts` — 内存实现，测试用。
- `uuid.ts` — `uuidv7`（时间有序，适合做会话/消息 ID）。
- `repo-utils.ts` — 共享工具。
- Session 是 agent-core 的可插拔点：coding-agent 用自己的 `SessionManager`（coding-agent/core/session-manager.ts）在 JSONL 之上加了 `SessionEntry` 版本化结构。

## 上下文压缩（`harness/compaction/`）

- `compaction.ts` — 主流程：
  - `estimateTokens` / `estimateContextTokens` / `calculateContextTokens` — token 估算。
  - `shouldCompact` — 是否触发压缩（基于阈值）。
  - `findCutPoint` / `findTurnStartIndex` — 找压缩切点（按 turn 边界）。
  - `prepareCompaction` — 准备压缩（选切点、保留近段）。
  - `compact` — 执行压缩：对被压缩段调用 `generateSummary` 生成摘要，替换原消息。
  - `serializeConversation` — 序列化为可读文本（喂给 summarizer）。
  - `getLastAssistantUsage` — 取最近的 usage 信息辅助决策。
  - `DEFAULT_COMPACTION_SETTINGS`。
- `branch-summarization.ts` — 分支总结（fork 时的会话树分支摘要）：
  - `collectEntriesForBranchSummary` / `prepareBranchEntries` / `generateBranchSummary`。
- 压缩通过 `Models` 调用 LLM 生成摘要（v0.80.0 起 `compact()`/`generateSummary()`/`generateBranchSummary()` 都接收 `Models` 参数，不再接受显式 apiKey/headers）。

## Skills 与 Prompt 模板

- `Skill { name, description, content, filePath, disableModelInvocation? }` — 加载自 `SKILL.md`（agentskills.io 规范）。
- `formatSkillsForSystemPrompt` — 生成 system prompt 中的 XML 块。
- `PromptTemplate { name, description?, content }` — 可被格式化成 prompt 用于显式调用。
- `formatPromptTemplateInvocation` / `formatSkillInvocation` — 显式调用时的格式化。

## 执行环境（`harness/env/`）

- `nodejs.ts` — Node.js 执行环境实现 `ExecutionEnv`，提供 shell 执行等能力（coding-agent 继承后改名 `ShellExecOptions`，v0.80.2）。
- `ExecutionEnv` 是抽象，便于在其他 runtime（Bun、浏览器）实现。

## 关键设计点

1. **协议无关 + 工具无关**：agent-core 不知道具体 LLM provider（用 `StreamFn`），也不知道具体工具（用 `AgentTool` 接口）。
2. **AgentMessage / Message 分离**：内部用富 `AgentMessage`，LLM 边界才 `convertToLlm`，UI-only 消息不会泄露给模型。
3. **Result<T, E> 模式**：可失败操作返回 `{ ok, value/error }` 而非抛错（`harness/types.ts`），配合 `getOrThrow` / `getOrUndefined`。
4. **StreamFn 不抛错契约**：所有失败编码进流的事件 + 最终 assistant 消息，保证循环鲁棒。
5. **并行工具执行**：支持 `parallel` 模式但保持 tool-result 消息的源序，平衡性能与正确性。
6. **可插拔 Session**：JSONL / 内存两种实现，下游可扩展。
7. **压缩作为一等公民**：内置 turn 边界感知的压缩，避免切断单个 turn。
