import { useState } from 'react'
import { api, PhotoRow, Proposal, seqColor, SeqState, Sequence } from './api'
import { fmtDistance, fmtDuration, fmtTime } from './format'

interface Props {
  projectId: string
  sequences: Sequence[]
  current: PhotoRow | null
  range: [number, number] | null
  onState: (s: SeqState) => void
  onGo: (idx: number) => void
  onError: (msg: string) => void
}

function SeqItem({ s, sequences, props }: { s: Sequence; sequences: Sequence[]; props: Props }) {
  const { projectId, current, range, onState, onGo, onError } = props
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(s.name)
  const [offset, setOffset] = useState(String(s.heading_offset))
  const run = (p: Promise<SeqState>) => p.then(onState, (e) => onError(e.message))
  const i = sequences.findIndex((x) => x.id === s.id)
  const next = sequences[i + 1]
  const h = s.headings
  const inThis = current?.sequence_id === s.id

  return (
    <li className={`seq ${inThis ? 'active' : ''}`}>
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
          <button className="link grow ellipsis seq-name" onClick={() => onGo(s.start_idx)} onDoubleClick={() => setEditing(true)} title="Aller au début · double-clic : renommer">
            {s.name}
          </button>
        )}
        <span className="muted small-text">{s.count} ph.</span>
      </div>
      <div className="muted small-text">
        {fmtTime(s.start)} → {fmtTime(s.end, false)} · {fmtDuration(s.duration_s)} · {fmtDistance(s.distance_m)}
      </div>
      <div className="small-text">
        Cap : {h.with_heading_pct}% · {h.computed} calculés · {h.manual} manuels
        {h.uncertain > 0 && <span className="warn-text"> · {h.uncertain} incertains</span>}
        {h.missing > 0 && <span className="warn-text"> · {h.missing} manquants</span>}
        {h.stale > 0 && <span className="warn-text"> · {h.stale} à revoir</span>}
        {s.anomalies > 0 && <span className="warn-text"> · {s.anomalies} anomalies GPS</span>}
      </div>
      <div className="seq-actions">
        <label className="small-text" title="Décalage angulaire appliqué à tous les caps calculés de la séquence">
          Décalage cap{' '}
          <input
            className="num"
            type="number"
            step="0.5"
            value={offset}
            onChange={(e) => setOffset(e.target.value)}
            onBlur={() => Number(offset) !== s.heading_offset && run(api.updateSequence(projectId, s.id, { heading_offset: Number(offset) || 0 }))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          °
        </label>
        <button className="small" onClick={() => setEditing(true)}>
          Renommer
        </button>
        {inThis && current && current.idx !== s.start_idx && (
          <button className="small" onClick={() => run(api.splitSequence(projectId, s.id, current.id))} title="Couper avant la photo courante (C)">
            Couper ici
          </button>
        )}
        {range && (
          <button className="small" onClick={() => run(api.setBounds(projectId, s.id, range[0], range[1]))} title="La séquence devient la plage sélectionnée">
            Limites = plage
          </button>
        )}
        {next && (
          <button className="small" onClick={() => run(api.mergeSequences(projectId, [s.id, next.id]))}>
            Fusionner avec la suivante
          </button>
        )}
        <button className="small danger" onClick={() => run(api.deleteSequence(projectId, s.id))} title="Les photos retournent dans « non classées » (annulable)">
          Supprimer
        </button>
      </div>
    </li>
  )
}

export default function SequencesTab(props: Props) {
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
        <div className="row wrap">
          <button
            className="primary small"
            disabled={!range}
            onClick={() => range && api.createSequence(projectId, range[0], range[1]).then(onState, (e) => onError(e.message))}
          >
            Créer une séquence avec la plage (S)
          </button>
          <button className="small" onClick={() => api.seqFromUnclassified(projectId).then(onState, (e) => onError(e.message))} title="Une séquence par bloc de photos non classées (toute la sortie sur un nouveau projet) ; découpez ensuite avec C">
            Tout en séquences
          </button>
        </div>
        <span className="muted small-text">
          {range
            ? `Plage : photos ${range[0] + 1} → ${range[1] + 1} (${range[1] - range[0] + 1}).`
            : 'Pas de plage : D = début, F = fin sur la photo courante, ou glisser sur la timeline.'}{' '}
          Découper en naviguant : C (ou ✂ Couper ici) sur la première photo de chaque nouvelle séquence. X : exclure la photo et passer à la suivante.
        </span>
      </div>

      <details className="proposals" open={proposals !== null}>
        <summary>Découpage proposé (photos non classées)</summary>
        <div className="row wrap small-text">
          <label>
            Interruption &gt; <input className="num" type="number" value={gap} onChange={(e) => setGap(Number(e.target.value))} /> s
          </label>
          <label>
            Saut &gt; <input className="num" type="number" value={dist} onChange={(e) => setDist(Number(e.target.value))} /> m
          </label>
          <label>
            Min. <input className="num" type="number" value={minPhotos} onChange={(e) => setMinPhotos(Number(e.target.value))} /> photos
          </label>
          <button className="small" onClick={propose}>
            Proposer
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
                      photos {p.start_idx + 1} → {p.end_idx + 1} ({p.count}){p.reason && <span className="muted"> · coupure : {p.reason}</span>}
                    </label>
                    <button className="small link" onClick={() => props.onGo(p.start_idx)}>
                      voir
                    </button>
                  </li>
                ))}
              </ul>
              <div className="row">
                <button className="primary small" onClick={acceptProposals}>
                  Créer {proposals.filter((p) => p.keep).length} séquence(s)
                </button>
                <button className="small" onClick={() => setProposals(null)}>
                  Ignorer
                </button>
              </div>
            </>
          ) : (
            <p className="muted small-text">Aucun segment proposé.</p>
          ))}
      </details>

      <h3>Séquences ({sequences.length})</h3>
      {sequences.length === 0 && <p className="muted small-text">Aucune séquence. Créez-en depuis une plage ou le découpage proposé.</p>}
      <ul className="seq-list">
        {sequences.map((s) => (
          <SeqItem key={`${s.id}-${s.name}-${s.heading_offset}`} s={s} sequences={sequences} props={props} />
        ))}
      </ul>
    </div>
  )
}
