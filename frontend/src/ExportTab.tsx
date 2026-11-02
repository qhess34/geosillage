import { useEffect, useState } from 'react'
import { api, ExportMode, ExportRecord, Job, seqColor, Sequence, SourcesState } from './api'
import FolderPicker from './FolderPicker'

interface Props {
  projectId: string
  sequences: Sequence[]
  jobs: Job[]
  sources: SourcesState
  excludedPhotos: number // photos excluded by the user
  onStarted: () => void
  onError: (msg: string) => void
}

const KEY = 'pss-export-dir'

const MODES: { id: ExportMode; label: string; help: string }[] = [
  { id: 'copy', label: 'Copier dans un dossier par séquence', help: 'Les photos sources restent intactes.' },
  {
    id: 'move',
    label: 'Déplacer les photos sources dans un dossier par séquence et modifier leurs EXIF',
    help: 'Pas de copie (pas d\'espace disque en plus). Les fichiers sont renommés (numéro + nom) et déplacés.',
  },
  { id: 'in_place', label: 'Modifier les EXIF des photos sources sur place', help: 'Les fichiers ne bougent pas.' },
]

export default function ExportTab({ projectId, sequences, jobs, sources, excludedPhotos, onStarted, onError }: Props) {
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
  const [mode, setMode] = useState<ExportMode>('copy')
  const [confirm, setConfirm] = useState<null | 'export' | 'restore' | 'trash'>(null)
  const [history, setHistory] = useState<ExportRecord[]>([])
  const running = jobs.some((j) => ['export', 'restore_sources', 'trash'].includes(j.kind) && j.state === 'running')

  useEffect(() => {
    api.exports(projectId).then(setHistory, () => undefined)
  }, [projectId, running])

  const chosen = sequences.filter((s) => !excluded.has(s.id))
  const jumps = chosen.reduce((n, s) => n + s.gps_jumps, 0)
  // Jump photos have no computed heading: they are counted apart
  const noHeading = chosen.reduce((n, s) => n + s.headings.uncertain + s.headings.missing, 0) - jumps

  const start = () => {
    setConfirm(null)
    try {
      localStorage.setItem(KEY, dir)
    } catch {
      /* ignore */
    }
    api
      .exportSequences(projectId, mode === 'in_place' ? null : dir, chosen.map((s) => s.id), compat, excludeJumps, mode)
      .then(onStarted, (e) => onError(e.message))
  }
  const trash = () => {
    setConfirm(null)
    api.trashExcluded(projectId).then(onStarted, (e) => onError(e.message))
  }
  const toTrash = excludedPhotos - sources.trashed
  const restore = () => {
    setConfirm(null)
    api.restoreSources(projectId).then(onStarted, (e) => onError(e.message))
  }
  const count = chosen.reduce((n, s) => n + s.count - (excludeJumps ? s.gps_jumps : 0), 0)

  return (
    <div>
      <p className="small-text muted">
        EXIF écrits : cap (GPSImgDirection, référence nord vrai), vitesse (GPSSpeed), GPSVersionID, et position quand elle
        a été corrigée. Les images ne sont jamais recompressées. Un dossier par séquence (<span className="mono">NN_nom/</span>)
        sauf en mode « sur place ».
      </p>
      <fieldset className="modes">
        <legend className="small-text">Mode</legend>
        {MODES.map((m) => (
          <label key={m.id} className="small-text">
            <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} /> {m.label}
            <span className="muted"> — {m.help}</span>
          </label>
        ))}
      </fieldset>
      {mode !== 'copy' && (
        <p className="warn-text small-text">
          Les photos sources seront modifiées. Les valeurs d'origine des balises écrites sont sauvegardées dans le projet :
          « Restaurer les photos sources » les remet (et remet les fichiers à leur place).
        </p>
      )}
      {mode !== 'in_place' && (
        <>
          <label className="small-text">Dossier de destination</label>
          <div className="row">
            <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/chemin/vers/export" />
            <button onClick={() => setPicking(true)}>Parcourir…</button>
          </div>
        </>
      )}
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
        <button
          className="primary"
          disabled={(mode !== 'in_place' && !dir.trim()) || !chosen.length || running}
          onClick={() => (mode === 'copy' ? start() : setConfirm('export'))}
        >
          {running ? 'Tâche en cours…' : `Exporter ${chosen.length} séquence(s)`}
        </button>
      </div>

      {toTrash > 0 && (
        <div className="small-text trash-box">
          {toTrash} photo(s) exclue(s) (touche X) : elles ne sont pas exportées.{' '}
          <button className="small" disabled={running} onClick={() => setConfirm('trash')}>
            Déplacer leurs fichiers dans « _exclues »
          </button>
        </div>
      )}
      {(sources.modified > 0 || sources.moved > 0) && (
        <div className="sources-box small-text">
          <strong>Photos sources modifiées par l'application :</strong> {sources.modified} avec EXIF modifiés
          {sources.moved > 0 && `, ${sources.moved} déplacées`}
          {sources.trashed > 0 && ` (dont ${sources.trashed} exclues dans « _exclues »)`}.
          <div className="actions">
            <button className="danger small" disabled={running} onClick={() => setConfirm('restore')}>
              Restaurer les photos sources
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="alertdialog">
            {confirm === 'trash' ? (
              <>
                <h2>Déplacer les photos exclues ?</h2>
                <p>
                  Les fichiers des {toTrash} photo(s) exclue(s) vont être déplacés dans un dossier « _exclues » à côté d'eux. Rien n'est
                  supprimé : « Restaurer les photos sources » les remet en place.
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>Annuler</button>
                  <button className="danger" onClick={trash}>
                    Déplacer
                  </button>
                </div>
              </>
            ) : confirm === 'export' ? (
              <>
                <h2>Modifier les photos sources ?</h2>
                <p>
                  {count} photo(s) source(s) vont être {mode === 'move' ? 'déplacées dans les dossiers de séquence, renommées, et ' : ''}modifiées
                  (cap{sequences.some((s) => s.corrected > 0) ? ', positions corrigées' : ''}).
                </p>
                <p className="small-text muted">
                  L'image n'est pas recompressée. Les valeurs d'origine des balises sont sauvegardées et peuvent être remises avec
                  « Restaurer les photos sources ».
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>Annuler</button>
                  <button className="danger" onClick={start}>
                    Modifier les photos sources
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Restaurer les photos sources ?</h2>
                <p>
                  Les balises modifiées reprennent leurs valeurs d'origine
                  {sources.moved > 0 ? ' et les photos déplacées retournent à leur emplacement et à leur nom d\'origine' : ''}. Les
                  corrections restent dans le projet.
                </p>
                <div className="actions">
                  <button onClick={() => setConfirm(null)}>Annuler</button>
                  <button className="danger" onClick={restore}>
                    Restaurer
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <>
          <h3>Historique des exports</h3>
          <ul className="export-history small-text">
            {history.map((h) => (
              <li key={h.id}>
                <strong>{h.sequence_name}</strong> — {h.photo_count} photos, {h.report.with_heading} avec cap
                {h.report.corrected_positions > 0 && `, ${h.report.corrected_positions} positions corrigées`}
                {(h.report.excluded_gps_jumps?.length ?? 0) > 0 && `, ${h.report.excluded_gps_jumps?.length} sauts GPS exclus`}
                {h.report.mode === 'move' ? ' · photos sources déplacées' : h.report.mode === 'in_place' ? ' · photos sources modifiées sur place' : ''} ·{' '}
                {new Date(h.ts * 1000).toLocaleString('fr-FR')}
                <div className="mono break muted">{h.path}</div>
                {(h.report.foreign_files?.length ?? 0) > 0 && (
                  <div className="warn-text">
                    {h.report.foreign_files?.length} autre(s) JPEG dans le dossier, hors séquence (ex. {h.report.foreign_files?.[0]})
                  </div>
                )}
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
