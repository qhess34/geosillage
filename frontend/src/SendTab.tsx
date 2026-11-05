import { seqColor, Sequence } from './api'
import PublishedEdit from './PublishedEdit'

// Panoramax project: send the corrections of each sequence (replaces the Export tab)
export default function SendTab({
  projectId,
  instance,
  sequences,
  onStarted,
  onError,
}: {
  projectId: string
  instance: string | null
  sequences: Sequence[]
  onStarted: () => void
  onError: (msg: string) => void
}) {
  const changed = sequences.filter((s) => s.changed_since_publication)
  return (
    <div className="small-text">
      <h3>Envoyer les corrections sur Panoramax</h3>
      <p className="muted">
        Séquences déjà publiées sur {instance?.replace(/^https?:\/\//, '') ?? 'Panoramax'}. Corrigez positions, caps et orientation dans
        les autres onglets, puis, pour chaque séquence : « Comparer avec Panoramax » et « Envoyer les corrections ». Seules les photos qui
        diffèrent sont envoyées ; les photos exclues peuvent être supprimées de Panoramax (sur demande).
      </p>
      <p>{changed.length ? `${changed.length} séquence(s) modifiée(s) depuis l'import ou le dernier envoi.` : 'Aucune séquence modifiée.'}</p>
      <ul className="seq-list">
        {sequences.map((s) => (
          <li key={s.id} className="seq">
            <div className="seq-head">
              <span className="chip" style={{ background: seqColor(sequences, s.id) }} />
              <strong className="grow ellipsis">{s.name}</strong>
              <span className="muted">{s.count} ph.</span>
            </div>
            {s.changed_since_publication && <span className="badge warn-text">modifiée, à envoyer</span>}
            <PublishedEdit projectId={projectId} s={s} onStarted={onStarted} onError={onError} />
          </li>
        ))}
      </ul>
    </div>
  )
}
