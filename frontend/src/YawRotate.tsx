import { useState } from 'react'
import { api, UndoState } from './api'
import { t, useLang } from './i18n'

type Target = { photo_ids?: number[]; start_idx?: number; end_idx?: number; sequence_id?: number; all?: boolean }

const KEY = 'pss-yaw-angle'
function loadAngle(): string {
  try {
    return localStorage.getItem(KEY) || '180'
  } catch {
    return '180'
  }
}

// Camera mounting correction (badly aligned on the helmet, or backwards: 180): a constant angle added to each photo's
// orientation (XMP PoseHeadingDegrees, on top of the head angles already fixed; the JPEG is never rotated)
export default function YawRotate({
  projectId,
  target,
  what,
  onDone,
  onError,
}: {
  projectId: string
  target: Target
  what: string // translated: "the sequence", "all the photos of the project"…
  onDone: (undo?: UndoState) => void
  onError: (msg: string) => void
}) {
  useLang()
  const [angle, setAngle] = useState(loadAngle)
  const value = Number(angle.replace(',', '.'))
  const valid = angle.trim() !== '' && Number.isFinite(value) && Math.abs(value) <= 360
  const remember = () => {
    try {
      localStorage.setItem(KEY, angle)
    } catch {
      /* ignore */
    }
  }
  return (
    <span className="yaw-rotate small-text">
      <input
        className="num"
        type="number"
        step="1"
        min={-360}
        max={360}
        value={angle}
        onChange={(e) => setAngle(e.target.value)}
        aria-label={t('yaw.angleLabel')}
        title={t('yaw.angleTitle')}
      />
      °{' '}
      <button
        className="small"
        disabled={!valid}
        onClick={() => {
          remember()
          api.rotateYaw(projectId, target, value).then((r) => onDone(r.undo), (e) => onError(e.message))
        }}
        title={t('yaw.title', { what })}
      >
        {t('yaw.fix')}
      </button>
    </span>
  )
}
