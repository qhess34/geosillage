import { useEffect, useState } from 'react'
import { api, ProjectItem } from './api'
import { locale, t, useLang } from './i18n'
import NewPanoramaxProject from './NewPanoramaxProject'

export default function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  useLang()
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
      <header className="brand-head">
        <img src="/logo.svg" alt="" width="56" height="56" />
        <div>
          <h1>
            Geo<span className="brand-accent">Sillage</span>
          </h1>
          <p className="muted">{t('home.tagline')}</p>
        </div>
      </header>
      <form className="row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('home.namePlaceholder')} />
        <button className="primary" type="submit" disabled={!name.trim()}>
          {t('home.create')}
        </button>
      </form>
      <p className="small-text">
        <button className="link" onClick={() => setPnx(!pnx)}>
          {t('home.pnxLink')}
        </button>
      </p>
      {pnx && <NewPanoramaxProject onCreated={onOpen} onCancel={() => setPnx(false)} />}
      {error && <p className="error">{error}</p>}
      <h2>{t('home.projects')}</h2>
      {projects === null ? (
        <p className="muted">{t('home.loading')}</p>
      ) : projects.length === 0 ? (
        <p className="muted">{t('home.none')}</p>
      ) : (
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <button className="link project-name" onClick={() => onOpen(p.id)}>
                {p.name}
              </button>
              {p.kind === 'panoramax' && <span className="badge" title={t('home.pnxBadgeTitle')}>Panoramax</span>}
              <span className="muted">
                {t('home.projectInfo', { n: p.photo_count, date: new Date(p.created_at * 1000).toLocaleDateString(locale()) })}
              </span>
              <button className="small danger" onClick={() => setToDelete(p)}>
                {t('home.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {toDelete && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="alertdialog">
            <h2>{t('home.deleteTitle', { name: toDelete.name })}</h2>
            <p>
              {t('home.deleteBody')}
              <br />
              <strong>{t('home.deleteSources')}</strong>
            </p>
            <div className="actions">
              <button onClick={() => setToDelete(null)}>{t('common.cancel')}</button>
              <button className="danger" onClick={remove}>
                {t('home.deleteConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
