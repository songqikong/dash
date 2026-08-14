// DASH markdown renderer: block + inline markdown → ANSI lines with
// display-width wrapping. Streaming-safe: unterminated fences/tables degrade
// to plain paragraphs instead of corrupting the frame.

const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[38;5;245m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strike: '\x1b[9m',
  code: '\x1b[48;5;236;38;5;180m',
  link: '\x1b[4;38;5;81m',
  h1: '\x1b[38;5;78;1m',
  h2: '\x1b[38;5;121;1m',
  h3: '\x1b[38;5;121m',
  list: '\x1b[38;5;222m',
  quote: '\x1b[38;5;245;3m',
  hr: '\x1b[38;5;236m',
  th: '\x1b[1;38;5;81m',
  kw: '\x1b[38;5;141m',
  str: '\x1b[38;5;179m',
  num: '\x1b[38;5;150m',
  com: '\x1b[38;5;245;3m',
  reset: '\x1b[0m',
}
const RESET = ANSI.reset

function charWidth(ch) {
  const c = ch.codePointAt(0)
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) return 2
  return 1
}
export function strWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

// ── inline ────────────────────────────────────────────────────────────────
const INLINE = /(`[^`]*`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\n]*\))/g

function inlineSegments(text) {
  const segs = []
  let last = 0
  let m
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index), s: null })
    if (m[1]) segs.push({ t: m[1].slice(1, -1), s: 'code' })
    else if (m[2]) segs.push({ t: m[2].slice(2, -2), s: 'bold' })
    else if (m[3]) segs.push({ t: m[3].slice(1, -1), s: 'italic' })
    else if (m[4]) segs.push({ t: m[4].slice(2, -2), s: 'strike' })
    else if (m[5]) {
      const open = m[5].indexOf('](')
      segs.push({ t: m[5].slice(1, open), s: 'link' })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ t: text.slice(last), s: null })
  return segs
}

// ── code highlighting (lightweight, common languages) ─────────────────────
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'class',
  'import', 'export', 'from', 'def', 'async', 'await', 'try', 'catch', 'finally',
  'new', 'this', 'null', 'undefined', 'true', 'false', 'None', 'True', 'False',
  'and', 'or', 'not', 'in', 'is', 'lambda', 'yield', 'with', 'as', 'raise',
  'echo', 'then', 'do', 'done', 'fi', 'case', 'esac', 'printf', 'elif', 'select',
])
const COMMENT = /^(\s*)(\/\/|#|--|;).*$/
const STRING = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/
const NUMBER = /^\d[\d_]*\.?\d*[a-zA-Z]*/

function highlightCodeLine(line) {
  const segs = []
  let i = 0
  const mC = line.match(COMMENT)
  if (mC) {
    segs.push({ t: line, s: 'com' })
    return segs
  }
  while (i < line.length) {
    const rest = line.slice(i)
    const mS = rest.match(STRING)
    if (mS) { segs.push({ t: mS[1], s: 'str' }); i += mS[1].length; continue }
    const mN = rest.match(NUMBER)
    if (mN) { segs.push({ t: mN[0], s: 'num' }); i += mN[0].length; continue }
    const mW = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (mW) {
      segs.push(KEYWORDS.has(mW[0]) ? { t: mW[0], s: 'kw' } : { t: mW[0], s: null })
      i += mW[0].length
      continue
    }
    segs.push({ t: rest[0], s: null })
    i += 1
  }
  return segs
}

// ── segment wrapping ──────────────────────────────────────────────────────
function wrapSegments(segs, width, prefix = '') {
  const lines = []
  let cur = ''
  let curW = strWidth(prefix)
  const push = (line) => lines.push(line)
  const flushLine = () => {
    if (cur.length || !lines.length) {
      push(cur)
      cur = ''
      curW = strWidth(prefix)
    }
  }
  let first = true
  const emit = (text, style) => {
    if (!text) return
    let seg = text
    while (seg.length) {
      const w = charWidth(seg[0])
      if (curW + w > width && cur.length) {
        flushLine()
        cur = prefix // continuation indent
        curW = strWidth(prefix)
        first = false
      }
      const ch = seg[0]
      cur += (style ? ANSI[style] : '') + ch + (style ? RESET : '')
      curW += w
      seg = seg.slice(1)
    }
  }
  for (const s of segs) emit(s.t, s.s)
  flushLine()
  if (first && prefix) lines[0] = prefix + lines[0]
  return lines
}

// ── blocks ────────────────────────────────────────────────────────────────
function splitBlocks(src) {
  const lines = src.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // fence
    const fm = line.match(/^\s*```\s*([\w+-]*)\s*$/)
    if (fm) {
      const lang = fm[1]
      const body = []
      i++
      let closed = false
      while (i < lines.length) {
        if (/^\s*```\s*$/.test(lines[i])) { closed = true; i++; break }
        body.push(lines[i])
        i++
      }
      blocks.push({ kind: 'code', lang, body, closed })
      continue
    }
    // table: current line has | and next is separator
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = []
      while (i < lines.length && lines[i].includes('|')) {
        if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i]) && rows.length) break
        rows.push(lines[i])
        i++
      }
      blocks.push({ kind: 'table', rows })
      continue
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', level: (line.match(/^#{1,6}/) || [''])[0].length, text: line.replace(/^#{1,6}\s*/, '') })
      i++
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1+\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    const lm = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
    if (lm && !/^\s*[-*_]\s*$/.test(line)) {
      const items = []
      while (i < lines.length) {
        const m2 = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
        if (m2) { items.push({ marker: m2[1], text: m2[2] }); i++ }
        else if (/^\s*$/.test(lines[i])) { i++; break }
        else { items.push({ marker: '', text: lines[i] }); i++ }
      }
      blocks.push({ kind: 'list', items })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', body })
      continue
    }
    // paragraph
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*```/.test(lines[i])) {
      if (/^\s{0,3}#{1,6}\s/.test(lines[i])) break
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) break
      para.push(lines[i])
      i++
    }
    if (para.length) { blocks.push({ kind: 'para', lines: para }); continue }
    i++
  }
  return blocks
}

// ── render ────────────────────────────────────────────────────────────────
export function renderMarkdown(src, width) {
  const out = []
  const blocks = splitBlocks(src)
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const style = b.level <= 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3'
      const prefix = '#'.repeat(Math.min(b.level, 3)) + ' '
      const lines = wrapSegments([{ t: b.text, s: style }], width)
      lines.forEach((ln, i) => out.push((i === 0 ? ANSI[style] + prefix + RESET : '') + ln))
    } else if (b.kind === 'hr') {
      out.push(ANSI.hr + '─'.repeat(Math.max(4, width - 4)) + RESET)
    } else if (b.kind === 'list') {
      for (const it of b.items) {
        const marker = it.marker ? (it.marker === '-' || it.marker === '*' || it.marker === '+' ? '•' : it.marker) : ' '
        const segs = [{ t: marker + ' ', s: 'list' }].concat(inlineSegments(it.text))
        wrapSegments(segs, width, '  ').forEach((ln) => out.push(ln))
      }
    } else if (b.kind === 'quote') {
      for (const ql of b.body) {
        const segs = [{ t: '▍ ', s: 'quote' }].concat(inlineSegments(ql))
        wrapSegments(segs, width, '  ').forEach((ln) => out.push(ln))
      }
    } else if (b.kind === 'para') {
      const segs = []
      b.lines.forEach((ln, i) => {
        if (i) segs.push({ t: ' ', s: null })
        segs.push(...inlineSegments(ln))
      })
      wrapSegments(segs, width).forEach((ln) => out.push(ln))
    } else if (b.kind === 'code') {
      if (b.closed) {
        const segs = b.body.map((l, i) => ({ t: (i ? '\n' : '') + l, s: 'code' }))
        // wrap per line to keep the bg shade per line
        for (const l of b.body) {
          const hl = highlightCodeLine(l)
          const wrapped = wrapSegments(hl, width - 2, '  ')
          wrapped.forEach((ln) => out.push(ANSI.code + ln + RESET))
        }
      } else {
        // streaming: unclosed fence → plain paragraph
        const segs = []
        b.body.forEach((l, i) => {
          if (i) segs.push({ t: ' ', s: null })
          segs.push(...inlineSegments(l))
        })
        wrapSegments(segs, width).forEach((ln) => out.push(ln))
      }
    } else if (b.kind === 'table') {
      const cells = b.rows.map((r) => r.split('|').map((c) => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '')))
      if (cells.length < 2) {
        // streaming: no separator yet → plain
        const segs = []
        b.rows.forEach((l, i) => {
          if (i) segs.push({ t: ' ', s: null })
          segs.push(...inlineSegments(l))
        })
        wrapSegments(segs, width).forEach((ln) => out.push(ln))
        continue
      }
      const ncol = Math.max(...cells.map((r) => r.length))
      const colW = []
      for (let c = 0; c < ncol; c++) {
        let w = 0
        for (const r of cells) if (r[c]) w = Math.max(w, strWidth(r[c]))
        colW.push(Math.min(w + 2, Math.max(3, Math.floor(width / ncol))))
      }
      const total = colW.reduce((a, b) => a + b, 0) + ncol + 1
      const sepLine = ANSI.hr + '+' + colW.map((w) => '─'.repeat(w)).join('+') + '+' + RESET
      const renderRow = (row, style) => {
        let line = ''
        for (let c = 0; c < ncol; c++) {
          const cell = (row[c] || '').padEnd ? row[c] : ''
          const pad = Math.max(0, colW[c] - strWidth(cell))
          line += '| ' + (style ? ANSI[style] : '') + cell + ' '.repeat(pad) + (style ? RESET : '') + ' '
        }
        line += '|'
        return line
      }
      const headerSep = cells[1] || []
      cells[0] && out.push(renderRow(cells[0], 'th'))
      out.push(sepLine)
      for (let r = 2; r < cells.length; r++) out.push(renderRow(cells[r], null))
    }
  }
  return out
}
