import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useMemo, useState } from 'react'
import { api, PhotoRow, QualityIssue, SeqState, UndoState } from './api'
import { CheckAction } from './CheckCard'
import { t } from './i18n'
import { computeIssues, Issue, IssueStep, sameIssue, STEP_KINDS } from './issues'

interface IssuesParams {
  projectId: string
  photos: PhotoRow[]
  isPnx: boolean
  current: PhotoRow | null
  goIdxRef: MutableRefObject<(idx: number) => void>
  setSeqStart: (v: number | null) => void
  setRange: (r: [number, number] | null) => void
  setTab: (t: 'photo') => void
  setCenterTick: Dispatch<SetStateAction<number>>
  setConfirmExclude: (v: { range: [number, number]; n: number }) => void
  afterHeadingChange: (u?: UndoState) => unknown
  applyState: (s: SeqState & { done?: string }) => unknown
  setError: (m: string) => void
  setNotice: (m: string) => void
}

// Points to check and the one being corrected (card of the Photo tab, list of a step, N / Shift+N)
export function useIssues({
  projectId,
  photos,
  isPnx,
  current,
  goIdxRef,
  setSeqStart,
  setRange,
  setTab,
  setCenterTick,
  setConfirmExclude,
  afterHeadingChange,
  applyState,
  setError,
  setNotice,
}: IssuesParams) {
  const [quality, setQuality] = useState<QualityIssue[]>([])
  const [issuesStep, setIssuesStep] = useState<IssueStep | null>(null) // list of things to fix of a step (floating window)
  const closeIssues = useCallback(() => setIssuesStep(null), [])
  const [confirmInterp, setConfirmInterp] = useState<number[] | null>(null) // photos to place between their neighbours

  // points to check, recomputed whenever the photos change (positions, exclusions, headings)
  useEffect(() => {
    if (photos.length) api.quality(projectId).then(setQuality, () => undefined)
    else setQuality([])
  }, [projectId, photos])
  // Everything to check, in the order of the ride (N / Shift+N, step bar, Bilan, card of the Photo tab)
  const checkPoints = useMemo(() => computeIssues(quality, photos, isPnx), [quality, photos, isPnx])
  // the same, per step of the step bar (list of things to fix of a step)
  const issuesByStep = useMemo(() => {
    const by = (st: IssueStep) => checkPoints.filter((c) => STEP_KINDS[st].includes(c.kind))
    return { dups: by('dups'), gps: by('gps'), seq: by('seq') }
  }, [checkPoints])
  // The issue being corrected (card on top of the Photo tab), as reached; looked up again in the list at each
  // render: gone = fixed
  const [focusPoint, setFocusPoint] = useState<Issue | null>(null)
  // stop being corrected: its photos, widened or narrowed by hand before comparing them
  const [stopAdj, setStopAdj] = useState<[number, number] | null>(null)
  const focusLive = focusPoint ? checkPoints.find((c) => sameIssue(c, focusPoint)) ?? null : null
  const focusOn = useCallback(
    (c: Issue) => {
      goIdxRef.current(c.start)
      setSeqStart(null)
      setRange(c.end > c.start ? [c.start, c.end] : null)
      setFocusPoint(c)
      setStopAdj(c.kind === 'stop' ? [c.start, c.end] : null)
      setTab('photo')
      setCenterTick((t) => t + 1) // the map shows the photo, even when it does not follow the navigation
    },
    [],
  )
  useEffect(() => {
    const [a, b] = focusPoint?.kind === 'stop' && stopAdj ? stopAdj : [focusPoint?.start ?? 0, focusPoint?.end ?? 0]
    if (focusPoint && (!current || current.idx < a || current.idx > b)) setFocusPoint(null)
  }, [current, focusPoint, stopAdj])
  // « Ignorer » headings to check: the manual heading is right (computed one wrong, GPS lost); points recomputed
  const ignoreHeadings = useCallback(
    (ids: number[]) =>
      api.ignoreHeadings(projectId, ids).then((res) => {
        setQuality(res.issues)
        afterHeadingChange(res.undo)
        setNotice(t('issues.headingKept'))
      }, (er) => setError(er.message)),
    [projectId, afterHeadingChange],
  )
  // Actions of the card of the Photo tab on the photos of the issue being corrected (exclusion: confirmed first)
  const fixIssue = useCallback(
    (what: CheckAction) => {
      if (!focusPoint) return
      const r: [number, number] = [focusPoint.start, focusPoint.end]
      const kept = photos.slice(r[0], r[1] + 1).filter((p) => !p.excluded)
      if (what === 'exclude') return setConfirmExclude({ range: r, n: kept.length })
      if (what === 'ignore-headings') return ignoreHeadings(kept.map((p) => p.id))
      if (what === 'interpolate')
        return api.positionsBatch(projectId, { photo_ids: kept.map((p) => p.id), mode: 'interpolate' }).then((res) => {
          if (!res.changed) setError(t('issues.cannotInterp'))
          else setNotice(t('issues.interpDone', { n: res.changed }))
          afterHeadingChange(res.undo)
        }, (er) => setError(er.message))
      if (what === 'clear-headings')
        return api.headingRange(projectId, r[0], r[1], 'clear').then((res) => {
          afterHeadingChange(res.undo)
          setNotice(t('issues.clearDone'))
        }, (er) => setError(er.message))
      return api
        .createSequence(projectId, r[0], r[1])
        .then((st) => applyState({ ...st, done: t('menu.seqCreated', { from: r[0] + 1, to: r[1] + 1 }) }), (er) => setError(er.message))
    },
    [focusPoint, photos, projectId, afterHeadingChange, applyState, ignoreHeadings],
  )
  // « Interpoler tous les trous possibles » (list of things to fix): every hole with a positioned photo before and
  // after; a bulk action, confirmed first
  const askInterpolateAll = useCallback(
    () =>
      api.missingPositions(projectId).then((runs) => {
        const ids = runs.filter((r) => r.prev && r.next).flatMap((r) => r.ids)
        if (ids.length) setConfirmInterp(ids)
        else setNotice(t('issues.noGap'))
      }, (e) => setError(e.message)),
    [projectId],
  )
  const interpolateAll = useCallback(
    (ids: number[]) =>
      api.positionsBatch(projectId, { photo_ids: ids, mode: 'interpolate' }).then((r) => {
        afterHeadingChange(r.undo)
        setNotice(t('issues.interpAllDone', { n: r.changed }))
      }, (e) => setError(e.message)),
    [projectId, afterHeadingChange],
  )
  const nextIssue = useCallback(() => {
    if (!focusPoint) return
    const c = checkPoints.find((x) => x.start > focusPoint.end) ?? checkPoints.find((x) => x.start > focusPoint.start)
    if (c) focusOn(c)
    else setNotice(t('issues.noMore'))
  }, [focusPoint, checkPoints, focusOn])

  return {
    quality,
    setQuality,
    checkPoints,
    issuesByStep,
    issuesStep,
    setIssuesStep,
    closeIssues,
    focusPoint,
    setFocusPoint,
    focusLive,
    stopAdj,
    setStopAdj,
    focusOn,
    ignoreHeadings,
    fixIssue,
    askInterpolateAll,
    confirmInterp,
    setConfirmInterp,
    interpolateAll,
    nextIssue,
  }
}
