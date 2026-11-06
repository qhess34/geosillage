import { FLAGS, PhotoRow, Project, QualityIssue, Sequence } from './api'
import { isPlaced, isUsable } from './issues'

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

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

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
  const pnx = project.kind === 'panoramax'
  const usable = photos.filter(isUsable)
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

  // 2. GPS delay: photos placed on the track by the time synchronisation
  const synced = photos.filter((p) => p.pos_method === 'time').length
  steps.push({
    id: 'sync',
    label: 'Synchro',
    state: synced ? 'ok' : 'todo',
    // the offset is not shown: it can differ from one batch of photos to another (see the Synchro tab)
    sub: synced ? `${plural(synced, 'photo', 'photos')}` : 'pas encore faite',
    help: (synced ? `${plural(synced, 'photo synchronisée', 'photos synchronisées')} ; décalages par lot dans l'onglet Synchro. ` : '') + 'Retard du GPS de la caméra : faites glisser une photo le long de la trace sur la vue satellite (onglet Synchro).',
    go: () => onTab('sync'),
  })

  // 3. Duplicates and stops: identical files are set aside on import; stops are sorted by hand
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
      ? 'Photos prises au même endroit (feu rouge, pause) : gardez la ou les meilleures et excluez les autres. Clic : la liste des arrêts à trier.'
      : 'Les fichiers identiques sont écartés à l\'import. Aucune série de photos au même endroit.',
    go: () => (issueCounts.dups ? onIssues('dups') : onTab('summary')),
  })

  // 4. GPS correction: positions, GPS jumps, points to check about positions and headings
  const missing = usable.filter((p) => !isPlaced(p))
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
      'Positions (M), photos sans position, recalage OSM, caps. ' +
      (gpsParts.length ? 'Clic : la liste des corrections (cause, correction) ; un clic sur une photo y va.' : 'Plus rien n\'est signalé.'),
    go: () => (issueCounts.gps ? onIssues('gps') : onTab('summary')),
  })

  if (!pnx) {
    // 5. Sequences
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
      go: () => (issueCounts.seq ? onIssues('seq') : onTab('sequences')),
    })

    // 6. Export
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

  // 7. Upload (Panoramax project: corrections to send)
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
          help: 'Publication sur Panoramax des séquences exportées : « Publier » sur chaque séquence (onglet Export et envoi).',
          go: () => onTab('export'),
        },
  )

  const current: Record<string, string> = { sync: 'sync', sequences: 'seq', export: 'export', send: 'send' }
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
