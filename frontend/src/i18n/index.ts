import { useSyncExternalStore } from 'react'
import { en } from './en'
import { fr, Key } from './fr'

// Home-made translation (no dependency): fr.ts is the reference and the fallback, en.ts the same keys.
// To add a text: a key in fr.ts and en.ts, then t('key', { param }) in the component (see doc/GUIDE_CODE.md).
export type Lang = 'fr' | 'en'
export type { Key }
export const LANGS: { id: Lang; label: string; locale: string }[] = [
  { id: 'fr', label: 'Français', locale: 'fr-FR' },
  { id: 'en', label: 'English', locale: 'en-GB' },
]
const STORE_KEY = 'pss-lang'
const tables: Record<Lang, Partial<Record<Key, string>>> = { fr, en }

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved === 'fr' || saved === 'en') return saved
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language || '') ? 'en' : 'fr'
}

let current: Lang = initialLang()
const listeners = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = current

export const getLang = (): Lang => current
export function setLang(l: Lang) {
  if (l === current) return
  current = l
  try {
    localStorage.setItem(STORE_KEY, l)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l
  listeners.forEach((f) => f())
}

// Re-renders the component when the language changes; returns it
export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    getLang,
  )
}

// Locale of the dates and numbers
export const locale = (): string => LANGS.find((l) => l.id === current)!.locale

export type Params = Record<string, string | number>
const fill = (s: string, p?: Params) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s)

export function t(key: Key, params?: Params): string {
  return fill(tables[current][key] ?? fr[key] ?? key, params)
}

// Plural: keys "<base>.one" and "<base>.many"; {n} is the count
export type PluralBase = Key extends infer K ? (K extends `${infer B}.one` ? B : never) : never
export function tp(base: PluralBase, n: number, params?: Params): string {
  const one = current === 'fr' ? n < 2 : n === 1
  return t(`${base}.${one ? 'one' : 'many'}` as Key, { n, ...params })
}
