// Heading versus orientation, shown side by side so they are not confused:
// - heading (cap): direction of travel, from north (GPSImgDirection) — Panoramax: navigation arrows, map;
// - orientation: where the centre of the image looks, from the direction of travel (XMP PoseHeadingDegrees) —
//   Panoramax: the photo opens facing forward. Changing one never changes the other.
export const CAP_HELP =
  'Cap = sens de déplacement, mesuré depuis le nord (0° nord, 90° est). Écrit dans GPSImgDirection ; Panoramax s\'en sert pour les flèches de navigation et la carte.'
export const ORIENTATION_HELP =
  'Orientation = angle entre le centre de l\'image et le sens de déplacement (caméra sur casque, mal alignée ou à l\'envers). Écrite dans PoseHeadingDegrees ; Panoramax s\'en sert pour ouvrir la photo face à l\'avant. Elle ne change pas le cap.'

// Small top view: north, the heading (blue) and where the centre of the image looks (orange)
export function CapOrientationDiagram({ heading, yaw }: { heading: number | null; yaw: number | null }) {
  const r = 30
  const at = (deg: number, len: number) => {
    const a = ((deg - 90) * Math.PI) / 180
    return [32 + Math.cos(a) * len, 32 + Math.sin(a) * len]
  }
  const h = heading ?? 0
  const [hx, hy] = at(h, r)
  const [cx, cy] = at(h + (yaw ?? 0), r)
  return (
    <svg className="cap-diagram" width="80" height="80" viewBox="0 0 64 64" role="img" aria-label="Cap et orientation, vue de dessus">
      <circle cx="32" cy="32" r="31" fill="none" stroke="currentColor" strokeOpacity="0.25" />
      <text x="32" y="8" textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.6">
        N
      </text>
      {heading != null && <line x1="32" y1="32" x2={hx} y2={hy} stroke="#1d4ed8" strokeWidth="3" markerEnd="url(#cap-arrow)" />}
      {heading != null && yaw ? <line x1="32" y1="32" x2={cx} y2={cy} stroke="#ea580c" strokeWidth="2.5" strokeDasharray="3 2" /> : null}
      <defs>
        <marker id="cap-arrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="#1d4ed8" />
        </marker>
      </defs>
    </svg>
  )
}
