import { useEffect, useState } from 'react'
import { locale, t, useLang } from './i18n'
import { fmtShift } from './format'
import { api, ClockCheck, ExportMode, ExportRecord, Job, seqColor, Sequence, SourcesState } from './api'
import FolderPicker from './FolderPicker'
import { publicationStates, PublishButton, PublishOptionsPanel, usePublishOptions, viewerUrl } from './Publication'

interface Props {
  projectId: string
  sequences: Sequence[]
  jobs: Job[]
  sources: SourcesState
  excludedPhotos: number // photos excluded by the user
  clock: ClockCheck // camera clock against GPS time (Bilan)
  onStarted: () => void
  onError: (msg: string) => void
}

const KEY = 'pss-export-dir'

const modes = (): { id: ExportMode; label: string; help: string }[] => [
  { id: 'copy', label: t('exp.mode.copy'), help: t('exp.mode.copyHelp') },
  { id: 'move', label: t('exp.mode.move'), help: t('exp.mode.moveHelp') },
  { id: 'in_place', label: t('exp.mode.inPlace'), help: t('exp.mode.inPlaceHelp') },
]

export default function ExportTab({ projectId, sequences, jobs, sources, excludedPhotos, clock, onStarted, onError }: Props) {
  useLang()
  // Destination: the folder of this project's last export, else the last folder typed in this browser
  const lastProjectDir = () =>
    sequences
      .filter((s) => s.last_export?.out_dir && s.last_export.mode !== 'in_place')
      .sort((a, b) => (b.last_export?.ts ?? 0) - (a.last_export?.ts ?? 0))[0]?.last_export?.out_dir ?? ''
  const [dir, setDir] = useState(() => {
    const d = lastProjectDir()
    if (d) return d
    try {
      return localStorage.getItem(KEY) || ''
    } catch {
      return ''
    }
  })
  const [picking, setPicking] = useState(false)
  // Ticked by default: the sequences to export (never exported, or changed since their last export / re-export).
  // The user's own ticks override that default, and are forgotten when a sequence's export state changes.
  const [overrides, setOverrides] = useState<Map<number, boolean>>(new Map())
  const stateKey = sequences.map((s) => `${s.id}:${s.needs_export ? 1 : 0}`).join(',')
  useEffect(() => {
    setOverrides(new Map())
  }, [stateKey])
  const isTicked = (s: Sequence) => overrides.get(s.id) ?? s.needs_export
  const tickAll = (v: boolean | null) => setOverrides(v == null ? new Map() : new Map(sequences.map((s) => [s.id, v])))
  const [compat, setCompat] = useState(true)
  const [excludeJumps, setExcludeJumps] = useState(true)
  // Camera clock off by a stable amount: correcting the capture time is ticked by default
  const clockOff = clock.state === 'shifted'
  const [fixClock, setFixClock] = useState(clockOff)
  useEffect(() => setFixClock(clockOff), [clockOff])
  const [mode, setMode] = useState<ExportMode>('copy')
  const [confirm, setConfirm] = useState<null | 'export' | 'restore' | 'trash'>(null)
  const [history, setHistory] = useState<ExportRecord[]>([])
  const running = jobs.some((j) => ['export', 'restore_sources', 'trash'].includes(j.kind) && j.state === 'running')
  const publishing = jobs.some((j) => j.kind === 'publish' && j.state === 'running')
  const pub = usePublishOptions() // options of the « Publier » buttons of the exported sequences

  useEffect(() => {
    api.exports(projectId).then(setHistory, () => undefined)
  }, [projectId, running])

  const chosen = sequences.filter(isTicked)
  const jumps = chosen.reduce((n, s) => n + s.gps_jumps, 0)
  // Jump photos have no computed heading: they are counted apart
  const noHeading = chosen.reduce((n, s) => n + s.headings.uncertain + s.headings.missing, 0) - jumps

  const start = () => {
    setConfirm(null)
    try {
      localStorage.setItem(KEY, dir)
    } catch {
      /* ignore */
    }
    api
      .exportSequences(projectId, mode === 'in_place' ? null : dir, chosen.map((s) => s.id), compat, excludeJumps, mode, clockOff && fixClock)
      .then(onStarted, (e) => onError(e.message))
  }
  const trash = () => {
    setConfirm(null)
    api.trashExcluded(projectId).then(onStarted, (e) => onError(e.message))
  }
  const toTrash = excludedPhotos - sources.trashed
  const restore = () => {
    setConfirm(null)
    api.restoreSources(projectId).then(onStarted, (e) => onError(e.message))
  }
  const count = chosen.reduce((n, s) => n + s.count - (excludeJumps ? s.gps_jumps : 0), 0)

  return (
    <div>
      <p className="small-text muted">{t('exp.intro')}</p>
      <fieldset className="modes">
        <legend className="small-text">{t('exp.mode')}</legend>
        {modes().map((m) => (
          <label key={m.id} className="small-text">
            <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} /> {m.label}
            <span className="muted"> — {m.help}</span>
          </label>
        ))}
      </fieldset>
      {mode !== 'copy' && (
        <p className="warn-text small-text">
          {t('exp.sourcesWarn')}
        </p>
      )}
      {mode !== 'in_place' && (
        <>
          <label className="small-text">{t('exp.destination')}</label>
          <div className="row">
            <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder={t('exp.destPlaceholder')} />
            <button onClick={() => setPicking(true)}>{t('exp.browse')}</button>
          </div>
        </>
      )}
      <h3>{t('exp.sequences')}</h3>
      {sequences.length > 0 && (
        <div className="row wrap small-text">
          {sequences.some((s) => !s.needs_export) && (
            <span className="muted">{t('exp.unchangedUnticked')}</span>
          )}
          <button className="small" onClick={() => tickAll(true)}>
            {t('exp.tickAll')}
          </button>
          <button className="small" onClick={() => tickAll(null)}>
            {t('exp.tickPending', { n: sequences.filter((s) => s.needs_export).length })}
          </button>
        </div>
      )}
      {sequences.length === 0 ? (
        <p className="muted small-text">{t('exp.noSequence')}</p>
      ) : (
        <ul className="export-list">
          {sequences.map((s, i) => {
            const p = s.last_publication
            return (
              <li key={s.id} className="export-row">
                <label>
                  <input
                    type="checkbox"
                    checked={isTicked(s)}
                    onChange={() => setOverrides(new Map(overrides).set(s.id, !isTicked(s)))}
                  />{' '}
                  <span className="chip" style={{ background: seqColor(sequences, s.id) }} /> {i + 1} · {s.name}{' '}
                  <span className="muted">({t('seq.photos', { n: s.count })})</span>{' '}
                  {s.last_export ? (s.needs_export ? <span className="badge warn-text">{t('seq.reexportNeeded')}</span> : <span className="badge">{t('exp.exported')}</span>) : null}{' '}
                  {p && (
                    <span className={`badge ${p.state === 'error' || p.state === 'uploading' || s.changed_since_publication ? 'warn-text' : ''}`} title={p.message ?? p.instance}>
                      {s.changed_since_publication ? t('exp.changedSincePub') : t('exp.pubOn', { state: publicationStates()[p.state], date: new Date(p.ts * 1000).toLocaleDateString(locale()) })}
                    </span>
                  )}
                </label>
                {s.last_export && (
                  <span className="row export-row-actions">
                    {p?.first_picture_id && (
                      <a className="button-link small" href={viewerUrl(p.instance, p.first_picture_id)} target="_blank" rel="noreferrer">
                        {t('exp.view')}
                      </a>
                    )}
                    <PublishButton projectId={projectId} s={s} o={pub} running={publishing} onStarted={onStarted} onError={onError} />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <label className="small-text option-line">
        <input type="checkbox" checked={compat} onChange={(e) => setCompat(e.target.checked)} /> {t('exp.compat')}
      </label>
      <label className="small-text option-line">
        <input type="checkbox" checked={excludeJumps} onChange={(e) => setExcludeJumps(e.target.checked)} /> {t('exp.excludeJumps', { count: jumps > 0 ? ` (${jumps})` : '' })}
      </label>
      {clockOff && (
        <label className="small-text option-line">
          <input type="checkbox" checked={fixClock} onChange={(e) => setFixClock(e.target.checked)} />{' '}
          {t('exp.fixClock', { shift: fmtShift(clock.shift_s ?? 0), tz: clock.tz ?? '' })}
        </label>
      )}
      {noHeading > 0 && (
        <p className="warn-text small-text">
          {t('exp.noHeading', { n: noHeading })}
        </p>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={(mode !== 'in_place' && !dir.trim()) || !chosen.length || running}
          onClick={() => (mode === 'copy' ? start() : setConfirm('export'))}
        >
          {running
            ? t('exp.running')
            : chosen.length === 0 && sequences.length > 0 && sequences.every((s) => !s.needs_export)
              ? t('exp.allUpToDate')
              : t('exp.export', { n: chosen.length })}
        </button>
      </div>

      {toTrash > 0 && (
        <div className="small-text trash-box">
          {t('exp.toTrash', { n: toTrash })}{' '}
          <button className="small" disabled={running} onClick={() => setConfirm('trash')}>
            {t('exp.trashBtn')}
          </button>
        </div>
      )}
      {(sources.modified > 0 || sources.moved > 0) && (
        <div className="sources-box small-text">
          <strong>{t('exp.sourcesChanged')}</strong> {t('exp.sourcesModified', { n: sources.modified })}
          {sources.moved > 0 && t('exp.sourcesMoved', { n: sources.moved })}
          {sources.trashed > 0 && t('exp.sourcesTrashed', { n: sources.trashed })}.
          <div className="actions">
            <button className="danger small" disabled={running} onClick={() => setConfirm('restore')}>
              {t('exp.restoreBtn')}
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="alertdialog">
            {confirm === 'trash' ? (
              <>
                <h2>{t('exp.trashTitle')}</h2>
                <p>
                  {t('exp.trashBody', { n: toTrash })}
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
                  <button className="danger" onClick={trash}>
                    {t('exp.move')}
                  </button>
                </div>
              </>
            ) : confirm === 'export' ? (
              <>
                <h2>{t('exp.modifyTitle')}</h2>
                <p>
                  {t('exp.modifyBody', {
                    n: count,
                    moved: mode === 'move' ? t('exp.modifyMoved') : '',
                    what: sequences.some((s) => s.corrected > 0) ? t('exp.modifyHeadPos') : t('exp.modifyHead'),
                  })}
                </p>
                <p className="small-text muted">
                  {t('exp.modifyNote')}
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
                  <button className="danger" onClick={start}>
                    {t('exp.modifyBtn')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>{t('exp.restoreTitle')}</h2>
                <p>
                  {t('exp.restoreBody', { moved: sources.moved > 0 ? t('exp.restoreMoved') : '' })}
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
                  <button className="danger" onClick={restore}>
                    {t('exp.restore')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <PublishOptionsPanel o={pub} projectId={projectId} sequences={sequences} running={publishing} onStarted={onStarted} onError={onError} />

      {history.length > 0 && (
        <>
          <h3>{t('exp.history')}</h3>
          <ul className="export-history small-text">
            {history.map((h) => (
              <li key={h.id}>
                <strong>{h.sequence_name}</strong> — {t('exp.histPhotos', { n: h.photo_count, h: h.report.with_heading })}
                {h.report.corrected_positions > 0 && t('exp.histPos', { n: h.report.corrected_positions })}
                {(h.report.excluded_gps_jumps?.length ?? 0) > 0 && t('exp.histJumps', { n: h.report.excluded_gps_jumps?.length ?? 0 })}
                {h.report.mode === 'move' ? t('exp.histMoved') : h.report.mode === 'in_place' ? t('exp.histInPlace') : ''} ·{' '}
                {new Date(h.ts * 1000).toLocaleString(locale())}
                <div className="mono break muted">{h.path}</div>
                {(h.report.foreign_files?.length ?? 0) > 0 && (
                  <div className="warn-text">
                    {t('exp.foreign', { n: h.report.foreign_files?.length ?? 0, ex: h.report.foreign_files?.[0] ?? '' })}
                  </div>
                )}
                {Object.keys(h.report.problems).length > 0 && (
                  <details className="error">
                    <summary>{t('exp.problems', { n: Object.keys(h.report.problems).length })}</summary>
                    <ul className="problems">
                      {Object.entries(h.report.problems)
                        .slice(0, 20)
                        .map(([f, msg]) => (
                          <li key={f}>
                            <span className="mono">{f.split('/').pop()}</span> : {msg}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {picking && (
        <FolderPicker
          title={t('exp.folderTitle')}
          initial={dir || '~'}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setDir(p)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
