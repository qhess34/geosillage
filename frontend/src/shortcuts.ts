import { Dispatch, SetStateAction, useEffect, useRef } from 'react'
import { api, PhotoDetail, PhotoRow, SeqState, Sequence, UndoState } from './api'
import { t } from './i18n'
import { Issue, issueText, issueDetail } from './issues'

// Shown in the help window (?): [key label, description]
export const shortcutList = (): [string, string][] => [
  ['← / →', t('sc.prevNext')],
  [t('key.homeEnd'), t('sc.firstLast')],
  [t('key.page'), t('sc.seqPrevNext')],
  ['D', t('sc.start')],
  ['F', t('sc.finish')],
  ['C', t('sc.cut')],
  [t('key.delete'), t('sc.exclude')],
  [t('key.shiftX'), t('sc.include')],
  [t('key.escape'), t('sc.clearRange')],
  ['[ / ]', t('sc.heading')],
  [t('key.nextIssue'), t('sc.nextIssue')],
  ['M', t('sc.positions')],
  ['Ctrl+Z / Ctrl+Y', t('sc.undoRedo')],
  ['?', t('sc.help')],
]

export interface ShortcutsParams {
  projectId: string
  photos: PhotoRow[]
  sequences: Sequence[]
  current: PhotoRow | null
  detail: PhotoDetail | null
  range: [number, number] | null
  seqStart: number | null
  isPnx: boolean
  showExcluded: boolean
  editMode: boolean
  carryPos: boolean
  checkPoints: Issue[]
  blocked: boolean // a dialog is open: no shortcut
  showHelp: boolean
  setShowHelp: Dispatch<SetStateAction<boolean>>
  setEditMode: Dispatch<SetStateAction<boolean>>
  setSeqStart: (v: number | null) => void
  setRange: (r: [number, number] | null) => void
  setConfirmExclude: (v: { range: [number, number]; n: number }) => void
  setNotice: (m: string) => void
  setError: (m: string) => void
  goIdx: (idx: number) => void
  stepIdx: (idx: number, dir: 1 | -1, count?: number) => number
  nextKept: (idx: number) => PhotoRow | null
  applyState: (s: SeqState & { done?: string }) => unknown
  afterHeadingChange: (u?: UndoState) => unknown
  undoRedo: (which: 'undo' | 'redo') => unknown
  markStart: () => void
  finishSequence: () => void
  carryCorrection: (from: PhotoRow, to: PhotoRow | undefined) => void
  focusOn: (c: Issue) => void
  excludeRange: (r: [number, number], n: number) => unknown
}

// Keyboard shortcuts of the project screen; one listener, reading the values of the last render
export function useShortcuts(params: ShortcutsParams) {
  const latest = useRef(params)
  useEffect(() => {
    latest.current = params
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const {
        projectId, photos, sequences, current, detail, range, seqStart, isPnx, showExcluded, editMode, carryPos, checkPoints, blocked, showHelp,
        setShowHelp, setEditMode, setSeqStart, setRange, setConfirmExclude, setNotice, setError,
        goIdx, stepIdx, nextKept, applyState, afterHeadingChange, undoRedo, markStart, finishSequence, carryCorrection, focusOn, excludeRange,
      } = latest.current
      const el = e.target as HTMLElement
      if (el?.closest('input, textarea, select') || blocked) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z') {
        undoRedo(e.shiftKey ? 'redo' : 'undo')
      } else if (ctrl && e.key.toLowerCase() === 'y') {
        undoRedo('redo')
      } else if (ctrl) {
        return
      } else if (e.key === '?') {
        setShowHelp((v) => !v)
      } else if (e.key === 'Escape' && showHelp) {
        setShowHelp(false)
      } else if (!photos.length) {
        return
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = current ? current.idx : -1
        const dir = e.key === 'ArrowRight' ? 1 : -1
        const target = i < 0 ? stepIdx(-1, 1) : stepIdx(i, dir, e.shiftKey ? 10 : 1)
        if (dir === 1 && !e.shiftKey && editMode && carryPos && current && target !== i) carryCorrection(current, photos[target])
        goIdx(target)
      } else if (e.key === 'Home') goIdx(stepIdx(-1, 1))
      else if (e.key === 'End') goIdx(stepIdx(photos.length, -1))
      else if (e.key === 'PageDown' || e.key === 'PageUp') {
        if (!sequences.length) return
        const i = current?.idx ?? -1
        const target =
          e.key === 'PageDown' ? sequences.find((s) => s.start_idx > i) : [...sequences].reverse().find((s) => s.start_idx < i && !(current?.sequence_id === s.id && s.start_idx === i))
        if (target) goIdx(target.start_idx)
      } else if (isPnx && 'dDfFsScC'.includes(e.key)) {
        return // Panoramax project: the cut of the published sequences cannot change
      } else if (e.key === 'd' || e.key === 'D') {
        markStart()
      } else if (e.key === 'f' || e.key === 'F' || e.key === 's' || e.key === 'S') {
        finishSequence()
      } else if (e.key === 'c' || e.key === 'C') {
        if (current) api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'X' && e.shiftKey) {
        if (current?.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }, false).then(applyState, (er) => setError(er.message))
      } else if (e.key === 'x' || e.key === 'Delete') {
        if (range && seqStart == null && range[1] > range[0]) {
          // a range drawn on the timeline: exclude it all, after confirmation
          const n = photos.slice(range[0], range[1] + 1).filter((p) => !p.excluded).length
          if (n > 1) setConfirmExclude({ range, n })
          else excludeRange(range, n)
        } else if (current) {
          // exclude and move on: pressing the key repeatedly removes a series of photos
          if (!current.excluded) api.excludePhotos(projectId, { photo_ids: [current.id] }).then(applyState, (er) => setError(er.message))
          // the photo marked "Début" is excluded: the start moves to the next photo that is not
          if (seqStart === current.idx) {
            const next = nextKept(current.idx)
            setSeqStart(next ? next.idx : null)
            if (!next) setRange(null)
          }
          goIdx(showExcluded ? current.idx + 1 : stepIdx(current.idx, 1))
        }
      } else if (e.key === 'n' || e.key === 'N') {
        const i = current?.idx ?? -1
        const list = checkPoints
        const k = e.shiftKey ? list.map((c) => c.start < i).lastIndexOf(true) : list.findIndex((c) => c.start > i)
        if (k < 0) {
          setNotice(list.length ? t(e.shiftKey ? 'notice.noIssueBefore' : 'notice.noIssueAfter') : t('notice.nothingToCheck'))
        } else {
          const c = list[k]
          focusOn(c)
          setNotice(t('notice.issueAt', { k: k + 1, total: list.length, range: `${c.start + 1}${c.end > c.start ? ` → ${c.end + 1}` : ''}`, kind: issueText(c.kind).one, detail: issueDetail(c) }))
        }
      } else if (e.key === 'm' || e.key === 'M') {
        setEditMode((v) => !v)
      } else if (e.key === 'Escape') {
        setEditMode(false)
        setSeqStart(null)
        setRange(null)
      } else if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
        if (detail?.heading_final == null) return
        const d = (e.key === ']' || e.key === '}' ? 1 : -1) * (e.shiftKey ? 5 : 1)
        const v = (((detail.heading_final + d) % 360) + 360) % 360
        api.setHeading(projectId, detail.id, Math.round(v * 100) / 100).then((r) => afterHeadingChange(r.undo), (er) => setError(er.message))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
