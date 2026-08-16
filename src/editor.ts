// DASH draft editor: multiline text buffer with oh-my-pi editor semantics
// (cursor movement, word ops, kill-ring, undo, jump-to-char, external editor).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { DASH_HOME } from './config.js'

function isWordChar(ch: string): boolean {
  return /[\w\u00C0-\uFFFF]/.test(ch)
}

interface UndoEntry {
  text: string
  cursor: number
}

export class Draft {
  text = ''
  cursor = 0 // UTF-16 index
  undoStack: UndoEntry[] = []
  killRing: string[] = []
  yankIndex = -1

  pushUndo(): void {
    this.undoStack.push({ text: this.text, cursor: this.cursor })
    if (this.undoStack.length > 300) this.undoStack.shift()
  }

  undo(): void {
    const s = this.undoStack.pop()
    if (s) {
      this.text = s.text
      this.cursor = s.cursor
    }
  }

  kill(text: string): void {
    if (text) this.killRing.push(text)
    this.yankIndex = -1
  }

  yank(): void {
    if (!this.killRing.length) return
    this.yankIndex = this.killRing.length - 1
    this.insert(this.killRing[this.yankIndex], true)
  }

  yankPop(): void {
    if (!this.killRing.length) return
    // rotate ring, then replace the last yanked region
    const last = this.killRing.pop()
    this.killRing.unshift(last!)
    this.yankIndex = 0
    const t = this.killRing[0]
    this.pushUndo()
    this.text = this.text.slice(0, this.cursor) + t + this.text.slice(this.cursor)
    this.cursor += t.length
  }

  insert(text: string, skipUndo = false): void {
    if (!text) return
    if (!skipUndo) this.pushUndo()
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor)
    this.cursor += text.length
  }

  // ── cursor movement ──
  moveLeft(): void { if (this.cursor > 0) this.cursor-- }
  moveRight(): void { if (this.cursor < this.text.length) this.cursor++ }

  lineIndexes(): { lines: string[]; starts: number[] } {
    const lines = this.text.split('\n')
    const starts: number[] = []
    let acc = 0
    for (const l of lines) {
      starts.push(acc)
      acc += l.length + 1
    }
    return { lines, starts }
  }

  rowCol(): { row: number; col: number } {
    const { lines, starts } = this.lineIndexes()
    let row = 0
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= this.cursor) row = i
      else break
    }
    return { row, col: this.cursor - starts[row] }
  }

  cursorTo(row: number, col: number): void {
    const { lines, starts } = this.lineIndexes()
    if (row < 0) row = 0
    if (row >= lines.length) row = lines.length - 1
    if (col < 0) col = 0
    if (col > lines[row].length) col = lines[row].length
    this.cursor = starts[row] + col
  }

  moveUp(): void {
    const { row, col } = this.rowCol()
    if (row > 0) this.cursorTo(row - 1, col)
  }

  moveDown(): void {
    const { row, col } = this.rowCol()
    const { lines } = this.lineIndexes()
    if (row < lines.length - 1) this.cursorTo(row + 1, col)
  }

  wordBoundaryLeft(): number {
    // skip spaces, then skip a word
    let i = this.cursor
    while (i > 0 && this.text[i - 1] === ' ') i--
    while (i > 0 && !this.text[i - 1].match(/\s/)) i--
    return i
  }

  wordBoundaryRight(): number {
    let i = this.cursor
    while (i < this.text.length && this.text[i] === ' ') i++
    while (i < this.text.length && !this.text[i].match(/\s/)) i++
    return i
  }

  moveWordLeft(): void { this.cursor = this.wordBoundaryLeft() }
  moveWordRight(): void { this.cursor = this.wordBoundaryRight() }

  lineStart(): void {
    const { starts } = this.lineIndexes()
    const { row } = this.rowCol()
    this.cursor = starts[row]
  }

  lineEnd(): void {
    const { lines, starts } = this.lineIndexes()
    const { row } = this.rowCol()
    this.cursor = starts[row] + lines[row].length
  }

  /** Jump to the nth occurrence of char after (dir=1) or before (dir=-1) cursor. */
  jumpToChar(ch: string, dir: number): void {
    if (!ch) return
    let i = this.cursor + dir
    let n = 0
    while (i >= 0 && i < this.text.length) {
      if (this.text[i] === ch) {
        n++
        if (n === 1) { this.cursor = i; return }
      }
      i += dir
    }
  }

  // ── editing ──
  delBack(): void {
    if (this.cursor <= 0) return
    this.pushUndo()
    const i = this.cursor - 1
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor)
    this.cursor = i
  }

  delFwd(): void {
    if (this.cursor >= this.text.length) return
    this.pushUndo()
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1)
  }

  delWordBack(): void {
    const i = this.wordBoundaryLeft()
    if (i === this.cursor) return
    this.pushUndo()
    this.kill(this.text.slice(i, this.cursor))
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor)
    this.cursor = i
  }

  delWordFwd(): void {
    const i = this.wordBoundaryRight()
    if (i === this.cursor) return
    this.pushUndo()
    this.kill(this.text.slice(this.cursor, i))
    this.text = this.text.slice(0, this.cursor) + this.text.slice(i)
  }

  delToLineStart(): void {
    const { starts } = this.lineIndexes()
    const { row } = this.rowCol()
    const i = starts[row]
    if (i === this.cursor) return
    this.pushUndo()
    this.kill(this.text.slice(i, this.cursor))
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor)
    this.cursor = i
  }

  delToLineEnd(): void {
    const { lines, starts } = this.lineIndexes()
    const { row } = this.rowCol()
    const end = starts[row] + lines[row].length
    if (end === this.cursor) return
    this.pushUndo()
    this.kill(this.text.slice(this.cursor, end))
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end)
  }

  replaceAll(text: string): void {
    this.pushUndo()
    this.text = text
    this.cursor = text.length
  }

  /** External editor ($EDITOR) round-trip on a temp file. Returns false on failure. */
  externalEdit(): boolean {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
    const file = path.join(DASH_HOME, 'edit-' + Date.now().toString(36) + '.txt')
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, this.text)
      const res = spawnSync(editor, [file], { stdio: 'inherit' })
      if (res.error || res.status !== 0) {
        try { fs.unlinkSync(file) } catch (e) { /* ignore */ }
        return false
      }
      const out = fs.readFileSync(file, 'utf8')
      fs.unlinkSync(file)
      this.replaceAll(out)
      return true
    } catch (e) {
      try { fs.unlinkSync(file) } catch (e2) { /* ignore */ }
      return false
    }
  }
}
