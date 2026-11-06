import { api, GpxSummary, PhotoRow, SeqState, Sequence } from './api'
import { MenuItem } from './ContextMenu'
import { SnapScope } from './OsmSnapPanel'

// Context menu (right click) on the map, the timeline or a sequence
export type MenuContext = { x: number; y: number; kind: 'photos' | 'sequence'; range?: [number, number]; sequenceId?: number | null }
export type SnapOpen = { scope: SnapScope; sequenceId: number | null; bounds?: [number, number] }
export type ValueDlg = { kind: 'offset' | 'yaw'; range: [number, number] }

export interface MenuDeps {
  projectId: string
  photos: PhotoRow[]
  sequences: Sequence[]
  gpx: GpxSummary | null
  isPnx: boolean
  goIdx: (idx: number) => void
  openSnap: (s: SnapOpen) => void
  openGpxSnap: (r?: [number, number]) => void
  openValueDlg: (v: ValueDlg) => void
  applyState: (s: SeqState & { done?: string }) => unknown
  clearSelection: () => void
  onError: (m: string) => void
}

export function contextMenuItems(ctx: MenuContext | null, d: MenuDeps): { title: string; items: MenuItem[] } {
  const { projectId, photos, sequences, gpx, isPnx, goIdx, openGpxSnap, applyState } = d
  if (!ctx) return { title: '', items: [] }
  if (ctx.kind === 'sequence') {
    const sq = sequences.find((x) => x.id === ctx.sequenceId)
    return {
      title: sq ? `${sq.name} (${sq.count} photos)` : 'Séquence',
      items: [
        {
          label: 'Recaler sur OpenStreetMap…',
          disabled: !sq,
          onClick: () => {
            if (!sq) return
            goIdx(sq.start_idx)
            d.openSnap({ scope: 'sequence', sequenceId: sq.id })
          },
        },
        ...(gpx && sq ? [{ label: 'Recaler sur la trace GPX…', onClick: () => openGpxSnap([sq.start_idx, sq.end_idx]) }] : []),
      ],
    }
  }
  const r = ctx.range as [number, number]
  const inSeq = photos[r[0]]?.sequence_id ?? null
  const sameSeq = inSeq != null && photos.slice(r[0], r[1] + 1).every((p) => p.sequence_id === inSeq)
  const sq = sameSeq ? sequences.find((x) => x.id === inSeq) : undefined
  const these = r[0] === r[1] ? 'de cette photo' : `de ces ${r[1] - r[0] + 1} photos`
  const items: MenuItem[] = [
    {
      label: r[0] === r[1] ? 'Recaler cette photo sur OpenStreetMap…' : `Recaler ces ${r[1] - r[0] + 1} photos sur OpenStreetMap…`,
      onClick: () => d.openSnap({ scope: 'custom', sequenceId: inSeq, bounds: r }),
    },
    ...(gpx
      ? [{ label: r[0] === r[1] ? 'Recaler cette photo sur la trace GPX…' : `Recaler ces ${r[1] - r[0] + 1} photos sur la trace GPX…`, onClick: () => openGpxSnap(r) }]
      : []),
    { label: `Décalage du cap (sens de déplacement) ${these}…`, onClick: () => d.openValueDlg({ kind: 'offset', range: r }) },
    { label: `Orientation de la caméra ${these}…`, onClick: () => d.openValueDlg({ kind: 'yaw', range: r }) },
  ]
  if (!isPnx && photos.slice(r[0], r[1] + 1).every((p) => p.sequence_id == null))
    items.push({
      label: r[0] === r[1] ? 'Créer une séquence avec cette photo' : `Créer une séquence avec ces ${r[1] - r[0] + 1} photos`,
      onClick: () =>
        api.createSequence(projectId, r[0], r[1]).then((st) => {
          applyState({ ...st, done: `Séquence créée : photos ${r[0] + 1} → ${r[1] + 1}` })
          d.clearSelection()
        }, (er) => d.onError(er.message)),
    })
  if (sq)
    items.push({
      label: `Recaler toute la séquence « ${sq.name} »…`,
      onClick: () => d.openSnap({ scope: 'sequence', sequenceId: sq.id }),
    })
  return { title: r[0] === r[1] ? `Photo ${r[0] + 1}` : `Photos ${r[0] + 1} → ${r[1] + 1}`, items }
}
