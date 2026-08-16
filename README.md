# DASH — Deepseek Agentic Service Harness (terminal edition)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**oh-my-pi 的使用习惯，DeepSeek Harness 的完整 agent 内核，跑在终端里。**

像 [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) 一样以官方 `dsh` CLI 的 profile
方式启动，但按键、编辑语义、状态栏与设置面板遵循 oh-my-pi 的习惯。内核完全是
DSH：插件通过官方工厂 `ctx.agents.create()` 创建真实 Agent，`agent.followup()`
驱动回合、`agent.cancel()` 中断、`session/event` 事件流渲染流式输出 —— 工具调用、
思考、会话持久化、compaction、agent preset 全部走 DSH 官方服务。UI 是零依赖的
raw-ANSI 终端渲染（无 React/Ink），整个插件只有一个 `index.ts`。

## 安装

前置：官方 `dsh` CLI（`npm install -g @deepseek-ai/dsh`）。

```sh
git clone https://github.com/songqikong/dash.git
cd dash
npm install          # 首次：安装 typescript 等构建依赖
sh install.sh        # 编译 src/*.ts → dist/，创建 ~/.dsh/profiles/dash + ~/.local/bin/dash
dash                 # 启动（等价于 dsh --profile dash）
```

`DASH_PROVIDER` / `DASH_MODEL` 环境变量可覆盖默认模型；LLM provider 配置完全复用
`$DSH_HOME/settings.yaml`（Web Models 页面写的那份），无需单独配置。

## 一个 TUI，_全程 DSH 官方链路_

### 01 · 终端原生渲染，零依赖

整个界面是 raw-ANSI：差分渲染只重绘变化的行、kitty 键盘协议（CSI-u）逐键精确
解析、SGR 鼠标（滚轮滚动/列表中移动选择）、备用屏幕 + 隐藏硬件光标。不引入
React/Ink，没有 node_modules 包袱 —— 插件本体一个文件，运行时依赖只有 DSH
官方包。

### 02 · oh-my-pi 编辑语义全套

多行输入（kitty Shift+Enter / Ctrl+J）、词/行移动与删除、kill-ring（Ctrl+Y /
Alt+Y yank-pop）、undo（Ctrl+-）、跳转字符（Ctrl+] / Ctrl+Alt+]）、Ctrl+G 外部
编辑器往返、粘贴、`@` 文件补全（目录可深入）。快捷键全量来自 oh-my-pi 的 action
表，可在 `~/.dash/keybindings.yml` 重映射，`/hotkeys` 查看当前绑定。

### 03 · 流式转录

Markdown 渲染（标题/列表/引用/代码高亮/表格/链接，流式安全 —— 未闭合的代码块
与表格降级为普通段落而非破坏帧）、thinking 流式折叠（Ctrl+T 显隐）、工具卡片
（⛭/✓/✗ 状态、参数折叠 Ctrl+O、结果摘要）、消息元数据（时间/耗时/模型）、
置顶提示词栏 + ↓N 未读 pill（浏览历史时）。

### 04 · 状态栏仪表

omp 风格状态行：`⬢ 模型 · ◉ 思考深度 · in/out tokens · TPS sparkline · 缓存命中率 · ⏱ 会话耗时`，
外加活动行（spinner + ⛭ 工具名 / ⏵ 模型自述工作行 / ✓ 回合统计）、队列、状态
提示、git 分支 / cwd / 会话标题。所有信息都在输入框上方 —— 屏幕最底部只属于
输入文字。

### 05 · 模型角色体系

default / smol / plan / task 四个角色，值支持 `provider/model:effort` 后缀，
持久化 `~/.dash/config.yml` 的 `modelRoles`。三栏选择器（Alt+M，Tab 切栏 ·
j/k 移动 · Enter 下钻）、Ctrl+P 循环当前角色模型、Alt+P 临时换模型、
Shift+Tab 循环思考级别。默认思考深度可在设置面板配置。

### 06 · 会话工作流

`/resume` 选择器（列表按 mtime 排序、标题并行加载、Enter 恢复 + 事件日志重放、
`d` 删除 dash-* 会话）、`/rename`、`/new`、持久化（`~/.dsh/sessions`）、
`autoResume` 启动自动恢复最近会话。双击 Esc 进入时间回溯：从会话日志 fork 出
一个种子会话，把那条消息放回编辑器改完重发（omp 的 rewind 语义）。

### 07 · 官方 agent preset 模式

DSH 四种官方 Agent 模式直接可用：**标准模式**（功能完整）、**PTC 模式**（Code
Mode SDK）、**极简模式**（仅持久 bash + str_replace_editor 双工具）、**创造模式**
（preset 创作）。`/preset` 选择器或设置面板「会话模式」项切换；空白会话立即
重建生效，已产生对话的会话 `/new` 后生效；选择持久化 `preset.id`。装载走官方
`discoverPresets` / `mountPreset`，在 agent 工厂的 `setup` 钩子中完成。

### 08 · omp 风格设置面板

`/settings` 完全移植 oh-my-pi 的 SettingsList 交互：appearance / model /
interaction / session 四个页签 + 分组侧栏（≥2 组时左右分栏、非活动组淡化）、
type-to-search 跨页模糊搜索（Tab 跳到下一命中的页签）、Enter/Space 循环取值、
3 行描述区、变更标记、Esc 先退搜索再关面板。12 个真实旋钮（语言、主题、色盲
模式、spinner 帧、默认思考深度、隐藏思考块、advisor、双击 Esc、排队投递、回合
铃、静默启动、autoResume），全部即时生效并写入 `~/.dash/config.yml`。

### 08½ · 启动欢迎屏

进入会话前显示 omp 风格欢迎屏：尖角单列框（无圆角元素，全部元素居中），
`Welcome back!` + 粗体 DASH 字符画 + 模型名/提供方，下方依次是 Tips、当前
Agent preset、最近会话（真实读自 `~/.dsh/sessions`，含相对时间）。第一条消息
发出后自动让位给转录。

### 09 · Agent Hub（子代理中心）

Alt+A / `/hub` 打开子代理树：缩进层级、label、mode、running/inactive 状态、
过滤；Enter 看详情、`s` 给子代理发消息（followup）、`x` 中断（ancestor 授权）。

### 10 · advisor 第二模型旁听

`/advisor on` 开启：每回合完成后用第二模型对该回合给一条简短点评（advisor: 前缀
注记行），在主会话转录中可见。

### 11 · TTSR：时间旅行流规则

`~/.dash/rules.yml` 里写正则 → 提示语。流式输出命中即注入
`agent.steer()` 提示并打 ⚠ 卡片，每回合去重 —— 纠正行为而不付上下文税。

### 12 · DSH 命令注册表 + 技能 + 项目指令

`/plan` `/goal` `/compact` 等自动转发 DSH 命令注册表；`/skills` 列出可用技能；
`/init` 把 AGENTS.md/CLAUDE.md 注入为 instructions；`/think` `/focus` 注入
推理/专注 steer。回合结束可选响铃（`notify.turnEnd`）。

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
| `PgUp/PgDn` · `Alt+↑/↓` | 滚动历史 / 出队 |
| `鼠标滚轮` | 滚动历史；悬浮列表中移动选择（SGR 鼠标，自动启用） |
| `/help /clear /models /new /exit /model <p>/<m> /status` | 斜杠命令 |
| `/plan /goal /compact` 等 | 自动转发到 DSH 命令注册表 |

完整列表见 `FEATURES.md`；键位可在 `~/.dash/keybindings.yml` 重映射。

## 会话控制

- `/new` 新会话 · `/resume` 恢复/重放/删除 · `/rename <t>` 重命名 · `/clear` 清屏
- `/preset` 切换 agent preset（标准/PTC/极简/创造）· `/settings` 设置面板
- `/model <p>/<m>` 换模型 · `/role <name>` 切角色 · `/theme <dark|light>` 换主题
- `/lang <en|zh>` 切换界面语言（默认英文）
- `/plan` 计划模式开关 · `/goal` `/compact`（DSH 注册表）· `/hub` 子代理中心
- `/advisor <on|off>` · `/skills` · `/init` · `/think` `/focus` · `/status` · `/hotkeys`

## 配置

- **默认模型**：profile 的 `cordis.patch.yml` 中 `agent-default-model`（默认
  `opencode-go / deepseek-v4-flash`，凭据走 `$DSH_HOME/.credentials.yaml`）。
- **启动覆盖**：`DASH_PROVIDER` / `DASH_MODEL` 环境变量。
- **用户设置**：`~/.dash/config.yml`（语言、主题、spinner、思考深度、advisor、preset、
  autoResume 等，设置面板写入）；`~/.dash/keybindings.yml`（键位）；
  `~/.dash/rules.yml`（TTSR 流规则）。界面语言默认英文，`/lang <en|zh>` 或
  设置面板「Language」切换。
- **权限**：终端信任模型 —— `danger-full-access` + `policy: never`（无审批弹窗，
  终端即信任边界）；想收紧可改 profile 的 `cordis.patch.yml`（`permission` 行的
  `defaultPreset` 必须与 `sandbox-policy` / `approval` 两个旋钮匹配，否则启动报错）。

## 明确排除（依赖 oh-my-pi 私有原生栈，DSH 内核不提供）

- 60+ provider 生态（DSH 用自己的 provider 注册表）
- LSP（14 ops）/ DAP（28 ops）工具（DSH 内核无此栈；read/grep/glob 由 DSH 工具承担）
- /collab 中继（依赖 omp 服务器）
- STT/语音 /live（无音频后端）
- 图像协议（kitty/sixel 图片显示）、OSC 5522 剪贴板图片
- 原生 in-process ripgrep/brush（DSH 提供等价的工具实现）
- 会话导出/分享对话框、会话树形面板（终端由 /resume 覆盖）

## 开发

源码在 `src/`（TypeScript），编译产物进 `dist/`。

```sh
npm install        # 首次：安装 typescript / @types（构建依赖）
npm run build      # 编译 src/*.ts → dist/
sh install.sh      # 自动重新编译并把 dist/ 复制进 ~/.dsh/profiles/dash/node_modules/dash-tui
dash               # 启动（Ctrl+C 退出）
```

`sh install.sh --no-build` 可跳过编译只复制。改完 `src/*.ts` 重跑
`sh install.sh` 即可生效。运行时依赖只有 DSH 官方包
（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-presets`），
解析自 `~/.dsh/profiles/node_modules` 共享目录。

pty 集成测试在 `tests/`（b1–b6，真实聊天往返 + 按键驱动）：

```sh
cd tests && python3 b1.py   # 每批独立验证：编辑器/对话框/命令/恢复/设置/模式
```

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 插件本体（agent 生命周期 + 事件投影 + 渲染 + 输入分发） |
| `src/keys.ts` | 键解析（kitty/CSI/legacy）+ oh-my-pi action 注册表 |
| `src/editor.ts` | 多行草稿编辑器（kill-ring/undo/跳转字符/外部编辑器） |
| `src/markdown.ts` | 流式安全的 Markdown → ANSI 渲染器 |
| `src/config.ts` | `~/.dash` 配置读写（扁平点号键，YAML 持久化） |
| `src/dsh.d.ts` | DSH 官方 API 面的环境声明（dsh-llm/agent/session/presets） |
| `dist/` | tsc 编译产物（install.sh 复制进 profile） |
| `tests/` | b1–b6 pty 回归测试 |
| `cordis.patch.yml` | profile 补丁层（模型/权限/沙箱） |

## License

MIT. See [LICENSE](LICENSE).

- [GitHub](https://github.com/songqikong/dash)
- [主页](https://songqikong.github.io/dash/)

_made for terminals that stay open_
