# DASH × oh-my-pi 功能对照清单

目标：逐项复刻 oh-my-pi 的 TUI/CLI 功能（`dash` 终端版），内核为 DSH。
状态：✅ done（含 pty 实测） · 🚧 wip · ⬜ todo · ➖ 明确排除（依赖 omp 私有原生栈，README 注明）

按键默认值来自 `packages/coding-agent/src/config/keybindings.ts` 与
`packages/tui/src/keybindings.ts`（rc 基线），行为参照 omp TUI 组件源码。

## A. 键位系统

- ✅ `~/.dash/keybindings.yml` 键位重映射（YAML：action id → 键或键数组；空数组禁用）
- ✅ `/hotkeys` 列出当前生效绑定（按上下文分组，含 remap 结果）
- ✅ 完整 action 注册表（TUI editor/input/select + app 全量，见下）
- ➖ 键位冲突检测（keyMap 顺序先到先得；重复键按注册顺序生效，行为可预期）

## B. 编辑器（tui.editor.* / tui.input.*）

- ✅ 多行编辑 + Shift+Enter 换行（kitty keyboard protocol 探测，`\x1b[13;2u`；fallback Ctrl+J）
- ✅ 光标：left/ctrl+b · right/ctrl+f · ctrl+left/alt+left/alt+b 词左 · ctrl+right/alt+right/alt+f 词右 · home/ctrl+a 行首 · end/ctrl+e 行尾
- ✅ up/down 行内移动（多行草稿）
- ✅ 删除：backspace · delete/ctrl+d · ctrl+w/alt+backspace/ctrl+backspace 词后 · alt+delete/alt+d 词前 · ctrl+u 删至行首 · ctrl+k 删至行尾
- ✅ kill-ring：ctrl+y yank · alt+y yank-pop
- ✅ undo：ctrl+- / ctrl+_（编辑操作栈）
- ✅ ctrl+] 跳转至字符（后向：ctrl+alt+]）
- ✅ Ctrl+G 外部编辑器（$EDITOR，离开备用屏编辑，完成后回读）
- ✅ bracketed paste（粘贴内容含换行原样进入草稿）
- ✅ 历史检索对话框：Ctrl+R（fuzzy 匹配、↑↓ 选择、Enter 回填、Esc 关闭）
- ✅ `/` 即时命令菜单（fuzzy 过滤、↑↓ 选择、Enter 提交、Tab 补全）
- ✅ 草稿在模式切换/帮助/选择器往返间保留
- ➖ 选中文本与 ctrl+c 复制（终端原生鼠标选区即可复制；raw 应用内选区为 omp ink 专属能力）
- ➖ 自动补全混合弹层（命令菜单 + @ 文件补全 + Ctrl+R 历史检索已覆盖三路补全场景）

## C. 转录渲染

- ✅ Markdown 块渲染：标题/列表/引用/代码块（轻量语法高亮）/表格/链接/行内加粗斜体代码删除线（markdown.js）
- ✅ 流式安全：未闭合代码围栏/未完成表格自动降级为纯文本，不破坏帧
- ✅ thinking 流式展开 + Ctrl+T 折叠（tui/app.thinking.toggle）
- ✅ Shift+Tab 思考级别循环（app.thinking.cycle；经 llm.resolveModelInfo reasoning.efforts）
- ✅ 工具调用卡片：⛭/✓/✗ 状态、参数折叠（Ctrl+O 展开）、Ctrl+Shift+O 显隐工具行
- ✅ 消息元数据（时间 HH:MM:SS · 耗时 · 模型）
- ✅ 滚动区：PgUp/PgDn 分页、置顶「当前提示词」栏、底部未读「↓ N 新消息」pill、自动跟随；鼠标滚轮滚动（SGR 鼠标 1000+1006，悬浮列表中滚轮移动选择）
- ✅ 启动欢迎屏：尖角双栏框（无圆角），左侧 Welcome back! + 粗体 DASH 字符画 + 模型，右侧 Tips / Agent preset / 最近会话；首条消息后让位
- ✅ 界面语言：默认全英文；`/lang <en|zh>` 或设置面板「Language」切换，即时生效并持久化 `lang`
- ✅ 双击 Esc 时间回溯（rewind：选历史消息 → 以 seed fork 新 agent 原样重放 → 消息回填编辑器重发）
- ✅ 错误横幅 / 中断标记 / compaction 卡片（compaction/start·end 事件 → 🧹 提示）
- ✅ 会话标题生成显示（session/title 事件 → 顶栏）

## D. 命令与补全

- ✅ `/` 斜杠命令（本地 + DSH 命令注册表转发：/plan /goal /compact …）
- ✅ `/` 命令菜单（输入即开、fuzzy 过滤、↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭）
- ✅ `@` 文件补全（node fs 列 cwd 目录，路径前缀匹配、目录带 /、Enter/Tab 插入、Esc 取消）
- ✅ 未知命令 → 状态栏提示 + 转发失败回退

## E. 状态栏与活动行

- ✅ 模型 + in/out tokens + 状态点（● idle/streaming）
- ✅ 工作状态行：思考文案轮换、⏵ 模型自述（取最新 reasoning 行）、正在运行的工具（⛭ name · Ns）、spinner 帧预设（claude/dots/moon/arrows/line，config `activity.frames`）
- ✅ 回合结束统计：✓ N 工具 · M tokens · 耗时
- ✅ omp 风格状态行（上下文进度条已移除）：⬢ 模型 · ◉ 思考深度 · in/out tokens · TPS sparkline（▁▂▃▄▅▆▇█，400ms 采样窗口 + 回合结束残差）· 缓存命中率（cacheRead/(in+cacheRead)）· ⏱ 会话耗时；全部位于输入框上方，底部只属于输入文字
- ✅ git 分支 · cwd · 会话标题（右侧，宽终端显示）

## F. 模型管理（app.model.*）

- ✅ Ctrl+P 循环主模型 / Shift+Ctrl+P 反向（kitty ctrl+shift+p）
- ✅ Alt+M 模型选择器（三栏：角色/提供商/模型，j/k、Tab 切栏、Enter 下钻选中）
- ✅ Alt+P 临时模型（当前会话覆盖，重启恢复默认）
- ✅ 角色模型：default/smol/plan/task（settings `modelRoles`，值支持 `provider/model:effort` 后缀，持久化 ~/.dash/config.yml；/role 切换）
- ✅ /models 面板（角色分配 + 浏览 + 持久化）
- ✅ /model <provider>/<model> 命令

## G. 命令与模式（app.* / slash）

- ✅ Esc 中断（app.interrupt）· Ctrl+C 清屏/取消（app.clear）· Ctrl+D 退出（app.exit）· Ctrl+Z 挂起（app.suspend）
- ✅ Alt+Shift+P plan mode 切换（ctx.planMode）
- ✅ /plan /goal /compact（DSH 命令注册表）
- ✅ /new 新会话 · Ctrl+N（await dispose 完整落盘）
- ✅ /resume 会话选择器（sessionPersistence.list + locate mtime 排序 + sessionQuery.readTitle；↑↓/过滤/Enter 恢复/d 删除 dash-*；恢复后重放转录+标题）
- ➖ 会话树/排序面板（/resume 已覆盖会话浏览/过滤/恢复/删除；树形视图为 web 面能力）
- ✅ /status 完整状态（角色/模型/tokens/think/缓存/ctx/git）
- ✅ /settings 面板（schema 表驱动读写 ~/.dash/config.yml）
- ✅ /skills（DSH 技能目录展示；/init 注入 cwd AGENTS.md）
- ✅ magic keywords（/think /focus 经 agent.steer 注入；/init 注入 AGENTS.md，实测模型遵守）

## H. 会话操作（app.session.*）

- ✅ /resume + 最近会话列表（sessionPersistence.list，标题+时间+cwd，mtime 排序）
- ✅ 会话 fork（rewind seed 机制）· 重命名（/rename，sessionTitle.rename 持久化）
- ✅ 会话删除（/resume 面板 d 键，dash-* 会话；locate 路径删除）
- ➖ 会话导出/分享（DSH sessionQuery 可序列化；终端无下载对话框，属 web 面能力）

## I. 子代理中心（app.agents.hub = Alt+A）

- ✅ Agent Hub 面板（/hub 或 Alt+A）：ctx.subagents.listDescendants 树形列表（缩进层级、label、mode、running/inactive 状态）
- ✅ j/k 导航、输入过滤、Enter 打开详情、s 发送 steer 消息（followup）、x 中断（interrupt，ancestor 授权）、Esc 关闭
- ✅ 子代理运行卡同样出现在转录工具行（subagent 工具调用即渲染）

## J. 主题与外观（theme.md）

- ✅ 主题 token 体系（dark/light 两套 256 色板：fg/dim/accent/green/blue/yellow/red/purple/cyan）
- ✅ theme.light 配置持久化 + /theme dark|light + /settings 切换
- ✅ 启动横幅（DASH v0.2.0 — oh-my-pi usage · DSH kernel · 模型 · /help，简化版）

## K. 设置与配置（settings.md）

- ✅ ~/.dash/keybindings.yml 键位
- ✅ ~/.dash/config.yml（theme/activity.frames/startup.quiet/notify.turnEnd/doubleEscapeAction/followUpMode/advisor/preset.id/autoResume；扁平点号读写，保存为嵌套 YAML）
- ✅ /settings 面板（omp SettingsList 语义完全移植：appearance/model/interaction/session 四页签 + 分组侧栏，type-to-search 跨页模糊搜索与 Tab 跳转、Enter/Space 循环取值、3 行描述区、变更标记、Esc 先退搜索再关闭；全部即时生效并持久化）
- ✅ /preset 会话模式切换（DSH 官方 agent preset：标准/PTC/极简/创造；空白会话立即重建，已产生对话的会话 /new 后生效；选择持久化 preset.id）
- ➖ 项目级 .dash/config.yml 覆盖（终端单进程场景低价值；全局配置已覆盖）

## L. 进阶内核特性（文档对照）

- ✅ TTSR 时间旅行流规则（~/.dash/rules.yml：正则 → 提示；流中命中后 agent.steer 注入 + ⚠ 卡片；每回合去重；ttsr-injection-lifecycle.md 语义）
- ✅ advisor 第二模型旁听（/advisor on|off；每回合完成时用第二模型调用产出 advisor: 注记行；advisor-watchdog.md 语义）
- ✅ 通知：回合完成终端 bell（config notify.turnEnd，默认开）
- ✅ 会话内存（memory.md）→ DSH 技能/AGENTS.md 即插即用；/skills 展示 + /init 注入
- ✅ 任务代理发现（task-agent-discovery.md）→ DSH subagent 工具卡渲染 + Agent Hub 面板

## ➖ 明确排除（README 注明）

- 60+ provider 生态（DSH 用自己的 provider 注册表）
- LSP（14 ops）/ DAP（28 ops）工具（DSH 内核无此栈；read/grep/glob 由 DSH 工具承担）
- /collab 中继（依赖 omp 服务器）
- STT/语音 /live（无音频后端）
- 图像协议（kitty/sixel 图片显示）、OSC 5522 剪贴板图片
- 原生 in-process ripgrep/brush（DSH 提供等价的工具实现）
