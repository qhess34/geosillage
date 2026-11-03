import { useState } from 'react'
import { api, UndoState } from './api'

type Target = { photo_ids?: number[]; start_idx?: number; end_idx?: number; sequence_id?: number; all?: boolean }

const KEY = 'pss-yaw-angle'
function loadAngle(): string {
  try {
    return localStorage.getItem(KEY) || '180'
  } catch {
    return '180'
  }
}

// Orientation of the camera (XMP PoseHeadingDegrees, the JPEG is never rotated): rotate by a custom angle, or set it
export default function YawRotate({
  projectId,
  target,
  what,
  onDone,
  onError,
}: {
  projectId: string
  target: Target
  what: string // "la séquence", "toutes les photos du projet"…
  onDone: (undo?: UndoState) => void
  onError: (msg: string) => void
}) {
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
        aria-label="Angle de rotation (°)"
        title="Angle en degrés (−360 à 360)"
      />
      °{' '}
      <button
        className="small"
        disabled={!valid}
        onClick={() => {
          remember()
          api.rotateYaw(projectId, target, value).then((r) => onDone(r.undo), (e) => onError(e.message))
        }}
        title={`Tourne ${what} de cet angle, ajouté à l'orientation actuelle de chaque photo (caméra à l'envers : 180). XMP PoseHeadingDegrees, le JPEG n'est pas modifié. Ctrl+Z annule.`}
      >
        ↻ Tourner
      </button>
      <button
        className="small"
        disabled={!valid}
        onClick={() => {
          remember()
          api.setYaw(projectId, target, value).then((r) => onDone(r.undo), (e) => onError(e.message))
        }}
        title={`Même orientation pour ${what} : cet angle remplace celle de chaque photo (0 = celle de la caméra). Ctrl+Z annule.`}
      >
        = Fixer
      </button>
    </span>
  )
}
