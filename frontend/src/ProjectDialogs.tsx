import { api, UndoState } from './api'
import { Confirm, ValueDialog } from './Dialogs'
import { t, useLang } from './i18n'
import { shortcutList } from './shortcuts'
import { ValueDlg } from './contextMenuItems'

// Small windows of the project screen: help, confirmations of bulk actions, value of a series of photos

export function HelpDialog({ onClose }: { onClose: () => void }) {
  useLang()
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small-modal" role="dialog" aria-label={t('help.title')}>
        <h2>{t('help.title')}</h2>
        <table className="summary">
          <tbody>
            {shortcutList().map(([k, v]) => (
              <tr key={k}>
                <th>
                  <kbd>{k}</kbd>
                </th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small-text muted">{t('help.mouse')}</p>
        <div className="actions">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmInterpolate({ ids, onCancel, onConfirm }: { ids: number[]; onCancel: () => void; onConfirm: () => void }) {
  useLang()
  return (
    <Confirm title={t('dlg.interpTitle', { n: ids.length })} confirmLabel={t('dlg.interpConfirm', { n: ids.length })} onCancel={onCancel} onConfirm={onConfirm}>
      <p>{t('dlg.interpBody')}</p>
    </Confirm>
  )
}

export function ConfirmExclude({ range, n, onCancel, onConfirm }: { range: [number, number]; n: number; onCancel: () => void; onConfirm: () => void }) {
  useLang()
  return (
    <Confirm title={t('dlg.excludeTitle', { n })} confirmLabel={t('dlg.excludeConfirm', { n })} danger onCancel={onCancel} onConfirm={onConfirm}>
      <p>{t('dlg.excludeBody', { a: range[0] + 1, b: range[1] + 1 })}</p>
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
  useLang()
  const offset = dlg.kind === 'offset'
  return (
    <ValueDialog
      title={t(offset ? 'dlg.offsetTitle' : 'dlg.yawTitle', { a: dlg.range[0] + 1, b: dlg.range[1] + 1 })}
      label={t(offset ? 'dlg.offsetLabel' : 'dlg.yawLabel')}
      initial={dlg.kind === 'offset' ? '0' : '180'}
      unit="°"
      applyLabel={t('dlg.apply')}
      help={t(offset ? 'dlg.offsetHelp' : 'dlg.yawHelp')}
      onCancel={onClose}
      onApply={(v) => {
        const r = dlg.range
        const target = { start_idx: r[0], end_idx: r[1] }
        onClose()
        ;(dlg.kind === 'offset' ? api.headingOffset(projectId, target, v) : api.rotateYaw(projectId, target, v)).then(
          (res) => onDone(res.undo, t(offset ? 'dlg.offsetDone' : 'dlg.yawDone', { v: `${v > 0 ? '+' : ''}${v}`, a: r[0] + 1, b: r[1] + 1 })),
          (er) => onError(er.message),
        )
      }}
    />
  )
}
