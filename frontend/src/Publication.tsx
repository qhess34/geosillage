import { useEffect, useState } from 'react'
import { api, PanoramaxStatus, Sequence, Tag } from './api'
import { Confirm } from './Dialogs'

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

// Options of a publication on Panoramax, shared by the « Publier » buttons of the exported sequences: connection,
// visibility, attributes (those of the last publication are proposed again)
export function usePublishOptions() {
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [visibility, setVisibility] = useState<'anyone' | 'owner-only'>('anyone')
  const [transport, setTransport] = useState('')
  const [extra, setExtra] = useState('') // other attributes, one key=value per line
  const [tagsReady, setTagsReady] = useState(false)
  useEffect(() => {
    if (!st || tagsReady) return
    setTransport(st.semantics.find((t) => t.key === 'transport')?.value ?? '')
    setExtra(st.semantics.filter((t) => t.key !== 'transport').map((t) => `${t.key}=${t.value}`).join('\n'))
    setTagsReady(true)
  }, [st, tagsReady])
  const parsed = parseTags(extra)
  const semantics: Tag[] = [...(transport ? [{ key: 'transport', value: transport }] : []), ...parsed.tags]
  return { st, setSt, visibility, setVisibility, transport, setTransport, extra, setExtra, parsed, semantics }
}
export type PublishOptions = ReturnType<typeof usePublishOptions>

// Section « Publier sur Panoramax » of the Export tab: connection and options; each exported sequence has its own
// « Publier » button in the list above
export function PublishOptionsPanel({
  o,
  projectId,
  sequences,
  running,
  onStarted,
  onError,
}: {
  o: PublishOptions
  projectId: string
  sequences: Sequence[]
  running: boolean // a publication is in progress
  onStarted: () => void
  onError: (msg: string) => void
}) {
  // exported sequences not (fully) on Panoramax yet: never published, or upload interrupted / failed
  const pending = sequences.filter((s) => s.last_export && s.last_publication?.state !== 'ready' && s.last_publication?.state !== 'processing')
  const [confirmAll, setConfirmAll] = useState(false)
  const publishAll = () => {
    setConfirmAll(false)
    api.publish(projectId, pending.map((s) => s.id), o.visibility, o.semantics).then(onStarted, (e) => onError(e.message))
  }
  return (
    <div className="publish small-text">
      <h3>Publier sur Panoramax</h3>
      <p className="muted">
        Une fois une séquence exportée, « Publier » sur sa ligne (ou « Publier les n séquences… » ci-dessous pour toutes celles
        qui ne sont pas encore en ligne) l'envoie telle qu'exportée (dossier de son dernier export), comme{' '}
        <strong>une seule</strong> séquence Panoramax : ni redécoupée, ni dédoublonnée. Une séquence modifiée depuis son export est
        d'abord réexportée ; un envoi interrompu reprend où il s'était arrêté.
      </p>
      <PnxConnection onChange={o.setSt} onError={onError} />
      {o.st?.connected && (
        <>
          <fieldset className="modes">
            <legend>Visibilité</legend>
            <label>
              <input type="radio" checked={o.visibility === 'anyone'} onChange={() => o.setVisibility('anyone')} /> Tout le monde
            </label>
            <label>
              <input type="radio" checked={o.visibility === 'owner-only'} onChange={() => o.setVisibility('owner-only')} /> Moi seulement
              (essai, modifiable ensuite sur Panoramax)
            </label>
          </fieldset>
          <fieldset className="modes">
            <legend>Attributs de la séquence (sémantique Panoramax)</legend>
            <div className="row wrap" role="radiogroup" aria-label="Mode de déplacement">
              {TRANSPORTS.map(([v, label]) => (
                <label key={v}>
                  <input type="radio" checked={o.transport === v} onChange={() => o.setTransport(v)} /> {label}
                </label>
              ))}
            </div>
            <label className="tags-input">
              Autres attributs, un par ligne <span className="muted">(clé=valeur, ex. hashtag=gravel)</span>
              <textarea rows={3} value={o.extra} onChange={(e) => o.setExtra(e.target.value)} spellCheck={false} aria-label="Autres attributs" />
            </label>
            {o.parsed.bad.length > 0 && <p className="warn-text">Ligne(s) sans « clé=valeur » : {o.parsed.bad.join(', ')}</p>}
            <p className="muted">
              {o.semantics.length ? `Envoyés : ${o.semantics.map((t) => `${t.key}=${t.value}`).join(', ')}.` : 'Aucun attribut envoyé.'}{' '}
              Ils sont copiés sur la séquence Panoramax et reproposés au prochain envoi.
            </p>
          </fieldset>
          <div className="actions">
            <button
              className="primary"
              disabled={!pending.length || running || o.parsed.bad.length > 0}
              title={pending.length ? '' : 'Toutes les séquences exportées sont déjà publiées'}
              onClick={() => setConfirmAll(true)}
            >
              {running ? 'Publication en cours…' : `⇪ Publier les ${pending.length} séquence(s) exportée(s) non publiée(s)`}
            </button>
          </div>
          {confirmAll && (
            <Confirm title={`Publier ${pending.length} séquence(s) ?`} confirmLabel="Publier" onCancel={() => setConfirmAll(false)} onConfirm={publishAll}>
              <p>
                Sur <strong>{o.st!.instance.replace(/^https?:\/\//, '')}</strong>,{' '}
                {o.visibility === 'anyone' ? 'visibles par tout le monde' : 'visibles par vous seulement'}
                {o.semantics.length ? <>, avec {o.semantics.map((t) => `${t.key}=${t.value}`).join(', ')}</> : ', sans attribut'}. Envoyées
                l'une après l'autre ; une séquence modifiée depuis son export est d'abord réexportée.
              </p>
              <ul className="small-text">
                {pending.map((s) => (
                  <li key={s.id}>
                    {s.name} ({s.count} photos){s.last_publication?.state === 'uploading' ? ' — reprise de l\'envoi interrompu' : ''}
                    {s.needs_export ? ' — réexportée d\'abord' : ''}
                  </li>
                ))}
              </ul>
            </Confirm>
          )}
        </>
      )}
    </div>
  )
}

// « Publier » button of an exported sequence (Export tab), with its confirmation
export function PublishButton({
  projectId,
  s,
  o,
  running,
  onStarted,
  onError,
}: {
  projectId: string
  s: Sequence
  o: PublishOptions
  running: boolean
  onStarted: () => void
  onError: (msg: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const pub = s.last_publication
  const label = pub?.state === 'uploading' ? 'Reprendre l\'envoi' : pub ? 'Republier' : 'Publier'
  const why = !o.st?.connected
    ? 'Connectez-vous à Panoramax (section « Publier sur Panoramax » ci-dessous)'
    : o.parsed.bad.length
      ? 'Attributs à corriger (section « Publier sur Panoramax »)'
      : running
        ? 'Une publication est en cours'
        : ''
  const publish = () => {
    setConfirm(false)
    api.publish(projectId, [s.id], o.visibility, o.semantics).then(onStarted, (e) => onError(e.message))
  }
  return (
    <>
      <button className={pub ? 'small' : 'small primary'} disabled={!!why} title={why || `Publier « ${s.name} » sur Panoramax`} onClick={() => setConfirm(true)}>
        ⇪ {label}
      </button>
      {confirm && o.st && (
        <Confirm title={`${label} « ${s.name} » ?`} confirmLabel={label} onCancel={() => setConfirm(false)} onConfirm={publish}>
          <p>
            {s.count} photos sur <strong>{o.st.instance.replace(/^https?:\/\//, '')}</strong>,{' '}
            {o.visibility === 'anyone' ? 'visibles par tout le monde' : 'visibles par vous seulement'}
            {o.semantics.length ? <>, avec {o.semantics.map((t) => `${t.key}=${t.value}`).join(', ')}</> : ''}.
            {s.needs_export ? ' La séquence a changé depuis son export : elle est d\'abord réexportée.' : ''}
          </p>
          {pub && pub.state !== 'uploading' && (
            <p className="small-text warn-text">
              Elle est déjà sur Panoramax : republier crée une nouvelle séquence. Pour envoyer seulement des corrections, utilisez
              « Comparer avec Panoramax » (onglet Séquences).
            </p>
          )}
        </Confirm>
      )}
    </>
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
