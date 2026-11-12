import { t, useLang } from './i18n'
import { Issue, issueDetail, IssueStep, issueText, sameIssue, STEP_KINDS } from './issues'

const stepTitle = (s: IssueStep) => t(`step.${s}`)

// What is left to fix for a step, at the top of its tab, grouped by kind with the cause and the fix. A click on an
// item goes to its photo: map centred on it, card explaining it above this list (same tab).
export default function IssuesPanel({
  step,
  issues,
  current,
  duplicates,
  onPick,
  onIgnore,
  onInterpolateAll,
}: {
  step: IssueStep
  issues: Issue[]
  current: Issue | null // the item being corrected (highlighted)
  duplicates: number // identical files set aside on import (nothing to do)
  onPick: (i: Issue) => void
  onIgnore: (i: Issue) => void // headings to check: the manual heading is right
  onInterpolateAll?: () => void
}) {
  useLang()
  const kinds = STEP_KINDS[step].filter((k) => issues.some((i) => i.kind === k))
  const where = (i: Issue) => (i.end > i.start ? t('issues.panel.photos', { a: i.start + 1, b: i.end + 1 }) : t('issues.panel.photo', { a: i.start + 1 }))
  return (
    <section className="issues-list small-text" role="region" aria-label={t('issues.panel.label', { step: stepTitle(step) })}>
      <h3>{t('issues.panel.title', { n: issues.length })}</h3>
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
    </section>
  )
}
