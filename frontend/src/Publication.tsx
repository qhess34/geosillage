import { useEffect, useState } from 'react'
import { api, PanoramaxStatus, Sequence, Tag } from './api'
import { Confirm } from './Dialogs'
import { rich, t, useLang } from './i18n'

// Wording of a publication state (a function: the language can change)
export const publicationStates = (): Record<string, string> => ({
  uploading: t('pub.state.uploading'),
  processing: t('pub.state.processing'),
  ready: t('pub.state.ready'),
  error: t('pub.state.error'),
})

// Link opening a published sequence in the instance's viewer, on its first picture
export function viewerUrl(instance: string, pictureId: string): string {
  return `${instance.replace(/\/+$/, '')}/#focus=pic&pic=${pictureId}`
}

// Options of a publication on Panoramax, shared by the « Publier » buttons of the exported sequences: connection,
// visibility, attributes (those of the last publication are proposed again)
export function usePublishOptions() {
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [visibility, setVisibility] = useState<'anyone' | 'owner-only'>('anyone')
  const [transport, setTransport] = useState('')
  const [extra, setExtra] = useState('') // other attributes, one key=value per line
  const [tagsReady, setTagsReady] = useState(false)
  useEffect(() => {
    if (!st || tagsReady) return
    setTransport(st.semantics.find((t) => t.key === 'transport')?.value ?? '')
    setExtra(st.semantics.filter((t) => t.key !== 'transport').map((t) => `${t.key}=${t.value}`).join('\n'))
    setTagsReady(true)
  }, [st, tagsReady])
  const parsed = parseTags(extra)
  const semantics: Tag[] = [...(transport ? [{ key: 'transport', value: transport }] : []), ...parsed.tags]
  return { st, setSt, visibility, setVisibility, transport, setTransport, extra, setExtra, parsed, semantics }
}
export type PublishOptions = ReturnType<typeof usePublishOptions>

// Section « Publier sur Panoramax » of the Export tab: connection, options, and « Publier les n séquences exportées non
// publiées » (one confirmation, one api.publish call); each exported sequence also has its own « Publier » button in
// the list above
export function PublishOptionsPanel({
  o,
  projectId,
  sequences,
  running,
  onStarted,
  onError,
}: {
  o: PublishOptions
  projectId: string
  sequences: Sequence[]
  running: boolean // a publication is in progress
  onStarted: () => void
  onError: (msg: string) => void
}) {
  useLang()
  // exported sequences not (fully) on Panoramax yet: never published, or upload interrupted / failed
  const pending = sequences.filter((s) => s.last_export && s.last_publication?.state !== 'ready' && s.last_publication?.state !== 'processing')
  const [confirmAll, setConfirmAll] = useState(false)
  const publishAll = () => {
    setConfirmAll(false)
    api.publish(projectId, pending.map((s) => s.id), o.visibility, o.semantics).then(onStarted, (e) => onError(e.message))
  }
  return (
    <div className="publish small-text">
      <h3>{t('pub.heading')}</h3>
      <p className="muted">{rich(t('pub.intro'))}</p>
      <PnxConnection onChange={o.setSt} onError={onError} />
      {o.st?.connected && (
        <>
          <fieldset className="modes">
            <legend>{t('pub.visibility')}</legend>
            <label>
              <input type="radio" checked={o.visibility === 'anyone'} onChange={() => o.setVisibility('anyone')} /> {t('pub.everyone')}
            </label>
            <label>
              <input type="radio" checked={o.visibility === 'owner-only'} onChange={() => o.setVisibility('owner-only')} /> {t('pub.onlyMe')}
            </label>
          </fieldset>
          <fieldset className="modes">
            <legend>{t('pub.attrs')}</legend>
            <div className="row wrap" role="radiogroup" aria-label={t('pub.transportLabel')}>
              {transports().map(([v, label]) => (
                <label key={v}>
                  <input type="radio" checked={o.transport === v} onChange={() => o.setTransport(v)} /> {label}
                </label>
              ))}
            </div>
            <label className="tags-input">
              {t('pub.otherAttrs')} <span className="muted">{t('pub.otherAttrsHint')}</span>
              <textarea rows={3} value={o.extra} onChange={(e) => o.setExtra(e.target.value)} spellCheck={false} aria-label={t('pub.otherAttrsLabel')} />
            </label>
            {o.parsed.bad.length > 0 && <p className="warn-text">{t('pub.badLines', { lines: o.parsed.bad.join(', ') })}</p>}
            <p className="muted">
              {o.semantics.length ? t('pub.sent', { list: o.semantics.map((x) => `${x.key}=${x.value}`).join(', ') }) : t('pub.noneSent')}{' '}
              {t('pub.attrsNote')}
            </p>
          </fieldset>
          <div className="actions">
            <button
              className="primary"
              disabled={!pending.length || running || o.parsed.bad.length > 0}
              title={pending.length ? '' : t('pub.allPublished')}
              onClick={() => setConfirmAll(true)}
            >
              {running ? t('pub.running') : t('pub.publishAll', { n: pending.length })}
            </button>
          </div>
          {confirmAll && (
            <Confirm title={t('pub.confirmAllTitle', { n: pending.length })} confirmLabel={t('pub.publish')} onCancel={() => setConfirmAll(false)} onConfirm={publishAll}>
              <p>
                {rich(t('pub.confirmAllBody', { instance: o.st!.instance.replace(/^https?:\/\//, ''), vis: visText(o), attrs: attrsText(o, true) }))}
              </p>
              <ul className="small-text">
                {pending.map((s) => (
                  <li key={s.id}>
                    {s.name} ({t('seq.photos', { n: s.count })}){s.last_publication?.state === 'uploading' ? t('pub.resumeUpload') : ''}
                    {s.needs_export ? t('pub.reexportFirst') : ''}
                  </li>
                ))}
              </ul>
            </Confirm>
          )}
        </>
      )}
    </div>
  )
}

// « Publier » button of an exported sequence (Export tab), with its confirmation
export function PublishButton({
  projectId,
  s,
  o,
  running,
  onStarted,
  onError,
}: {
  projectId: string
  s: Sequence
  o: PublishOptions
  running: boolean
  onStarted: () => void
  onError: (msg: string) => void
}) {
  useLang()
  const [confirm, setConfirm] = useState(false)
  const pub = s.last_publication
  const label = pub?.state === 'uploading' ? t('pub.resume') : pub ? t('pub.republish') : t('pub.publish')
  const why = !o.st?.connected
    ? t('pub.whyConnect')
    : o.parsed.bad.length
      ? t('pub.whyAttrs')
      : running
        ? t('pub.whyRunning')
        : ''
  const publish = () => {
    setConfirm(false)
    api.publish(projectId, [s.id], o.visibility, o.semantics).then(onStarted, (e) => onError(e.message))
  }
  return (
    <>
      <button className={pub ? 'small' : 'small primary'} disabled={!!why} title={why || t('pub.publishTitle', { name: s.name })} onClick={() => setConfirm(true)}>
        ⇪ {label}
      </button>
      {confirm && o.st && (
        <Confirm title={t('pub.confirmTitle', { label, name: s.name })} confirmLabel={label} onCancel={() => setConfirm(false)} onConfirm={publish}>
          <p>
            {rich(t('pub.confirmBody', { n: t('seq.photos', { n: s.count }), instance: o.st.instance.replace(/^https?:\/\//, ''), vis: visText(o), attrs: attrsText(o, false) }))}
            {s.needs_export ? t('pub.changedSinceExport') : ''}
          </p>
          {pub && pub.state !== 'uploading' && (
            <p className="small-text warn-text">
              {t('pub.alreadyOn')}
            </p>
          )}
        </Confirm>
      )}
    </>
  )
}

// Transport modes offered by the Panoramax website (attribute transport); "other": no attribute
const transports = (): [string, string][] => [
  ['walk', t('pub.walk')],
  ['bike', t('pub.bike')],
  ['car', t('pub.car')],
  ['', t('pub.otherTransport')],
]

const visText = (o: PublishOptions) => (o.visibility === 'anyone' ? t('pub.visAnyone') : t('pub.visOwner'))
const attrsText = (o: PublishOptions, always: boolean) =>
  o.semantics.length ? t('pub.withAttrs', { list: o.semantics.map((x) => `${x.key}=${x.value}`).join(', ') }) : always ? t('pub.noAttr') : ''

// "key=value" lines → attributes; blank lines are ignored, lines without "=" are reported
export function parseTags(text: string): { tags: Tag[]; bad: string[] } {
  const tags: Tag[] = []
  const bad: string[] = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    const i = l.indexOf('=')
    const key = i > 0 ? l.slice(0, i).trim() : ''
    const value = i > 0 ? l.slice(i + 1).trim() : ''
    if (!key || !value) bad.push(`« ${l.slice(0, 30)} »`)
    else if (!tags.some((t) => t.key === key && t.value === value)) tags.push({ key, value })
  }
  return { tags, bad }
}

// Instance address and connection (claim link); the token stays on the server
export function PnxConnection({ onChange, onError }: { onChange: (s: PanoramaxStatus) => void; onError: (msg: string) => void }) {
  useLang()
  const [st, setSt] = useState<PanoramaxStatus | null>(null)
  const [url, setUrl] = useState('')
  const take = (p: Promise<PanoramaxStatus>) =>
    p.then(
      (s) => {
        setSt(s)
        setUrl(s.instance)
        onChange(s)
      },
      (e) => onError(e.message),
    )
  useEffect(() => {
    take(api.pnxStatus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!st) return null
  return (
    <>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim() && url.trim() !== st.instance) take(api.pnxInstance(url))
        }}
      >
        <label className="grow">
          {t('pub.instance')}{' '}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://panoramax.openstreetmap.fr" aria-label={t('pub.instanceLabel')} />
        </label>
        <button className="small" type="submit" disabled={url.trim() === st.instance}>
          {t('pub.change')}
        </button>
      </form>

      {st.connected ? (
        <p>
          {rich(t('pub.connectedTo', { instance: st.instance.replace(/^https?:\/\//, '') }))}
          {st.account ? rich(t('pub.asAccount', { account: st.account })) : ''} ·{' '}
          <button className="link" onClick={() => take(api.pnxLogout())}>
            {t('pub.logout')}
          </button>
        </p>
      ) : st.claim_url ? (
        <div className="claim-box">
          <p>
            {t('pub.claim1')}{' '}
            <a href={st.claim_url} target="_blank" rel="noreferrer">
              {t('pub.claimLink')}
            </a>
          </p>
          <p>
            {t('pub.claim2')}{' '}
            <button className="small primary" onClick={() => take(api.pnxCheck())}>
              {t('pub.claimCheck')}
            </button>{' '}
            <button className="small" onClick={() => take(api.pnxLogin())}>
              {t('pub.claimNew')}
            </button>
          </p>
        </div>
      ) : (
        <p>
          <button className="small primary" onClick={() => take(api.pnxLogin())}>
            {t('pub.login')}
          </button>{' '}
          <span className="muted">{t('pub.loginNote')}</span>
        </p>
      )}

    </>
  )
}
