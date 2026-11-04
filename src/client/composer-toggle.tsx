/**
 * Per-session unrestricted switch in the composer tool row.
 *
 * Mirrors the native control next to it (the same `Switch` primitive and row
 * geometry as the auto-continue entry), because the operator should not have
 * to learn a second switch style: label first, pill switch second.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerInjected } from './controller.ts'
import type { UnrestrictedLocaleKey } from './locales.ts'

/** Props assembled by the composer slot renderer. */
export type UnrestrictedComposerToggleProps =
  PropsLocale<'settings.unrestricted'>
  & InjectFace<ComposerInjected>

/**
 * @param props - slot runtime, the `settings.unrestricted` dictionary, and the
 *   controller face for the session this occurrence belongs to.
 */
export function UnrestrictedComposerToggle(props: UnrestrictedComposerToggleProps) {
  const state = props.useUnrestrictedSession(snapshot => snapshot)
  if (props.sessionId === undefined || props.sessionId === '') return null
  const t = props.t as (key: UnrestrictedLocaleKey) => string
  const label = t('composerLabel')
  const title = !state.writable
    ? t('composerReadOnly')
    : state.loading
      ? t('composerLoading')
      : state.enabled ? t('composerOnTitle') : t('composerOffTitle')
  return (
    <div className="dsh-unrestricted-composer" title={title} data-enabled={state.enabled ? 'true' : 'false'}>
      <span className="dsh-unrestricted-composerLabel">{label}</span>
      <span className="dsh-unrestricted-composerSwitch">
        <Switch
          checked={state.enabled}
          disabled={!state.writable || state.loading}
          label={label}
          onChange={(checked) => { props.setEnabled(checked) }}
        />
      </span>
    </div>
  )
}
