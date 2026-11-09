import { useEffect, useState } from 'react'
import { api, FsListing } from './api'
import FsBrowser from './FsBrowser'
import { t, useLang } from './i18n'

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
  useLang()
  const [listing, setListing] = useState<FsListing | null>(null)
  const [typed, setTyped] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState(false) // 2:1 pictures without XMP: 360° or flat?

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

  const start = async (media?: '360' | 'flat') => {
    setBusy(true)
    try {
      if (!media) {
        const c = await api.importCheck(projectId, chosen) // refused here when the type differs from the project's
        if (c.ask) {
          setAsk(true)
          return
        }
      }
      await api.importPaths(projectId, chosen, media)
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
      <div className="modal" role="dialog" aria-label={t('imp.title')}>
        <h2>{t('imp.title')}</h2>
        <p className="muted">
          {t('imp.help')}
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            go(typed)
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('imp.pathPh')} />
          <button type="submit">{t('common.open')}</button>
        </form>
        <FsBrowser
          listing={listing}
          error={error}
          onGo={go}
          headExtra={
            listing && (
              <>
                <span className="muted" style={{ whiteSpace: 'nowrap' }}>{t('imp.jpegHere', { n: listing.jpeg_count })}</span>
                <button className="primary" onClick={() => add(listing.path)}>
                  {t('imp.addFolder')}
                </button>
              </>
            )
          }
          rowExtra={(path) => (
            <button className="small" onClick={() => add(path)}>
              + {t('common.add')}
            </button>
          )}
        />
        {chosen.length > 0 && (
          <div>
            <h3>{t('imp.chosen')}</h3>
            <ul className="chosen">
              {chosen.map((c) => (
                <li key={c}>
                  <span className="mono ellipsis">{c}</span>
                  <button className="small" onClick={() => setChosen(chosen.filter((x) => x !== c))}>
                    {t('common.remove')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {ask && (
          <div className="warn-box small-text" role="alert">
            <p>{t('imp.ask')}</p>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => start('360')}>
                {t('imp.ask360')}
              </button>
              <button disabled={busy} onClick={() => start('flat')}>
                {t('imp.askFlat')}
              </button>
            </div>
          </div>
        )}
        {error && !listing && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={!chosen.length || busy} onClick={() => start()}>
            {chosen.length > 1 ? t('imp.start.many', { n: chosen.length }) : t('imp.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
