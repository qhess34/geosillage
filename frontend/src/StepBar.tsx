import { FLAGS, PhotoRow, Project, QualityIssue, Sequence } from './api'
import { hasNoHeading, isPlaced, isUsable } from './issues'
import { t, tp, useLang } from './i18n'

// The only navigation of the project screen: the steps ARE the tabs of the side panel, in the order of the work
// (import → GPS delay → duplicates and stops → positions and direction → sequences → export → upload), each with its
// state (short subtitle, detail on hover); the current photo (viewer, details) is a tab apart, not a step.
// A Panoramax project hides Sequences and Export (no cut, no export: the photos stay on the instance).
export type StepTab = 'summary' | 'sync' | 'dups' | 'gps' | 'sequences' | 'export' | 'send' | 'photo'
type State = 'ok' | 'warn' | 'todo'
interface Step {
  id: StepTab
  label: string
  state: State
  sub: string
  help: string
  detail?: string // shown on hover only, keeps the visible subtitle short
}

export default function StepBar({
  project,
  photos,
  sequences,
  quality,
  tab,
  onTab,
}: {
  project: Project
  photos: PhotoRow[]
  sequences: Sequence[]
  quality: QualityIssue[]
  tab: StepTab
  onTab: (t: StepTab) => void
}) {
  useLang()
  const pnx = project.kind === 'panoramax'
  const usable = photos.filter(isUsable)
  const steps: Step[] = []

  // 1. Import
  steps.push({
    id: 'summary',
    label: pnx ? t('step.importPnx') : t('step.import'),
    state: photos.length ? 'ok' : 'todo',
    sub: photos.length ? (pnx ? `${tp('step.sequences', sequences.length)} · ${tp('step.photos', photos.length)}` : tp('step.photos', photos.length)) : t('step.import.none'),
    help: photos.length ? t('step.import.help') : t('step.import.helpNone'),
  })

  // 2. GPS delay: photos placed on the track by the time synchronisation
  const synced = photos.filter((p) => p.pos_method === 'time').length
  steps.push({
    id: 'sync',
    label: t('step.sync'),
    state: synced ? 'ok' : 'todo',
    // the offset is not shown: it can differ from one batch of photos to another (see the Synchro tab)
    sub: synced ? tp('step.photos', synced) : t('step.sync.none'),
    help: (synced ? tp('step.sync.done', synced) + t('step.sync.helpDone') : '') + t('step.sync.help'),
  })

  // 3. Duplicates and stops: identical files are set aside on import; stops are sorted by hand
  const stops = quality.filter((q) => q.kind === 'stop')
  const dups = project.summary.duplicates
  steps.push({
    id: 'dups',
    label: t('step.dups'),
    state: !photos.length ? 'todo' : stops.length ? 'warn' : 'ok',
    sub: stops.length ? t('step.dups.toSort', { stops: tp('step.stops', stops.length) }) : t('step.dups.noStop'),
    detail: dups ? t('step.detail.dupsSkipped', { n: dups }) : undefined,
    help: stops.length ? t('step.dups.helpStops') : t('step.dups.help'),
  })

  // 4. GPS correction: positions, GPS jumps, points to check about positions and headings
  const missing = usable.filter((p) => !isPlaced(p))
  const jumps = usable.filter((p) => p.flags & FLAGS.GPS_JUMP && p.pos_method == null)
  const gpsPoints = quality.filter((q) => q.kind !== 'stop')
  const noHeading = photos.filter(hasNoHeading)
  const gpsParts = [
    missing.length && tp('step.gps.noPos', missing.length),
    jumps.length && tp('step.gps.jumps', jumps.length),
    noHeading.length && tp('step.gps.noHeading', noHeading.length),
    gpsPoints.length && tp('step.gps.points', gpsPoints.length),
  ].filter(Boolean) as string[]
  steps.push({
    id: 'gps',
    label: t('step.gps'),
    state: !photos.length ? 'todo' : gpsParts.length ? 'warn' : 'ok',
    sub: gpsParts.length ? tp('step.sub.toCheck', missing.length + jumps.length + noHeading.length + gpsPoints.length) : t('step.gps.none'),
    detail: gpsParts.length ? t('step.detail.gps', { parts: gpsParts.join(' · ') }) : undefined,
    help: t('step.gps.help') + (gpsParts.length ? t('step.gps.helpSome') : t('step.gps.helpNone')),
  })

  if (!pnx) {
    // 5. Sequences
    const unclassified = usable.filter((p) => p.sequence_id == null)
    steps.push({
      id: 'sequences',
      label: t('step.seq'),
      state: !sequences.length ? 'todo' : unclassified.length ? 'warn' : 'ok',
      sub: !sequences.length
        ? t('step.seq.none')
        : unclassified.length
          ? tp('step.sub.toClassify', unclassified.length)
          : tp('step.sequences', sequences.length),
      detail: unclassified.length ? t('step.detail.seq', { n: unclassified.length }) : undefined,
      help: unclassified.length ? t('step.seq.helpUnclassified') : t('step.seq.help'),
    })

    // 6. Export
    const exported = sequences.filter((s) => s.last_export)
    const again = sequences.filter((s) => s.last_export && s.needs_export)
    steps.push({
      id: 'export',
      label: t('step.export'),
      state: !exported.length ? 'todo' : exported.length < sequences.length || again.length ? 'warn' : 'ok',
      sub: tp('step.export.done', exported.length, { total: sequences.length }),
      detail: again.length ? t('step.detail.export', { n: again.length }) : undefined,
      help: t('step.export.help'),
    })
  }

  // 7. Upload (Panoramax project: corrections to send)
  const published = sequences.filter((s) => s.last_publication?.state === 'ready')
  const changed = sequences.filter((s) => s.last_publication && s.changed_since_publication)
  const failed = sequences.filter((s) => s.last_publication && ['error', 'uploading'].includes(s.last_publication.state))
  steps.push(
    pnx
      ? {
          id: 'send',
          label: t('step.send'),
          state: changed.length ? 'warn' : 'ok',
          sub: changed.length ? tp('step.send.toSend', changed.length) : t('step.send.upToDate'),
          help: t('step.send.helpPnx'),
        }
      : {
          id: 'send',
          label: t('step.send'),
          state: !published.length && !failed.length ? 'todo' : published.length < sequences.length || changed.length || failed.length ? 'warn' : 'ok',
          sub: tp('step.send.published', published.length, { total: sequences.length }),
          detail: [changed.length && tp('step.send.changed', changed.length), failed.length && tp('step.send.failed', failed.length)].filter(Boolean).join(' · ') || undefined,
          help: t('step.send.help'),
        },
  )

  return (
    <nav className="steps" role="tablist" aria-label={t('steps.nav')}>
      {steps.map((s, i) => (
        <button
          key={s.id}
          role="tab"
          aria-selected={tab === s.id}
          className={`step ${s.state}${tab === s.id ? ' current' : ''}`}
          title={`${s.label} : ${s.sub}${s.detail ? `\n${s.detail}` : ''}\n${s.help}`}
          onClick={() => onTab(s.id)}
        >
          <span className="ico">{s.state === 'ok' ? '✓' : s.state === 'warn' ? '!' : i + 1}</span>
          <span className="txt">
            <span className="lab">{s.label}</span>
            <span className="sub">{s.sub}</span>
          </span>
        </button>
      ))}
      {pnx && (
        <span className="steps-note small-text muted" title={t('sum.pnxHidden')}>
          {t('steps.pnxHidden')}
        </span>
      )}
      <span className="steps-spacer" />
      <button
        role="tab"
        aria-selected={tab === 'photo'}
        className={`step photo-step${tab === 'photo' ? ' current' : ''}`}
        title={t('steps.photoHelp')}
        onClick={() => onTab('photo')}
      >
        {t('tab.photo')}
      </button>
    </nav>
  )
}

// Tab order (keys 1…n) as shown for this project
export const stepTabs = (pnx: boolean): StepTab[] =>
  pnx ? ['summary', 'sync', 'dups', 'gps', 'send'] : ['summary', 'sync', 'dups', 'gps', 'sequences', 'export', 'send']
