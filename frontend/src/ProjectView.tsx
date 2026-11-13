import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, GpxSummary, PhotoDetail, PhotoRow, Project, SeqState, Sequence, UndoState } from './api'
import { builtinBasemaps } from './basemaps'
import { useCustomBasemaps } from './useCustomBasemaps'
import SettingsDialog from './SettingsDialog'
import ExportTab from './ExportTab'
import ImportDialog from './ImportDialog'
import PhotoMap from './PhotoMap'
import SendTab from './SendTab'
import StepBar, { StepTab, stepTabs } from './StepBar'
import PublishTab from './PublishTab'
import Tips from './Tips'
import IssuesPanel from './IssuesPanel'
import CheckCard from './CheckCard'
import { canInterpolate, Issue, IssueStep, stepOf } from './issues'
import StopCompare from './StopCompare'
import MapLegend from './MapLegend'
import { AddBasemap } from './Dialogs'
import SequencesTab from './SequencesTab'
import SyncTab from './SyncTab'
import { positionAt, Track } from './timesync'
import { loadOverlay, OverlaySettings, saveOverlay } from './panoramaxLayer'
import Timeline from './Timeline'
import ContextMenu from './ContextMenu'
import OsmSnapPanel, { SnapPreview } from './OsmSnapPanel'
import { GpxSnapDialog } from './Gpx'
import PhotoTab, { SeqButtons, TravelSection } from './PhotoTab'
import RideSettings from './RideSettings'
import SummaryTab from './SummaryTab'
import JobBar from './JobBar'
import { ConfirmExclude, ConfirmInterpolate, HelpDialog, RangeValueDialog } from './ProjectDialogs'
import { contextMenuItems, MenuContext, SnapOpen, ValueDlg } from './contextMenuItems'
import { useShortcuts } from './shortcuts'
import { useIssues } from './useIssues'
import { t, useLang } from './i18n'

// Small displacements (local flat approximation, enough for a few hundred meters)
const M_PER_DEG = 111320
function metersBetween(lat0: number, lon0: number, lat1: number, lon1: number): { east: number; north: number } {
  return { north: (lat1 - lat0) * M_PER_DEG, east: (lon1 - lon0) * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180) }
}
function shifted(lat: number, lon: number, east: number, north: number): { lat: number; lon: number } {
  return { lat: lat + north / M_PER_DEG, lon: lon + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)) }
}

type Tab = StepTab

export default function ProjectView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const lang = useLang() // re-render (menus, help) when the language changes
  const [project, setProject] = useState<Project | null>(null)
  const isPnx = project?.kind === 'panoramax' // sequences already published: corrections only, no cut, no export
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [undoState, setUndoState] = useState<UndoState>({ undo: null, redo: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  // Manual sequence: index of the photo marked "Début"; the range follows the navigation until "Fin"
  const [seqStart, setSeqStart] = useState<number | null>(null)
  const [viewYaw, setViewYaw] = useState(0) // 360° viewer direction relative to the front
  const [overlay, setOverlayState] = useState<OverlaySettings>(loadOverlay)
  // "Suivre" (default): the map keeps the current photo in its centre while browsing
  const [follow, setFollowState] = useState(() => {
    try {
      return localStorage.getItem('pss-follow') !== '0' // on by default
    } catch {
      return true
    }
  })
  const setFollow = (v: boolean) => {
    setFollowState(v)
    try {
      localStorage.setItem('pss-follow', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // Excluded photos: hidden on the map and skipped by ← → unless shown
  const [showExcluded, setShowExcludedState] = useState(() => {
    try {
      return localStorage.getItem('pss-show-excluded') === '1'
    } catch {
      return false
    }
  })
  const setShowExcluded = (v: boolean) => {
    setShowExcludedState(v)
    try {
      localStorage.setItem('pss-show-excluded', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // Positions mode: → carries the current photo's correction (offset from its original position) to the next photo
  const [carryPos, setCarryPosState] = useState(() => {
    try {
      return localStorage.getItem('pss-carry-position') !== '0' // on by default
    } catch {
      return true
    }
  })
  const setCarryPos = (v: boolean) => {
    setCarryPosState(v)
    try {
      localStorage.setItem('pss-carry-position', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  const mapPhotos = useMemo(() => (showExcluded ? photos : photos.filter((p) => !p.excluded)), [photos, showExcluded])
  const [centerTick, setCenterTick] = useState(0)
  // OSM snapping of a range: panel shown above the photo tab, preview on the map
  const [snapOpen, setSnapOpen] = useState<SnapOpen | null>(null)
  // context menu (right click) on the map, the timeline or a sequence
  const [ctx, setCtx] = useState<MenuContext | null>(null)
  const [snapPreview, setSnapPreview] = useState<SnapPreview | null>(null)
  const [snapHighlight, setSnapHighlight] = useState<[number, number] | null>(null) // photos the snapping panel works on
  const setOverlay = (o: OverlaySettings) => {
    setOverlayState(o)
    saveOverlay(o)
  }
  const anchor = useRef<number | null>(null)
  // Reopening a project: back to the same photo, tab (and timeline zoom, see Timeline) as when it was left
  const viewKey = `pss-view-${projectId}`
  const savedView = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(viewKey) || '{}') as { photo?: number; tab?: Tab }
    } catch {
      return {}
    }
  }, [viewKey])
  const [tab, setTab] = useState<Tab>(!savedView.tab || (savedView.tab as string) === 'photo' ? 'gps' : savedView.tab)
  const [showImport, setShowImport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [confirmExclude, setConfirmExclude] = useState<{ range: [number, number]; n: number } | null>(null)
  const [addingBasemap, setAddingBasemap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // heading offset / orientation of a series of photos (context menu)
  const [valueDlg, setValueDlg] = useState<ValueDlg | null>(null)
  const [stopCompare, setStopCompare] = useState<[number, number] | null>(null) // photos of a stop side by side
  const [editMode, setEditMode] = useState(false)
  const [track, setTrack] = useState<Track | null>(null)
  // imported GPX (summary), and the dialog projecting a range of photos onto its line (with the line on the map)
  const [gpx, setGpx] = useState<GpxSummary | null>(null)
  const [gpxSnap, setGpxSnap] = useState<[number, number] | null>(null)
  const [gpxLine, setGpxLine] = useState<Track | null>(null)
  useEffect(() => {
    api.gpx(projectId).then((r) => setGpx(r.gpx), () => undefined)
  }, [projectId])
  useEffect(() => {
    if (!gpxSnap) return setGpxLine(null)
    api.gpxTrack(projectId).then((r) => setGpxLine(r.runs), (e) => setError(e.message))
  }, [gpxSnap, projectId])
  // proposed photos to project onto the GPX: the selection, else the current photo's sequence, else the whole ride
  const openGpxSnap = (r?: [number, number]) => {
    const seq = current?.sequence_id != null ? sequences.find((x) => x.id === current.sequence_id) : undefined
    setGpxSnap(r ?? (range && range[1] > range[0] ? range : seq ? [seq.start_idx, seq.end_idx] : [0, Math.max(0, photos.length - 1)]))
  }
  const [syncOffset, setSyncOffset] = useState<number | null>(null)
  const [syncDragged, setSyncDragged] = useState<{ photoId: number; offset: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { custom, add: addBasemap, remove: removeBasemap } = useCustomBasemaps()
  const basemaps = useMemo(() => [...builtinBasemaps(), ...custom], [custom, lang])
  const [basemapId, setBasemapId] = useState(() => {
    try {
      return localStorage.getItem('pss-basemap') || 'osm'
    } catch {
      return 'osm'
    }
  })
  const basemap = basemaps.find((b) => b.id === basemapId) ?? basemaps[0]
  const [panelWidth, setPanelWidth] = useState(400)
  const lastPhotosKey = useRef('')

  const byIdx = photos
  const goIdxRef = useRef<(idx: number) => void>(() => undefined)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !photos.length) return
    restored.current = true
    const p = photos.find((x) => x.id === savedView.photo)
    if (p) {
      setSelected(p.id)
      anchor.current = p.idx
    }
  }, [photos, savedView])
  useEffect(() => {
    if (!restored.current) return
    try {
      localStorage.setItem(viewKey, JSON.stringify({ photo: selected ?? undefined, tab }))
    } catch {
      /* ignore */
    }
  }, [viewKey, selected, tab])
  // a Panoramax project has no Sequences nor Export step (tab of an older version, or of a ride, remembered)
  useEffect(() => {
    if (isPnx && (tab === 'export' || tab === 'sequences')) setTab('send')
  }, [isPnx, tab])
  const current = useMemo(() => photos.find((p) => p.id === selected) ?? null, [photos, selected])

  const reloadPhotos = useCallback(async () => setPhotos(await api.photos(projectId)), [projectId])
  const refresh = useCallback(async () => {
    try {
      const p = await api.project(projectId)
      setProject(p)
      const key = `${p.summary.total}-${p.summary.thumbs_done}-${p.summary.thumbs_failed}-${p.summary.gps_jumps}-${p.summary.missing_files}`
      if (key !== lastPhotosKey.current) {
        lastPhotosKey.current = key
        await reloadPhotos()
        const s = await api.sequences(projectId)
        setSequences(s.sequences)
        setUndoState(s.undo)
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectId, reloadPhotos])

  useEffect(() => {
    refresh()
  }, [refresh])

  const running = project?.jobs.some((j) => j.state === 'running')
  // When a job ends (export…), the sequences' export state may have changed. Keyed on the finished jobs, so that a
  // job that ends before the first poll (a short re-export) is not missed.
  const finishedJobs = (project?.jobs ?? []).filter((j) => j.state !== 'running').map((j) => j.id).join(',')
  const lastFinished = useRef<string | null>(null)
  useEffect(() => {
    if (!project) return
    if (lastFinished.current != null && lastFinished.current !== finishedJobs)
      api.sequences(projectId).then((s) => {
        setSequences(s.sequences)
        setUndoState(s.undo)
      }, () => undefined)
    lastFinished.current = finishedJobs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedJobs, projectId])
  useEffect(() => {
    if (!running) return
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
  }, [running, refresh])

  // After any edit: sequences/undo state from the response, photos reloaded (colours, headings)
  const applyState = useCallback(
    async (s: SeqState & { done?: string }) => {
      setSequences(s.sequences)
      setUndoState(s.undo)
      if (s.done) setNotice(s.done)
      await reloadPhotos()
      api.project(projectId).then(setProject, () => undefined)
    },
    [projectId, reloadPhotos],
  )
  const afterHeadingChange = useCallback(
    async (u?: UndoState) => {
      if (u) setUndoState(u)
      await reloadPhotos()
      const s = await api.sequences(projectId)
      setSequences(s.sequences)
      setUndoState(s.undo)
    },
    [projectId, reloadPhotos],
  )
  const fail = useCallback((m: string) => setError(m), [])
  const {
    quality,
    setQuality,
    checkPoints,
    issuesByStep,
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
  } = useIssues({
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
  })

  // Time synchronisation: track loaded when the tab opens (and after imports)
  const photoCount = photos.length
  useEffect(() => {
    if (tab !== 'sync') return
    api.track(projectId).then((t) => setTrack(t.runs), (e) => setError(e.message))
  }, [tab, projectId, photoCount, gpx?.in_use, gpx?.shift_s, gpx?.name])
  // photos the offset would move (scope of the Synchro tab): only they are previewed on the map
  const [syncIds, setSyncIds] = useState<Set<number> | null>(null)
  const sync = useMemo(() => (tab === 'sync' && track ? { track, offset: syncOffset, ids: syncIds } : null), [tab, track, syncOffset, syncIds])
  const onSyncOffset = useCallback(
    (offset: number, final: boolean) => {
      setSyncOffset(offset)
      if (!final || selected == null) return
      // Authoritative value from the backend (same projection, geodesic)
      const p = photos.find((x) => x.id === selected)
      const pos = p && p.ts != null && track ? positionAt(track, p.ts + offset) : null
      setSyncDragged({ photoId: selected, offset })
      if (pos)
        api.syncOffset(projectId, selected, pos[0], pos[1]).then((r) => {
          setSyncOffset(r.offset_s)
          setSyncDragged({ photoId: selected, offset: r.offset_s })
        }, () => undefined)
    },
    [selected, photos, track, projectId],
  )

  useEffect(() => {
    if (selected == null) {
      setDetail(null)
      return
    }
    api.photo(projectId, selected).then(setDetail, () => setDetail(null))
  }, [projectId, selected, photos])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(t)
  }, [notice])

  const goIdx = useCallback(
    (idx: number, extend = false) => {
      if (!byIdx.length) return
      const i = Math.max(0, Math.min(byIdx.length - 1, idx))
      setSelected(byIdx[i].id)
      if (extend && anchor.current != null) {
        setSeqStart(null)
        setRange([Math.min(anchor.current, i), Math.max(anchor.current, i)])
      } else anchor.current = i
    },
    [byIdx],
  )
  goIdxRef.current = goIdx

  // Last position correction made by hand (east / north m), and the photo that holds it now (moved by hand, or
  // carried to with →) with its expected position: the rows may not be reloaded yet when → is pressed right away
  const lastCarry = useRef<{ id: number; east: number; north: number; lat: number; lon: number } | null>(null)
  const undoRedo = useCallback(
    (which: 'undo' | 'redo') => {
      lastCarry.current = null
      return (which === 'undo' ? api.undo(projectId) : api.redo(projectId)).then(applyState, (e) => setError(e.message))
    },
    [projectId, applyState],
  )

  const markStart = useCallback(() => {
    if (!current) return
    setSeqStart(current.idx)
    setRange([current.idx, current.idx])
    anchor.current = current.idx
    setNotice(t('pv.markStart', { n: current.idx + 1 }))
  }, [current])
  // Index reached by moving `count` photos from idx in direction dir, skipping excluded photos unless shown
  const stepIdx = useCallback(
    (idx: number, dir: 1 | -1, count = 1) => {
      if (showExcluded) return idx + dir * count
      let i = idx
      let last = idx
      for (let left = count; left > 0; ) {
        i += dir
        if (i < 0 || i >= photos.length) break
        if (!photos[i].excluded) {
          last = i
          left--
        }
      }
      return last
    },
    [photos, showExcluded],
  )
  // First photo after idx that is not excluded
  const nextKept = useCallback((idx: number) => photos.slice(idx + 1).find((p) => !p.excluded) ?? null, [photos])
  const finishSequence = useCallback(() => {
    // from the marked start (or a range drawn on the timeline) to the current photo
    const r: [number, number] | null =
      seqStart != null && current ? [Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)] : range
    if (!r) {
      setError(t('pv.markStartFirst'))
      return
    }
    api.createSequence(projectId, r[0], r[1]).then((s) => {
      // Chain: the next photo not excluded becomes the start of the next sequence (unless it already belongs to one)
      const next = nextKept(r[1])
      const chain = next != null && next.sequence_id == null
      applyState({
        ...s,
        done: t('menu.seqCreated', { from: r[0] + 1, to: r[1] + 1 }) + (chain ? t('pv.nextStart', { n: next!.idx + 1 }) : ''),
      })
      if (chain) {
        setSeqStart(next.idx)
        setRange([next.idx, next.idx])
        anchor.current = next.idx
        setSelected(next.id)
      } else {
        setRange(null)
        setSeqStart(null)
      }
    }, (er) => setError(er.message))
  }, [seqStart, current, range, projectId, applyState, nextKept])
  // While a start is marked, the range follows the current photo
  useEffect(() => {
    if (seqStart == null || !current) return
    setRange([Math.min(seqStart, current.idx), Math.max(seqStart, current.idx)])
  }, [seqStart, current])

  // Same correction applied to `to`: the shift last made by hand (drop position minus position before the drag),
  // carried along the → presses; photos corrected by hand are never moved
  const carryCorrection = useCallback(
    (from: PhotoRow, to: PhotoRow | undefined) => {
      const c = lastCarry.current
      if (!c || c.id !== from.id || !to || to.pos_method === 'manual' || to.lat == null || to.lon == null) return
      const { east, north } = c
      if (Math.hypot(east, north) < 0.05 || Math.abs(east) > 1000 || Math.abs(north) > 1000) return
      const r2 = (v: number) => Math.round(v * 100) / 100
      lastCarry.current = { id: to.id, east, north, ...shifted(to.lat, to.lon, east, north) }
      api.positionsBatch(projectId, { start_idx: to.idx, end_idx: to.idx, mode: 'offset', east_m: r2(east), north_m: r2(north) }).then((r) => {
        afterHeadingChange(r.undo)
        setNotice(t('pv.carried', { n: to.idx + 1, m: Math.round(Math.hypot(east, north) * 10) / 10 }))
      }, (er) => setError(er.message))
    },
    [projectId, afterHeadingChange],
  )

  const excludeRange = useCallback(
    (r: [number, number], n: number) =>
      api.excludePhotos(projectId, { start_idx: r[0], end_idx: r[1] }).then((s) => {
        applyState({ ...s, done: t('pv.excludedN', { n }) })
        setRange(null)
      }, (er) => setError(er.message)),
    [projectId, applyState],
  )

  // Keyboard shortcuts
  useShortcuts({
    projectId,
    photos,
    sequences,
    current,
    detail,
    range,
    seqStart,
    isPnx,
    showExcluded,
    editMode,
    carryPos,
    checkPoints,
    blocked: !!(showImport || confirmExclude || addingBasemap || stopCompare || valueDlg || confirmInterp || showSettings || gpxSnap),
    showHelp,
    setShowHelp,
    setEditMode,
    setSeqStart,
    setRange,
    setConfirmExclude,
    setNotice,
    setError,
    goIdx,
    stepIdx,
    nextKept,
    applyState,
    afterHeadingChange,
    undoRedo,
    markStart,
    finishSequence,
    carryCorrection,
    focusOn,
    excludeRange,
    tabs: stepTabs(isPnx),
    setTab,
  })

  // Right click on a photo of the map / timeline: the selection if the photo is in it, otherwise this photo
  const photosContext = (idx: number | null, x: number, y: number) => {
    if (range && (idx == null || (idx >= range[0] && idx <= range[1]))) setCtx({ x, y, kind: 'photos', range })
    else if (idx != null) {
      goIdx(idx)
      setCtx({ x, y, kind: 'photos', range: [idx, idx] })
    }
  }
  const ctxItems = () =>
    contextMenuItems(ctx, {
      projectId,
      photos,
      sequences,
      gpx,
      isPnx,
      goIdx,
      openSnap: setSnapOpen,
      openGpxSnap,
      openValueDlg: setValueDlg,
      applyState,
      clearSelection: () => {
        setRange(null)
        setSeqStart(null)
      },
      onError: (m) => setError(m),
    })

  const chooseBasemap = (id: string) => {
    if (id === '__add') {
      setAddingBasemap(true)
      return
    }
    setBasemapId(id)
    try {
      localStorage.setItem('pss-basemap', id)
    } catch {
      /* ignore */
    }
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    const move = (ev: MouseEvent) => setPanelWidth(Math.max(280, Math.min(window.innerWidth * 0.65, startW - (ev.clientX - startX))))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!project) return <div className="home">{error ? <p className="error">{error}</p> : t('pv.loading')}</div>

  // Whole-ride settings, at the top of « Sens de déplacement et orientation » (Photo tab)
  const rideSettings = (
    <RideSettings
      project={project}
      onDone={(u) => {
        afterHeadingChange(u)
        refresh()
      }}
      onError={fail}
    />
  )

  // Top of a step's tab: the card of the issue being corrected (if it belongs to this step), then what is left to fix
  const issuesOf = (step: IssueStep) => (
    <>
      {focusPoint && stepOf(focusPoint.kind) === step && (
              <CheckCard
                issue={focusLive ?? focusPoint}
                fixed={!focusLive}
                index={focusLive ? checkPoints.indexOf(focusLive) : -1}
                total={checkPoints.length}
                detail={detail}
                editMode={editMode}
                interpolable={canInterpolate(focusPoint, photos)}
                onPositions={() => setEditMode(true)}
                onCompare={() => setStopCompare(stopAdj ?? [focusPoint.start, focusPoint.end])}
                stopEditor={
                  focusPoint.kind === 'stop' && stopAdj
                    ? {
                        photos,
                        range: stopAdj,
                        currentIdx: current?.idx ?? null,
                        onRange: (r) => {
                          setStopAdj(r)
                          setRange(r)
                          if (current && (current.idx < r[0] || current.idx > r[1])) goIdx(Math.min(Math.max(current.idx, r[0]), r[1]))
                        },
                        onGo: (i) => {
                          if (i < stopAdj[0] || i > stopAdj[1]) {
                            const r: [number, number] = [Math.min(stopAdj[0], i), Math.max(stopAdj[1], i)]
                            setStopAdj(r)
                            setRange(r)
                          }
                          goIdx(i)
                          setCenterTick((t) => t + 1)
                        },
                      }
                    : undefined
                }
                onAction={fixIssue}
                onNext={nextIssue}
                onClose={() => setFocusPoint(null)}
              />
      )}
      {(step !== 'seq' || issuesByStep.seq.length > 0) && (
        <IssuesPanel
          step={step}
          issues={issuesByStep[step]}
          current={focusPoint}
          duplicates={project.summary.duplicates}
          onPick={focusOn}
          onIgnore={(i: Issue) => ignoreHeadings(photos.slice(i.start, i.end + 1).filter((p) => !p.excluded).map((p) => p.id))}
          onInterpolateAll={askInterpolateAll}
        />
      )}
    </>
  )

  return (
    <div className="workspace">
      <header className="toolbar">
        <div className="tool-group" role="group" aria-label={t('pv.grpProject')}>
          <span className="tool-group-label">{t('pv.grpProject')}</span>
        <button className="brand-back" onClick={onBack} title={t('pv.backTitle')} aria-label={t('pv.back')}>
          ← <img src="/logo.svg" alt="" width="20" height="20" />
        </button>
        <strong className="ellipsis project-title" title={project.name}>
          {project.name}
        </strong>
        {isPnx ? (
          <span className="badge" title={t('pv.pnxBadge', { instance: project.pnx_instance ?? 'Panoramax' })}>
            {t('pv.pnxBadgeLabel')}
          </span>
        ) : (
          <button className="primary" onClick={() => setShowImport(true)}>
            {t('pv.import')}
          </button>
        )}
        </div>
        <span className="tool-sep" />
        <div className="tool-group" role="group" aria-label={t('pv.grpEdit')}>
          <span className="tool-group-label">{t('pv.grpEdit')}</span>
          <div className="btn-group">
            <button disabled={!undoState.undo} onClick={() => undoRedo('undo')} title={undoState.undo ? t('pv.undoTitle', { name: undoState.undo }) : t('pv.nothingUndo')}>
              {t('pv.undo')}
            </button>
            <button disabled={!undoState.redo} onClick={() => undoRedo('redo')} title={undoState.redo ? t('pv.redoTitle', { name: undoState.redo }) : t('pv.nothingRedo')}>
              {t('pv.redo')}
            </button>
          </div>
          {!isPnx && (
            <div className="btn-group" role="group" aria-label={t('pv.cutGroup')}>
              <SeqButtons current={current} seqStart={seqStart} range={range} onStart={markStart} onFinish={finishSequence} />
            </div>
          )}
        </div>
        <span className="tool-sep" />
        <div className="tool-group" role="group" aria-label={t('pv.grpMode')}>
          <span className="tool-group-label">{t('pv.grpMode')}</span>
          <button
            className={editMode ? 'primary mode-on' : ''}
            aria-pressed={editMode}
            onClick={() => setEditMode(!editMode)}
            title={t('pv.positionsTitle')}
          >
            {t('pv.positions')}
          </button>
        </div>
        <span className="spacer" />
        {notice && <div className="toast small-text">✓ {notice}</div>}
        <button onClick={() => setShowSettings(true)} title={t('settings.buttonTitle')}>
          {t('settings.heading')}
        </button>
        <button onClick={() => setShowHelp(true)} title={t('help.button')} aria-label={t('help.title')}>
          ?
        </button>
      </header>
      {editMode && (
        <div className="mode-banner small-text" role="status">
          <strong>{t('pv.modeBanner')}</strong>
          <button className="small" onClick={() => setEditMode(false)}>
            {t('pv.modeExit')}
          </button>
        </div>
      )}
      <Tips onHelp={() => setShowHelp(true)} />
      <StepBar
        project={project}
        photos={photos}
        sequences={sequences}
        quality={quality}
        tab={tab}
        onTab={setTab}
      />
      {error && (
        <div className="error banner" onClick={() => setError(null)}>
          {error} <span className="muted">(cliquer pour fermer)</span>
        </div>
      )}
      <main className="main" style={{ gridTemplateColumns: `1fr 6px ${panelWidth}px` }}>
        <div className="center">
          <div className="map-area">
          <PhotoMap
            onContextMenu={(id, x, y) => photosContext(id == null ? null : photos.find((p) => p.id === id)?.idx ?? null, x, y)}
            photos={mapPhotos}
            sequences={sequences}
            basemap={basemap}
            selectedId={selected}
            range={snapOpen && snapHighlight ? snapHighlight : range}
            editMode={editMode}
            sync={sync}
            overlay={overlay}
            follow={follow}
            centerTick={centerTick}
            snapPreview={snapPreview}
            lineTrack={gpxLine}
            viewAzimuth={(tab === 'sync' || tab === 'gps') && current?.heading != null ? (((current.heading + viewYaw) % 360) + 360) % 360 : null}
            viewYaw={tab === 'sync' ? viewYaw : 0}
            onSyncOffset={onSyncOffset}
            onSelect={(id, extend) => {
              const p = photos.find((x) => x.id === id)
              if (p) goIdx(p.idx, extend)
            }}
            onMove={(id, lat, lon) => {
              // remembered at once (→ may be pressed before the photos are reloaded): the shift just made, added to the
              // correction this photo already carried if it is the one holding it
              const p = photos.find((x) => x.id === id)
              const c = lastCarry.current
              const before = c?.id === id ? { lat: c.lat, lon: c.lon } : p?.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : null
              if (before) {
                const d = metersBetween(before.lat, before.lon, lat, lon)
                const base = c?.id === id ? c : { east: 0, north: 0 }
                lastCarry.current = { id, east: base.east + d.east, north: base.north + d.north, lat, lon }
              } else lastCarry.current = null
              api.setPosition(projectId, id, lat, lon).then((r) => afterHeadingChange(r.undo), (er) => setError(er.message))
            }}
          />
          <MapLegend panoramax={overlay.enabled ? overlay.url : null} />
          {(seqStart != null || (range && range[1] > range[0])) && !snapOpen && (
            <div className="selection-chip small-text" role="status">
              {seqStart != null ? (
                <>
                  <strong>{t('pv.selStart', { n: seqStart + 1 })}</strong>
                  {current && current.idx !== seqStart ? t('pv.selStartTo', { to: current.idx + 1, n: Math.abs(current.idx - seqStart) + 1 }) : ''}
                  {t('pv.selStartHelp')}
                </>
              ) : (
                range && (
                  <>
                    <strong>
                      {t('pv.selRange', { a: range[0] + 1, b: range[1] + 1 })}
                    </strong>{' '}
                    {t('pv.selRangeHelp', { n: range[1] - range[0] + 1 })}
                  </>
                )
              )}
              <button
                className="small"
                onClick={() => {
                  setSeqStart(null)
                  setRange(null)
                }}
                title={t('pv.deselectTitle')}
              >
                {t('pv.deselect')}
              </button>
            </div>
          )}
          </div>
          <div className="map-follow small-text">
            <button
              className={overlay.enabled ? 'small primary' : 'small'}
              aria-pressed={overlay.enabled}
              onClick={() => setOverlay({ ...overlay, enabled: !overlay.enabled })}
              title={t('pv.overlayTitle', { url: overlay.url })}
            >
              Panoramax
            </button>
            <select className="small" value={basemap.id} onChange={(e) => chooseBasemap(e.target.value)} aria-label={t('pv.basemap')} title={t('pv.basemap')}>
              {basemaps.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value="__add">{t('pv.addBasemap')}</option>
            </select>
            <span className="tool-sep" />
            <button className="small" disabled={!current} onClick={() => setCenterTick((n) => n + 1)} title={t('pv.centerTitle')}>
              {t('pv.center')}
            </button>
            <label title={t('pv.followTitle')}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t('pv.follow')}
            </label>
            <label title={t('pv.excludedTitle')}>
              <input type="checkbox" checked={showExcluded} onChange={(e) => { setShowExcluded(e.target.checked); e.target.blur() }} /> {t('pv.excluded')}
            </label>
            {editMode && (
              <label title={t('pv.carryTitle')}>
                <input type="checkbox" checked={carryPos} onChange={(e) => { setCarryPos(e.target.checked); e.target.blur() }} /> {t('pv.carry')}
              </label>
            )}
          </div>
            {snapOpen && (
              <OsmSnapPanel
                key={`${snapOpen.scope}-${snapOpen.sequenceId}-${snapOpen.bounds?.join('-')}`}
                projectId={projectId}
                initialScope={snapOpen.scope}
                initialBounds={snapOpen.bounds}
                sequenceId={snapOpen.sequenceId}
                timelineRange={seqStart == null ? range : null}
                current={current}
                sequences={sequences}
                photos={photos}
                onPreview={setSnapPreview}
                onRange={setSnapHighlight}
                onDone={(u, moved) => {
                  setSnapOpen(null)
                  setNotice(t('pv.snapped', { n: moved }))
                  afterHeadingChange(u)
                }}
                onClose={() => setSnapOpen(null)}
                onError={fail}
              />
            )}
          <div className="tl-head">
            <span title={t('tl.labelTitle')}>{t('tl.label')}</span>
            <button className="small" onClick={() => setShowHelp(true)} title={t('tl.helpBtn')} aria-label={t('tl.helpBtn')}>
              ?
            </button>
          </div>
          <Timeline
            photos={photos}
            sequences={sequences}
            selectedIdx={current?.idx ?? null}
            range={snapOpen && snapHighlight ? snapHighlight : range}
            onPick={goIdx}
            onContextMenu={photosContext}
            warnings={quality}
            thumbUrl={(id) => api.thumbUrl(projectId, id)}
            storageKey={`pss-timeline-${projectId}`}
            hideExcluded={!showExcluded}
          />
          {ctx && <ContextMenu x={ctx.x} y={ctx.y} {...ctxItems()} onClose={() => setCtx(null)} />}
        </div>
        <div className="resizer" onMouseDown={startResize} title={t('pv.resize')} />
        <aside className="side">
          <div className="tab-body">
            {tab === 'dups' && issuesOf('dups')}
            {tab === 'gps' &&
              (detail ? (
                <PhotoTab
                  issues={issuesOf('gps')}
                  ride={rideSettings}
                  projectId={projectId}
                  photo={detail}
                  count={photos.length}
                  sequences={sequences}
                  range={range}
                  onView={setViewYaw}
                  onChanged={afterHeadingChange}
                  onError={fail}
                />
              ) : photos.length ? (
                <>
                  {issuesOf('gps')}
                  <p className="muted">{t('pv.pickPhoto')}</p>
                  <TravelSection ride={rideSettings} />
                </>
              ) : (
                <p className="muted">{t('pv.importFirst')}</p>
              ))}
            {tab === 'sequences' && issuesOf('seq')}
            {tab === 'sequences' && !isPnx && (
              <SequencesTab
                pnx={isPnx}
                onCut={() => current && api.cutAt(projectId, current.id).then(applyState, (er) => setError(er.message))}
                onSeqContext={(sq, x, y) => setCtx({ x, y, kind: 'sequence', sequenceId: sq.id })}
                projectId={projectId}
                sequences={sequences}
                current={current}
                range={range}
                onState={(s) => {
                  applyState(s)
                  setRange(null)
                }}
                onGo={(idx) => goIdx(idx)}
                onRefresh={() => {
                  setNotice(t('pv.orientFixed'))
                  afterHeadingChange()
                }}
                onExported={() => {
                  setNotice(t('pv.reexportStarted'))
                  refresh()
                }}
                onError={fail}
              />
            )}
            {tab === 'sync' && (
              <SyncTab
                onPreviewIds={setSyncIds}
                gpx={gpx}
                onGpx={(g) => {
                  setGpx(g)
                  setNotice(g ? (g.in_use ? t('pv.syncGpx', { name: g.name }) : t('pv.syncCamera')) : t('pv.gpxRemoved'))
                }}
                onGpxSnap={() => openGpxSnap()}
                onView={setViewYaw}
                projectId={projectId}
                photo={detail}
                photos={photos}
                sequences={sequences}
                range={range}
                offset={syncOffset}
                dragged={syncDragged}
                onOffset={setSyncOffset}
                onGo={(idx) => goIdx(idx)}
                onApplied={() => {
                  afterHeadingChange()
                  api.project(projectId).then(setProject, () => undefined)
                }}
                onNotice={setNotice}
                onError={fail}
              />
            )}
            {tab === 'send' && isPnx && (
              <SendTab projectId={projectId} instance={project.pnx_instance} sequences={sequences} onStarted={refresh} onError={fail} />
            )}
            {tab === 'send' && !isPnx && (
              <PublishTab projectId={projectId} sequences={sequences} jobs={project.jobs} onStarted={refresh} onError={fail} />
            )}
            {tab === 'export' && !isPnx && (
              <ExportTab
                projectId={projectId}
                sequences={sequences}
                jobs={project.jobs}
                sources={project.sources}
                excludedPhotos={project.summary.excluded}
                clock={project.summary.clock}
                onStarted={refresh}
                onError={fail}
              />
            )}
            {tab === 'summary' && (
              <SummaryTab
                links={{
                  gps: issuesByStep.gps.length ? () => setTab('gps') : null,
                  dups: issuesByStep.dups.length ? () => setTab('dups') : null,
                  excluded: showExcluded ? null : () => setShowExcluded(true),
                }}
                projectId={projectId}
                project={project}
                isPnx={isPnx} onRefresh={refresh} onSettings={() => setShowSettings(true)} />
            )}
          </div>
        </aside>
      </main>
      <JobBar jobs={project.jobs} projectId={projectId} projectName={project.name} />
      {showImport && <ImportDialog projectId={projectId} onClose={() => setShowImport(false)} onStarted={refresh} />}
      {confirmInterp && (
        <ConfirmInterpolate
          ids={confirmInterp}
          onCancel={() => setConfirmInterp(null)}
          onConfirm={() => {
            interpolateAll(confirmInterp)
            setConfirmInterp(null)
          }}
        />
      )}
      {confirmExclude && (
        <ConfirmExclude
          range={confirmExclude.range}
          n={confirmExclude.n}
          onCancel={() => setConfirmExclude(null)}
          onConfirm={() => {
            excludeRange(confirmExclude.range, confirmExclude.n)
            setConfirmExclude(null)
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          project={project}
          overlay={overlay}
          onOverlay={setOverlay}
          custom={custom}
          onRemoveBasemap={(id) => {
            removeBasemap(id)
            if (basemapId === id) chooseBasemap('osm')
          }}
          onHeadingSource={(u) => {
            afterHeadingChange(u)
            refresh()
          }}
          onHeadingsSaved={() => {
            setNotice(t('pv.headingsRecomputed'))
            lastPhotosKey.current = ''
            refresh()
          }}
          onQualitySaved={() => {
            api.project(projectId).then(setProject, () => undefined)
            api.quality(projectId).then(setQuality, (e) => setError(e.message))
            setNotice(t('pv.thresholdsSaved'))
          }}
          onError={fail}
          onClose={() => setShowSettings(false)}
        />
      )}
      {valueDlg && (
        <RangeValueDialog
          projectId={projectId}
          dlg={valueDlg}
          onClose={() => setValueDlg(null)}
          onDone={(u, msg) => {
            afterHeadingChange(u)
            setNotice(msg)
          }}
          onError={(m) => setError(m)}
        />
      )}
      {addingBasemap && (
        <AddBasemap
          onCancel={() => setAddingBasemap(false)}
          onAdd={(name, url, attribution) => {
            const b = addBasemap(name, url, attribution)
            setAddingBasemap(false)
            chooseBasemap(b.id)
          }}
        />
      )}
      {gpxSnap && (
        <GpxSnapDialog
          projectId={projectId}
          photos={photos.length}
          initial={gpxSnap}
          sequences={sequences}
          onClose={() => setGpxSnap(null)}
          onPreview={setSnapPreview}
          onError={fail}
          onDone={(msg, u) => {
            setGpxSnap(null)
            setNotice(msg)
            afterHeadingChange(u)
          }}
        />
      )}
      {stopCompare && (
        <StopCompare
          projectId={projectId}
          photos={photos}
          range={stopCompare}
          onClose={() => setStopCompare(null)}
          onGo={(idx) => {
            setStopCompare(null)
            goIdx(idx)
          }}
          onDone={(s, n) => {
            setStopCompare(null)
            applyState({ ...s, done: t('pv.stopExcluded', { n }) })
          }}
          onError={fail}
        />
      )}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    </div>
  )
}
