// DASH key handling: raw-byte parser (kitty keyboard protocol, CSI, legacy)
// plus the oh-my-pi action registry (defaults from omp keybindings.ts,
// remappable through ~/.dash/keybindings.yml).

// ---- action registry (omp TUI + app keybindings) ----
export const ACTIONS = {
  // editor
  'tui.editor.cursorUp': { desc: 'Move cursor up' },
  'tui.editor.cursorDown': { desc: 'Move cursor down' },
  'tui.editor.cursorLeft': { desc: 'Move cursor left' },
  'tui.editor.cursorRight': { desc: 'Move cursor right' },
  'tui.editor.cursorWordLeft': { desc: 'Move cursor word left' },
  'tui.editor.cursorWordRight': { desc: 'Move cursor word right' },
  'tui.editor.cursorLineStart': { desc: 'Move to line start' },
  'tui.editor.cursorLineEnd': { desc: 'Move to line end' },
  'tui.editor.jumpForward': { desc: 'Jump forward to character' },
  'tui.editor.jumpBackward': { desc: 'Jump backward to character' },
  'tui.editor.pageUp': { desc: 'Page up' },
  'tui.editor.pageDown': { desc: 'Page down' },
  'tui.editor.deleteCharBackward': { desc: 'Delete character backward' },
  'tui.editor.deleteCharForward': { desc: 'Delete character forward' },
  'tui.editor.deleteWordBackward': { desc: 'Delete word backward' },
  'tui.editor.deleteWordForward': { desc: 'Delete word forward' },
  'tui.editor.deleteToLineStart': { desc: 'Delete to line start' },
  'tui.editor.deleteToLineEnd': { desc: 'Delete to line end' },
  'tui.editor.yank': { desc: 'Yank' },
  'tui.editor.yankPop': { desc: 'Yank pop' },
  'tui.editor.undo': { desc: 'Undo' },
  // input
  'tui.input.newLine': { desc: 'Insert newline' },
  'tui.input.submit': { desc: 'Submit input' },
  'tui.input.tab': { desc: 'Tab / autocomplete' },
  'tui.input.copy': { desc: 'Copy selection' },
  // select
  'tui.select.up': { desc: 'Move selection up' },
  'tui.select.down': { desc: 'Move selection down' },
  'tui.select.pageUp': { desc: 'Selection page up' },
  'tui.select.pageDown': { desc: 'Selection page down' },
  'tui.select.confirm': { desc: 'Confirm selection' },
  'tui.select.cancel': { desc: 'Cancel selection' },
  // app
  'app.interrupt': { desc: 'Interrupt current operation' },
  'app.clear': { desc: 'Clear screen or cancel' },
  'app.exit': { desc: 'Exit application' },
  'app.suspend': { desc: 'Suspend application' },
  'app.display.reset': { desc: 'Reset terminal display' },
  'app.thinking.cycle': { desc: 'Cycle thinking level' },
  'app.thinking.toggle': { desc: 'Toggle thinking mode' },
  'app.model.cycleForward': { desc: 'Cycle to next model' },
  'app.model.cycleBackward': { desc: 'Cycle to previous model' },
  'app.model.select': { desc: 'Select model' },
  'app.model.selectTemporary': { desc: 'Select temporary model for current session' },
  'app.tools.expand': { desc: 'Expand tools' },
  'app.tools.toggleVisibility': { desc: 'Show or hide tool activity' },
  'app.editor.external': { desc: 'Open external editor' },
  'app.message.followUp': { desc: 'Send follow-up message' },
  'app.retry': { desc: 'Retry last failed assistant turn' },
  'app.message.dequeue': { desc: 'Dequeue message' },
  'app.clipboard.pasteTextRaw': { desc: 'Paste text from clipboard as raw text' },
  'app.clipboard.copyLine': { desc: 'Copy current line' },
  'app.clipboard.copyPrompt': { desc: 'Copy prompt' },
  'app.agents.hub': { desc: 'Open the agent hub' },
  'app.plan.toggle': { desc: 'Toggle plan mode' },
  'app.history.search': { desc: 'Search history' },
  'app.session.observe': { desc: 'Observe sessions' },
}

// omp defaults: action -> default keys
export const DEFAULT_ACTION_KEYS = {
  'tui.editor.cursorUp': ['up'],
  'tui.editor.cursorDown': ['down'],
  'tui.editor.cursorLeft': ['left', 'ctrl+b'],
  'tui.editor.cursorRight': ['right', 'ctrl+f'],
  'tui.editor.cursorWordLeft': ['alt+left', 'ctrl+left', 'alt+b'],
  'tui.editor.cursorWordRight': ['alt+right', 'ctrl+right', 'alt+f'],
  'tui.editor.cursorLineStart': ['home', 'ctrl+a'],
  'tui.editor.cursorLineEnd': ['end', 'ctrl+e'],
  'tui.editor.jumpForward': ['ctrl+]'],
  'tui.editor.jumpBackward': ['ctrl+alt+]'],
  'tui.editor.pageUp': ['pageup'],
  'tui.editor.pageDown': ['pagedown'],
  'tui.editor.deleteCharBackward': ['backspace'],
  'tui.editor.deleteCharForward': ['delete', 'ctrl+d'],
  'tui.editor.deleteWordBackward': ['ctrl+w', 'alt+backspace', 'ctrl+backspace', 'super+alt+backspace'],
  'tui.editor.deleteWordForward': ['alt+delete', 'alt+d', 'super+alt+delete', 'super+alt+d'],
  'tui.editor.deleteToLineStart': ['ctrl+u'],
  'tui.editor.deleteToLineEnd': ['ctrl+k'],
  'tui.editor.yank': ['ctrl+y'],
  'tui.editor.yankPop': ['alt+y'],
  'tui.editor.undo': ['ctrl+-', 'ctrl+_'],
  'tui.input.newLine': ['shift+enter', 'ctrl+j'],
  'tui.input.submit': ['enter'],
  'tui.input.tab': ['tab'],
  'tui.input.copy': ['ctrl+c'],
  'tui.select.up': ['up'],
  'tui.select.down': ['down'],
  'tui.select.pageUp': ['pageup'],
  'tui.select.pageDown': ['pagedown'],
  'tui.select.confirm': ['enter'],
  'tui.select.cancel': ['escape', 'ctrl+c'],
  'app.interrupt': ['escape'],
  'app.clear': ['ctrl+c'],
  'app.exit': ['ctrl+d'],
  'app.suspend': ['ctrl+z'],
  'app.display.reset': ['alt+l'],
  'app.thinking.cycle': ['shift+tab'],
  'app.thinking.toggle': ['ctrl+t'],
  'app.model.cycleForward': ['ctrl+p'],
  'app.model.cycleBackward': ['shift+ctrl+p'],
  'app.model.select': ['alt+m'],
  'app.model.selectTemporary': ['alt+p'],
  'app.tools.expand': ['ctrl+o'],
  'app.tools.toggleVisibility': ['ctrl+shift+o'],
  'app.editor.external': ['ctrl+g'],
  'app.message.followUp': ['ctrl+q', 'ctrl+enter'],
  'app.retry': ['alt+r'],
  'app.message.dequeue': ['alt+up', 'shift+up'],
  'app.clipboard.pasteTextRaw': ['ctrl+shift+v', 'alt+shift+v'],
  'app.clipboard.copyLine': ['alt+shift+l'],
  'app.clipboard.copyPrompt': ['alt+shift+c'],
  'app.agents.hub': ['alt+a'],
  'app.plan.toggle': ['alt+shift+p'],
  'app.history.search': ['ctrl+r'],
  'app.session.observe': ['ctrl+s'],
}

/** Build key -> [actions] map; remap from ~/.dash/keybindings.yml wins. */
export function buildKeyMap(remap = {}) {
  const actionKeys = {}
  for (const [action, keys] of Object.entries(DEFAULT_ACTION_KEYS)) {
    actionKeys[action] = keys.slice()
  }
  for (const [action, val] of Object.entries(remap)) {
    if (!(action in ACTIONS)) continue
    if (val === undefined || val === null) continue
    const keys = Array.isArray(val) ? val.filter((k) => typeof k === 'string') : [val]
    actionKeys[action] = keys // empty array disables
  }
  const map = new Map()
  for (const [action, keys] of Object.entries(actionKeys)) {
    for (const k of keys) {
      const norm = String(k).toLowerCase().replace(/^super[+]/, 'meta+')
      if (!map.has(norm)) map.set(norm, [])
      map.get(norm).push(action)
    }
  }
  return map
}

/** Normalized key id for an event, e.g. 'shift+ctrl+p', 'alt+m', 'enter'. */
export function keyId(ev) {
  const mods = []
  if (ev.ctrl) mods.push('ctrl')
  if (ev.alt) mods.push('alt')
  if (ev.shift) mods.push('shift')
  if (ev.meta) mods.push('meta')
  const base = ev.char !== null ? ev.char.toLowerCase() : ev.key
  return mods.length ? mods.join('+') + '+' + base : base
}

const CTRL_CHARS = {
  '\x01': 'a', '\x02': 'b', '\x03': 'c', '\x04': 'd', '\x05': 'e', '\x06': 'f',
  '\x07': 'g', '\x08': 'h', '\x09': 'tab', '\x0a': 'j', '\x0b': 'k', '\x0c': 'l',
  '\x0d': 'enter', '\x0e': 'n', '\x0f': 'o', '\x10': 'p', '\x11': 'q', '\x12': 'r',
  '\x13': 's', '\x14': 't', '\x15': 'u', '\x16': 'v', '\x17': 'w', '\x18': 'x',
  '\x19': 'y', '\x1a': 'z', '\x1b': 'escape',
}

// kitty functional key codes (CSI <code>; <mods>; <text> u)
const KITTY_FUNC = {
  57358: 'home', 57359: 'end', 57360: 'insert', 57361: 'delete',
  57362: 'pageup', 57363: 'pagedown', 57364: 'left', 57365: 'right',
  57366: 'up', 57367: 'down', 13: 'enter', 9: 'tab', 27: 'escape', 127: 'backspace',
}
const MODS = { 2: 'shift', 3: 'alt', 4: 'alt shift', 5: 'ctrl', 6: 'ctrl shift', 7: 'ctrl alt', 8: 'ctrl alt shift' }

function modsOf(n) {
  const m = MODS[Number(n)]
  return m ? m.split(' ') : []
}

export class KeyParser {
  constructor() {
    this.buf = ''
  }
  feed(chunk) {
    this.buf += chunk
  }
  get partialEscape() {
    return this.buf === '\x1b' || (this.buf.startsWith('\x1b[') && this.buf.length < 4)
  }
  dropPartial() {
    if (this.buf === '\x1b') this.buf = ''
    else if (this.buf.startsWith('\x1b[') && this.buf.length < 4) this.buf = ''
  }
  /** Extract as many events as possible; leaves partial sequences in buf. */
  poll() {
    const events = []
    for (;;) {
      const ev = this.next()
      if (!ev) break
      events.push(ev)
    }
    return events
  }
  next() {
    const b = this.buf
    if (!b.length) return null
    const ch = b[0]
    if (ch === '\x1b') {
      if (b.length < 2) return null
      const c2 = b[1]
      if (c2 === '[') {
        // CSI ... final
        const m = b.match(/^\x1b\[([0-9;:]*)([A-Za-z~])/)
        if (!m) {
          // bracketed paste
          if (b.startsWith('\x1b[200~')) {
            this.buf = b.slice(6)
            return { key: 'paste-start', char: null, ctrl: false, alt: false, shift: false, meta: false }
          }
          if (b.startsWith('\x1b[201~')) {
            this.buf = b.slice(6)
            return { key: 'paste-end', char: null, ctrl: false, alt: false, shift: false, meta: false }
          }
          if (b.startsWith('\x1b[>')) {
            // kitty capability response: CSI > flags u
            const m2 = b.match(/^\x1b\[>([0-9;]*)([A-Za-z~])/)
            if (m2) {
              this.buf = b.slice(m2[0].length)
              if (m2[2] === 'u') return { key: 'kitty-response', char: null, ctrl: false, alt: false, shift: false, meta: false, flags: m2[1] }
              return null
            }
            if (b.length < 8) return null
            this.buf = b.slice(1)
            return null
          }
          if (b.length < 4) return null
          this.buf = b.slice(1)
          return null
        }
        this.buf = b.slice(m[0].length)
        return this.csiEvent(m[1], m[2])
      }
      if (c2 === 'O') {
        if (b.length < 3) return null
        const c3 = b[2]
        this.buf = b.slice(3)
        const names = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }
        return { key: names[c3] || 'unknown', char: null, ctrl: false, alt: false, shift: false, meta: false }
      }
      if (c2 === '\x1b') {
        // Esc Esc (or Alt+Esc): two consecutive escape events
        this.buf = b.slice(2)
        return { key: 'escape', char: null, ctrl: false, alt: false, shift: false, meta: false }
      }
      if (b.length < 3) return null
      const c3 = b[2]
      this.buf = b.slice(2)
      return { key: null, char: c3, ctrl: false, alt: true, shift: false, meta: false }
    }
    if (ch === '\r') {
      this.buf = b.slice(1)
      return { key: 'enter', char: null, ctrl: false, alt: false, shift: false, meta: false }
    }
    if (ch === '\n') {
      this.buf = b.slice(1)
      return { key: 'newline', char: null, ctrl: false, alt: false, shift: false, meta: false }
    }
    this.buf = b.slice(1)
    if (ch === '\x7f') {
      return { key: 'backspace', char: null, ctrl: false, alt: false, shift: false, meta: false }
    }
    if (ch === '\t') {
      return { key: 'tab', char: null, ctrl: false, alt: false, shift: false, meta: false }
    }
    const code = ch.charCodeAt(0)
    if (code < 32) {
      const name = CTRL_CHARS[ch]
      if (name === 'tab' || name === 'enter' || name === 'escape') {
        return { key: name, char: null, ctrl: false, alt: false, shift: false, meta: false }
      }
      return { key: null, char: name, ctrl: true, alt: false, shift: false, meta: false }
    }
    let i = 1
    while (i < this.buf.length) {
      const cc = this.buf.charCodeAt(i)
      if (cc < 32 || cc === 0x7f || cc === 0x1b || cc === 0x0d || cc === 0x0a) break
      i++
    }
    const text = ch + this.buf.slice(0, i)
    this.buf = this.buf.slice(i)
    return { key: null, char: text, ctrl: false, alt: false, shift: false, meta: false }
  }
  csiEvent(param, final) {
    // kitty CSI-u: <code>; <mods>; <text> u
    if (final === 'u') {
      const parts = param.split(';')
      const code = Number(parts[0])
      const mods = modsOf(parts[1] || '1')
      let char = null
      let key = null
      if (parts[2]) {
        try {
          const text = JSON.parse('"' + parts[2].replace(/"/g, '\\"') + '"')
          if (text) char = text
        } catch (e) { /* ignore */ }
      }
      if (char === null) {
        if (KITTY_FUNC[code]) key = KITTY_FUNC[code]
        else if (code >= 1 && code <= 26) char = String.fromCharCode(96 + code)
        else if (code >= 32) char = String.fromCharCode(code)
        else key = 'unknown'
      }
      return {
        key,
        char,
        ctrl: mods.includes('ctrl'),
        alt: mods.includes('alt'),
        shift: mods.includes('shift'),
        meta: false,
      }
    }
    // legacy CSI
    const parts = param.split(';')
    const mods = modsOf(parts[1] || '1')
    const base = parts[0]
    if (final === 'A') return this.keyEvent('up', mods)
    if (final === 'B') return this.keyEvent('down', mods)
    if (final === 'C') return this.keyEvent('right', mods)
    if (final === 'D') return this.keyEvent('left', mods)
    if (final === 'H') return this.keyEvent('home', mods)
    if (final === 'F') return this.keyEvent('end', mods)
    if (final === 'Z') return this.keyEvent('tab', [...mods, 'shift'])
    if (final === '~') {
      if (base === '3') return this.keyEvent('delete', mods)
      if (base === '5') return this.keyEvent('pageup', mods)
      if (base === '6') return this.keyEvent('pagedown', mods)
      if (base === '2') return this.keyEvent('insert', mods)
    }
    if (final >= 'A' && final <= 'Z') {
      return { key: 'unknown', char: null, ctrl: false, alt: false, shift: false, meta: false }
    }
    return null
  }
  keyEvent(name, mods) {
    return {
      key: name,
      char: null,
      ctrl: mods.includes('ctrl'),
      alt: mods.includes('alt'),
      shift: mods.includes('shift'),
      meta: mods.includes('meta'),
    }
  }
}

/** Push the kitty keyboard protocol; returns the request string. */
export function kittyPushRequest() {
  return '\x1b[>1;2;3;4;5;6;7u'
}
