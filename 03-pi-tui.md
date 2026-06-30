# pi-tui 技术细节

`@earendil-works/pi-tui` — 终端 UI 库，差分渲染引擎 + 组件库 + 键绑定 + 终端图像协议。完全独立，无内部包依赖，是 coding-agent 交互模式的基础设施。

## 顶层结构

```
packages/tui/src/
├── index.ts              # 全部导出
├── tui.ts                # TUI 核心：差分渲染、Container/Component/Overlay
├── terminal.ts           # Terminal 抽象 + ProcessTerminal（raw mode、协议协商）
├── keys.ts               # Kitty 键盘协议解析、Key/matchesKey/parseKey
├── keybindings.ts        # KeybindingsManager、TUI_KEYBINDINGS
├── stdin-buffer.ts       # 输入批处理切分
├── native-modifiers.ts   # 原生修饰键检测
├── terminal-colors.ts    # OSC 11 背景色 / 配色方案探测
├── terminal-image.ts     # Kitty / iTerm2 图像协议
├── editor-component.ts   # EditorComponent 接口（自定义编辑器）
├── autocomplete.ts       # AutocompleteProvider、SlashCommand
├── fuzzy.ts              # 模糊匹配
├── kill-ring.ts          # Emacs 风格 kill-ring（剪切历史）
├── undo-stack.ts         # 撤销栈
├── word-navigation.ts    # 单词级光标移动
├── utils.ts              # sliceByColumn / visibleWidth / wrapTextWithAnsi / truncateToWidth
└── components/
    ├── box.ts            # 带边框容器
    ├── text.ts           # 纯文本
    ├── spacer.ts         # 弹性间隔
    ├── input.ts          # 单行输入
    ├── editor.ts         # 多行编辑器（核心）
    ├── markdown.ts       # Markdown 渲染（marked）
    ├── select-list.ts    # 可选列表（fuzzy 搜索）
    ├── settings-list.ts  # 设置项列表
    ├── loader.ts         # 加载指示器
    ├── cancellable-loader.ts
    ├── truncated-text.ts # 截断文本
    └── image.ts          # 图像组件
```

## 核心抽象

### `TUI`（`tui.ts`）— 差分渲染引擎
- 管理一个 `Container` 树 + 浮层（Overlay），每个渲染周期：
  1. 遍历可见组件树，每个 `Component.render(width): string[]` 输出行数组。
  2. 与上一帧做 **差分对比**，只输出变化的行/单元格（核心性能机制）。
  3. 处理 Kitty 图像占位行（`isImageLine`、`extractKittyImageIds`/`extractKittyImageRows`），避免差分渲染破坏图像。
- `Component` 接口：`render(width)`、可选 `handleInput(data)`、`receivesKeyReleases`（Kitty 协议按键释放）。
- `Container` / `Focusable`（`isFocusable` 守卫）/ `OverlayHandle` / `OverlayOptions`（锚点、边距、失焦选项）。
- `CURSOR_MARKER` — 渲染流中标记光标位置的特殊序列。
- `SizeValue` — 尺寸值（支持百分比/固定）。

### `Terminal`（`terminal.ts`）— 终端抽象
- `Terminal` 接口 + `ProcessTerminal`（真实进程终端）。
- 职责：
  - raw mode 切换、尺寸查询、读写。
  - **Kitty 键盘协议协商**：`DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7`，发送 `\x1b[>7u\x1b[?u\x1b[c`，解析 `KeyboardProtocolNegotiationSequence`（`kitty-flags` / `device-attributes`），片段超时 `150ms`。
  - **Apple Terminal Shift+Enter** 兼容（`\x1b[13;2u`）。
  - **终端进度条**（OSC 9;4 序列）+ keepalive。
  - 通过 `StdinBuffer` 批处理输入，避免_escape sequence 被切断。
- `isAppleTerminalSession()` 等环境探测。

### 键盘输入（`keys.ts`）
- Kitty 键盘协议打印格式解析：`parseKey`、`decodeKittyPrintable`、`isKeyRelease`、`isKeyRepeat`、`isKittyProtocolActive`、`setKittyProtocolActive`。
- `matchesKey(keyData, "ctrl+x")` — 键序列匹配（注意：AGENTS.md 禁止硬编码 key check，应走 `DEFAULT_*_KEYBINDINGS`）。
- `Key` / `KeyId` / `KeyEventType` 类型。

### 键绑定（`keybindings.ts`）
- `KeybindingsManager` — 管理绑定集合，检测冲突（`KeybindingConflict`）。
- `TUI_KEYBINDINGS` — TUI 层默认绑定。
- `getKeybindings` / `setKeybindings`、`KeybindingDefinition` / `KeybindingsConfig`。

### 终端图像（`terminal-image.ts`）
- 两套协议：
  - **Kitty**：`encodeKitty`（分块 base64 + `\x1b_G`）、`deleteKittyImage` / `deleteAllKittyImages`（按 image id）。
  - **iTerm2**：`encodeITerm2`。
- 能力探测：`detectCapabilities` / `getCapabilities` / `setCapabilities`（缓存可重置）、`TerminalCapabilities` / `ImageProtocol`。
- 尺寸计算：`getImageDimensions` 分派到 `getPngDimensions` / `getJpegDimensions` / `getWebpDimensions` / `getGifDimensions`。
- `calculateImageRows` / `getCellDimensions` / `setCellDimensions` — 计算图像占用行数（差分渲染需要）。
- `renderImage` / `imageFallback` / `hyperlink`（fallback 用超链接）。

## 组件库（`components/`）

### `Editor`（`editor.ts`）— 多行编辑器（最复杂组件）
- 功能：多行文本编辑、光标移动（含 `word-navigation.ts` 单词级移动）、选中、复制/剪切/粘贴（`kill-ring.ts`）、撤销/重做（`undo-stack.ts`）。
- 主题：`EditorTheme`。
- 支持 `EditorComponent` 接口（`editor-component.ts`）让外部提供自定义编辑器（coding-agent 用它做扩展编辑器）。
- `Enter` / `Shift+Enter` / `Ctrl+J` 换行键绑定（v0.80.0 加 `Ctrl+J` 为默认换行）。

### `Markdown`（`markdown.ts`）
- 用 `marked` 解析 Markdown，输出 ANSI 着色行；`MarkdownTheme` / `MarkdownOptions`。
- 支持代码块语法高亮（coding-agent 用 `highlight.js` 在外层增强）。

### `SelectList`（`select-list.ts`）— 列表选择
- `fuzzyFilter` 驱动的搜索、布局选项（`SelectListLayoutOptions`）、截断上下文、主题。
- `SelectItem`、`AutocompleteItem` 与 `autocomplete.ts` 联动。

### 其他组件
- `Box`（边框）、`Text`、`Spacer`（弹性空间）、`Input`（单行）、`TruncatedText`。
- `Loader` / `CancellableLoader`（加载指示器，含 spinner）。
- `SettingsList`（设置项，带 `SettingItem`）。
- `Image`（图像渲染组件，封装 `terminal-image.ts`）。

## 辅助模块

- **`stdin-buffer.ts`** — 输入批处理：把快速到达的 stdin 字节按事件切分成完整键序列（`StdinBufferEventMap` / `StdinBufferOptions`），避免 escape 序列被读多次。
- **`autocomplete.ts`** — `AutocompleteProvider` 接口、`CombinedAutocompleteProvider`（合并多源）、`SlashCommand`、`AutocompleteSuggestions`。
- **`fuzzy.ts`** — `fuzzyMatch` / `fuzzyFilter` / `FuzzyMatch`（评分 + 高亮位置）。
- **`terminal-colors.ts`** — 解析 OSC 11 背景色响应（`parseOsc11BackgroundColor`）、终端配色方案报告（`parseTerminalColorSchemeReport`），用于自动主题适配。
- **`utils.ts`** — `visibleWidth`（ANSI 感知的显示宽度，依赖 `get-east-asian-width` 处理 CJK 宽字符）、`sliceByColumn`、`wrapTextWithAnsi`、`truncateToWidth`。

## 关键设计点

1. **差分渲染**：核心性能机制，每帧只重绘变化单元格，支持高频流式输出。
2. **Kitty 键盘协议优先**：精确按键事件（含修饰键、释放、重复），带协商 + 超时回退到传统转义序列解析。
3. **图像协议感知渲染**：差分引擎识别 Kitty/iTerm2 图像占位行，不破坏已渲染图像。
4. **组件接口极简**：只需实现 `render(width): string[]` + 可选 `handleInput`，易于扩展自定义组件。
5. **零内部依赖**：只依赖 `marked`（Markdown）和 `get-east-asian-width`（CJK 宽度），保持轻量可独立复用。
6. **Overlay 系统**：浮层带锚点/边距/失焦策略，支持弹窗、下拉选择等 UI 模式。
7. **可配置键绑定**：所有键绑定走 `KeybindingsManager`，默认值集中在 `TUI_KEYBINDINGS`，下游（coding-agent）有 `DEFAULT_APP_KEYBINDINGS`。
