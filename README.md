# DASH — Deepseek Agentic Service Harness

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A terminal TUI for the official [dsh](https://github.com/deepseek-ai/dsh) CLI,
launched as a dsh profile like [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI),
but with keybindings, editing semantics, the status bar and the settings panel
following oh-my-pi conventions. The kernel is pure DSH: the plugin creates real
agents through the official `ctx.agents.create()` factory, drives turns with
`agent.followup()`, interrupts with `agent.cancel()`, and renders the streaming
`session/event` event flow. Tool calls, reasoning, session persistence,
compaction and agent presets all go through DSH's official services. The UI is
zero-dependency raw-ANSI terminal rendering (no React/Ink) — the whole plugin
lives in a single `index.ts`.

## Install

Prerequisite: the official `dsh` CLI (`npm install -g @deepseek-ai/dsh`).

```sh
git clone https://github.com/songqikong/dash.git
cd dash
npm install          # first time: installs typescript and other build deps
sh install.sh        # compiles src/*.ts → dist/, creates ~/.dsh/profiles/dash + ~/.local/bin/dash
dash                 # launch (equivalent to dsh --profile dash)
```

`DASH_PROVIDER` / `DASH_MODEL` environment variables override the default
model; LLM provider configuration is fully reused from `$DSH_HOME/settings.yaml`
(the same file the Web Models page writes) — no separate setup needed.

## One TUI, _official DSH end to end_

### 01 · Native terminal rendering, zero deps

The whole UI is raw ANSI: diff rendering redraws only changed rows, the kitty
keyboard protocol (CSI-u) gives per-key precision, SGR mouse support (wheel
scrolling, moving the selection in list overlays), alternate screen plus a
hidden hardware cursor. No React/Ink, no node_modules baggage — the plugin body
is one file and its only runtime dependencies are the official DSH packages.

### 02 · Full oh-my-pi-style editing

Multi-line input (kitty Shift+Enter / Ctrl+J), word/line movement and deletion,
kill-ring (Ctrl+Y / Alt+Y yank-pop), undo (Ctrl+-), char jump (Ctrl+] /
Ctrl+Alt+]), Ctrl+G external-editor round-trip, paste, `@` file completion
(recursive into directories). All keybindings come from oh-my-pi's action
table and can be remapped in `~/.dash/keybindings.yml`; `/hotkeys` shows the
active bindings.

### 03 · Streaming transcript

Markdown rendering (headings/lists/quotes/code highlighting/tables/links,
stream-safe — unclosed code blocks and tables degrade to plain paragraphs
instead of breaking the frame), streamed reasoning folding (Ctrl+T toggles),
tool cards (⛭/✓/✗ states, arg folding Ctrl+O, result summaries), message
metadata (time/duration/model), pinned prompt header plus a ↓N unread pill
while browsing history.

### 04 · Status-bar dashboard

omp-style status lines: **A** (above the input) shows `⬢ model · preset · ◉
thinking effort · in/out tokens`, **C** (below the input, the bottom row) shows
activity (spinner + ⛭ tool name / ⏵ model self-reported work / ✓ turn stats),
queue, status hints, and `/help`. Both rows sit on a theme background band with
balanced left/right segments — the right side carries the TPS sparkline, cache
hit %, session elapsed, the restored **context-window indicator** (usage/total
+ a 10-cell bar), and git branch / cwd / session title.

### 05 · Model role system

Four roles — default / smol / plan / task — with values supporting a
`provider/model:effort` suffix, persisted to `modelRoles` in
`~/.dash/config.yml`. Three-column picker (Alt+M, Tab moves columns · j/k
move · Enter drills down), Ctrl+P cycles the current role's model, Alt+P
swaps in a temporary model, Shift+Tab cycles thinking effort. The default
effort is configurable in the settings panel.

### 06 · Session workflow

`/resume` picker (sorted by mtime, parallel title loading, Enter restores with
event-log replay, `d` deletes dash-* sessions), `/rename`, `/new`,
persistence (`~/.dsh/sessions`), `autoResume` restores the most recent session
at startup. Double-Esc enters time-rewind: fork a seed session from the
session log, drop that message back into the editor, edit and resend
(omp's rewind semantics).

### 07 · Official agent preset modes

DSH's four official agent modes are directly available: **Standard** (full
featured), **PTC** (Code Mode SDK), **Minimal** (persistent bash +
str_replace_editor only), **Creative** (preset authoring). Switch via the
`/preset` picker or the «Session mode» settings item; blank sessions rebuild
immediately, sessions with history take effect after `/new`; the choice is
persisted as `preset.id`. Loading uses the official
`discoverPresets` / `mountPreset` in the agent factory's `setup` hook.

### 08 · omp-style settings panel

`/settings` is a full port of oh-my-pi's SettingsList interaction: four tabs
(appearance / model / interaction / session) with a grouped sidebar (two or
more groups split left/right, inactive groups dimmed), type-to-search fuzzy
search across tabs (Tab jumps to the next matching tab), Enter/Space cycles
values, a 3-line description area, change markers, Esc backs out of search
before closing. 12 real knobs (language, theme, color-blind mode, spinner
frames, default thinking effort, hide reasoning, advisor, double-Esc, queue
delivery, turn bell, quiet boot, autoResume) — all applied live and written to
`~/.dash/config.yml`.

### 08½ · Splash welcome screen

Before the session starts you get an omp-style welcome screen: a sharp-cornered
single column box (no rounded elements, everything centered) with a bold DASH
wordmark (ANSI Shadow art) + model/provider, then a Tips block (all hints live
inside the box), the current agent preset (**highlighted** — it also appears on
status line A above the input), and recent sessions (read live from
`~/.dsh/sessions` with relative times). It yields to the transcript once the
first message is sent.

### 09 · Agent Hub

Alt+A / `/hub` opens the subagent tree: indentation, label, mode,
running/inactive states, filtering; Enter shows details, `s` messages a
subagent (followup), `x` interrupts it (ancestor authorization).

### 10 · Advisor — second-model bystander

`/advisor on` enables it: after every turn the second model posts a short
comment on that turn (prefixed `advisor:`), visible in the main transcript.

### 11 · TTSR — time-travel streaming rules

Write regex → prompt pairs in `~/.dash/rules.yml`. When streaming output hits
a rule, DASH injects the prompt via `agent.steer()` and stamps a ⚠ card —
deduplicated per turn, correcting behavior without a context tax.

### 12 · DSH command registry + skills + project instructions

`/plan` `/goal` `/compact` etc. forward automatically to the DSH command
registry; `/skills` lists available skills; `/init` injects
AGENTS.md/CLAUDE.md as instructions; `/think` `/focus` inject
reasoning/focus steers. Optional turn-end bell (`notify.turnEnd`).

### 13 · Smart `/` command menu

Typing `/` at the prompt opens the command menu above the input. Type to
fuzzy-filter, ↑↓ to select. **Tab** completes the highlighted command (no
double slash), **Enter** runs the highlighted command directly. Commands with
arguments get zsh-style completion: type `/models ` then Tab and the provider
list appears; pick a provider, Tab again and its models show up. The same
works for `/lang <en|zh>`, `/theme <dark|light>`, `/role <name>`,
`/advisor <on|off>` and `/preset <id>` — Tab accepts a candidate and, when a
deeper level exists, keeps the menu open for the next argument.

## Keybindings (oh-my-pi conventions)

| Key | Behavior |
|---|---|
| `Enter` | Send (queues as a follow-up while streaming) |
| `Ctrl+Enter` / `Ctrl+Q` | Queue a follow-up message |
| `Esc` / `Ctrl+C` | Interrupt generation (idle: `Ctrl+C` quits, `Esc` asks for confirmation) |
| `Ctrl+P` / `Alt+P` | Cycle model |
| `Alt+M` | Model picker (j/k move · Tab switches column · Enter selects) |
| `Alt+R` | Resend last instruction |
| `Ctrl+R` / `↑` | Input history |
| `Ctrl+N` | New session (/new) |
| `Ctrl+T` | Toggle reasoning |
| `Ctrl+O` | Expand/fold tool args |
| `Ctrl+L` | Reset display |
| `PgUp/PgDn` · `Alt+↑/↓` | Scroll history / dequeue |
| `Mouse wheel` | Scroll history; move selection in list overlays (SGR mouse, auto-enabled) |
| `/` + `Tab` / `Enter` | Complete / run the highlighted command; Tab completes arguments |
| `/help /clear /models /new /exit /model <p>/<m> /status` | Slash commands |
| `/plan /goal /compact` etc. | Forwarded to the DSH command registry |

Full list in `FEATURES.md`; bindings are remappable in
`~/.dash/keybindings.yml`.

## Session control

- `/new` new session · `/resume` restore/replay/delete · `/rename <t>` rename · `/clear` clear screen
- `/preset` switch agent preset (standard/PTC/minimal/creative) · `/settings` settings panel
- `/model <p>/<m>` set model · `/role <name>` switch role · `/theme <dark|light>` switch theme
- `/lang <en|zh>` switch UI language (**English by default**)
- `/plan` plan-mode toggle · `/goal` `/compact` (DSH registry) · `/hub` agent hub
- `/advisor <on|off>` · `/skills` · `/init` · `/think` `/focus` · `/status` · `/hotkeys`

## Configuration

- **Default model**: `agent-default-model` in the profile's
  `cordis.patch.yml` (default `opencode-go / deepseek-v4-flash`; credentials
  come from `$DSH_HOME/.credentials.yaml`).
- **Startup overrides**: `DASH_PROVIDER` / `DASH_MODEL` environment variables.
- **User settings**: `~/.dash/config.yml` (language, theme, spinner, effort,
  advisor, preset, autoResume etc., written by the settings panel);
  `~/.dash/keybindings.yml` (keymap); `~/.dash/rules.yml` (TTSR stream rules).
  The UI language is English by default; switch with `/lang <en|zh>` or the
  «Language» item in the settings panel.
- **Permissions**: the terminal trusts the model —
  `danger-full-access` + `policy: never` (no approval dialogs; the terminal is
  the trust boundary). To tighten, edit the profile's `cordis.patch.yml`
  (the `defaultPreset` of the `permission` line must match the
  `sandbox-policy` / `approval` knobs or startup fails).

## Explicitly out of scope (they need oh-my-pi's private native stack, which DSH does not provide)

- 60+ provider ecosystem (DSH has its own provider registry)
- LSP (14 ops) / DAP (28 ops) tools (DSH has no such stack; read/grep/glob are
  covered by DSH tools)
- `/collab` relay (depends on the omp server)
- STT/voice `/live` (no audio backend)
- Image protocols (kitty/sixel image display), OSC 5522 clipboard images
- Native in-process ripgrep/brush (DSH ships equivalent tools)
- Session export/share dialogs, session tree panel (the terminal uses `/resume`)

## Development

Source lives in `src/` (TypeScript), compiled output in `dist/`.

```sh
npm install        # first time: typescript / @types (build deps)
npm run build      # compiles src/*.ts → dist/
sh install.sh      # recompiles and copies dist/ into ~/.dsh/profiles/dash/node_modules/dash-tui
dash               # launch (Ctrl+C to quit)
```

`sh install.sh --no-build` skips the compile and just copies. After editing
`src/*.ts`, rerun `sh install.sh` to apply. Runtime dependencies are only the
official DSH packages (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent`,
`@deepseek-ai/dsh-agent-presets`), resolved from the shared
`~/.dsh/profiles/node_modules` directory.

pty integration tests live in `tests/` (b1–b8: real chat round-trips plus
key-driven interaction):

```sh
cd tests && python3 b1.py   # each suite independently verifies editor/dialogs/commands/resume/settings/modes
```

## Repository layout

| Path | Purpose |
|---|---|
| `src/index.ts` | plugin body (agent lifecycle + event projection + rendering + input dispatch) |
| `src/keys.ts` | key parsing (kitty/CSI/legacy) + oh-my-pi action registry |
| `src/editor.ts` | multi-line draft editor (kill-ring/undo/char jump/external editor) |
| `src/markdown.ts` | stream-safe Markdown → ANSI renderer |
| `src/config.ts` | `~/.dash` config read/write (flat dotted keys, YAML persistence) |
| `src/dsh.d.ts` | ambient declarations for the official DSH API surface |
| `dist/` | tsc output (copied into the profile by install.sh) |
| `tests/` | b1–b8 pty regression tests |
| `cordis.patch.yml` | profile patch layer (model/permissions/sandbox) |

## License

MIT. See [LICENSE](LICENSE).

- [GitHub](https://github.com/songqikong/dash)
- [Home](https://songqikong.github.io/dash/)

_made for terminals that stay open_
