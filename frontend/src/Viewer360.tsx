import { PanoData, Viewer } from '@photo-sphere-viewer/core'
import '@photo-sphere-viewer/core/index.css'
import { useEffect, useRef, useState } from 'react'
import PhotoViewer from './PhotoViewer'

interface Props {
  thumbUrl: string
  imageUrl: string
  alt: string
  height?: number
  // Helmet camera: angle of the image centre relative to the bike (degrees, right > 0), i.e. the value of
  // XMP-GPano:PoseHeadingDegrees. The view's front is then the direction of the bike.
  yaw?: number | null
  onFixYaw?: (yaw: number) => void // "the bike goes where I am looking now"
  onResetYaw?: () => void
  fixLabel?: string
  // view direction relative to the front (degrees, right > 0): lets the map arrow turn with the view
  onView?: (yawDeg: number) => void
}

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

const MODE_KEY = 'pss-viewer-mode'

function savedMode(): '360' | 'flat' {
  try {
    return localStorage.getItem(MODE_KEY) === 'flat' ? 'flat' : '360'
  } catch {
    return '360'
  }
}

// 360° viewer (equirectangular). The thumbnail is shown first, then the full-resolution photo. The view
// direction is kept from one photo to the next, so stepping through a ride keeps looking the same way.
// Keyboard handling stays with the application (arrows = previous / next photo).
function Sphere({ thumbUrl, imageUrl, height, yaw, onFixYaw, onResetYaw, fixLabel, onView }: Props) {
  const onViewRef = useRef(onView)
  onViewRef.current = onView
  const el = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pose = yaw ?? 0

  useEffect(() => {
    const v = new Viewer({
      container: el.current as HTMLDivElement,
      panorama: thumbUrl,
      defaultYaw: 0,
      defaultZoomLvl: 0,
      keyboard: false,
      mousewheelCtrlKey: false,
      navbar: ['zoom', 'move', 'fullscreen'],
      loadingTxt: '',
      lang: { zoom: 'Zoom', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière', moveUp: 'Haut', moveDown: 'Bas', moveLeft: 'Gauche', moveRight: 'Droite', fullscreen: 'Plein écran', loadError: 'Image illisible' },
    })
    viewer.current = v
    ;(window as unknown as { __pssViewer?: Viewer }).__pssViewer = v // inspection in end-to-end tests
    let frame = 0
    v.addEventListener('position-updated', ({ position }) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => onViewRef.current?.(norm180((position.yaw * 180) / Math.PI)))
    })
    return () => {
      cancelAnimationFrame(frame)
      onViewRef.current?.(0)
      v.destroy()
      viewer.current = null
    }
    // the viewer is created once; photos are changed with setPanorama below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = viewer.current
    if (!v) return
    let cancelled = false
    setError(null)
    // The XMP of the file is overridden by the project's value (the photo may not be exported yet)
    const keep = () => ({
      position: v.getPosition(),
      zoom: v.getZoomLevel(),
      transition: false as const,
      showLoader: false,
      panoData: (image: HTMLImageElement, xmp?: PanoData): PanoData => ({
        ...xmp,
        isEquirectangular: true,
        fullWidth: xmp?.fullWidth ?? image.naturalWidth,
        fullHeight: xmp?.fullHeight ?? image.naturalHeight,
        croppedX: xmp?.croppedX ?? 0,
        croppedY: xmp?.croppedY ?? 0,
        poseHeading: pose,
      }),
    })
    v.setPanorama(thumbUrl, keep())
      .catch(() => undefined)
      .then(() => (cancelled ? undefined : v.setPanorama(imageUrl, keep())))
      .catch((e) => {
        if (!cancelled && e?.type !== 'abort' && !String(e).includes('abort')) setError('Photo illisible')
      })
    return () => {
      cancelled = true
    }
    // a new yaw for the same photo reloads it (cached) with the new correction
  }, [thumbUrl, imageUrl, pose])

  const fix = async () => {
    const v = viewer.current
    if (!v || !onFixYaw) return
    // stop the inertia of a mouse drag first, so the direction read is the one on screen
    await v.stopAnimation()
    // The view is in the corrected frame (front = bike for the current yaw): the bike is where we look now
    const look = norm180((v.getPosition().yaw * 180) / Math.PI)
    onFixYaw(Math.round(norm180(pose - look) * 10) / 10)
    v.rotate({ yaw: 0, pitch: v.getPosition().pitch })
  }

  return (
    <div className="viewer360" style={{ height }}>
      <div ref={el} className="viewer360-canvas" />
      {error && <div className="viewer360-error">{error}</div>}
      <button
        className="small viewer360-reset"
        onClick={() => viewer.current?.animate({ yaw: 0, pitch: 0, zoom: 0, speed: '3rpm' })}
        title="Recentrer la vue : face à l'avant (le vélo si sa direction est fixée), à l'horizon, sans zoom"
      >
        ⟲ Recentrer
      </button>
      {onFixYaw && (
        <div className="viewer360-fix">
          <button className="small primary" onClick={fix} title="Tournez la vue vers la route devant le vélo, puis cliquez (caméra sur casque)">
            🚲 {fixLabel ?? 'Fixer la direction du vélo'}
          </button>
          {yaw != null && yaw !== 0 && onResetYaw && (
            <button className="small" onClick={onResetYaw} title="Le centre de l'image regarde dans la direction du vélo">
              Tête {yaw > 0 ? '+' : ''}
              {yaw}° ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function Viewer360(props: Props) {
  const [mode, setMode] = useState<'360' | 'flat'>(savedMode)
  const toggle = () => {
    const m = mode === '360' ? 'flat' : '360'
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="viewer-wrap">
      {mode === '360' ? <Sphere {...props} /> : <PhotoViewer {...props} />}
      <div className="viewer-tools">
        <button className="small" onClick={toggle} title="Basculer entre la vue 360° et l'image à plat (équirectangulaire)">
          {mode === '360' ? 'À plat' : 'Vue 360°'}
        </button>
        <a className="small-text" href={props.imageUrl} target="_blank" rel="noreferrer">
          Original
        </a>
      </div>
    </div>
  )
}
