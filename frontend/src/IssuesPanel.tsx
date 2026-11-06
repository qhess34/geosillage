import { useEffect } from 'react'
import { useDraggable } from './useDraggable'

// Kinds of things to fix, and the step of the step bar they belong to
export type IssueKind = 'stop' | 'spacing' | 'gps_dop' | 'heading' | 'jump' | 'missing' | 'unclassified'
export type IssueStep = 'dups' | 'gps' | 'seq'

export interface Issue {
  kind: IssueKind
  start: number
  end: number
  label: string
  detail: string
}

export const STEP_KINDS: Record<IssueStep, IssueKind[]> = {
  dups: ['stop'],
  gps: ['missing', 'jump', 'spacing', 'gps_dop', 'heading'],
  seq: ['unclassified'],
}
const STEP_TITLES: Record<IssueStep, string> = {
  dups: 'Doublons et arrêts',
  gps: 'Correction GPS',
  seq: 'Séquences',
}

// What each problem is, why it happens and how to fix it (the list; the card of the Photo tab gives the details
// of the photo reached)
export const KIND_INFO: Record<IssueKind, { title: string; cause: string; fix: string }> = {
  stop: {
    title: 'Arrêts',
    cause: 'plusieurs photos prises au même endroit (feu rouge, pause).',
    fix: 'comparer les photos, garder la ou les meilleures (pas forcément la première), exclure les autres.',
  },
  missing: {
    title: 'Photos sans position',
    cause: 'le GPS n\'avait pas de position (perte du signal, tunnel, début de sortie).',
    fix: 'interpoler entre les photos voisines, ou placer à la main (M puis clic sur la carte), ou exclure.',
  },
  jump: {
    title: 'Sauts GPS',
    cause: 'position incohérente avec les photos voisines (déplacement impossible en si peu de temps).',
    fix: 'glisser la photo au bon endroit (M), sinon elle est exclue de l\'export.',
  },
  spacing: {
    title: 'Grands écarts',
    cause: 'plus de 25 m entre deux photos qui se suivent : position fausse, photos manquantes ou vitesse élevée.',
    fix: 'vérifier sur la vue satellite et corriger la position si l\'une des deux est fausse.',
  },
  gps_dop: {
    title: 'Précision GPS faible',
    cause: 'la caméra indique une position peu précise (DOP > 5).',
    fix: 'comparer avec la vue satellite et corriger la position si elle est décalée.',
  },
  heading: {
    title: 'Caps à vérifier',
    cause: 'cap saisi à la main très différent du cap calculé depuis la trace.',
    fix: 'revenir au cap calculé si c\'est une erreur de saisie.',
  },
  unclassified: {
    title: 'Photos non classées',
    cause: 'photos ni dans une séquence, ni exclues.',
    fix: 'créer une séquence avec elles (D / F, ou depuis l\'encadré), ou les exclure (X).',
  },
}

// Floating window (moved by its title bar) listing what is left to fix for a step, grouped by kind with the cause
// and the fix. A click on an item goes to its photo: map centred on it, photo loaded in the Photo tab with the card
// explaining it. The window stays open while correcting.
export default function IssuesPanel({
  step,
  issues,
  current,
  duplicates,
  onPick,
  onInterpolateAll,
  onClose,
}: {
  step: IssueStep
  issues: Issue[]
  current: Issue | null // the item being corrected (highlighted)
  duplicates: number // identical files set aside on import (nothing to do)
  onPick: (i: Issue) => void
  onInterpolateAll?: () => void
  onClose: () => void
}) {
  const { box, style, handlers } = useDraggable<HTMLDivElement>()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, select')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const kinds = STEP_KINDS[step].filter((k) => issues.some((i) => i.kind === k))
  const where = (i: Issue) => (i.end > i.start ? `Photos ${i.start + 1} → ${i.end + 1}` : `Photo ${i.start + 1}`)
  return (
    <div className="snap-panel snap-modal issues-modal small-text" ref={box} role="dialog" aria-label={`À corriger : ${STEP_TITLES[step]}`} style={style}>
      <div className="row between snap-title" title="Faire glisser pour déplacer la fenêtre" {...handlers}>
        <h3>
          À corriger : {STEP_TITLES[step]} ({issues.length})
        </h3>
        <button className="small" onClick={onClose} aria-label="Fermer">
          ✕
        </button>
      </div>
      {step === 'dups' && duplicates > 0 && (
        <p className="muted">
          {duplicates} doublon(s) (fichiers identiques) écarté(s) automatiquement à l'import : rien à faire.
        </p>
      )}
      {issues.length === 0 && <p className="muted">Rien à corriger pour cette étape.</p>}
      {kinds.map((k) => {
        const list = issues.filter((i) => i.kind === k)
        return (
          <section key={k} className="issues-group">
            <h4>
              {KIND_INFO[k].title} ({list.length})
            </h4>
            <p className="muted">
              <strong>Cause :</strong> {KIND_INFO[k].cause} <strong>Correction :</strong> {KIND_INFO[k].fix}
            </p>
            {k === 'missing' && onInterpolateAll && (
              <button className="small" onClick={onInterpolateAll} title="Chaque trou entre deux photos positionnées ; les photos en début / fin de sortie restent à placer">
                Interpoler tous les trous possibles
              </button>
            )}
            <ul>
              {list.map((i) => {
                const on = current != null && current.kind === i.kind && current.start === i.start
                return (
                  <li key={`${i.kind}-${i.start}`}>
                    <button className={`issue-item${on ? ' current' : ''}`} onClick={() => onPick(i)} title="Aller à cette photo (carte et onglet Photo)">
                      <span>{where(i)}</span>
                      {i.detail && <span className="muted">{i.detail.replace(/^précision GPS faible \(|\)$/g, '').replace(/ photo\(s\) non classée\(s\)$/, ' photos')}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
