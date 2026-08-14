# DASH — Deepseek Agentic Service Harness (terminal edition)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

oh-my-pi 的 TUI 使用逻辑 + DeepSeek Harness 的完整 agent 内核，跑在终端里。
像 [dsh-cc-tui](https://github.com/ccch1mneyyy/dsh-cc-tui) 一样通过官方
`dsh` CLI 以 profile 方式启动，但按键与界面遵循 oh-my-pi 的习惯。

内核完全是 DSH：插件通过官方工厂 `ctx.agents.create()` 创建真实 Agent，
`agent.followup()` 驱动回合、`agent.cancel()` 中断、`session/event` 事件流
渲染流式输出 —— 工具调用、思考、会话持久化、compaction 全部走 DSH 官方服务。
UI 是零依赖的 raw-ANSI 终端渲染（无 React/Ink），整个插件只有一个
`index.js`。

## 安装

前置：官方 `dsh` CLI（`npm install -g @deepseek-ai/dsh`）。

```sh
git clone https://github.com/songqikong/dash.git
cd dash
sh install.sh          # 创建 ~/.dsh/profiles/dash + ~/.local/bin/dash
dash                   # 启动（等价于 dsh --profile dash）
```

本地开发：改完 `index.js` 等源码后重跑 `sh install.sh` 生效（会复制进
`~/.dsh/profiles/dash/node_modules/dash-tui/`）。

## 按键（oh-my-pi 习惯）

| 键 | 行为 |
|---|---|
| `Enter` | 发送（流式中排队为后续消息） |
| `Ctrl+Enter` / `Ctrl+Q` | 排队后续消息 |
| `Esc` / `Ctrl+C` | 中断生成（空闲时 `Ctrl+C` 退出，`Esc` 需确认） |
| `Ctrl+P` / `Alt+P` | 循环切换模型 |
| `Alt+M` | 模型选择器（j/k 移动 · Tab 切栏 · Enter 选中） |
| `Alt+R` | 重发上一条指令 |
| `Ctrl+R` / `↑` | 输入历史 |
| `Ctrl+N` | 新会话（/new） |
| `Ctrl+T` | 显隐思考过程 |
| `Ctrl+O` | 工具参数展开/折叠 |
| `Ctrl+L` | 重置显示 |
| `PgUp/PgDn` · `Alt+↑/↓` | 滚动历史 |
| `/help /clear /models /new /exit /model <p>/<m> /status` | 斜杠命令 |
| `/plan /goal /compact` 等 | 自动转发到 DSH 命令注册表 |

## 功能总览（对照 oh-my-pi，逐项见 FEATURES.md）

- **键位**：oh-my-pi 全量 action 表（TUI editor/input/select + app），`~/.dash/keybindings.yml` 重映射，`/hotkeys` 查看
- **编辑器**：多行（kitty 协议 Shift+Enter / Ctrl+J）、词/行移动与删除、kill-ring、undo、跳转字符、Ctrl+G 外部编辑器、粘贴
- **转录**：Markdown 渲染（标题/列表/引用/代码高亮/表格/链接）、thinking 流式折叠、工具卡片、消息元数据、置顶提示词栏 + 未读 pill、双击 Esc 时间回溯（fork 重放）
- **状态栏**：上下文分段进度条、TPS sparkline、缓存命中率、思考深度、⏵ 模型自述工作行、回合统计、git/cwd/标题
- **模型**：角色体系（default/smol/plan/task + :effort 后缀）、三栏选择器、Ctrl+P 循环、Alt+P 临时
- **会话**：/resume 选择器（恢复+重放+删除）、/rename、/new、持久化（~/.dsh/sessions）
- **命令**：/plan /goal /compact（DSH 注册表）、/settings 面板、/theme、/skills、/init /think /focus、/hub、/advisor、TTSR 流规则（~/.dash/rules.yml）、回合 bell
- **主题**：dark/light 双色板

## 明确排除（依赖 oh-my-pi 私有原生栈，DSH 内核不提供）

- 60+ provider 生态（DSH 用自己的 provider 注册表）
- LSP（14 ops）/ DAP（28 ops）工具（DSH 内核无此栈；read/grep/glob 由 DSH 工具承担）
- /collab 中继（依赖 omp 服务器）
- STT/语音 /live（无音频后端）
- 图像协议（kitty/sixel 图片显示）、OSC 5522 剪贴板图片
- 原生 in-process ripgrep/brush（DSH 提供等价工具实现）
- 会话导出/分享对话框、会话树形面板（web 面能力；终端由 /resume 覆盖）

## 配置

- 默认模型：profile 的 `cordis.patch.yml` 中 `agent-default-model`（默认
  `opencode-go / deepseek-v4-flash`，与本地 Web GUI 相同，凭据走
  `$DSH_HOME/.credentials.yaml`）。
- 启动时可用 `DASH_PROVIDER` / `DASH_MODEL` 环境变量覆盖。
- LLM provider 配置完全复用 `$DSH_HOME/settings.yaml`（Web Models 页面写的
  那份），无需单独配置。
- 权限：终端信任模型 —— `danger-full-access` + `policy: never`（无审批弹窗，
  终端即信任边界，与其它终端 agent 一致）；想收紧可改 profile 的
  `cordis.patch.yml`（注意 `permission` 行的 `defaultPreset` 必须与
  `sandbox-policy` / `approval` 两个旋钮匹配，否则启动报错）。

## 开发

```sh
sh install.sh        # 把 index.js 复制进 ~/.dsh/profiles/dash/node_modules/dash-tui
dash                 # 启动（Ctrl+C 退出）
```

改完 `index.js` 后重跑 `sh install.sh` 即可生效。依赖只有两个 DSH 官方包
（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`），解析自
`~/.dsh/profiles/node_modules` 共享目录。
