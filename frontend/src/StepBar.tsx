import { FLAGS, PhotoRow, Project, QualityIssue, Sequence } from './api'
import { hasNoHeading, isPlaced, isUsable } from './issues'
import { t, tp, useLang } from './i18n'

// Progress of the ride, step by step: import → GPS delay (sync) → duplicates and stops → GPS correction → sequences → export → upload.
// Computed from what the interface already has (photos, sequences, points to check); a click opens the right place.
export type StepTab = 'photo' | 'sequences' | 'sync' | 'export' | 'send' | 'summary'
type State = 'ok' | 'warn' | 'todo'
interface Step {
  id: string
  label: string
  state: State
  sub: string
  help: string
  go: () => void
}

export default function StepBar({
  project,
  photos,
  sequences,
  quality,
  tab,
  onTab,
  onIssues,
  issueCounts,
}: {
  project: Project
  photos: PhotoRow[]
  sequences: Sequence[]
  quality: QualityIssue[]
  tab: StepTab
  onTab: (t: StepTab) => void
  // steps with things to fix open their list (floating window over the map)
  onIssues: (step: 'dups' | 'gps' | 'seq') => void
  issueCounts: { dups: number; gps: number; seq: number }
}) {
  useLang()
  const pnx = project.kind === 'panoramax'
  const usable = photos.filter(isUsable)
  const steps: Step[] = []

  // 1. Import
  steps.push({
    id: 'import',
    label: pnx ? t('step.importPnx') : t('step.import'),
    state: photos.length ? 'ok' : 'todo',
    sub: photos.length ? (pnx ? `${tp('step.sequences', sequences.length)} · ${tp('step.photos', photos.length)}` : tp('step.photos', photos.length)) : t('step.import.none'),
    help: photos.length ? t('step.import.help') : t('step.import.helpNone'),
    go: () => onTab('summary'),
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
    go: () => onTab('sync'),
  })

  // 3. Duplicates and stops: identical files are set aside on import; stops are sorted by hand
  const stops = quality.filter((q) => q.kind === 'stop')
  const dups = project.summary.duplicates
  steps.push({
    id: 'dups',
    label: t('step.dups'),
    state: !photos.length ? 'todo' : stops.length ? 'warn' : 'ok',
    sub: stops.length
      ? t('step.dups.toSort', { stops: tp('step.stops', stops.length) })
      : `${dups ? `${tp('step.dups.skipped', dups)} · ` : ''}${t('step.dups.noStop')}`,
    help: stops.length ? t('step.dups.helpStops') : t('step.dups.help'),
    go: () => (issueCounts.dups ? onIssues('dups') : onTab('summary')),
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
    sub: gpsParts.length ? gpsParts.join(' · ') : t('step.gps.none'),
    help: t('step.gps.help') + (gpsParts.length ? t('step.gps.helpSome') : t('step.gps.helpNone')),
    go: () => (issueCounts.gps ? onIssues('gps') : onTab('summary')),
  })

  if (!pnx) {
    // 5. Sequences
    const unclassified = usable.filter((p) => p.sequence_id == null)
    steps.push({
      id: 'seq',
      label: t('step.seq'),
      state: !sequences.length ? 'todo' : unclassified.length ? 'warn' : 'ok',
      sub: !sequences.length
        ? t('step.seq.none')
        : `${sequences.length}${unclassified.length ? ` · ${tp('step.seq.unclassified', unclassified.length)}` : ''}`,
      help: unclassified.length ? t('step.seq.helpUnclassified') : t('step.seq.help'),
      go: () => (issueCounts.seq ? onIssues('seq') : onTab('sequences')),
    })

    // 6. Export
    const exported = sequences.filter((s) => s.last_export)
    const again = sequences.filter((s) => s.last_export && s.needs_export)
    steps.push({
      id: 'export',
      label: t('step.export'),
      state: !exported.length ? 'todo' : exported.length < sequences.length || again.length ? 'warn' : 'ok',
      sub: tp('step.export.done', exported.length, { total: sequences.length }) + (again.length ? ` · ${t('step.export.again', { n: again.length })}` : ''),
      help: t('step.export.help'),
      go: () => onTab('export'),
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
          go: () => onTab('send'),
        }
      : {
          id: 'send',
          label: t('step.send'),
          state: !published.length && !failed.length ? 'todo' : published.length < sequences.length || changed.length || failed.length ? 'warn' : 'ok',
          sub:
            tp('step.send.published', published.length, { total: sequences.length }) +
            (changed.length ? ` · ${tp('step.send.changed', changed.length)}` : '') +
            (failed.length ? ` · ${tp('step.send.failed', failed.length)}` : ''),
          help: t('step.send.help'),
          go: () => onTab('export'),
        },
  )

  const current: Record<string, string> = { sync: 'sync', sequences: 'seq', export: 'export', send: 'send' }
  return (
    <nav className="steps" aria-label={t('steps.nav')}>
      {steps.map((s, i) => (
        <button
          key={s.id}
          className={`step ${s.state}${current[tab] === s.id ? ' current' : ''}`}
          title={`${s.label} : ${s.sub}\n${s.help}`}
          onClick={s.go}
        >
          <span className="ico">{s.state === 'ok' ? '✓' : s.state === 'warn' ? '!' : i + 1}</span>
          <span className="txt">
            <span className="lab">{s.label}</span>
            <span className="sub">{s.sub}</span>
          </span>
        </button>
      ))}
    </nav>
  )
}
