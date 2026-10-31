import { useEffect, useState } from 'react'
import { api, ExportRecord, Job, seqColor, Sequence } from './api'
import FolderPicker from './FolderPicker'

interface Props {
  projectId: string
  sequences: Sequence[]
  jobs: Job[]
  onStarted: () => void
  onError: (msg: string) => void
}

const KEY = 'pss-export-dir'

export default function ExportTab({ projectId, sequences, jobs, onStarted, onError }: Props) {
  const [dir, setDir] = useState(() => {
    try {
      return localStorage.getItem(KEY) || ''
    } catch {
      return ''
    }
  })
  const [picking, setPicking] = useState(false)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [compat, setCompat] = useState(true)
  const [excludeJumps, setExcludeJumps] = useState(true)
  const [history, setHistory] = useState<ExportRecord[]>([])
  const running = jobs.some((j) => j.kind === 'export' && j.state === 'running')

  useEffect(() => {
    api.exports(projectId).then(setHistory, () => undefined)
  }, [projectId, running])

  const chosen = sequences.filter((s) => !excluded.has(s.id))
  const jumps = chosen.reduce((n, s) => n + s.gps_jumps, 0)
  // Jump photos have no computed heading: they are counted apart
  const noHeading = chosen.reduce((n, s) => n + s.headings.uncertain + s.headings.missing, 0) - jumps

  const start = () => {
    try {
      localStorage.setItem(KEY, dir)
    } catch {
      /* ignore */
    }
    api.exportSequences(projectId, dir, chosen.map((s) => s.id), compat, excludeJumps).then(onStarted, (e) => onError(e.message))
  }

  return (
    <div>
      <p className="small-text muted">
        Chaque séquence est copiée dans son propre dossier (<span className="mono">NN_nom/</span>), avec les EXIF corrigés :
        cap (GPSImgDirection, référence nord vrai, et XMP PoseHeadingDegrees) et position quand elle a été corrigée. Les
        images ne sont pas recompressées et les originaux ne sont jamais modifiés.
      </p>
      <label className="small-text">Dossier de destination</label>
      <div className="row">
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/chemin/vers/export" />
        <button onClick={() => setPicking(true)}>Parcourir…</button>
      </div>
      <h3>Séquences à exporter</h3>
      {sequences.length === 0 ? (
        <p className="muted small-text">Aucune séquence.</p>
      ) : (
        <ul className="export-list">
          {sequences.map((s, i) => (
            <li key={s.id}>
              <label>
                <input
                  type="checkbox"
                  checked={!excluded.has(s.id)}
                  onChange={() => {
                    const n = new Set(excluded)
                    if (n.has(s.id)) n.delete(s.id)
                    else n.add(s.id)
                    setExcluded(n)
                  }}
                />{' '}
                <span className="chip" style={{ background: seqColor(sequences, s.id) }} /> {String(i + 1).padStart(2, '0')} · {s.name}{' '}
                <span className="muted">({s.count} photos)</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <label className="small-text">
        <input type="checkbox" checked={compat} onChange={(e) => setCompat(e.target.checked)} /> Compatibilité Panoramax : un cap
        arrondi à 0° est écrit 0,6° (Panoramax considère 0 comme « absent » et le recalculerait)
      </label>
      <label className="small-text">
        <input type="checkbox" checked={excludeJumps} onChange={(e) => setExcludeJumps(e.target.checked)} /> Exclure les photos en
        saut GPS non corrigées{jumps > 0 ? ` (${jumps})` : ''} : leur position est fausse
      </label>
      {noHeading > 0 && (
        <p className="warn-text small-text">
          {noHeading} photo(s) sans cap fiable (arrêt, GPS manquant) : elles seront exportées sans cap. Corrigez-les dans
          l'onglet Photo si besoin.
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={!dir.trim() || !chosen.length || running} onClick={start}>
          {running ? 'Export en cours…' : `Exporter ${chosen.length} séquence(s)`}
        </button>
      </div>

      {history.length > 0 && (
        <>
          <h3>Historique des exports</h3>
          <ul className="export-history small-text">
            {history.map((h) => (
              <li key={h.id}>
                <strong>{h.sequence_name}</strong> — {h.photo_count} photos, {h.report.with_heading} avec cap
                {h.report.corrected_positions > 0 && `, ${h.report.corrected_positions} positions corrigées`}
                {(h.report.excluded_gps_jumps?.length ?? 0) > 0 && `, ${h.report.excluded_gps_jumps?.length} sauts GPS exclus`} ·{' '}
                {new Date(h.ts * 1000).toLocaleString('fr-FR')}
                <div className="mono break muted">{h.path}</div>
                {Object.keys(h.report.problems).length > 0 && (
                  <div className="error">{Object.keys(h.report.problems).length} problème(s) de vérification</div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {picking && (
        <FolderPicker
          title="Dossier d'export"
          initial={dir || '~'}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setDir(p)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
