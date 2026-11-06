// Things to check or fix on a ride: one list (N / Shift+N, step bar, Bilan, card of the Photo tab), one table of
// texts per kind, and the photo predicates they share.
import { FLAGS, PhotoRow, QualityIssue } from './api'

export type IssueKind = QualityIssue['kind'] | 'jump' | 'missing' | 'no_heading' | 'unclassified'
export type IssueStep = 'dups' | 'gps' | 'seq'

// Located on photos start..end. `detail` is the backend's text for the points to check (quality.py), shown as is;
// the other fields are structured, never read back from a text.
export interface Issue {
  kind: IssueKind
  start: number
  end: number
  count: number // photos concerned
  detail: string | null
  meters?: number // spacing: distance between the two photos
}

export const STEP_KINDS: Record<IssueStep, IssueKind[]> = {
  dups: ['stop'],
  gps: ['missing', 'jump', 'spacing', 'gps_dop', 'heading', 'no_heading'],
  seq: ['unclassified'],
}

// Title of a group, name of one item, cause and fix: the only place these texts are written
export const ISSUE_TEXT: Record<IssueKind, { title: string; one: string; cause: string; fix: string }> = {
  stop: {
    title: 'Arrêts',
    one: 'Arrêt',
    cause: 'plusieurs photos prises au même endroit (feu rouge, pause).',
    fix: 'comparer les photos, garder la ou les meilleures (pas forcément la première), exclure les autres.',
  },
  missing: {
    title: 'Photos sans position',
    one: 'Photos sans position',
    cause: 'le GPS n\'avait pas de position (perte du signal, tunnel, début de sortie).',
    fix: 'interpoler entre les photos voisines (entourées en rouge sur la carte), ou placer à la main (M puis clic sur la carte).',
  },
  jump: {
    title: 'Sauts GPS',
    one: 'Saut GPS',
    cause: 'position incohérente avec les photos voisines (déplacement impossible en si peu de temps) ; la photo est en rouge, loin de la trace.',
    fix: 'glisser la photo au bon endroit (M) ; sinon elle est exclue de l\'export.',
  },
  spacing: {
    title: 'Grands écarts',
    one: 'Grand écart',
    cause: 'grande distance entre deux photos qui se suivent (seuil réglable dans ⚙ Réglages) : position fausse, photos manquantes ou vitesse élevée.',
    fix: 'vérifier sur la vue satellite et corriger la position si l\'une des deux est fausse ; sinon, rien à faire.',
  },
  gps_dop: {
    title: 'Précision GPS faible',
    one: 'Précision GPS faible',
    cause: 'la caméra indique une position peu précise (DOP au-dessus du seuil réglable dans ⚙ Réglages).',
    fix: 'comparer avec la vue satellite et corriger la position si elle est décalée.',
  },
  heading: {
    title: 'Caps à vérifier',
    one: 'Cap à vérifier',
    cause: 'cap saisi à la main très différent du cap calculé depuis la trace.',
    fix: 'revenir au cap calculé si c\'est une erreur de saisie ; si c\'est le cap calculé qui est faux (perte du GPS), ignorer.',
  },
  no_heading: {
    title: 'Photos sans cap',
    one: 'Photos sans cap',
    cause:
      'aucun cap ne peut être calculé : pas de position utilisable autour de la photo (photos voisines sans position ou en saut GPS), ou caméra immobile sur tout le tronçon. Sans cap, Panoramax ne sait pas orienter la photo.',
    fix: 'corriger les positions voisines (le cap est alors recalculé), ou saisir le cap à la main dans la section Cap de l\'onglet Photo (cadran, [ ]) ; sinon, exclure.',
  },
  unclassified: {
    title: 'Photos non classées',
    one: 'Photos non classées',
    cause: 'photos ni dans une séquence, ni exclues.',
    fix: 'créer une séquence avec elles, ou les exclure.',
  },
}

// Photos without a position at the start / end of the ride: no neighbour on one side
export const MISSING_EDGE_FIX =
  'pas de photo positionnée des deux côtés (début ou fin de sortie) : placer à la main (M puis clic sur la carte), synchroniser la sortie (onglet Synchro), ou exclure.'

// A photo that can be used (not excluded, file readable, not a duplicate) / that has a usable position
export const isUsable = (p: PhotoRow) => !p.excluded && !(p.flags & (FLAGS.DUPLICATE | FLAGS.UNREADABLE | FLAGS.MISSING_FILE))
export const isPlaced = (p: PhotoRow) => p.lat != null || (p.lat_orig != null && !(p.flags & (FLAGS.NO_GPS | FLAGS.INVALID_COORD)))

// A placed, usable photo with no final heading (neither computed nor typed); uncorrected GPS jumps are reported
// apart (their heading comes back once the position is fixed)
export const hasNoHeading = (p: PhotoRow) =>
  isUsable(p) && isPlaced(p) && p.heading == null && !(p.flags & FLAGS.GPS_JUMP && p.pos_method == null)

export const sameIssue = (a: Pick<Issue, 'kind' | 'start' | 'end'>, b: Pick<Issue, 'kind' | 'start' | 'end'>) =>
  a.kind === b.kind && a.start === b.start && a.end === b.end

// Short text of an item (lists, notices): backend detail, distance, or number of photos
export function issueDetail(i: Issue): string {
  if (i.kind === 'spacing' && i.meters != null) return `${i.meters} m d'écart`
  if (i.detail) return i.detail
  if (i.kind === 'jump') return 'position incohérente'
  return `${i.count} photo${i.count > 1 ? 's' : ''}`
}

// Everything to check, in the order of the ride: points to check (backend), uncorrected GPS jumps, photos without a
// position, unclassified photos (not in a Panoramax project: its cut cannot change)
export function computeIssues(quality: QualityIssue[], photos: PhotoRow[], pnx: boolean): Issue[] {
  const out: Issue[] = quality.map((q) => ({ kind: q.kind, start: q.start_idx, end: q.end_idx, count: q.count, detail: q.detail, meters: q.meters }))
  const runs = (kind: IssueKind, test: (p: PhotoRow) => boolean) => {
    let start = -1
    photos.forEach((p, i) => {
      const hit = isUsable(p) && test(p)
      if (hit && start < 0) start = i
      if (start >= 0 && (!hit || i === photos.length - 1)) {
        const end = hit ? i : i - 1
        out.push({ kind, start, end, count: end - start + 1, detail: null })
        start = -1
      }
    })
  }
  photos.forEach((p) => {
    if (isUsable(p) && p.flags & FLAGS.GPS_JUMP && p.pos_method == null) out.push({ kind: 'jump', start: p.idx, end: p.idx, count: 1, detail: null })
  })
  runs('missing', (p) => !isPlaced(p))
  runs('no_heading', hasNoHeading)
  if (!pnx) runs('unclassified', (p) => p.sequence_id == null)
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

// A positioned, usable photo before and after the issue (photos without a position can be interpolated)
export function canInterpolate(i: Issue, photos: PhotoRow[]): boolean {
  const ok = (p: PhotoRow) => isUsable(p) && isPlaced(p)
  return photos.slice(0, i.start).some(ok) && photos.slice(i.end + 1).some(ok)
}
