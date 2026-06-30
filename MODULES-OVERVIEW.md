# Pi 代码库模块概览

Pi 是一个自扩展的 Agent 框架项目，由 4 个 npm 包组成的 monorepo。核心是 coding-agent（面向用户的编程 Agent CLI），构建在 agent-core（Agent 运行时）、pi-ai（多 Provider LLM 统一 API）、pi-tui（终端 UI 库）之上。

## 模块列表

| 包名 (`@earendil-works/*`) | 目录 | 角色 | 依赖 |
|---|---|---|---|
| `pi-ai` | `packages/ai` | 统一多 Provider LLM API（OpenAI/Anthropic/Google/Bedrock/...） | `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`, `typebox` 等 |
| `pi-agent-core` | `packages/agent` | 通用 Agent 运行时：工具调用循环、会话管理、上下文压缩、Skills/Prompt 模板 | `@earendil-works/pi-ai`, `typebox`, `yaml`, `ignore` |
| `pi-tui` | `packages/tui` | 终端 UI 库：差分渲染、组件、键绑定、Markdown、终端图像 | `get-east-asian-width`, `marked` |
| `pi-coding-agent` | `packages/coding-agent` | 面向用户的编程 Agent CLI（read/bash/edit/write 工具、会话、扩展系统、交互/打印/RPC 三种运行模式） | `pi-agent-core`, `pi-ai`, `pi-tui`, `chalk`, `glob`, `diff`, `highlight.js`, `jiti`, `proper-lockfile`, `undici` 等 |

## 模块依赖关系

```
                       pi-tui  (独立，无内部依赖)
                          │
                          ▼
   pi-ai  ◄────── pi-agent-core
     │                 │
     │                 ▼
     └────────► pi-coding-agent ◄── pi-tui
```

- **`pi-tui`** 完全独立，不依赖其他三个包（它是纯渲染/UI 基础设施）。
- **`pi-agent-core`** 依赖 `pi-ai`（通过 `Models` / `StreamFn` 与 LLM 交互）。
- **`pi-coding-agent`** 同时依赖三者：通过 `pi-agent-core` 驱动 Agent，通过 `pi-ai` 与 LLM 交互，通过 `pi-tui` 构建交互式界面。

## 调用链路（用户发起一次 prompt）

1. 用户在 `pi-coding-agent` 的交互模式（基于 `pi-tui`）输入消息，或通过 `pi -p` / RPC 模式提交。
2. `AgentSession`（coding-agent）接收消息，委托给 `AgentHarness`（agent-core）。
3. `AgentHarness` 组装 system prompt、skills、工具，调用 `runAgentLoop`（agent-core 的核心循环）。
4. Agent 循环在每次 LLM 请求边界调用 `convertToLlm` 把 `AgentMessage[]` 转成 LLM 可见的 `Message[]`，然后通过 `StreamFn` 调用 `pi-ai` 的 `Models.streamSimple()`。
5. `pi-ai` 的 `Models` 解析 provider 认证（`auth/resolve.ts`），委托给对应 provider（`providers/*`）和 API 实现（`api/*`）。
6. 返回的 `AssistantMessageEventStream` 经 agent-loop 解析工具调用，调用对应 `AgentTool`（coding-agent 注册的 read/bash/edit/write 等）。
7. 工具结果作为 `AgentMessage` 追加到上下文，循环继续直到 `stopReason` 触发停止。
8. 所有 `AgentMessage` 持久化到 JSONL 会话仓库（agent-core 的 `session/`），需要时触发上下文压缩（`compaction/`）。

## 技术架构分层

- **L1 — LLM 抽象层（`pi-ai`）**：把 9 种 API 协议 + 30+ Provider 统一成 `Models` / `Provider` / `streamSimple`，处理认证、模型目录、流式事件、prompt cache。
- **L2 — Agent 运行时（`pi-agent-core`）**：协议无关的 Agent 循环，工具执行（顺序/并行）、队列消息注入、上下文压缩、会话 JSONL 仓库、Skills/Prompt 模板。不知道具体工具，只定义 `AgentTool` 接口。
- **L3a — 编程领域层（`pi-coding-agent/core`）**：实现具体工具（bash/edit/read/write/grep/find/ls）、会话管理、扩展系统、认证存储、系统提示词构建、项目信任。
- **L3b — 终端 UI 层（`pi-tui`）**：差分渲染引擎、组件库、键绑定、终端图像协议（Kitty/iTerm2）、Markdown 渲染。
- **L4 — 应用层（`pi-coding-agent/modes` + `cli` + `main`）**：三种运行模式（Interactive / Print / RPC）、CLI 参数解析、启动 UI、主题、扩展加载。

详细的各模块技术分析见：
- [01-pi-ai.md](./01-pi-ai.md)
- [02-pi-agent-core.md](./02-pi-agent-core.md)
- [03-pi-tui.md](./03-pi-tui.md)
- [04-pi-coding-agent.md](./04-pi-coding-agent.md)
