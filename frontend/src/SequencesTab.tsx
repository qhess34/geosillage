import { useState } from 'react'
import { api, PhotoRow, Proposal, seqColor, SeqState, Sequence } from './api'
import { fmtDistance, fmtDuration, fmtTime } from './format'
import { PUBLICATION_STATES, viewerUrl } from './Publication'
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
          <button className="link grow ellipsis seq-name" onClick={() => onGo(s.start_idx)} onDoubleClick={() => setEditing(true)} title="Aller au début · double-clic : renommer">
            {s.name}
          </button>
        )}
        {!editing && (
          <button className="small icon" onClick={() => setEditing(true)} title="Renommer" aria-label="Renommer">
            ✎
          </button>
        )}
        <span className="muted small-text">{s.count} photos</span>
      </div>
      <div className="small-text">
        {props.pnx ? null : last ? (
          s.needs_export ? (
            <span className="badge warn-text" title={`Modifiée depuis l'export du ${new Date(last.ts * 1000).toLocaleString('fr-FR')}`}>
              à réexporter
            </span>
          ) : (
            <span className="badge" title={last.path}>
              exportée le {new Date(last.ts * 1000).toLocaleString('fr-FR')}
            </span>
          )
        ) : (
          <span className="muted">jamais exportée</span>
        )}
        {s.last_publication && (
          <>
            {' '}
            <span
              className={`badge ${s.last_publication.state === 'ready' && !s.changed_since_publication ? '' : 'warn-text'}`}
              title={s.last_publication.message ?? s.last_publication.instance}
            >
              {s.changed_since_publication ? 'modifiée depuis la publication' : `${PUBLICATION_STATES[s.last_publication.state]} sur Panoramax`}
            </span>
            {s.last_publication.first_picture_id && (
              <>
                {' '}
                <a href={viewerUrl(s.last_publication.instance, s.last_publication.first_picture_id)} target="_blank" rel="noreferrer">
                  voir
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
            <button className="small" onClick={() => run(api.splitSequence(projectId, s.id, current.id))} title="Couper avant la photo courante (C)">
              ✂ Couper ici
            </button>
          )}
          {range && (
            <button className="small" onClick={() => run(api.setBounds(projectId, s.id, range[0], range[1]))} title="La séquence devient la plage sélectionnée">
              Limites = plage
            </button>
          )}
          {next && (
            <button className="small" onClick={() => run(api.mergeSequences(projectId, [s.id, next.id]))} title={`Fusionner avec « ${next.name} »`}>
              Fusionner avec la suivante
            </button>
          )}
          <span className="spacer" />
          {last && (
            <button
              className={confirmReexport ? 'small danger' : s.needs_export ? 'small primary' : 'small'}
              onClick={reexport}
              title={`Même dossier et mêmes réglages que le dernier export (${last.mode === 'copy' ? 'copie' : last.mode === 'move' ? 'photos sources déplacées' : 'photos sources modifiées sur place'}) : ${last.path}`}
            >
              {confirmReexport ? 'Confirmer : modifie les photos sources' : '⟳ Réexporter'}
            </button>
          )}
          <button className="small danger" onClick={() => run(api.deleteSequence(projectId, s.id))} title="Les photos retournent dans « non classées » (annulable)">
            Supprimer
          </button>
        </div>
      )}
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
        {!props.pnx && (
          <div className="row wrap">
            <button
              className="primary small"
              disabled={!range}
              onClick={() => range && api.createSequence(projectId, range[0], range[1]).then(onState, (e) => onError(e.message))}
            >
              Créer avec la plage (F)
            </button>
            <button className="small" onClick={() => api.seqFromUnclassified(projectId).then(onState, (e) => onError(e.message))} title="Une séquence par bloc de photos non classées (toute la sortie sur un nouveau projet) ; découpez ensuite avec C">
              Tout en séquences
            </button>
          </div>
        )}
        {!props.pnx && <span className="muted small-text">
          {range
            ? `Plage : photos ${range[0] + 1} → ${range[1] + 1} (${range[1] - range[0] + 1}).`
            : 'Créer à la main : « ⏵ Début » (D) sur la première photo, naviguer, puis « ⏹ Fin » (F) sur la dernière.'}{' '}
          Découper en naviguant : C (ou ✂ Couper) sur la première photo de chaque nouvelle séquence. X : exclure la photo et passer à la suivante.
        </span>}
        {props.pnx && (
          <span className="muted small-text">
            Séquences déjà publiées : leur découpage ne change pas. X exclut une photo (supprimée de Panoramax à l'envoi, sur demande).
          </span>
        )}
      </div>

      {!props.pnx && <details className="proposals" open={proposals !== null}>
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
                <span className="spacer" />
                <button className="small" onClick={() => setProposals(null)}>
                  Ignorer
                </button>
                <button className="primary small" onClick={acceptProposals}>
                  Créer {proposals.filter((p) => p.keep).length} séquence(s)
                </button>
              </div>
            </>
          ) : (
            <p className="muted small-text">Aucun segment proposé.</p>
          ))}
      </details>}

      <h3>Séquences ({sequences.length})</h3>
      {sequences.length === 0 && <p className="muted small-text">Aucune séquence. Créez-en depuis une plage ou le découpage proposé.</p>}
      <ul className="seq-list">
        {sequences.map((s) => (
          <SeqItem key={`${s.id}-${s.name}`} s={s} sequences={sequences} props={props} />
        ))}
      </ul>
    </div>
  )
}
