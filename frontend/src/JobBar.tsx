import { useEffect, useRef, useState } from 'react'
import { api, Job } from './api'
import { t, useLang } from './i18n'

const JOB_KINDS = ['import', 'thumbnails', 'check_files', 'export', 'publish', 'publish_update'] as const
const jobLabel = (kind: string) => ((JOB_KINDS as readonly string[]).includes(kind) ? t(`job.kind.${kind}` as 'job.kind.import') : kind)

const fmtLeft = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`)
const jobState = (s: Job['state']) => t(`job.state.${s}` as 'job.state.done')

// Status bar: running jobs (progress, time left from the speed seen here), last job; a system notification when a
// long job ends while the window is in the background (if the user allowed it)
export default function JobBar({ jobs, projectId, projectName }: { jobs: Job[]; projectId: string; projectName: string }) {
  useLang()
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
          new Notification(`${jobLabel(j.kind)} ${jobState(j.state)}`, { body: `${projectName}${j.message ? ` — ${j.message}` : ''}` })
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
              {jobLabel(j.kind)} : {j.message ?? ''} {j.total ? `${j.done}/${j.total}` : ''}
              {j.total > 0 && <progress value={j.done} max={j.total} />}
              {eta != null && <span className="muted">{t('job.left', { time: fmtLeft(eta) })}</span>}
              <button className="small" onClick={() => api.cancelJob(projectId, j.id)}>
                {t('common.cancel')}
              </button>
            </span>
          )
        })
      ) : last ? (
        <span className={last.state === 'error' ? 'error' : 'muted'}>
          {t('job.last', { kind: jobLabel(last.kind), state: jobState(last.state) })}
          {last.message ? ` (${last.message})` : ''}
        </span>
      ) : (
        <span className="muted">{t('job.ready')}</span>
      )}
      {canNotify && perm === 'default' && (
        <button
          className="link small-text"
          title={t('job.notifyTitle')}
          onClick={() => Notification.requestPermission().then(setPerm)}
        >
          {t('job.notify')}
        </button>
      )}
    </footer>
  )
}
