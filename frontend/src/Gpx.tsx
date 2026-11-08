import { useEffect, useState } from 'react'
import { api, FsListing, GpxSnapStats, GpxSummary, UndoState } from './api'
import type { SnapPreview } from './OsmSnapPanel'
import { useDraggable } from './useDraggable'
import { Confirm } from './Dialogs'
import FsBrowser from './FsBrowser'
import { fmtDistance, fmtTime } from './format'
import { Key, t, useLang } from './i18n'

const LAST_DIR = 'pss-last-gpx-dir'

// Choose a .gpx file on this machine (served by the backend, like the photo folders)
export function GpxFilePicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  useLang()
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const go = (path: string) =>
    api.fs(path, '.gpx').then(
      (l) => {
        setListing(l)
        setError(null)
        try {
          localStorage.setItem(LAST_DIR, l.path)
        } catch {
          /* ignore */
        }
      },
      (e) => setError(e.message),
    )
  // keys stay in the window: arrows must not change the photo behind it; Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      e.stopImmediatePropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  useEffect(() => {
    let start = '~'
    try {
      start = localStorage.getItem(LAST_DIR) || '~'
    } catch {
      /* ignore */
    }
    go(start).catch(() => go('~'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={t('gpx.pick.title')}>
        <h2>{t('gpx.pick.title')}</h2>
        <p className="muted small-text">
          {t('gpx.pick.help')}
        </p>
        <FsBrowser listing={listing} error={error} onGo={go} onFile={onPick} />
        <div className="actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

const fmtShift = (s: number) => {
  const sign = s < 0 ? '−' : '+'
  const a = Math.abs(s)
  const h = Math.floor(a / 3600)
  const m = Math.round((a % 3600) / 60)
  return `${sign}${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`
}
const shiftFrom = (k: string) => (['gps', 'positions', 'manual', 'none'].includes(k) ? t(`gpx.from.${k}` as Key) : '')

// Synchro tab: the reference track (camera GPS or imported GPX), import / choose / forget the GPX
export function GpxSection({
  projectId,
  gpx,
  onChanged,
  onSnap,
  onError,
}: {
  projectId: string
  gpx: GpxSummary | null
  onChanged: (g: GpxSummary | null) => void // the track of the sync changed: reload it
  onSnap: () => void // open the « project onto the GPX line » dialog
  onError: (m: string) => void
}) {
  useLang()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [forget, setForget] = useState(false)
  const [shiftEdit, setShiftEdit] = useState<string | null>(null) // hours being typed
  const run = (p: Promise<{ gpx: GpxSummary | null }>) => {
    setBusy(true)
    p.then((r) => onChanged(r.gpx), (e) => onError(e.message)).finally(() => setBusy(false))
  }
  const saveShift = () => {
    const h = Number((shiftEdit ?? '').replace(',', '.').replace('−', '-'))
    if (!Number.isFinite(h) || Math.abs(h) > 15) return onError(t('gpx.shiftInvalid'))
    setShiftEdit(null)
    run(api.gpxPatch(projectId, { shift_s: Math.round(h * 3600) }))
  }
  return (
    <section className="gpx-section">
      <h3>{t('gpx.ref')}</h3>
      <div className="row wrap">
        <label>
          <input type="radio" checked={!gpx?.in_use} disabled={busy} onChange={() => gpx && run(api.gpxPatch(projectId, { in_use: false }))} /> {t('gpx.cameraGps')}
        </label>
        <label title={gpx ? '' : t('gpx.importFirst')}>
          <input type="radio" checked={!!gpx?.in_use} disabled={!gpx || busy} onChange={() => run(api.gpxPatch(projectId, { in_use: true }))} /> {t('gpx.track')}
          {gpx ? ` « ${gpx.name} »` : ''}
        </label>
        <span className="spacer" />
        <button className="small" disabled={busy} onClick={() => setPicking(true)}>
          {gpx ? t('gpx.other') : t('gpx.import')}
        </button>
      </div>
      {gpx && (
        <div className="small-text gpx-info">
          <div>
            {t('gpx.points', { n: gpx.points, dist: fmtDistance(gpx.length_m), a: fmtTime(gpx.start), b: fmtTime(gpx.end, false), runs: gpx.runs > 1 ? t('gpx.runs', { n: gpx.runs }) : '' })}
          </div>
          <div className={gpx.covered < gpx.photos ? 'warn-text' : ''}>
            {t('gpx.covered', { n: gpx.covered, total: gpx.photos, warn: gpx.covered === 0 ? t('gpx.coveredWarn') : '' })}
          </div>
          <div>
            {t('gpx.shift')}{' '}
            {shiftEdit == null ? (
              <>
                <strong>{fmtShift(gpx.shift_s)}</strong> ({shiftFrom(gpx.shift_from ?? 'none')}){' '}
                <button className="link small-text" onClick={() => setShiftEdit(String(gpx.shift_s / 3600))}>
                  {t('gpx.edit')}
                </button>
              </>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  saveShift()
                }}
              >
                <input autoFocus value={shiftEdit} onChange={(e) => setShiftEdit(e.target.value)} style={{ width: '5em' }} aria-label={t('gpx.shiftHours')} /> h{' '}
                <button className="small" type="submit">
                  OK
                </button>
                <button className="small" type="button" onClick={() => setShiftEdit(null)}>
                  {t('common.cancel')}
                </button>
              </form>
            )}
          </div>
          <div className="row wrap">
            <button className="small" onClick={onSnap} title={t('gpx.snapTitle')}>
              {t('gpx.snapBtn')}
            </button>
            <span className="spacer" />
            <button
              className="small"
              disabled={busy}
              onClick={() => setForget(true)}
            >
              {t('gpx.forget')}
            </button>
          </div>
        </div>
      )}
      <p className="muted small-text">
        {gpx?.in_use
          ? t('gpx.helpIn')
          : t('gpx.helpOut')}
      </p>
      {forget && gpx && (
        <Confirm
          title={t('gpx.forgetTitle')}
          confirmLabel={t('common.remove')}
          danger
          onCancel={() => setForget(false)}
          onConfirm={() => {
            setForget(false)
            run(api.gpxDelete(projectId))
          }}
        >
          <p>
            {t('gpx.forgetBody', { name: gpx.name })}
          </p>
        </Confirm>
      )}
      {picking && (
        <GpxFilePicker
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false)
            run(api.gpxImport(projectId, path))
          }}
        />
      )}
    </section>
  )
}

// Photos of a range moved onto the closest point of the GPX line (whatever the time), one undoable operation.
// Floating window (moved by its title bar): the map stays visible with the preview of the moves.
export function GpxSnapDialog({
  projectId,
  photos,
  initial,
  sequences,
  onPreview,
  onDone,
  onClose,
  onError,
}: {
  projectId: string
  photos: number // number of photos of the ride
  initial: [number, number] // range proposed (selection, sequence or whole ride)
  sequences: { id: number; name: string; start_idx: number; end_idx: number }[]
  onPreview: (p: SnapPreview | null) => void // current position → position on the GPX, drawn on the map
  onDone: (msg: string, undo: UndoState) => void
  onClose: () => void
  onError: (m: string) => void
}) {
  useLang()
  const { box, style, handlers } = useDraggable<HTMLDivElement>()
  const [range, setRange] = useState<[number, number]>(initial)
  const [maxDist, setMaxDist] = useState(30)
  const [keepManual, setKeepManual] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<GpxSnapStats | null>(null)
  // preview, recomputed when the settings change (a little after the last keystroke)
  useEffect(() => {
    let live = true
    const timer = window.setTimeout(() => {
      api.gpxSnapPreview(projectId, { start_idx: range[0], end_idx: range[1], max_dist: maxDist, keep_manual: keepManual }).then(
        (r) => {
          if (!live) return
          setStats(r)
          onPreview({
            ways: { type: 'FeatureCollection', features: [] },
            moves: {
              type: 'FeatureCollection',
              features: r.moves.flatMap(([from, to]) => [
                { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [from, to] } },
                { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: to } },
              ]),
            },
            highlight: null,
          })
        },
        (e) => live && (setStats(null), onPreview(null), onError(e.message)),
      )
    }, 300)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, range[0], range[1], maxDist, keepManual])
  useEffect(() => () => onPreview(null), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest('input, textarea, select')) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const apply = () => {
    setBusy(true)
    api
      .gpxSnap(projectId, { start_idx: range[0], end_idx: range[1], max_dist: maxDist, keep_manual: keepManual })
      .then(
        (r) =>
          onDone(
            t('gpx.snap.done', {
              moved: r.moved,
              mean: r.mean_m,
              max: r.max_m,
              far: r.too_far ? t('gpx.snap.far', { n: r.too_far }) : '',
              kept: r.kept_manual ? t('gpx.snap.kept', { n: r.kept_manual }) : '',
            }),
            r.undo,
          ),
        (e) => onError(e.message),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="snap-panel snap-modal gpx-snap small-text" ref={box} role="dialog" aria-label={t('gpx.snap.title')} style={style}>
      <div className="row between snap-title" title={t('gpx.snap.drag')} {...handlers}>
        <h3>{t('gpx.snap.title')}</h3>
        <button className="small" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      <p className="muted">
        {t('gpx.snap.help')}
      </p>
      <div className="row wrap">
        <label>
          {t('gpx.snap.photos')}{' '}
          <input type="number" min={1} max={photos} value={range[0] + 1} onChange={(e) => setRange([Math.max(0, Math.min(Number(e.target.value) - 1, range[1])), range[1]])} style={{ width: '6em' }} />
        </label>
        <label>
          →{' '}
          <input type="number" min={1} max={photos} value={range[1] + 1} onChange={(e) => setRange([range[0], Math.min(photos - 1, Math.max(Number(e.target.value) - 1, range[0]))])} style={{ width: '6em' }} />
        </label>
        <button className="link small-text" onClick={() => setRange([0, photos - 1])}>
          {t('gpx.snap.whole')}
        </button>
        {sequences.length > 0 && (
          <select
            aria-label={t('gpx.snap.sequence')}
            value=""
            onChange={(e) => {
              const sq = sequences.find((x) => x.id === Number(e.target.value))
              if (sq) setRange([sq.start_idx, sq.end_idx])
            }}
          >
            <option value="">{t('gpx.snap.sequenceOpt')}</option>
            {sequences.map((sq) => (
              <option key={sq.id} value={sq.id}>
                {sq.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row wrap">
        <label>
          {t('gpx.snap.maxDist')}{' '}
          <input type="number" min={1} max={200} value={maxDist} onChange={(e) => setMaxDist(Math.max(1, Math.min(200, Number(e.target.value) || 30)))} style={{ width: '5em' }} /> m
        </label>
        <label>
          <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} /> {t('sync.keepManual')}
        </label>
      </div>
      <p className="gpx-snap-stats">
        {stats
          ? t('gpx.snap.stats', {
              moved: stats.moved,
              mean: stats.mean_m,
              max: stats.max_m,
              far: stats.too_far ? t('gpx.snap.statFar', { n: stats.too_far }) : '',
              kept: stats.kept_manual ? t('gpx.snap.statKept', { n: stats.kept_manual }) : '',
            })
          : t('gpx.snap.computing')}
      </p>
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || !stats?.moved} onClick={apply}>
          {t('gpx.snap.apply', { n: stats ? stats.moved : '', a: range[0] + 1, b: range[1] + 1 })}
        </button>
      </div>
    </div>
  )
}
