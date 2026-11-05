import { FLAGS, PhotoRow, Project, QualityIssue, Sequence } from './api'

// Progress of the ride, step by step: import → duplicates and stops → GPS correction → sequences → export → upload.
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

const UNUSABLE = FLAGS.DUPLICATE | FLAGS.UNREADABLE | FLAGS.MISSING_FILE
const placed = (p: PhotoRow) => p.lat != null || (p.lat_orig != null && !(p.flags & (FLAGS.NO_GPS | FLAGS.INVALID_COORD)))
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

export default function StepBar({
  project,
  photos,
  sequences,
  quality,
  tab,
  onTab,
  onShow,
}: {
  project: Project
  photos: PhotoRow[]
  sequences: Sequence[]
  quality: QualityIssue[]
  tab: StepTab
  onTab: (t: StepTab) => void
  onShow: (range: [number, number]) => void // select photos and open the Photo tab
}) {
  const pnx = project.kind === 'panoramax'
  const usable = photos.filter((p) => !p.excluded && !(p.flags & UNUSABLE))
  const show = (i: { start_idx: number; end_idx: number }) => onShow([i.start_idx, i.end_idx])
  const steps: Step[] = []

  // 1. Import
  steps.push({
    id: 'import',
    label: pnx ? 'Import Panoramax' : 'Import',
    state: photos.length ? 'ok' : 'todo',
    sub: photos.length ? (pnx ? `${plural(sequences.length, 'séquence', 'séquences')} · ${photos.length} photos` : `${photos.length} photos`) : 'aucune photo',
    help: photos.length ? 'Bilan de l\'import : anomalies, durée, distance.' : 'Importez les dossiers de la sortie (bouton Importer).',
    go: () => onTab('summary'),
  })

  // 2. Duplicates and stops: identical files are set aside on import; stops are sorted by hand
  const stops = quality.filter((q) => q.kind === 'stop')
  const dups = project.summary.duplicates
  steps.push({
    id: 'dups',
    label: 'Doublons et arrêts',
    state: !photos.length ? 'todo' : stops.length ? 'warn' : 'ok',
    sub: stops.length
      ? `${plural(stops.length, 'arrêt', 'arrêts')} à trier`
      : `${dups ? `${plural(dups, 'doublon écarté', 'doublons écartés')} · ` : ''}aucun arrêt`,
    help: stops.length
      ? 'Photos prises au même endroit (feu rouge, pause) : gardez la ou les meilleures et excluez les autres (X). Clic : premier arrêt.'
      : 'Les fichiers identiques sont écartés à l\'import. Aucune série de photos au même endroit.',
    go: () => (stops.length ? show(stops[0]) : onTab('summary')),
  })

  // 3. GPS correction: positions, GPS jumps, points to check about positions and headings
  const missing = usable.filter((p) => !placed(p))
  const jumps = usable.filter((p) => p.flags & FLAGS.GPS_JUMP && p.pos_method == null)
  const gpsPoints = quality.filter((q) => q.kind !== 'stop')
  const gpsParts = [
    missing.length && plural(missing.length, 'sans position', 'sans position'),
    jumps.length && plural(jumps.length, 'saut GPS', 'sauts GPS'),
    gpsPoints.length && plural(gpsPoints.length, 'point à vérifier', 'points à vérifier'),
  ].filter(Boolean) as string[]
  steps.push({
    id: 'gps',
    label: 'Correction GPS',
    state: !photos.length ? 'todo' : gpsParts.length ? 'warn' : 'ok',
    sub: gpsParts.length ? gpsParts.join(' · ') : 'rien à signaler',
    help:
      'Retard GPS (onglet Synchro), positions (M), recalage OSM, caps. ' +
      (gpsParts.length ? 'Clic : le premier point (photos sans position : Bilan).' : 'Plus rien n\'est signalé ; la synchro reste possible (onglet Synchro).'),
    go: () =>
      missing.length
        ? onTab('summary')
        : jumps.length
          ? onShow([jumps[0].idx, jumps[0].idx])
          : gpsPoints.length
            ? show(gpsPoints[0])
            : onTab('sync'),
  })

  if (!pnx) {
    // 4. Sequences
    const unclassified = usable.filter((p) => p.sequence_id == null)
    steps.push({
      id: 'seq',
      label: 'Séquences',
      state: !sequences.length ? 'todo' : unclassified.length ? 'warn' : 'ok',
      sub: !sequences.length
        ? 'aucune séquence'
        : `${sequences.length}${unclassified.length ? ` · ${plural(unclassified.length, 'photo non classée', 'photos non classées')}` : ''}`,
      help: unclassified.length
        ? 'Photos ni dans une séquence, ni exclues : créez des séquences (D / F) ou excluez-les (X).'
        : 'Découpage de la sortie en séquences (onglet Séquences).',
      go: () => onTab('sequences'),
    })

    // 5. Export
    const exported = sequences.filter((s) => s.last_export)
    const again = sequences.filter((s) => s.last_export && s.needs_export)
    steps.push({
      id: 'export',
      label: 'Export',
      state: !exported.length ? 'todo' : exported.length < sequences.length || again.length ? 'warn' : 'ok',
      sub: `${exported.length} / ${sequences.length} exportée${exported.length > 1 ? 's' : ''}${again.length ? ` · ${again.length} à réexporter` : ''}`,
      help: 'Un dossier par séquence, avec les EXIF corrigés (onglet Export).',
      go: () => onTab('export'),
    })
  }

  // 6. Upload (Panoramax project: corrections to send)
  const published = sequences.filter((s) => s.last_publication?.state === 'ready')
  const changed = sequences.filter((s) => s.last_publication && s.changed_since_publication)
  const failed = sequences.filter((s) => s.last_publication && ['error', 'uploading'].includes(s.last_publication.state))
  steps.push(
    pnx
      ? {
          id: 'send',
          label: 'Envoi',
          state: changed.length ? 'warn' : 'ok',
          sub: changed.length ? `${plural(changed.length, 'séquence à envoyer', 'séquences à envoyer')}` : 'à jour',
          help: 'Séquences modifiées ici depuis leur import ou leur dernier envoi : comparez puis envoyez (onglet Envoi).',
          go: () => onTab('send'),
        }
      : {
          id: 'send',
          label: 'Envoi',
          state: !published.length && !failed.length ? 'todo' : published.length < sequences.length || changed.length || failed.length ? 'warn' : 'ok',
          sub:
            `${published.length} / ${sequences.length} publiée${published.length > 1 ? 's' : ''}` +
            (changed.length ? ` · ${changed.length} modifiée${changed.length > 1 ? 's' : ''} depuis` : '') +
            (failed.length ? ` · ${failed.length} interrompue${failed.length > 1 ? 's' : ''}` : ''),
          help: 'Publication sur Panoramax des séquences exportées (onglet Envoi).',
          go: () => onTab('send'),
        },
  )

  const current: Record<string, string> = { sync: 'gps', sequences: 'seq', export: 'export', send: 'send' }
  return (
    <nav className="steps" aria-label="Étapes">
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
