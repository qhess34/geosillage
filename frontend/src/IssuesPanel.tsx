import { useEffect } from 'react'
import { t, useLang } from './i18n'
import { Issue, issueDetail, IssueStep, issueText, sameIssue, STEP_KINDS } from './issues'
import { useDraggable } from './useDraggable'

const stepTitle = (s: IssueStep) => t(`step.${s}`)

// Floating window (moved by its title bar) listing what is left to fix for a step, grouped by kind with the cause
// and the fix. A click on an item goes to its photo: map centred on it, photo loaded in the Photo tab with the card
// explaining it. The window stays open while correcting.
export default function IssuesPanel({
  step,
  issues,
  current,
  duplicates,
  onPick,
  onIgnore,
  onInterpolateAll,
  onClose,
}: {
  step: IssueStep
  issues: Issue[]
  current: Issue | null // the item being corrected (highlighted)
  duplicates: number // identical files set aside on import (nothing to do)
  onPick: (i: Issue) => void
  onIgnore: (i: Issue) => void // headings to check: the manual heading is right
  onInterpolateAll?: () => void
  onClose: () => void
}) {
  useLang()
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
  const where = (i: Issue) => (i.end > i.start ? t('issues.panel.photos', { a: i.start + 1, b: i.end + 1 }) : t('issues.panel.photo', { a: i.start + 1 }))
  return (
    <div className="snap-panel snap-modal issues-modal small-text" ref={box} role="dialog" aria-label={t('issues.panel.label', { step: stepTitle(step) })} style={style}>
      <div className="row between snap-title" title={t('gpx.snap.drag')} {...handlers}>
        <h3>
          {t('issues.panel.title', { step: stepTitle(step), n: issues.length })}
        </h3>
        <button className="small" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      {step === 'dups' && duplicates > 0 && (
        <p className="muted">
          {t('issues.panel.dups', { n: duplicates })}
        </p>
      )}
      {issues.length === 0 && <p className="muted">{t('issues.panel.none')}</p>}
      {kinds.map((k) => {
        const list = issues.filter((i) => i.kind === k)
        return (
          <section key={k} className="issues-group">
            <h4>
              {issueText(k).title} ({list.length})
            </h4>
            <p className="muted">
              <strong>{t('issues.cause')}</strong> {issueText(k).cause} <strong>{t('issues.fix')}</strong> {issueText(k).fix}
            </p>
            {k === 'missing' && onInterpolateAll && (
              <button className="small" onClick={onInterpolateAll} title={t('issues.interpAllTitle')}>
                {t('issues.interpAll')}
              </button>
            )}
            <ul>
              {list.map((i) => {
                const on = current != null && sameIssue(current, i)
                return (
                  <li key={`${i.kind}-${i.start}`} className="row">
                    <button className={`issue-item${on ? ' current' : ''}`} onClick={() => onPick(i)} title={t('issues.goto')}>
                      <span>{where(i)}</span>
                      <span className="muted">{issueDetail(i)}</span>
                    </button>
                    {i.kind === 'heading' && (
                      <button className="small" onClick={() => onIgnore(i)} title={t('issues.ignoreTitle')}>
                        {t('issues.ignore')}
                      </button>
                    )}
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
