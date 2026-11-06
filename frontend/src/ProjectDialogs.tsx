import { api, UndoState } from './api'
import { Confirm, ValueDialog } from './Dialogs'
import { SHORTCUTS } from './shortcuts'
import { ValueDlg } from './contextMenuItems'

// Small windows of the project screen: help, confirmations of bulk actions, value of a series of photos

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small-modal" role="dialog" aria-label="Raccourcis clavier">
        <h2>Raccourcis clavier</h2>
        <table className="summary">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <th>
                  <kbd>{k}</kbd>
                </th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small-text muted">Sur la carte et la timeline : Maj+clic étend la plage. Glisser sur la timeline sélectionne une plage.</p>
        <div className="actions">
          <button onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmInterpolate({ ids, onCancel, onConfirm }: { ids: number[]; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`Placer ${ids.length} photo(s) entre leurs voisines ?`} confirmLabel={`Placer ${ids.length} photo(s)`} onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        Chaque photo sans position prise entre deux photos positionnées est placée entre elles, selon l'heure de prise de vue. Les photos en
        début ou en fin de sortie restent à placer. Ctrl+Z annule.
      </p>
    </Confirm>
  )
}

export function ConfirmExclude({ range, n, onCancel, onConfirm }: { range: [number, number]; n: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`Exclure ${n} photos ?`} confirmLabel={`Exclure ${n} photos`} danger onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        Photos {range[0] + 1} → {range[1] + 1} de la plage sélectionnée. Elles ne sont ni supprimées ni exportées ; Ctrl+Z annule.
      </p>
    </Confirm>
  )
}

// Heading offset or camera orientation of a series of photos (context menu)
export function RangeValueDialog({
  projectId,
  dlg,
  onClose,
  onDone,
  onError,
}: {
  projectId: string
  dlg: ValueDlg
  onClose: () => void
  onDone: (u: UndoState, notice: string) => void
  onError: (m: string) => void
}) {
  return (
    <ValueDialog
      title={`${dlg.kind === 'offset' ? 'Décalage du cap' : 'Orientation de la caméra'} : photos ${dlg.range[0] + 1} → ${dlg.range[1] + 1}`}
      label={dlg.kind === 'offset' ? 'Décalage ajouté aux caps calculés (sens de déplacement)' : 'Angle ajouté à l\'orientation de chaque photo (centre de l\'image)'}
      initial={dlg.kind === 'offset' ? '0' : '180'}
      unit="°"
      applyLabel="Appliquer"
      help={
        dlg.kind === 'offset'
          ? 'Le cap est la direction dans laquelle on avance (flèches de navigation). Remplace le décalage déjà posé sur ces photos ; 0 le retire. Les caps manuels ne changent pas. L\'orientation de la caméra ne change pas. Ctrl+Z annule.'
          : 'L\'orientation est l\'angle entre le centre de l\'image et le sens de déplacement : caméra mal alignée sur le casque, ou à l\'envers (180°). Le cap ne change pas ; le fichier JPEG n\'est pas tourné. Ctrl+Z annule.'
      }
      onCancel={onClose}
      onApply={(v) => {
        const r = dlg.range
        const target = { start_idx: r[0], end_idx: r[1] }
        onClose()
        ;(dlg.kind === 'offset' ? api.headingOffset(projectId, target, v) : api.rotateYaw(projectId, target, v)).then(
          (res) => onDone(res.undo, `${dlg.kind === 'offset' ? 'Décalage du cap' : 'Orientation'} ${v > 0 ? '+' : ''}${v}° : photos ${r[0] + 1} → ${r[1] + 1}`),
          (er) => onError(er.message),
        )
      }}
    />
  )
}
