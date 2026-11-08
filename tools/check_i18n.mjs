#!/usr/bin/env node
// Flags French texts left in frontend/src outside i18n/: any line with a French accented letter once comments are
// removed. Texts go through t() (frontend/src/i18n/fr.ts + en.ts); see doc/GUIDE_CODE.md « Langues de l'interface ».
// Exceptions: proper names that stay as they are (add to ALLOWED, keep the list short).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'frontend', 'src')
const ACCENT = /[àâäçéèêëîïôöùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ]/
const ALLOWED = ['Géoplateforme'] // IGN service name (map attribution)

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) {
      if (f !== 'i18n') yield* files(p)
    } else if (/\.(ts|tsx)$/.test(f)) yield p
  }
}

let bad = 0
for (const file of files(ROOT)) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/(^|\s)\/\/.*$/, '$1')
    let l = code
    for (const a of ALLOWED) l = l.split(a).join('')
    if (ACCENT.test(l)) {
      bad++
      console.log(`${relative(join(ROOT, '..', '..'), file)}:${i + 1}: ${code.trim().slice(0, 110)}`)
    }
  })
}
if (bad) {
  console.log(`${bad} ligne(s) avec du texte français hors i18n/ (utiliser t())`)
  process.exit(1)
}
console.log('i18n : aucun texte français hors i18n/')
