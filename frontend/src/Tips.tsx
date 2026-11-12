import { useState } from 'react'
import { t, useLang } from './i18n'

// First-launch tips: a slim, closable band (not an overlay); once closed it stays closed (localStorage)
const KEY = 'pss-tips-seen'
const seen = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export default function Tips({ onHelp }: { onHelp: () => void }) {
  useLang()
  const [open, setOpen] = useState(() => !seen())
  if (!open) return null
  const close = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable: shown again next time */
    }
    setOpen(false)
  }
  return (
    <aside className="tips" role="note" aria-label={t('tips.title')}>
      <strong>{t('tips.title')}</strong> <span>{t('tips.body')}</span>
      <button className="small" onClick={onHelp}>
        {t('tips.help')}
      </button>
      <button className="small primary" onClick={close}>
        {t('tips.dismiss')}
      </button>
    </aside>
  )
}
