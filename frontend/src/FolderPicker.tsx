import { useEffect, useState } from 'react'
import { api, FsListing } from './api'
import FsBrowser from './FsBrowser'
import { t, useLang } from './i18n'

interface Props {
  title: string
  initial: string
  onPick: (path: string) => void
  onClose: () => void
}

// Choose one folder on the local machine (the export creates it if the typed path does not exist yet)
export default function FolderPicker({ title, initial, onPick, onClose }: Props) {
  useLang()
  const [listing, setListing] = useState<FsListing | null>(null)
  const [typed, setTyped] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const go = async (path: string) => {
    try {
      const l = await api.fs(path)
      setListing(l)
      setTyped(l.path)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    go(initial || '~').catch(() => go('~'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            go(typed)
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit">{t('common.open')}</button>
        </form>
        <p className="muted small-text">{t('folder.help')}</p>
        <FsBrowser listing={listing} error={error} onGo={go} />
        <div className="actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={!typed.trim()} onClick={() => onPick(typed.trim())}>
            {t('folder.choose', { name: typed.split('/').filter(Boolean).pop() || typed })}
          </button>
        </div>
      </div>
    </div>
  )
}
