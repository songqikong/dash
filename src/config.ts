// DASH config: ~/.dash/config.yml (flat subset) + ~/.dash/keybindings.yml
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'

export const DASH_HOME: string = process.env.DASH_HOME || path.join(os.homedir(), '.dash')

export function ensureDir(): void {
  fs.mkdirSync(DASH_HOME, { recursive: true })
}

export function loadYaml(file: string): any {
  try {
    const s = fs.readFileSync(file, 'utf8')
    const v = yaml.load(s)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

/** Flat-dot key reader: get('theme.dark') */
export function getCfg(root: any, key: string, fallback?: any): any {
  let cur = root
  for (const k of String(key).split('.')) {
    if (cur == null || typeof cur !== 'object') return fallback
    cur = cur[k]
  }
  return cur === undefined ? fallback : cur
}

/** Write a flat-dot key back into a nested object and serialize as YAML. */
export function setCfg(root: any, key: string, value: any): void {
  const parts = String(key).split('.')
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

export const CONFIG_PATH: string = path.join(DASH_HOME, 'config.yml')
export const KEYBINDINGS_PATH: string = path.join(DASH_HOME, 'keybindings.yml')
export const RULES_PATH: string = path.join(DASH_HOME, 'rules.yml')

/** Official DSH user settings document ($DSH_HOME/settings.yaml, hot-reloaded by the host). */
export const DSH_SETTINGS_PATH: string = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'settings.yaml')

export function loadDshSettings(): any {
  return loadYaml(DSH_SETTINGS_PATH)
}

export function saveDshSettings(root: any): void {
  try {
    fs.mkdirSync(path.dirname(DSH_SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(DSH_SETTINGS_PATH, yaml.dump(root, { noRefs: true }))
  } catch (e) { /* ignore */ }
}

export function loadConfig(): any {
  ensureDir()
  return loadYaml(CONFIG_PATH)
}

export function saveConfig(root: any): void {
  ensureDir()
  fs.writeFileSync(CONFIG_PATH, yaml.dump(root, { noRefs: true }))
}

export function loadKeybindingsConfig(): any {
  ensureDir()
  return loadYaml(KEYBINDINGS_PATH)
}

/** One TTSR rule: regex pattern from ~/.dash/rules.yml, compiled at load. */
export interface TtsrRule {
  name: string
  re: RegExp
  message: string
}

/** TTSR rules: [{ name, pattern, message }] from ~/.dash/rules.yml */
export function loadRules(): TtsrRule[] {
  ensureDir()
  const raw = loadYaml(RULES_PATH)
  if (!Array.isArray(raw)) return []
  const rules: TtsrRule[] = []
  for (const r of raw) {
    if (r && typeof r === 'object' && typeof r.pattern === 'string' && typeof r.message === 'string') {
      try {
        rules.push({ name: String(r.name || r.pattern), re: new RegExp(r.pattern), message: r.message })
      } catch (e) { /* invalid regex skipped */ }
    }
  }
  return rules
}
