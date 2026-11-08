import { useState } from 'react'
import { locale, t, useLang } from './i18n'
import { api, PhotoRow, Proposal, seqColor, SeqState, Sequence } from './api'
import { fmtDistance, fmtDuration, fmtTime } from './format'
import { publicationStates, viewerUrl } from './Publication'
import PublishedEdit from './PublishedEdit'

interface Props {
  projectId: string
  sequences: Sequence[]
  current: PhotoRow | null
  range: [number, number] | null
  onState: (s: SeqState) => void
  onGo: (idx: number) => void
  onRefresh: () => void // reload photos and sequences after an edit that does not return them
  onExported: () => void // an export job was started
  onError: (msg: string) => void
  pnx?: boolean // Panoramax project: published sequences, their cut and export do not change
  onSeqContext?: (s: Sequence, x: number, y: number) => void // right click on a sequence: context menu
}

function SeqItem({ s, sequences, props }: { s: Sequence; sequences: Sequence[]; props: Props }) {
  useLang()
  const { projectId, current, range, onState, onGo, onError } = props
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(s.name)
  const [confirmReexport, setConfirmReexport] = useState(false)
  const last = s.last_export
  const reexport = () => {
    if (last && last.mode !== 'copy' && !confirmReexport) {
      setConfirmReexport(true) // second click: the photo sources will be modified again
      return
    }
    setConfirmReexport(false)
    api.reexport(projectId, s.id).then(() => props.onExported(), (e) => onError(e.message))
  }
  const run = (p: Promise<SeqState>) => p.then(onState, (e) => onError(e.message))
  const i = sequences.findIndex((x) => x.id === s.id)
  const next = sequences[i + 1]
  const inThis = current?.sequence_id === s.id

  return (
    <li
      className={`seq ${inThis ? 'active' : ''}`}
      onContextMenu={(e) => {
        if (!props.onSeqContext || (e.target as HTMLElement).closest('input, textarea')) return
        e.preventDefault()
        props.onSeqContext(s, e.clientX, e.clientY)
      }}
    >
      <div className="seq-head">
        <span className="chip" style={{ background: seqColor(sequences, s.id) }} />
        {editing ? (
          <form
            className="row grow"
            onSubmit={(e) => {
              e.preventDefault()
              run(api.updateSequence(projectId, s.id, { name })).then(() => setEditing(false))
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <button className="small" type="submit">
              OK
            </button>
          </form>
        ) : (
          <button className="link grow ellipsis seq-name" onClick={() => onGo(s.start_idx)} onDoubleClick={() => setEditing(true)} title={t('seq.goStart')}>
            {s.name}
          </button>
        )}
        {!editing && (
          <button className="small icon" onClick={() => setEditing(true)} title={t('seq.rename')} aria-label={t('seq.rename')}>
            ✎
          </button>
        )}
        <span className="muted small-text">{t('seq.photos', { n: s.count })}</span>
      </div>
      <div className="small-text">
        {props.pnx ? null : last ? (
          s.needs_export ? (
            <span className="badge warn-text" title={t('seq.changedSinceExport', { date: new Date(last.ts * 1000).toLocaleString(locale()) })}>
              {t('seq.reexportNeeded')}
            </span>
          ) : (
            <span className="badge" title={last.path}>
              {t('seq.exportedOn', { date: new Date(last.ts * 1000).toLocaleString(locale()) })}
            </span>
          )
        ) : (
          <span className="muted">{t('seq.neverExported')}</span>
        )}
        {s.last_publication && (
          <>
            {' '}
            <span
              className={`badge ${s.last_publication.state === 'ready' && !s.changed_since_publication ? '' : 'warn-text'}`}
              title={s.last_publication.message ?? s.last_publication.instance}
            >
              {s.changed_since_publication ? t('seq.changedSincePub') : t('seq.onPanoramax', { state: publicationStates()[s.last_publication.state] })}
            </span>
            {s.last_publication.first_picture_id && (
              <>
                {' '}
                <a href={viewerUrl(s.last_publication.instance, s.last_publication.first_picture_id)} target="_blank" rel="noreferrer">
                  {t('seq.view')}
                </a>
              </>
            )}
          </>
        )}
      </div>
      <PublishedEdit projectId={projectId} s={s} onStarted={props.onExported} onError={onError} />
      <div className="muted small-text">
        {fmtTime(s.start)} → {fmtTime(s.end, false)} · {fmtDuration(s.duration_s)} · {fmtDistance(s.distance_m)}
      </div>
      {!props.pnx && (
        <div className="seq-actions">
          {inThis && current && current.idx !== s.start_idx && (
            <button className="small" onClick={() => run(api.splitSequence(projectId, s.id, current.id))} title={t('seq.splitTitle')}>
              {t('seq.split')}
            </button>
          )}
          {range && (
            <button className="small" onClick={() => run(api.setBounds(projectId, s.id, range[0], range[1]))} title={t('seq.boundsTitle')}>
              {t('seq.bounds')}
            </button>
          )}
          {next && (
            <button className="small" onClick={() => run(api.mergeSequences(projectId, [s.id, next.id]))} title={t('seq.mergeTitle', { name: next.name })}>
              {t('seq.merge')}
            </button>
          )}
          <span className="spacer" />
          {last && (
            <button
              className={confirmReexport ? 'small danger' : s.needs_export ? 'small primary' : 'small'}
              onClick={reexport}
              title={t('seq.reexportTitle', { mode: last.mode === 'copy' ? t('seq.mode.copy') : last.mode === 'move' ? t('seq.mode.move') : t('seq.mode.inplace'), path: last.path })}
            >
              {confirmReexport ? t('seq.reexportConfirm') : t('seq.reexport')}
            </button>
          )}
          <button className="small danger" onClick={() => run(api.deleteSequence(projectId, s.id))} title={t('seq.deleteTitle')}>
            {t('seq.delete')}
          </button>
        </div>
      )}
    </li>
  )
}

export default function SequencesTab(props: Props) {
  useLang()
  const { projectId, sequences, range, onState, onError } = props
  const [proposals, setProposals] = useState<(Proposal & { keep: boolean })[] | null>(null)
  const [gap, setGap] = useState(10)
  const [dist, setDist] = useState(100)
  const [minPhotos, setMinPhotos] = useState(5)

  const propose = () =>
    api.proposals(projectId, gap, dist, minPhotos).then(
      (p) => setProposals(p.map((x) => ({ ...x, keep: true }))),
      (e) => onError(e.message),
    )

  const acceptProposals = () => {
    const segs = (proposals || []).filter((p) => p.keep).map((p) => [p.start_idx, p.end_idx] as [number, number])
    if (!segs.length) return
    api.createSequences(projectId, segs).then(
      (s) => {
        onState(s)
        setProposals(null)
      },
      (e) => onError(e.message),
    )
  }

  return (
    <div>
      <div className="range-box">
        {!props.pnx && (
          <div className="row wrap">
            <button
              className="primary small"
              disabled={!range}
              onClick={() => range && api.createSequence(projectId, range[0], range[1]).then(onState, (e) => onError(e.message))}
            >
              {t('seq.create')}
            </button>
            <button className="small" onClick={() => api.seqFromUnclassified(projectId).then(onState, (e) => onError(e.message))} title={t('seq.allTitle')}>
              {t('seq.all')}
            </button>
          </div>
        )}
        {!props.pnx && <span className="muted small-text">
          {range
            ? t('seq.rangeInfo', { a: range[0] + 1, b: range[1] + 1, n: range[1] - range[0] + 1 })
            : t('seq.manualHelp')}{' '}
          {t('seq.cutHelp')}
        </span>}
        {props.pnx && (
          <span className="muted small-text">
            {t('seq.pnxHelp')}
          </span>
        )}
      </div>

      {!props.pnx && <details className="proposals" open={proposals !== null}>
        <summary>{t('seq.prop.title')}</summary>
        <div className="row wrap small-text">
          <label>
            {t('seq.prop.gap')} <input className="num" type="number" value={gap} onChange={(e) => setGap(Number(e.target.value))} /> s
          </label>
          <label>
            {t('seq.prop.jump')} <input className="num" type="number" value={dist} onChange={(e) => setDist(Number(e.target.value))} /> m
          </label>
          <label>
            {t('seq.prop.min')} <input className="num" type="number" value={minPhotos} onChange={(e) => setMinPhotos(Number(e.target.value))} /> {t('seq.prop.photos')}
          </label>
          <button className="small" onClick={propose}>
            {t('seq.prop.go')}
          </button>
        </div>
        {proposals &&
          (proposals.length ? (
            <>
              <ul className="prop-list">
                {proposals.map((p, i) => (
                  <li key={i}>
                    <label>
                      <input
                        type="checkbox"
                        checked={p.keep}
                        onChange={() => setProposals(proposals.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))}
                      />{' '}
                      {t('seq.prop.item', { a: p.start_idx + 1, b: p.end_idx + 1, n: p.count })}
                      {p.reason && <span className="muted"> · {t('seq.prop.cut', { reason: p.reason })}</span>}
                    </label>
                    <button className="small link" onClick={() => props.onGo(p.start_idx)}>
                      {t('seq.view')}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="row">
                <span className="spacer" />
                <button className="small" onClick={() => setProposals(null)}>
                  {t('seq.prop.ignore')}
                </button>
                <button className="primary small" onClick={acceptProposals}>
                  {t('seq.prop.create', { n: proposals.filter((p) => p.keep).length })}
                </button>
              </div>
            </>
          ) : (
            <p className="muted small-text">{t('seq.prop.none')}</p>
          ))}
      </details>}

      <h3>{t('seq.heading', { n: sequences.length })}</h3>
      {sequences.length === 0 && <p className="muted small-text">{t('seq.none')}</p>}
      <ul className="seq-list">
        {sequences.map((s) => (
          <SeqItem key={`${s.id}-${s.name}`} s={s} sequences={sequences} props={props} />
        ))}
      </ul>
    </div>
  )
}
