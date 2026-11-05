import { useEffect, useState } from 'react'
import { api, Job, PanoramaxStatus, seqColor, Sequence, Tag } from './api'

export const PUBLICATION_STATES: Record<string, string> = {
  uploading: 'envoi interrompu',
  processing: 'en traitement sur Panoramax',
  ready: 'publiée',
  error: 'erreur',
}

// Link opening a published sequence in the instance's viewer, on its first picture
export function viewerUrl(instance: string, pictureId: string): string {
  return `${instance.replace(/\/+$/, '')}/#focus=pic&pic=${pictureId}`
}

// Envoi tab: connection to a Panoramax instance and publication of the selected sequences (from their last export)
export default function PublishPanel({
  projectId,
  sequences,
  jobs,
  onStarted,
  onError,
}: {
  projectId: string
  sequences: Sequence[]
  jobs: Job[]
  onStarted: () => void
  onError: (msg: string) => void
}) {
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [visibility, setVisibility] = useState<'anyone' | 'owner-only'>('anyone')
  const [transport, setTransport] = useState('')
  const [extra, setExtra] = useState('') // other attributes, one key=value per line
  const [tagsReady, setTagsReady] = useState(false)
  // attributes of the last publication proposed again
  useEffect(() => {
    if (!st || tagsReady) return
    setTransport(st.semantics.find((t) => t.key === 'transport')?.value ?? '')
    setExtra(st.semantics.filter((t) => t.key !== 'transport').map((t) => `${t.key}=${t.value}`).join('\n'))
    setTagsReady(true)
  }, [st, tagsReady])
  const parsed = parseTags(extra)
  const semantics: Tag[] = [...(transport ? [{ key: 'transport', value: transport }] : []), ...parsed.tags]
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const running = jobs.some((j) => j.kind === 'publish' && j.state === 'running')

  const exported = sequences.filter((s) => s.last_export)
  const chosen = exported.filter((s) => picked.has(s.id))
  const publish = () => {
    setConfirm(false)
    api.publish(projectId, chosen.map((s) => s.id), visibility, semantics).then(() => {
      setPicked(new Set())
      onStarted()
    }, (e) => onError(e.message))
  }

  return (
    <div className="publish small-text">
      <h3>Publier sur Panoramax</h3>
      <PnxConnection onChange={setSt} onError={onError} />

      {st?.connected && (
        <>
          <p className="muted">
            Chaque séquence est envoyée telle qu'exportée (dossier de son dernier export), comme <strong>une seule</strong> séquence
            Panoramax : ni redécoupée, ni dédoublonnée. Une séquence modifiée depuis son export est d'abord réexportée. Un envoi
            interrompu reprend où il s'était arrêté.
          </p>
          {exported.length === 0 ? (
            <p className="muted">Aucune séquence exportée : exportez d'abord (onglet Export).</p>
          ) : (
            <ul className="export-list">
              {exported.map((s, i) => {
                const pub = s.last_publication
                return (
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
                      <span className="chip" style={{ background: seqColor(sequences, s.id) }} /> {sequences.indexOf(s) + 1 || i + 1} · {s.name}{' '}
                      <span className="muted">({s.count} photos)</span>{' '}
                      {pub && (
                        <span className={`badge ${pub.state === 'error' || pub.state === 'uploading' ? 'warn-text' : ''}`} title={pub.message ?? ''}>
                          {PUBLICATION_STATES[pub.state]} le {new Date(pub.ts * 1000).toLocaleDateString('fr-FR')}
                        </span>
                      )}{' '}
                      {s.changed_since_publication && <span className="badge warn-text">modifiée depuis</span>}
                    </label>{' '}
                    {pub?.first_picture_id && (
                      <a href={viewerUrl(pub.instance, pub.first_picture_id)} target="_blank" rel="noreferrer">
                        voir sur Panoramax
                      </a>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <fieldset className="modes">
            <legend>Visibilité</legend>
            <label>
              <input type="radio" checked={visibility === 'anyone'} onChange={() => setVisibility('anyone')} /> Tout le monde
            </label>
            <label>
              <input type="radio" checked={visibility === 'owner-only'} onChange={() => setVisibility('owner-only')} /> Moi seulement (essai,
              modifiable ensuite sur Panoramax)
            </label>
          </fieldset>
          <fieldset className="modes">
            <legend>Attributs de la séquence (sémantique Panoramax)</legend>
            <div className="row wrap" role="radiogroup" aria-label="Mode de déplacement">
              {TRANSPORTS.map(([v, label]) => (
                <label key={v}>
                  <input type="radio" checked={transport === v} onChange={() => setTransport(v)} /> {label}
                </label>
              ))}
            </div>
            <label className="tags-input">
              Autres attributs, un par ligne <span className="muted">(clé=valeur, ex. hashtag=gravel)</span>
              <textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} aria-label="Autres attributs" />
            </label>
            {parsed.bad.length > 0 && <p className="warn-text">Ligne(s) sans « clé=valeur » : {parsed.bad.join(', ')}</p>}
            <p className="muted">
              {semantics.length ? `Envoyés : ${semantics.map((t) => `${t.key}=${t.value}`).join(', ')}.` : 'Aucun attribut envoyé.'} Ils
              sont copiés sur la séquence Panoramax et reproposés au prochain envoi.
            </p>
          </fieldset>
          {confirm ? (
            <div className="confirm-box">
              Publier {chosen.length} séquence(s) sur {st!.instance.replace(/^https?:\/\//, '')}
              {visibility === 'anyone' ? ', visibles par tout le monde' : ', visibles par vous seulement'} ?{' '}
              <button className="small primary" onClick={publish}>
                Publier
              </button>{' '}
              <button className="small" onClick={() => setConfirm(false)}>
                Annuler
              </button>
            </div>
          ) : (
            <button className="primary" disabled={!chosen.length || running || parsed.bad.length > 0} onClick={() => setConfirm(true)}>
              {running ? 'Publication en cours…' : `Publier ${chosen.length} séquence(s)`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// Transport modes offered by the Panoramax website (attribute transport); "other": no attribute
const TRANSPORTS: [string, string][] = [
  ['walk', 'À pied'],
  ['bike', 'Vélo'],
  ['car', 'Voiture'],
  ['', 'Autre / non précisé'],
]

// "key=value" lines → attributes; blank lines are ignored, lines without "=" are reported
export function parseTags(text: string): { tags: Tag[]; bad: string[] } {
  const tags: Tag[] = []
  const bad: string[] = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    const i = l.indexOf('=')
    const key = i > 0 ? l.slice(0, i).trim() : ''
    const value = i > 0 ? l.slice(i + 1).trim() : ''
    if (!key || !value) bad.push(`« ${l.slice(0, 30)} »`)
    else if (!tags.some((t) => t.key === key && t.value === value)) tags.push({ key, value })
  }
  return { tags, bad }
}

// Instance address and connection (claim link); the token stays on the server
export function PnxConnection({ onChange, onError }: { onChange: (s: PanoramaxStatus) => void; onError: (msg: string) => void }) {
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [url, setUrl] = useState('')
  const take = (p: Promise<PanoramaxStatus>) =>
    p.then(
      (s) => {
        setSt(s)
        setUrl(s.instance)
        onChange(s)
      },
      (e) => onError(e.message),
    )
  useEffect(() => {
    take(api.pnxStatus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!st) return null
  return (
    <>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim() && url.trim() !== st.instance) take(api.pnxInstance(url))
        }}
      >
        <label className="grow">
          Instance{' '}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://panoramax.openstreetmap.fr" aria-label="Instance Panoramax" />
        </label>
        <button className="small" type="submit" disabled={url.trim() === st.instance}>
          Changer
        </button>
      </form>

      {st.connected ? (
        <p>
          ✓ Connecté à <strong>{st.instance.replace(/^https?:\/\//, '')}</strong>
          {st.account ? <> en tant que <strong>{st.account}</strong></> : ''} ·{' '}
          <button className="link" onClick={() => take(api.pnxLogout())}>
            Se déconnecter
          </button>
        </p>
      ) : st.claim_url ? (
        <div className="claim-box">
          <p>
            1. Ouvrez ce lien et connectez-vous sur Panoramax pour autoriser l'application :{' '}
            <a href={st.claim_url} target="_blank" rel="noreferrer">
              valider la connexion
            </a>
          </p>
          <p>
            2. Puis :{' '}
            <button className="small primary" onClick={() => take(api.pnxCheck())}>
              J'ai validé, vérifier
            </button>{' '}
            <button className="small" onClick={() => take(api.pnxLogin())}>
              Nouveau lien
            </button>
          </p>
        </div>
      ) : (
        <p>
          <button className="small primary" onClick={() => take(api.pnxLogin())}>
            Se connecter
          </button>{' '}
          <span className="muted">Un lien à ouvrir vous est donné ; aucun mot de passe n'est saisi dans l'application.</span>
        </p>
      )}

    </>
  )
}
