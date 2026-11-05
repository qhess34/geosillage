import { useEffect, useState } from 'react'
import { api, ProjectItem } from './api'
import NewPanoramaxProject from './NewPanoramaxProject'

export default function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectItem[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<ProjectItem | null>(null)
  const [pnx, setPnx] = useState(false)

  const load = () => api.projects().then(setProjects, (e) => setError(e.message))
  useEffect(() => {
    load()
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const { id } = await api.createProject(name.trim())
      onOpen(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const remove = async () => {
    if (!toDelete) return
    try {
      await api.deleteProject(toDelete.id)
      setToDelete(null)
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="home">
      <h1>Panoramax Sequence Studio</h1>
      <form className="row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du nouveau projet (ex. Sortie 14 juin)" />
        <button className="primary" type="submit" disabled={!name.trim()}>
          Créer le projet
        </button>
      </form>
      <p className="small-text">
        <button className="link" onClick={() => setPnx(!pnx)}>
          Corriger des séquences déjà publiées sur Panoramax…
        </button>
      </p>
      {pnx && <NewPanoramaxProject onCreated={onOpen} onCancel={() => setPnx(false)} />}
      {error && <p className="error">{error}</p>}
      <h2>Projets</h2>
      {projects === null ? (
        <p className="muted">Chargement…</p>
      ) : projects.length === 0 ? (
        <p className="muted">Aucun projet pour l'instant.</p>
      ) : (
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <button className="link project-name" onClick={() => onOpen(p.id)}>
                {p.name}
              </button>
              {p.kind === 'panoramax' && <span className="badge" title="Séquences déjà publiées, corrigées puis renvoyées">Panoramax</span>}
              <span className="muted">
                {p.photo_count} photos · créé le {new Date(p.created_at * 1000).toLocaleDateString('fr-FR')}
              </span>
              <button className="small danger" onClick={() => setToDelete(p)}>
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      )}
      {toDelete && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="alertdialog">
            <h2>Supprimer « {toDelete.name} » ?</h2>
            <p>
              Le projet (séquences, corrections, miniatures) sera supprimé définitivement.
              <br />
              <strong>Les photos sources ne sont pas touchées.</strong>
            </p>
            <div className="actions">
              <button onClick={() => setToDelete(null)}>Annuler</button>
              <button className="danger" onClick={remove}>
                Supprimer le projet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
