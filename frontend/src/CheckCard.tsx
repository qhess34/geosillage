import { PhotoDetail } from './api'
import StopRangeEditor from './StopRangeEditor'
import { Issue, ISSUE_TEXT, issueDetail, MISSING_EDGE_FIX } from './issues'

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
  const t = ISSUE_TEXT[issue.kind]
  const where = issue.end > issue.start ? `photos ${issue.start + 1} → ${issue.end + 1}` : `photo ${issue.start + 1}`
  const next = (
    <button className="small" onClick={onNext} title="Point suivant à vérifier (N)">
      Suivant (N) →
    </button>
  )
  if (fixed)
    return (
      <section className="check-card fixed small-text" role="status">
        <header>
          <strong>Traité ✓ : {t.one}</strong>
          <span className="muted">{where}</span>
          <button className="small icon" onClick={onClose} title="Fermer" aria-label="Fermer">
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
    <button className={editMode ? 'small primary' : 'small'} onClick={onPositions} title="Mode Positions (M) : glisser le point violet de la photo sur la carte">
      ✥ {editMode ? 'Mode Positions actif' : 'Corriger la position (M)'}
    </button>
  )
  // what this issue is precisely, on these photos
  const precise: Partial<Record<Issue['kind'], string | null>> = {
    spacing: `${issueDetail(issue)} entre les photos ${issue.start + 1} et ${issue.end + 1}.`,
    gps_dop: issue.detail,
    stop: issue.detail,
    no_heading:
      detail?.heading_auto_state === 'uncertain'
        ? 'La caméra ne bouge pas sur tout le tronçon : pas de sens de déplacement.'
        : 'Pas de position utilisable autour de cette photo pour calculer le sens de déplacement.',
    heading:
      detail?.heading_manual != null && detail.heading_auto != null
        ? `Cap saisi ${detail.heading_manual.toFixed(0)}°, calculé ${detail.heading_auto.toFixed(0)}°.`
        : issue.detail,
  }
  const actions: Record<Issue['kind'], React.ReactNode> = {
    no_heading: (
      <>
        {positions}
        <button className="small" onClick={() => onAction('exclude')}>
          Exclure ces photos
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
            Interpoler entre les voisines
          </button>
        )}
        {positions}
        {!interpolable && (
          <button className="small" onClick={() => onAction('exclude')}>
            Exclure ces photos
          </button>
        )}
      </>
    ),
    heading: (
      <>
        <button className="small primary" onClick={() => onAction('clear-headings')}>
          Revenir au cap calculé
        </button>
        <button
          className="small"
          onClick={() => onAction('ignore-headings')}
          title="Le cap saisi est le bon (le cap calculé est faux, par exemple après une perte du GPS) : ne plus le signaler, tant qu'il ne change pas"
        >
          Ignorer : le cap saisi est bon
        </button>
      </>
    ),
    stop: (
      <button className="small primary" onClick={onCompare}>
        Comparer {stopEditor ? `ces ${stopEditor.range[1] - stopEditor.range[0] + 1} photos` : 'les photos'}
      </button>
    ),
    unclassified: (
      <>
        <button className="small primary" onClick={() => onAction('create-sequence')}>
          Créer une séquence avec ces photos
        </button>
        <button className="small" onClick={() => onAction('exclude')}>
          Exclure ces photos
        </button>
      </>
    ),
  }
  return (
    <section className="check-card small-text" role="status">
      <header>
        <strong>À corriger : {t.one}</strong>
        <span className="muted">
          {where} · {index + 1}/{total}
        </span>
        <button className="small icon" onClick={onClose} title="Fermer" aria-label="Fermer">
          ✕
        </button>
      </header>
      {precise[issue.kind] && <p className="check-precise">{precise[issue.kind]}</p>}
      <p>
        <strong>Cause :</strong> {t.cause}
        <br />
        <strong>Correction :</strong> {issue.kind === 'missing' && !interpolable ? MISSING_EDGE_FIX : t.fix}
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
