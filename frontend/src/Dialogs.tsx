import { ReactNode, useEffect, useRef, useState } from 'react'

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
          <button onClick={onCancel}>Annuler</button>
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
        aria-label="Ajouter un fond de carte"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onAdd(name.trim(), url.trim(), attribution.trim())
        }}
      >
        <h2>Ajouter un fond de carte</h2>
        <label>
          Nom
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Orthophoto de ma commune" />
        </label>
        <label>
          Adresse des tuiles XYZ
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/{z}/{x}/{y}.png" spellCheck={false} />
        </label>
        <label>
          Attribution <span className="muted">(obligatoire selon le fournisseur)</span>
          <input value={attribution} onChange={(e) => setAttribution(e.target.value)} placeholder="© …" />
        </label>
        {url && !valid && <p className="small-text warn-text">L'adresse doit commencer par https:// et contenir {'{z}'}, {'{x}'} et {'{y}'}.</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Ajouter
          </button>
        </div>
      </form>
    </div>
  )
}
