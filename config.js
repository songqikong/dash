// DASH config: ~/.dash/config.yml (flat subset) + ~/.dash/keybindings.yml
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'

export const DASH_HOME = process.env.DASH_HOME || path.join(os.homedir(), '.dash')

export function ensureDir() {
  fs.mkdirSync(DASH_HOME, { recursive: true })
}

export function loadYaml(file) {
  try {
    const s = fs.readFileSync(file, 'utf8')
    const v = yaml.load(s)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

/** Flat-dot key reader: get('theme.dark') */
export function getCfg(root, key, fallback) {
  let cur = root
  for (const k of String(key).split('.')) {
    if (cur == null || typeof cur !== 'object') return fallback
    cur = cur[k]
  }
  return cur === undefined ? fallback : cur
}

/** Write a flat-dot key back into a nested object and serialize as YAML. */
export function setCfg(root, key, value) {
  const parts = String(key).split('.')
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

export const CONFIG_PATH = path.join(DASH_HOME, 'config.yml')
export const KEYBINDINGS_PATH = path.join(DASH_HOME, 'keybindings.yml')
export const RULES_PATH = path.join(DASH_HOME, 'rules.yml')

export function loadConfig() {
  ensureDir()
  return loadYaml(CONFIG_PATH)
}

export function saveConfig(root) {
  ensureDir()
  fs.writeFileSync(CONFIG_PATH, yaml.dump(root, { noRefs: true }))
}

export function loadKeybindingsConfig() {
  ensureDir()
  return loadYaml(KEYBINDINGS_PATH)
}

/** TTSR rules: [{ name, pattern, message }] from ~/.dash/rules.yml */
export function loadRules() {
  ensureDir()
  const raw = loadYaml(RULES_PATH)
  if (!Array.isArray(raw)) return []
  const rules = []
  for (const r of raw) {
    if (r && typeof r === 'object' && typeof r.pattern === 'string' && typeof r.message === 'string') {
      try {
        rules.push({ name: String(r.name || r.pattern), re: new RegExp(r.pattern), message: r.message })
      } catch (e) { /* invalid regex skipped */ }
    }
  }
  return rules
}
