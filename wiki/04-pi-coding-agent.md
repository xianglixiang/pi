# pi-coding-agent 技术细节

`@earendil-works/pi-coding-agent` — 面向用户的交互式编程 Agent CLI，read/bash/edit/write 工具 + 会话管理 + 扩展系统 + 三种运行模式。是整个 Pi 项目的用户可见入口，聚合 `pi-agent-core` + `pi-ai` + `pi-tui`。

## 顶层结构

```
packages/coding-agent/src/
├── index.ts              # 全部公开导出（SDK + 工具 + UI 组件）
├── cli.ts                # CLI 入口（bin）
├── main.ts               # 主流程：参数解析 → 创建 session → 选模式运行
├── config.ts             # 路径常量（agentDir/sessions/docs/examples/packageDir）、VERSION
├── migrations.ts         # 版本迁移与废弃警告
├── package-manager-cli.ts # pi update / pi config 子命令
├── bun/                  # Bun runtime 适配
├── cli/                  # CLI 子模块（参数、UI 流程）
│   ├── args.ts           # parseArgs、Mode、printHelp
│   ├── config-selector.ts
│   ├── file-processor.ts # 文件参数处理（@file 语法、图片）
│   ├── initial-message.ts
│   ├── list-models.ts
│   ├── project-trust.ts
│   ├── session-picker.ts
│   └── startup-ui.ts     # 首次设置、启动选择器
├── core/                 # 编程领域层
│   ├── extensions/       # 扩展系统（types/loader/runner/wrapper）
│   ├── tools/            # 内置工具实现（bash/edit/read/write/grep/find/ls）
│   ├── compaction/       # 压缩（继承 agent-core 并加 session entry 适配）
│   ├── export-html/      # 会话导出 HTML
│   ├── agent-session.ts          # AgentSession：核心会话 facade
│   ├── agent-session-runtime.ts  # 运行时工厂（服务/资源懒构造）
│   ├── agent-session-services.ts # 服务层（auth/model/session/settings 组装）
│   ├── sdk.ts            # createAgentSession 等 SDK 工厂
│   ├── session-manager.ts # JSONL 会话管理（SessionEntry 版本化结构）
│   ├── auth-storage.ts   # AuthStorage + File/InMemory backend
│   ├── model-registry.ts # ModelRegistry（models.json）
│   ├── model-resolver.ts # 解析初始模型、scoped models
│   ├── settings-manager.ts
│   ├── resource-loader.ts # AGENTS.md/CLAUDE.md/.pi 等项目资源加载
│   ├── trust-manager.ts  # 项目信任（ProjectTrustStore）
│   ├── project-trust.ts
│   ├── skills.ts         # 加载 .pi/skills
│   ├── prompt-templates.ts
│   ├── system-prompt.ts  # 系统提示词构建（含工具说明、上下文注入）
│   ├── messages.ts       # convertToLlm、CustomMessage
│   ├── bash-executor.ts  # Bash 执行器（带 spawn hook）
│   ├── exec.ts           # ExecOptions/ExecResult
│   ├── http-dispatcher.ts # HTTP 代理/分发
│   ├── event-bus.ts      # EventBus（扩展事件总线）
│   ├── keybindings.ts    # DEFAULT_APP_KEYBINDINGS、AppKeybinding
│   ├── telemetry.ts / timings.ts / diagnostics.ts
│   ├── output-guard.ts   # 接管/恢复 stdout（交互模式）
│   ├── defaults.ts / experimental.ts
│   └── ...（provider-attribution、provider-display-names、resolve-config-value 等）
├── modes/                # 三种运行模式
│   ├── index.ts
│   ├── print-mode.ts     # pi -p（一次性打印）
│   ├── interactive/      # 交互式 TUI 模式
│   │   ├── interactive-mode.ts
│   │   ├── model-search.ts
│   │   ├── theme/        # 主题（Theme、initTheme、selector）
│   │   └── components/   # 30+ TUI 组件（assistant/user message、tool exec、diff、selectors...）
│   └── rpc/              # RPC 模式（编辑器集成）
│       ├── rpc-mode.ts
│       ├── rpc-client.ts
│       ├── rpc-types.ts
│       └── jsonl.ts
└── utils/                # clipboard、frontmatter、image-convert、image-resize、paths、shell、windows-self-update
```

## 核心抽象

### `AgentSession`（`core/agent-session.ts`）— 核心 facade
- 包装 `AgentHarness`（agent-core），加上编程领域逻辑：工具注册、模型循环（Ctrl+P）、压缩协调、skill/prompt 模板调用、事件总线。
- `AgentSessionConfig` / `AgentSessionEvent` / `PromptOptions` / `SessionStats` / `ModelCycleResult` / `ParsedSkillBlock`。
- 是 SDK 和 UI 共用的中心对象。

### SDK 工厂（`core/sdk.ts`）
- `createAgentSession(options)` — 主入口，组装 auth/model/session/settings/tools。
- `createAgentSessionServices` / `createAgentSessionFromServices` — 服务层注入（测试/自定义）。
- `createAgentSessionRuntime` / `AgentSessionRuntime` — 运行时工厂，延迟构造服务。
- 工具工厂（支持自定义 cwd）：`createCodingTools`（全套）、`createReadOnlyTools`、`createBashTool`/`createEditTool`/`createReadTool`/`createWriteTool`/`createGrepTool`/`createFindTool`/`createLsTool`。
- `withFileMutationQueue` — 文件写操作的串行化队列（避免并发写冲突）。

### `CreateAgentSessionOptions`（`core/sdk.ts`）关键选项
- `cwd` / `agentDir`、`authStorage` / `modelRegistry` / `sessionManager` / `settingsManager` / `resourceLoader`（均可注入，有默认）。
- `model` / `thinkingLevel` / `scopedModels`（Ctrl+P 可循环的模型）。
- `noTools: "all" | "builtin"`、`tools: string[]`（白名单）、`excludeTools: string[]`（黑名单）、`customTools: ToolDefinition[]`。
- 默认启用 read/bash/edit/write；`-ne`（no extensions）等 CLI flag 映射到这里。

## 内置工具（`core/tools/`）

每个工具由"操作接口（Operations）+ 工具定义（Definition）+ 详情类型（Details）+ 输入（Input）+ 选项（Options）"组成：

| 文件 | 工具 | 要点 |
|---|---|---|
| `bash.ts` | bash | `BashOperations` / `BashSpawnContext` / `BashSpawnHook`，`createLocalBashOperations`，跨平台 shell |
| `edit.ts` | edit | 精确文本替换（oldText/newText，多段 disjoint edits），`EditOperations` |
| `edit-diff.ts` | (辅助) | `generateDiffString` / `generateUnifiedPatch` / `EditDiffResult` |
| `read.ts` | read | offset/limit、2000 行/50KB 截断，图片识别 |
| `write.ts` | write | 创建/覆盖，自动建父目录 |
| `grep.ts` | grep | `GrepOperations`（ripgrep 封装） |
| `find.ts` | find | `FindOperations` |
| `ls.ts` | ls | `LsOperations` |
| `file-mutation-queue.ts` | (辅助) | `withFileMutationQueue`，串行化文件写 |
| `output-accumulator.ts` / `truncate.ts` / `render-utils.ts` / `path-utils.ts` / `tool-definition-wrapper.ts` | (辅助) | 输出累积、截断（`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`、`truncateHead/Tail/Line`）、渲染、路径、包装 |

工具定义都由 `create*ToolDefinition` 工厂产生，支持注入自定义 cwd/operations，便于测试和扩展。

## 扩展系统（`core/extensions/`）

- **`types.ts`** — 庞大的类型定义：`Extension`、`ExtensionFactory`、`ExtensionAPI`、`ExtensionContext`、`ExtensionRuntime`、`ExtensionRunner`、`ExtensionEvent` 及其结果类型（`BeforeProviderRequestEventResult`、`BeforeAgentStartEventResult`、`InputEventResult`、`ToolCallEventResult` 等）。
  - 扩展可：订阅 agent 生命周期事件、注册 LLM 可调用工具、注册命令/快捷键/CLI flag、通过 UI 原语与用户交互（dialog/widget/selector/editor）、提供 autocomplete。
  - 事件覆盖：session start/end、before/after compact、before fork/switch/tree、turn start/end、tool call（bash/edit/read/write/grep/find/ls/custom）、before provider request、input、project trust。
- **`loader.ts`** — `discoverAndLoadExtensions`（用 `jiti` 即时编译 TS 扩展）、`LoadExtensionsResult`。
- **`runner.ts`** — `ExtensionRunner`、`createExtensionRuntime`，事件分发与结果合并。
- **`wrapper.ts`** — `wrapRegisteredTool` / `wrapRegisteredTools`、`defineTool`、`isBashToolResult` 等类型守卫。
- 扩展通过 `ExtensionAPI` 暴露的 context 访问 `ModelRegistry`、`SessionManager`、`EventBus`、`KeybindingsManager`、TUI、Theme 等。

### `EventBus`（`core/event-bus.ts`）
- `createEventBus` / `EventBus` / `EventBusController` — 扩展事件总线，与 agent-core 的 `AgentHarnessEvent` 桥接。

## 会话管理（`core/session-manager.ts`）

- `CURRENT_SESSION_VERSION = 3` — JSONL 会话格式版本。
- `SessionHeader { type:"session", version?, id, timestamp, cwd, parentSession? }`（v1 无 version）。
- `SessionEntry` 体系（`SessionEntryBase` 派生）：
  - `SessionInfoEntry`、`SessionMessageEntry`、`FileEntry`、`CompactionEntry`、`BranchSummaryEntry`、`ModelChangeEntry`、`ThinkingLevelChangeEntry`、`CustomEntry` / `CustomMessageEntry`。
- `SessionManager` — 创建/列举/读取/fork 会话；`buildSessionContext` / `parseSessionEntries` / `migrateSessionEntries` / `getLatestCompactionEntry`。
- 低层用同步 fs API（`appendFileSync`/`readSync`/`openSync`）+ readline 流式读。
- 继承 agent-core 的 `Session` 抽象，在 JSONL 之上加了版本化 entry 结构。

## 认证与模型

- **`auth-storage.ts`** — `AuthStorage` + `FileAuthStorageBackend` / `InMemoryAuthStorageBackend`，存 `auth.json`。凭据类型 `ApiKeyCredential`（`type:"api_key"`，v0.80.2）/ `OAuthCredential`。
- **`model-registry.ts`** — `ModelRegistry`，管理 `models.json`（用户配置的 provider + 模型）。
- **`model-resolver.ts`** — `findInitialModel` / `resolveCliModel` / `resolveModelScope` / `ScopedModel`（解析 `--model`、scoped models）。
- **`http-dispatcher.ts`** — `applyHttpProxySettings` / `configureHttpDispatcher`（undici dispatcher，HTTP 代理）。
- **`provider-attribution.ts` / `provider-display-names.ts`** — provider 头部合并、显示名映射。

## 资源加载与信任

- **`resource-loader.ts`** — `DefaultResourceLoader` / `loadProjectContextFiles`：发现并加载 `AGENTS.md`、`CLAUDE.md`、`.pi/` 项目资源；`ResourceCollision` / `ResourceDiagnostic`。
- **`trust-manager.ts`** — `ProjectTrustStore` / `hasTrustRequiringProjectResources`：项目信任决策（含 trust-requiring 资源检测，要求用户显式信任）。
- **`project-trust.ts`** / `cli/project-trust.ts` — `AppMode`、`resolveProjectTrusted`、首次信任 UI。
- **`skills.ts`** — `loadSkills` / `loadSkillsFromDir`（`.pi/skills/*.md`），`Skill` / `SkillFrontmatter`。
- **`system-prompt.ts`** — `buildSystemPrompt`：组装系统提示词（工具说明 + 项目资源 + skills + 上下文注入）。

## 运行模式（`modes/`）

### 1. Interactive Mode（`modes/interactive/`）
- `InteractiveMode` — 基于 `pi-tui` 的全屏交互式 TUI。
- 30+ 组件（`components/`）：`AssistantMessageComponent`、`UserMessageComponent`、`ToolExecutionComponent`、`BashExecutionComponent`、`DiffComponent`、各种 selector（model/session/theme/thinking/settings/tree/oauth/trust/scoped-models/show-images/user-message）、`FooterComponent`、`LoginDialogComponent`、`ExtensionEditorComponent` / `ExtensionInputComponent` / `ExtensionSelectorComponent`、`MarkdownComponent`（通过 `Markdown`）、`CompactionSummaryMessageComponent` / `BranchSummaryMessageComponent` / `SkillInvocationMessageComponent` 等。
- `theme/` — `Theme`、`initTheme`、主题监听与选择、`getMarkdownTheme` / `getSelectListTheme` / `getSettingsListTheme`、`highlightCode`（`highlight.js`）。
- `model-search.ts` — 模型搜索（fuzzy）。
- v0.80.0 起 `Ctrl+J` 为默认换行键。

### 2. Print Mode（`modes/print-mode.ts`）
- `runPrintMode` / `PrintModeOptions` — `pi -p "..."` 一次性运行，打印结果到 stdout，无 TUI。适合脚本/管道。

### 3. RPC Mode（`modes/rpc/`）
- `runRpcMode` / `RpcClient` — JSON-RPC over stdio，供编辑器（VS Code 等）集成。
- `rpc-types.ts` — `RpcCommand` / `RpcResponse` / `RpcEventListener` / `RpcSessionState` / `RpcExtensionUIRequest` / `RpcExtensionUIResponse`。
- `jsonl.ts` — JSON-RPC 编解码。

## CLI 入口（`main.ts` + `cli/`）

- `main(options)` — 主流程：
  1. `parseArgs`（`cli/args.ts`，`Mode` / `Args`）。
  2. 读取 piped stdin（`readPipedStdin`）。
  3. 处理 `@file` 参数与图片（`cli/file-processor.ts`）。
  4. 项目信任检查（`cli/project-trust.ts`）。
  5. 选会话（`cli/session-picker.ts`）/ 首次设置（`cli/startup-ui.ts`）。
  6. 构造 `createAgentSessionRuntime` → `createAgentSession`。
  7. 按 `Mode` 分派到 Interactive / Print / RPC。
  8. `runMigrations` / `showDeprecationWarnings`。
- `output-guard.ts` — `takeOverStdout` / `restoreStdout`：交互模式接管 stdout 防止输出污染 TUI。
- 子命令：`pi update --self`、`pi config`（`package-manager-cli.ts`）、`pi --list-models`（`cli/list-models.ts`）。
- `bun/` — Bun runtime 适配（pi 同时发布 Node 和 Bun 二进制）。

## 关键设计点

1. **分层清晰**：`core/` 是纯逻辑（可被 SDK 复用），`modes/` + `cli/` + `main.ts` 是应用层，`modes/interactive/components/` 是 UI。
2. **SDK 优先**：所有能力通过 `index.ts` 导出，`createAgentSession` 是程序化入口，CLI 只是薄壳。
3. **工具可注入**：每个工具的 Operations 接口可替换，便于测试和自定义 cwd。
4. **扩展系统是一等公民**：扩展可订阅几乎所有生命周期事件、注册工具/命令/快捷键、驱动 UI；用 `jiti` 即时编译 TS 扩展，无需预构建。
5. **项目信任 gating**：含 trust-requiring 资源的项目必须用户显式信任才加载，防止恶意 `.pi/` 资源。
6. **会话格式版本化**：`SessionEntry` 体系 + `migrateSessionEntries` 支持跨版本升级。
7. **三种模式共享 core**：Interactive / Print / RPC 复用同一 `AgentSession`，仅 UI/IO 边界不同。
8. **跨 runtime**：Node + Bun 双发布，`bun/` 隔离 runtime 特定代码。
9. **文件写串行化**：`withFileMutationQueue` 防止并行工具执行时的文件写冲突。
10. **stdout 接管**：交互模式用 `output-guard` 接管 stdout，避免外部输出破坏差分渲染。
