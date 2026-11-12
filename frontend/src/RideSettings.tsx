import { useState } from 'react'
import { api, Project, UndoState } from './api'
import YawRotate from './YawRotate'
import HeadingSource from './HeadingSource'
import { capHelp, orientationHelp } from './CapOrientation'
import { t, useLang } from './i18n'

// Settings of the whole ride (heading source, heading shift, camera mount), shown at the top of
// « Sens de déplacement et orientation » (Photo tab). Series of photos: context menu or range tools.
export default function RideSettings({ project, onDone, onError }: { project: Project; onDone: (u?: UndoState) => void; onError: (m: string) => void }) {
  useLang()
  const flat = project.media === 'flat'
  const [value, setValue] = useState('0')
  return (
    <div className="small-text ride-settings">
      <p className="muted section-help">{t('sum.rideHelp')}</p>
      <HeadingSource p={project} onDone={onDone} onError={onError} />
      <div className="form-row">
        <span title={`${capHelp()} ${t('sum.headingShiftHelp')}`}>{t('sum.headingShift')}</span>
        <span>
          <input className="num" type="number" step="0.5" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('sum.headingShiftLabel')} />°
          <button className="small" onClick={() => api.headingOffset(project.id, { all: true }, Number(value) || 0).then((r) => onDone(r.undo), (e) => onError(e.message))}>
            {t('sum.applyAll')}
          </button>
        </span>
      </div>
      <div className="form-row">
        <span title={`${orientationHelp()} ${t(flat ? 'sum.yawHelpFlat' : 'sum.yawHelp')}`}>{flat ? t('ride.mountFlat') : t('ride.mount')}</span>
        <YawRotate projectId={project.id} target={{ all: true }} what={t('sum.yawWhat')} onDone={onDone} onError={onError} />
      </div>
    </div>
  )
}
