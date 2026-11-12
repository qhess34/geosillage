// Things to check or fix on a ride: one list (N / Shift+N, step tabs, Bilan, card on top of a step's tab), one table of
// texts per kind, and the photo predicates they share.
import { FLAGS, PhotoRow, QualityIssue } from './api'
import { Key, t, tp } from './i18n'

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
// Step (tab) where an issue is listed and corrected
export const stepOf = (k: IssueKind): IssueStep => (Object.keys(STEP_KINDS) as IssueStep[]).find((s) => STEP_KINDS[s].includes(k)) ?? 'gps'

// Title of a group, name of one item, cause and fix: the only place these texts are keyed (i18n)
export const issueText = (k: IssueKind) => ({
  title: t(`issue.${k}.title` as Key),
  one: t(`issue.${k}.one` as Key),
  cause: t(`issue.${k}.cause` as Key),
  fix: t(`issue.${k}.fix` as Key),
})

// Photos without a position at the start / end of the ride: no neighbour on one side
export const missingEdgeFix = () => t('issue.missingEdge')

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
  if (i.kind === 'spacing' && i.meters != null) return t('issue.spacingDetail', { m: i.meters })
  if (i.detail) return i.detail
  if (i.kind === 'jump') return t('issue.jumpDetail')
  return tp('issue.count', i.count)
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
