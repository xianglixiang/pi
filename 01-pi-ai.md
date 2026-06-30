# pi-ai 技术细节

`@earendil-works/pi-ai` — 统一多 Provider LLM API，自动模型发现与 provider 配置。它是整个 Pi 的 LLM 抽象底座，agent-core 和 coding-agent 都通过它访问模型。

## 顶层结构

```
packages/ai/src/
├── index.ts            # 核心无副作用导出（typebox、类型、auth、models、utils）
├── compat.ts           # 旧版全局 API 入口（detectCompat、streamSimple 等历史接口）
├── types.ts            # 核心类型定义：Api/Provider/Model/Context/Message/Usage
├── models.ts           # Models 接口 + createModels()/builtinModels() 工厂
├── models.generated.ts # 【生成文件】provider 内置模型目录（由 scripts/generate-models.ts 生成）
├── image-models.ts / images-*.ts  # 图像生成模型抽象
├── oauth.ts            # OAuth 入口聚合
├── session-resources.ts # 会话级资源（prompt cache 管理）
├── cli.ts              # pi-ai 自带的 --list-models 等子命令
├── env-api-keys.ts     # 环境变量到 provider api key 的映射
├── api/                # 9 种 API 协议实现（每个含 .lazy.ts 延迟加载版）
├── providers/          # 30+ provider 工厂（每个含 .models.ts 模型清单）
├── auth/               # 认证解析：credential-store、context、resolve、types
└── utils/              # diagnostics、event-stream、json-parse、oauth/、overflow、validation
```

## 核心抽象

### `Models` 集合（`models.ts`）
- 运行时持有多个 `Provider`，负责 **认证解析** 和 **流式委托**。
- 每个 `Provider` 拥有：`id`、`name`、`baseUrl`、`auth: ProviderAuth`、`getModels()`、可选 `refreshModels()`（动态 provider 用）、`stream()`、`streamSimple()`。
- `Models.streamSimple(model, context, options)` 是 agent-core 调用的入口：解析 provider 认证 → 委托给拥有该 model 的 provider → 返回 `AssistantMessageEventStream`。
- `Models.getAuth(providerId)` 返回未配置 provider 的 undefined。

### `Provider<TApi>` 接口
- 泛型 `TApi` 让具体 provider 工厂声明其模型支持的 API（例如 `openaiProvider(): Provider<"openai-responses" | "openai-completions">`），给直接使用者类型化的模型列表；在 `Models` 集合内部统一存为 `Provider<Api>`。
- **每个 provider 都提供 `apiKey` 认证语义**（即使是纯环境变量/AWS profile/ADC 文件这类 ambient 凭据），其 `resolve()` 报告 provider 是否已配置。

### 核心类型（`types.ts`）
- `Api = KnownApi | string` — 9 种已知 API 协议：`openai-completions`、`mistral-conversations`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`。
- `Provider` / `Model<TApi>` / `Context`（消息历史 + 工具定义 + system prompt）。
- `ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh"`，`ModelThinkingLevel = "off" | ThinkingLevel`，`ThinkingBudgets`（基于 token 的 provider 才用）。
- `Transport = "sse" | "websocket" | "websocket-cached" | "auto"`。
- `CacheRetention = "none" | "short" | "long"`（prompt cache 保留偏好）。
- `Usage` 含 input/output/cacheRead/cacheWrite tokens 与 cost 明细。

## API 层（`api/`）

每条 API 协议由两个文件组成：`<name>.ts`（实现）+ `<name>.lazy.ts`（延迟加载封装）。

| API 文件 | 协议 | 典型 provider |
|---|---|---|
| `anthropic-messages.ts` | Anthropic Messages 流式 | Anthropic、AWS Bedrock（部分）、xai |
| `openai-completions.ts` | OpenAI Chat Completions（含 `detectCompat` 回退） | OpenAI 兼容、DeepSeek、Groq、Cerebras、Together、Fireworks 等 |
| `openai-responses.ts` | OpenAI Responses API | OpenAI、Azure OpenAI Responses |
| `openai-codex-responses.ts` | Codex WebSocket | OpenAI Codex |
| `google-generative-ai.ts` | Google Generative AI | Google |
| `google-vertex.ts` | Google Vertex AI | Google Vertex |
| `bedrock-converse-stream.ts` | AWS Bedrock Converse Stream | Amazon Bedrock |
| `mistral-conversations.ts` | Mistral Conversations | Mistral |
| `azure-openai-responses.ts` | Azure OpenAI Responses | Azure |
| `openrouter-images.ts` | 图像生成 | OpenRouter Images |

辅助：
- `lazy.ts` — 延迟加载 API 实现，避免冷启动开销；`streamSimple` / `lazyStream` 通过 `compat.ts` 暴露。
- `simple-options.ts` — `SimpleStreamOptions` 归一化（apiKey/thinkingLevel/transport 等请求级覆盖）。
- `transform-messages.ts` — 不同 provider 间的消息格式互转。
- `openai-prompt-cache.ts` / `openai-responses-shared.ts` — OpenAI 系列的 prompt cache 与共享逻辑。
- `cloudflare.ts` / `github-copilot-headers.ts` — 特定 provider 的头部/路由处理。

## Provider 层（`providers/`）

30+ provider 工厂，每个 provider 由 `<name>.ts`（工厂 + auth）和 `<name>.models.ts`（静态模型清单）组成。`all.ts` 聚合导出全部 provider（`@earendil-works/pi-ai/providers/all`）。

覆盖：OpenAI、Anthropic、Google、Google Vertex、AWS Bedrock、Azure、Mistral、xAI、Groq、Cerebras、DeepSeek、NVIDIA、GitHub Copilot、OpenRouter、Vercel AI Gateway、Fireworks、Together、HuggingFace、Moonshot、MiniMax、ZAI、Kimi、OpenCode、Cloudflare Workers AI / AI Gateway、Xiaomi 等。

特殊：
- `faux.ts` — 测试用 mock provider（在 `index.ts` 中导出）。
- `cloudflare-auth.ts` — Cloudflare 的请求级 base URL 派生（依赖 request-scoped `apiKey`/`env`，见 issue #6021）。
- `images/` — 图像 provider 实现。

## 认证系统（`auth/`）

- `types.ts` — `CredentialStore`、`AuthContext`、`ProviderAuth`、`AuthResult` 接口。
- `credential-store.ts` — `InMemoryCredentialStore`（运行时默认），凭据带 `type: "api_key"` 判别符与 provider-scoped `env`（v0.80.2 变更，与 `auth.json` 兼容）。
- `context.ts` — `defaultProviderAuthContext`，从 env / credential store 构造认证上下文。
- `resolve.ts` — `resolveProviderAuth()`：把 provider 的 auth 声明 + context 解析成实际的 `AuthResult`（headers / apiKey / OAuth token），是 `Models.streamSimple` 的关键步骤。`ModelsError` / `AuthModel` 类型在此。
- `helpers.ts` — 认证辅助。

OAuth 实现在 `utils/oauth/`（types、provider 接口、device-code flow、select/prompt UI 抽象）。

## 兼容入口（`compat.ts`）

历史的"全局 API"，仍在 agent-core 的 `agent-loop.ts` 中被直接使用（`streamSimple`、`validateToolArguments`、`EventStream`、`clampThinkingLevel`）。包含：
- `detectCompat` — 对没有显式 compat 元数据的模型做启发式探测（v0.80.2 恢复的回退）。
- 临时遗留 per-API stream 别名（`streamSimpleOpenAICompletions` 等，issue #6016/#6017）。

## 关键设计点

1. **核心入口无副作用**：`index.ts` 只导出类型和纯函数，不触发 provider 工厂、不加载生成目录；provider 工厂走 `providers/*`，API 实现走 `api/*`，旧全局 API 走 `compat`。
2. **延迟加载**：所有 API 实现通过 `.lazy.ts` + `lazyStream` 包装，避免 import 巨型 SDK（如 `@aws-sdk`）拖慢冷启动。
3. **认证解析与流式分离**：`Provider.auth` 声明认证方式，`Models` 在请求时才 `resolveProviderAuth` 派生实际凭据/headers，支持请求级覆盖（Cloudflare 场景）。
4. **生成式模型目录**：`models.generated.ts` 由 `scripts/generate-models.ts` 生成，禁止直接编辑；每个 provider 的 `.models.ts` 是源。
5. **TypeBox schema**：全包用 `typebox` 而非 `zod` 定义工具入参 schema，便于跨包共享 `TSchema`。
6. **流式事件统一**：`AssistantMessageEventStream` 是所有 provider 的统一输出，下游 agent-loop 消费。
