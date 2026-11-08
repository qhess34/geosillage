import { useEffect, useState } from 'react'
import { locale, t, useLang } from './i18n'
import { api, PanoramaxStatus, PnxSequence } from './api'
import { PnxConnection } from './Publication'

// Home page: project made of sequences already published on Panoramax (to correct them and send the corrections)
export default function NewPanoramaxProject({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  useLang()
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
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString(locale()) : '')

  const create = () => {
    const first = seqs?.find((s) => picked.has(s.id))
    const n = name.trim() || (first ? first.title : t('pnx.defaultName'))
    api.pnxCreateProject(n, chosen).then((r) => onCreated(r.id), (e) => setError(e.message))
  }

  return (
    <div className="pnx-new">
      <h2>{t('pnx.title')}</h2>
      <p className="muted small-text">
        {t('pnx.intro')}
      </p>
      <div className="small-text">
        <PnxConnection onChange={setSt} onError={setError} />
      </div>
      {st?.connected && (
        <>
          <h3>{t('pnx.yours')}</h3>
          {seqs === null ? (
            <p className="muted small-text">{t('pnx.loading')}</p>
          ) : seqs.length === 0 ? (
            <p className="muted small-text">{t('pnx.none')}</p>
          ) : (
            <>
              {seqs.length > 8 && <input className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('pnx.filter')} aria-label={t('pnx.filterLabel')} />}
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
                      <strong>{s.title || s.id}</strong> <span className="muted">· {t('seq.photos', { n: s.count ?? '?' })}{s.start ? ` · ${fmt(s.start)}` : ''}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="small-text">
            {t('pnx.paste')}{' '}
            <input className="grow" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…" aria-label={t('pnx.pasteLabel')} />
          </label>
          <div className="row wrap">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pnx.namePlaceholder')} aria-label={t('pnx.nameLabel')} />
            <button className="primary" disabled={!chosen.length} onClick={create}>
              {t('pnx.create', { n: chosen.length })}
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="small" onClick={onCancel}>
        {t('common.close')}
      </button>
    </div>
  )
}
