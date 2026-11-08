import { PhotoDetail } from './api'
import StopRangeEditor from './StopRangeEditor'
import { t, useLang } from './i18n'
import { Issue, issueText, issueDetail, missingEdgeFix } from './issues'

export type CheckAction = 'interpolate' | 'clear-headings' | 'ignore-headings' | 'create-sequence' | 'exclude'

// Card on top of the Photo tab: what is wrong on these photos (cause), how to fix it, the useful actions. When the
// issue is no longer in the list (fixed: interpolated, heading restored, sequence created… or ignored), it says so.
export default function CheckCard({
  issue,
  fixed,
  index,
  total,
  detail,
  editMode,
  interpolable,
  onPositions,
  onCompare,
  onAction,
  onNext,
  onClose,
  stopEditor,
}: {
  issue: Issue // as it was when reached (for the text); `fixed` when it has disappeared since
  fixed: boolean
  index: number // rank in the list (when not fixed)
  total: number
  detail: PhotoDetail | null
  editMode: boolean
  interpolable: boolean // photos without a position: a positioned photo before and after
  onPositions: () => void
  onCompare: () => void
  onAction: (what: CheckAction) => void
  onNext: () => void
  onClose: () => void
  stopEditor?: React.ComponentProps<typeof StopRangeEditor> // stop: photos of the stop, adjustable before comparing
}) {
  useLang()
  const tx = issueText(issue.kind)
  const where = issue.end > issue.start ? t('check.photosRange', { a: issue.start + 1, b: issue.end + 1 }) : t('check.photoOne', { a: issue.start + 1 })
  const next = (
    <button className="small" onClick={onNext} title={t('check.nextTitle')}>
      {t('check.next')}
    </button>
  )
  if (fixed)
    return (
      <section className="check-card fixed small-text" role="status">
        <header>
          <strong>{t('check.treated', { name: tx.one })}</strong>
          <span className="muted">{where}</span>
          <button className="small icon" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        <div className="row wrap">
          <span className="spacer" />
          {next}
        </div>
      </section>
    )

  const positions = (
    <button className={editMode ? 'small primary' : 'small'} onClick={onPositions} title={t('check.positionsTitle')}>
      ✥ {editMode ? t('check.positionsOn') : t('check.positions')}
    </button>
  )
  // what this issue is precisely, on these photos
  const precise: Partial<Record<Issue['kind'], string | null>> = {
    spacing: t('check.spacing', { detail: issueDetail(issue), a: issue.start + 1, b: issue.end + 1 }),
    gps_dop: issue.detail,
    stop: issue.detail,
    no_heading:
      detail?.heading_auto_state === 'uncertain'
        ? t('check.noHeadingStill')
        : t('check.noHeadingNoPos'),
    heading:
      detail?.heading_manual != null && detail.heading_auto != null
        ? t('check.headingDiff', { typed: detail.heading_manual.toFixed(0), computed: detail.heading_auto.toFixed(0) })
        : issue.detail,
  }
  const actions: Record<Issue['kind'], React.ReactNode> = {
    no_heading: (
      <>
        {positions}
        <button className="small" onClick={() => onAction('exclude')}>
          {t('check.excludeThese')}
        </button>
      </>
    ),
    jump: positions,
    spacing: positions,
    gps_dop: positions,
    missing: (
      <>
        {interpolable && (
          <button className="small primary" onClick={() => onAction('interpolate')}>
            {t('check.interpolate')}
          </button>
        )}
        {positions}
        {!interpolable && (
          <button className="small" onClick={() => onAction('exclude')}>
            {t('check.excludeThese')}
          </button>
        )}
      </>
    ),
    heading: (
      <>
        <button className="small primary" onClick={() => onAction('clear-headings')}>
          {t('photo.backToComputed')}
        </button>
        <button
          className="small"
          onClick={() => onAction('ignore-headings')}
          title={t('check.ignoreTitle')}
        >
          {t('check.ignore')}
        </button>
      </>
    ),
    stop: (
      <button className="small primary" onClick={onCompare}>
        {stopEditor ? t('check.compareN', { n: stopEditor.range[1] - stopEditor.range[0] + 1 }) : t('check.compare')}
      </button>
    ),
    unclassified: (
      <>
        <button className="small primary" onClick={() => onAction('create-sequence')}>
          {t('check.createSeq')}
        </button>
        <button className="small" onClick={() => onAction('exclude')}>
          {t('check.excludeThese')}
        </button>
      </>
    ),
  }
  return (
    <section className="check-card small-text" role="status">
      <header>
        <strong>{t('check.toFix', { name: tx.one })}</strong>
        <span className="muted">
          {where} · {index + 1}/{total}
        </span>
        <button className="small icon" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
          ✕
        </button>
      </header>
      {precise[issue.kind] && <p className="check-precise">{precise[issue.kind]}</p>}
      <p>
        <strong>{t('issues.cause')}</strong> {tx.cause}
        <br />
        <strong>{t('issues.fix')}</strong> {issue.kind === 'missing' && !interpolable ? missingEdgeFix() : tx.fix}
      </p>
      {issue.kind === 'stop' && stopEditor && <StopRangeEditor {...stopEditor} />}
      <div className="row wrap">
        {actions[issue.kind]}
        <span className="spacer" />
        {next}
      </div>
    </section>
  )
}
