import { useEffect } from 'react'
import { Issue, issueDetail, IssueStep, ISSUE_TEXT, sameIssue, STEP_KINDS } from './issues'
import { useDraggable } from './useDraggable'

const STEP_TITLES: Record<IssueStep, string> = {
  dups: 'Doublons et arrêts',
  gps: 'Correction GPS',
  seq: 'Séquences',
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
  // Escape closes the window (and only that: the selection is kept), unless a dialog is open above it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest('input, textarea, select') || document.querySelector('.modal-backdrop')) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
              {ISSUE_TEXT[k].title} ({list.length})
            </h4>
            <p className="muted">
              <strong>Cause :</strong> {ISSUE_TEXT[k].cause} <strong>Correction :</strong> {ISSUE_TEXT[k].fix}
            </p>
            {k === 'missing' && onInterpolateAll && (
              <button className="small" onClick={onInterpolateAll} title="Chaque trou entre deux photos positionnées ; les photos en début / fin de sortie restent à placer">
                Interpoler tous les trous possibles
              </button>
            )}
            <ul>
              {list.map((i) => {
                const on = current != null && sameIssue(current, i)
                return (
                  <li key={`${i.kind}-${i.start}`}>
                    <button className={`issue-item${on ? ' current' : ''}`} onClick={() => onPick(i)} title="Aller à cette photo (carte et onglet Photo)">
                      <span>{where(i)}</span>
                      <span className="muted">{issueDetail(i)}</span>
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
