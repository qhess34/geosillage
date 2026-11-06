import { FsListing } from './api'

// Listing of one local folder: clickable path (breadcrumb), parent button, sub-folders (the whole row opens it).
// `extra` adds actions to the header (current folder) and to each row (sub-folder path).
export default function FsBrowser({
  listing,
  error,
  onGo,
  headExtra,
  rowExtra,
}: {
  listing: FsListing | null
  error: string | null
  onGo: (path: string) => void
  headExtra?: React.ReactNode
  rowExtra?: (path: string) => React.ReactNode
}) {
  if (!listing) return error ? <p className="error">{error}</p> : null
  const sep = listing.path.includes('\\') && !listing.path.includes('/') ? '\\' : '/'
  const join = (d: string) => (listing.path.endsWith(sep) ? listing.path + d : listing.path + sep + d)
  // breadcrumb: "/", "/photos", "/photos/Sortie" (or "C:\", "C:\Users"…)
  const parts = listing.path.split(sep).filter(Boolean)
  const root = listing.path.startsWith(sep) ? sep : ''
  const crumbs = parts.map((name, i) => {
    const p = root + parts.slice(0, i + 1).join(sep)
    return { name, path: i === 0 && !root ? p + sep : p }
  })
  return (
    <div className="fs">
      <div className="fs-head">
        <button disabled={!listing.parent} onClick={() => listing.parent && onGo(listing.parent)} title="Dossier parent">
          ↑
        </button>
        <span className="fs-crumbs mono" title={listing.path}>
          {root && (
            <button className="link" onClick={() => onGo(root)}>
              {root}
            </button>
          )}
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="muted">{sep}</span>}
              {i === crumbs.length - 1 ? (
                <strong>{c.name}</strong>
              ) : (
                <button className="link" onClick={() => onGo(c.path)}>
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </span>
        {headExtra}
      </div>
      {error && <p className="error fs-error">{error}</p>}
      <ul className="fs-list">
        {listing.dirs.map((d) => (
          <li key={d}>
            <button className="fs-dir" onClick={() => onGo(join(d))} title="Ouvrir ce dossier">
              <span>📁 {d}</span>
              <span className="muted">›</span>
            </button>
            {rowExtra?.(join(d))}
          </li>
        ))}
        {!listing.dirs.length && !listing.files.length && <li className="muted">Dossier vide</li>}
        {listing.files.map((f) => (
          <li key={f.name} className="fs-file" title="Photo de ce dossier (pour information : l'import se fait par dossier)">
            <span>🖼 {f.name}</span>
            {f.size != null && <span>{(f.size / 1e6).toFixed(1)} Mo</span>}
          </li>
        ))}
        {listing.jpeg_count > listing.files.length && (
          <li className="muted">… et {listing.jpeg_count - listing.files.length} autres photos</li>
        )}
      </ul>
    </div>
  )
}
