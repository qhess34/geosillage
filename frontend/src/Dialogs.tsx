import { ReactNode, useEffect, useRef, useState } from 'react'
import { t, useLang } from './i18n'

// Confirmation inside the page (instead of the browser's window.confirm): Enter confirms, Escape cancels
export function Confirm({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useLang()
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ok.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal small-modal" role="alertdialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button ref={ok} className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// New XYZ background map (instead of three window.prompt)
export function AddBasemap({ onAdd, onCancel }: { onAdd: (name: string, url: string, attribution: string) => void; onCancel: () => void }) {
  useLang()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [attribution, setAttribution] = useState('')
  const valid = name.trim() && /^https?:\/\//.test(url.trim()) && url.includes('{z}') && url.includes('{x}') && url.includes('{y}')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal small-modal form-grid"
        role="dialog"
        aria-label={t('dlg.basemap.title')}
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onAdd(name.trim(), url.trim(), attribution.trim())
        }}
      >
        <h2>{t('dlg.basemap.title')}</h2>
        <label>
          {t('dlg.basemap.name')}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('dlg.basemap.namePh')} />
        </label>
        <label>
          {t('dlg.basemap.url')}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/{z}/{x}/{y}.png" spellCheck={false} />
        </label>
        <label>
          {t('dlg.basemap.attr')} <span className="muted">{t('dlg.basemap.attrReq')}</span>
          <input value={attribution} onChange={(e) => setAttribution(e.target.value)} placeholder="© …" />
        </label>
        {url && !valid && <p className="small-text warn-text">{t('dlg.basemap.urlHelp')}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {t('common.add')}
          </button>
        </div>
      </form>
    </div>
  )
}

// One number to type (heading offset, orientation…), Enter applies, Escape cancels
export function ValueDialog({
  title,
  label,
  initial,
  unit,
  help,
  applyLabel,
  onApply,
  onCancel,
}: {
  title: string
  label: string
  initial: string
  unit: string
  help?: ReactNode
  applyLabel: string
  onApply: (v: number) => void
  onCancel: () => void
}) {
  useLang()
  const [v, setV] = useState(initial)
  const n = Number(v.replace(',', '.'))
  const valid = v.trim() !== '' && Number.isFinite(n) && Math.abs(n) <= 360
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal small-modal form-grid"
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onApply(n)
        }}
      >
        <h2>{title}</h2>
        <label>
          {label}
          <span className="row">
            <input className="num" autoFocus type="number" step="0.5" min={-360} max={360} value={v} onChange={(e) => setV(e.target.value)} /> {unit}
          </span>
        </label>
        {help && <div className="small-text muted">{help}</div>}
        <div className="actions">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {applyLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
