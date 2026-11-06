import { useEffect, useState } from 'react'
import { api, PanoramaxStatus, PnxSequence } from './api'
import { PnxConnection } from './Publication'

// Home page: project made of sequences already published on Panoramax (to correct them and send the corrections)
export default function NewPanoramaxProject({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [seqs, setSeqs] = useState<PnxSequence[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (st?.connected && seqs === null) api.pnxMySequences().then(setSeqs, (e) => setError(e.message))
  }, [st, seqs])

  const extra = pasted
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 10)
  const chosen = [...picked, ...extra]
  const shown = (seqs ?? []).filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()))
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR') : '')

  const create = () => {
    const first = seqs?.find((s) => picked.has(s.id))
    const n = name.trim() || (first ? first.title : 'Séquences Panoramax')
    api.pnxCreateProject(n, chosen).then((r) => onCreated(r.id), (e) => setError(e.message))
  }

  return (
    <div className="pnx-new">
      <h2>Corriger des séquences déjà publiées</h2>
      <p className="muted small-text">
        Un projet Panoramax contient des séquences déjà en ligne : leurs photos restent sur Panoramax (affichées depuis
        l'instance). On y corrige positions, caps et orientation avec les mêmes outils, puis on envoie les corrections.
      </p>
      <div className="small-text">
        <PnxConnection onChange={setSt} onError={setError} />
      </div>
      {st?.connected && (
        <>
          <h3>Vos séquences</h3>
          {seqs === null ? (
            <p className="muted small-text">Chargement de vos séquences…</p>
          ) : seqs.length === 0 ? (
            <p className="muted small-text">Aucune séquence sur ce compte.</p>
          ) : (
            <>
              {seqs.length > 8 && <input className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer par titre" aria-label="Filtrer" />}
              <ul className="pnx-seq-list small-text">
                {shown.map((s) => (
                  <li key={s.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={() => {
                          const n = new Set(picked)
                          if (n.has(s.id)) n.delete(s.id)
                          else n.add(s.id)
                          setPicked(n)
                        }}
                      />{' '}
                      <strong>{s.title || s.id}</strong> <span className="muted">· {s.count ?? '?'} photos{s.start ? ` · ${fmt(s.start)}` : ''}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="small-text">
            Ou collez l'adresse (ou l'identifiant) de séquences :{' '}
            <input className="grow" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…" aria-label="Adresses de séquences" />
          </label>
          <div className="row wrap">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du projet (par défaut : titre de la séquence)" aria-label="Nom du projet" />
            <button className="primary" disabled={!chosen.length} onClick={create}>
              Créer le projet Panoramax ({chosen.length} séquence(s))
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="small" onClick={onCancel}>
        Fermer
      </button>
    </div>
  )
}
