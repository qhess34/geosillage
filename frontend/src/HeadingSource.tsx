import { api, Project, UndoState } from './api'
import { t, useLang } from './i18n'

// Source of the automatic headings for the whole project: trajectory or the camera's compass (GPSImgDirection).
// Detected at the first import, changed here (Summary tab, ⚙ Settings); undoable.
export default function HeadingSource({ p, onDone, onError }: { p: Project; onDone: (u?: UndoState) => void; onError: (m: string) => void }) {
  useLang()
  const set = (source: 'track' | 'device') =>
    api.headingSource(p.id, source).then((r) => onDone(r.undo), (e) => onError(e.message))
  return (
    <div className="form-row heading-source">
      <span title={t('headingSource.help')}>{t('headingSource.label')}</span>
      <select
        aria-label={t('headingSource.label')}
        value={p.heading_source}
        onChange={(e) => set(e.target.value as 'track' | 'device')}
      >
        <option value="track">{t('headingSource.track')}</option>
        <option value="device" disabled={!p.device_headings && p.heading_source !== 'device'}>
          {t('headingSource.device', { n: p.device_headings })}
        </option>
      </select>
    </div>
  )
}
