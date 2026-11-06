import { useEffect, useRef, useState } from 'react'
import { api, Job } from './api'

const JOB_LABELS: Record<string, string> = {
  import: 'Import',
  thumbnails: 'Miniatures',
  check_files: 'Vérification des fichiers',
  export: 'Export',
  publish: 'Publication Panoramax',
  publish_update: 'Corrections sur Panoramax',
}

const fmtLeft = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`)
const JOB_STATES: Record<Job['state'], string> = { done: 'terminée', error: 'erreur', cancelled: 'annulée', interrupted: 'interrompue', running: 'en cours' }

// Status bar: running jobs (progress, time left from the speed seen here), last job; a system notification when a
// long job ends while the window is in the background (if the user allowed it)
export default function JobBar({ jobs, projectId, projectName }: { jobs: Job[]; projectId: string; projectName: string }) {
  const running = jobs.filter((j) => j.state === 'running')
  const last = jobs[0]
  const seen = useRef(new Map<string, { t: number; done: number }>()) // first observation of each job
  const wasRunning = useRef(new Set<string>())
  const canNotify = typeof Notification !== 'undefined'
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied')
  useEffect(() => {
    for (const j of jobs) {
      if (j.state === 'running') {
        if (!seen.current.has(j.id)) seen.current.set(j.id, { t: Date.now(), done: j.done })
        wasRunning.current.add(j.id)
      } else if (wasRunning.current.has(j.id)) {
        wasRunning.current.delete(j.id)
        const long = Date.now() - (seen.current.get(j.id)?.t ?? Date.now()) > 10000
        if (canNotify && Notification.permission === 'granted' && long && document.hidden)
          new Notification(`${JOB_LABELS[j.kind] ?? j.kind} ${JOB_STATES[j.state]}`, { body: `${projectName}${j.message ? ` — ${j.message}` : ''}` })
      }
    }
  }, [jobs, projectName, canNotify])
  const left = (j: Job) => {
    const s = seen.current.get(j.id)
    if (!s || !j.total || j.done <= s.done) return null
    const elapsed = (Date.now() - s.t) / 1000
    if (elapsed < 3) return null
    return ((j.total - j.done) * elapsed) / (j.done - s.done)
  }
  return (
    <footer className="statusbar">
      {running.length ? (
        running.map((j) => {
          const eta = left(j)
          return (
            <span key={j.id} className="job">
              {JOB_LABELS[j.kind] ?? j.kind} : {j.message ?? ''} {j.total ? `${j.done}/${j.total}` : ''}
              {j.total > 0 && <progress value={j.done} max={j.total} />}
              {eta != null && <span className="muted">≈ {fmtLeft(eta)} restantes</span>}
              <button className="small" onClick={() => api.cancelJob(projectId, j.id)}>
                Annuler
              </button>
            </span>
          )
        })
      ) : last ? (
        <span className={last.state === 'error' ? 'error' : 'muted'}>
          Dernière tâche : {JOB_LABELS[last.kind] ?? last.kind} — {JOB_STATES[last.state]}
          {last.message ? ` (${last.message})` : ''}
        </span>
      ) : (
        <span className="muted">Prêt</span>
      )}
      {canNotify && perm === 'default' && (
        <button
          className="link small-text"
          title="Notification du système quand un export, une publication ou un import se termine pendant que vous êtes dans une autre fenêtre"
          onClick={() => Notification.requestPermission().then(setPerm)}
        >
          🔔 Me prévenir à la fin des tâches
        </button>
      )}
    </footer>
  )
}
