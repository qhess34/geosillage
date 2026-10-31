import { useEffect, useState } from 'react'
import { api, FsListing } from './api'

interface Props {
  projectId: string
  onClose: () => void
  onStarted: () => void
}

const LAST_DIR = 'pss-last-dir'

function lastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR) || '~'
  } catch {
    return '~'
  }
}

// Folder picker over the local file system (served by the backend, which runs on this machine)
export default function ImportDialog({ projectId, onClose, onStarted }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [typed, setTyped] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const go = async (path: string) => {
    try {
      const l = await api.fs(path)
      setListing(l)
      setTyped(l.path)
      setError(null)
      try {
        localStorage.setItem(LAST_DIR, l.path)
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    go(lastDir())
  }, [])

  const add = (p: string) => setChosen((c) => (c.includes(p) ? c : [...c, p]))

  const start = async () => {
    setBusy(true)
    try {
      await api.importPaths(projectId, chosen)
      onStarted()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Importer des photos">
        <h2>Importer des photos</h2>
        <p className="muted">
          L'import est récursif. Les fichiers sont seulement référencés : rien n'est copié ni modifié.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            go(typed)
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/chemin/vers/les/photos" />
          <button type="submit">Ouvrir</button>
        </form>
        {listing && (
          <div className="fs">
            <div className="fs-head">
              <button disabled={!listing.parent} onClick={() => listing.parent && go(listing.parent)} title="Dossier parent">
                ↑
              </button>
              <span className="mono ellipsis">{listing.path}</span>
              <span className="muted">{listing.jpeg_count} JPEG ici</span>
              <button className="primary" onClick={() => add(listing.path)}>
                Ajouter ce dossier
              </button>
            </div>
            <ul className="fs-list">
              {listing.dirs.map((d) => (
                <li key={d}>
                  <button className="link" onClick={() => go(`${listing.path}/${d}`)}>
                    📁 {d}
                  </button>
                  <button className="small" onClick={() => add(`${listing.path}/${d}`)}>
                    + Ajouter
                  </button>
                </li>
              ))}
              {!listing.dirs.length && <li className="muted">Aucun sous-dossier</li>}
            </ul>
          </div>
        )}
        {chosen.length > 0 && (
          <div>
            <h3>Dossiers à importer</h3>
            <ul className="chosen">
              {chosen.map((c) => (
                <li key={c}>
                  <span className="mono ellipsis">{c}</span>
                  <button className="small" onClick={() => setChosen(chosen.filter((x) => x !== c))}>
                    Retirer
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose}>Annuler</button>
          <button className="primary" disabled={!chosen.length || busy} onClick={start}>
            Importer {chosen.length > 1 ? `${chosen.length} dossiers` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
