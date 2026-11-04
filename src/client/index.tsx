/** 在本体的插件管理页面提供状态与预览，并在输入框工具栏提供会话级开关。 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the renderer provides the ctx.slots service used for registration.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: 本插件配置所在的原生槽位。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Context } from '@deepseek-ai/cordis'
import { createUnrestrictedController } from './controller.ts'
import { UnrestrictedComposerToggle } from './composer-toggle.tsx'
import { en, NS, zh, type UnrestrictedLocaleKey } from './locales.ts'
import { ensureStyles } from './styles.ts'
import { UnrestrictedCard } from './UnrestrictedCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 输入框工具行左侧的紧凑控件；会话级开关与「自动继续」同排。 */
    'conversation.input.left': {
      kind: 'list'
      scope: 'session'
    }
  }

  interface LocaleNamespaceMap {
    /** Unrestricted mode copy. */
    'settings.unrestricted': UnrestrictedLocaleKey
  }
}

/** Services required by the registration and the controller. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms']

/** 注册配置卡片与输入框内的会话级开关。 */
export function apply(ctx: Context): void {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-unrestricted: dictionaries')
  const controller = createUnrestrictedController(ctx)
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-unrestricted',
    locale: NS,
    inject: () => controller.face(),
  }, UnrestrictedCard))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-unrestricted-session',
    locale: NS,
    inject: (sessionId: string) => controller.composer(sessionId),
  }, UnrestrictedComposerToggle))
}
