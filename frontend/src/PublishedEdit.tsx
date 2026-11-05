import { useState } from 'react'
import { api, PublishedDiff, Sequence } from './api'
import { Confirm } from './Dialogs'

// Séquences tab: corrections of a sequence already on Panoramax (published by the application, or linked)

export default function PublishedEdit({
  projectId,
  s,
  onStarted,
  onError,
}: {
  projectId: string
  s: Sequence
  onStarted: () => void
  onError: (msg: string) => void
}) {
  const [diff, setDiff] = useState<PublishedDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [delExcluded, setDelExcluded] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const compare = () => {
    setBusy(true)
    api.pnxCompare(projectId, s.id).then(
      (d) => {
        setDiff(d)
        setBusy(false)
      },
      (e) => {
        setBusy(false)
        onError(e.message)
      },
    )
  }
  const started = () => {
    setDiff(null)
    setConfirm(false)
    onStarted()
  }

  if (!s.last_publication) return null // only sequences published by the application (or a Panoramax project)

  const nothing = diff && diff.photos_to_update === 0 && diff.to_delete === 0
  return (
    <div className="published-edit small-text">
      {!diff ? (
        <button className="small" disabled={busy} onClick={compare} title="Compare les positions, caps et orientations avec ceux de la séquence publiée">
          {busy ? 'Comparaison…' : 'Comparer avec Panoramax'}
        </button>
      ) : (
        <div className="confirm-box">
          {nothing ? (
            <div>✓ La séquence publiée est à jour.</div>
          ) : (
            <div>
              À envoyer : {diff.photos_to_update} photo(s) — {diff.positions} position(s), {diff.headings} cap(s), {diff.orientations}{' '}
              orientation(s)
              {diff.to_delete > 0 && <>, {diff.to_delete} photo(s) exclue(s) depuis</>}.
            </div>
          )}
          {diff.not_published > 0 && (
            <div className="warn-text">
              {diff.not_published} photo(s) de la séquence ne sont pas sur Panoramax (ajoutées depuis) : elles ne peuvent pas être ajoutées,
              republiez la séquence pour les inclure.
            </div>
          )}
          {!nothing && (
            <>
              {diff.to_delete > 0 && (
                <label className="option-line">
                  <input type="checkbox" checked={delExcluded} onChange={(e) => setDelExcluded(e.target.checked)} /> Supprimer aussi de Panoramax
                  les {diff.to_delete} photo(s) exclue(s) (définitif)
                </label>
              )}
              <div className="muted">
                Les corrections sont enregistrées par l'instance (affichage, carte), pas dans le fichier d'origine stocké sur Panoramax.
              </div>
              <button className="small primary" onClick={() => setConfirm(true)}>
                Envoyer les corrections
              </button>
              {confirm && (
                <Confirm
                  title="Envoyer les corrections ?"
                  confirmLabel="Envoyer"
                  danger={delExcluded && diff.to_delete > 0}
                  onCancel={() => setConfirm(false)}
                  onConfirm={() => api.pnxPush(projectId, s.id, delExcluded).then(started, (e) => onError(e.message))}
                >
                  <p>
                    {diff.photos_to_update} photo(s) corrigée(s) sur <strong>{diff.instance.replace(/^https?:\/\//, '')}</strong>
                    {delExcluded && diff.to_delete > 0 ? <>, et {diff.to_delete} photo(s) supprimée(s) définitivement</> : ''}.
                  </p>
                </Confirm>
              )}
            </>
          )}
          <div className="row wrap">
            {diff.last_edit && (
              <button
                className="small"
                onClick={() => api.pnxRevert(projectId, s.id).then(started, (e) => onError(e.message))}
                title="Renvoie les valeurs qu'avait Panoramax avant le dernier envoi de corrections (les photos supprimées ne reviennent pas)"
              >
                Remettre les valeurs d'avant (envoi du {new Date(diff.last_edit.ts * 1000).toLocaleString('fr-FR')})
              </button>
            )}
            <button className="small" onClick={() => setDiff(null)}>
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
