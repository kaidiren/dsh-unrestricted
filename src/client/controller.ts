/**
 * Browser-half controller: binds the `unrestricted` settings namespace, keeps
 * the per-session switch in sync with it, and reads per-preset state/previews.
 *
 * The armed flags live in the plugin config as `sessions: SessionId -> boolean`
 * so the host resolves them at assembly time; this half only mirrors the map
 * and writes single-session deltas into it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createStore, type Store } from './store.ts'

/** The settings section stored in the `unrestricted` namespace. */
export interface UnrestrictedSettings {
  /** Armed sessions; absent or `false` means the stock prompt is assembled. */
  sessions?: Record<string, boolean>
}

/** Per-preset fusion state reported by the host half. */
export interface UnrestrictedModeState {
  state: 'off' | 'active' | 'failed'
  issues: string[]
}

/** Host status endpoint payload. */
export interface UnrestrictedStatus {
  /** Session ids currently armed. */
  sessions: string[]
  /** Current plugin version reported by the host half. */
  version?: string
  modes: Record<string, UnrestrictedModeState>
}

/** Deploy preview for one preset: what an armed session would actually receive. */
export interface UnrestrictedPreview {
  presetId: string
  available: boolean
  /** `live` = bytes a live agent received; `standing` = preset scope, no agent bound. */
  source?: 'live' | 'standing'
  /** Fused prompt text; present when available. */
  text?: string
  bytes?: number
  lines?: number
  /** Structured error code when unavailable. */
  errorCode?: string
  /** Diagnostic reason when unavailable. */
  reason?: string
}

/** One fetched preview, keyed by preset, plus its in-flight/error state. */
export interface UnrestrictedPreviewEntry {
  status: 'loading' | 'ready' | 'failed'
  preview?: UnrestrictedPreview
  errorCode?: string
  message?: string
}

/** Full view snapshot the card subscribes to. */
export interface UnrestrictedViewSnapshot {
  /** Armed flags mirrored from settings; empty until the scope first syncs. */
  sessions: Record<string, boolean>
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Settings scope sync state. */
  settingsStatus: 'loading' | 'ready' | 'unavailable'
  /** Live host status; null until the first RPC answer. */
  status: UnrestrictedStatus | null
  /** presetId -> fetched deploy preview. */
  previews: Record<string, UnrestrictedPreviewEntry>
  /** Whether a settings write or status refresh is in flight. */
  busy: boolean
  /** Last transport/business failure, if any. */
  message?: string
}

/** One session's composer switch state. */
export interface ComposerToggleState {
  enabled: boolean
  writable: boolean
  loading: boolean
}

/** Minimal RPC wire shape (structural copy of the host RpcResult). */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Minimal observable contract consumed by the slot renderer's hook binding. */
export interface UnrestrictedViewSource {
  getSnapshot(): UnrestrictedViewSnapshot
  subscribe(listener: () => void): () => void
}

/** Inject face handed to the settings card at registration. */
export interface UnrestrictedCardInjected {
  hooks: {
    /** Reactive card view. */
    view: UnrestrictedViewSource
  }
  /** Arm or disarm one session, persisting the whole map. */
  setSessionEnabled: (sessionId: string, enabled: boolean) => Promise<void>
  /** Re-validate runtime state and refresh. */
  recheck: () => Promise<void>
  /** Re-read host status and invalidate cached previews. */
  refresh: () => Promise<void>
  /** Fetch the exact fused prompt this preset would deploy. */
  loadPreview: (presetId: string) => Promise<void>
}

/** Inject face handed to one composer occurrence. */
export interface ComposerInjected {
  hooks: {
    /** That session's switch state. */
    unrestrictedSession: Store<ComposerToggleState>
  }
  /** Session this occurrence renders for. */
  sessionId: string
  /** Arm or disarm this session. */
  setEnabled: (enabled: boolean) => void
}

const RPC_CHANNEL = '/dsh-unrestricted'
const SETTINGS_NS = 'unrestricted'

/** Human-readable error text for the banner. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether two armed maps carry the same session flags. */
function sameSessions(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/**
 * Create the controller bound to the calling plugin's context.
 * @param ctx - the browser plugin context (connection + remote + configForms injected).
 * @returns the card face factory and the per-session composer factory.
 */
export function createUnrestrictedController(ctx: Context) {
  const connection = ctx.get('connection') as ConnectionHandle
  const settings = ctx.configForms.get<UnrestrictedSettings>(SETTINGS_NS)

  let snapshot: UnrestrictedViewSnapshot = {
    sessions: {},
    writable: false,
    settingsStatus: 'loading',
    status: null,
    previews: {},
    busy: false,
  }
  const listeners = new Set<() => void>()
  const previewRequests = new Map<string, symbol>()
  const composerStores = new Map<string, Store<ComposerToggleState>>()
  let statusGeneration = 0
  let pendingOperations = 0

  const view: UnrestrictedViewSource = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  /** Mirror every composer switch from the same settings snapshot. */
  function publishComposers(armed: Record<string, boolean>, writable: boolean, loading: boolean): void {
    for (const [sessionId, store] of composerStores) {
      const next: ComposerToggleState = {
        enabled: armed[sessionId] === true,
        writable,
        loading,
      }
      const previous = store.getSnapshot()
      if (previous.enabled !== next.enabled || previous.writable !== next.writable || previous.loading !== next.loading) {
        store.set(next)
      }
    }
  }

  function publish(): void {
    const settingsSnapshot = settings.getSnapshot()
    const armed: Record<string, boolean> = {}
    for (const [sessionId, value] of Object.entries(settingsSnapshot.value?.sessions ?? {})) {
      if (value === true) armed[sessionId] = true
    }
    if (!sameSessions(armed, snapshot.sessions)) invalidatePreviews()
    snapshot = {
      sessions: armed,
      writable: settingsSnapshot.writable,
      settingsStatus: settingsSnapshot.status,
      status: snapshot.status,
      previews: snapshot.previews,
      busy: pendingOperations > 0,
      message: snapshot.message,
    }
    for (const listener of listeners) listener()
    publishComposers(armed, settingsSnapshot.writable, settingsSnapshot.status !== 'ready')
  }

  function invalidatePreviews(): void {
    previewRequests.clear()
    snapshot = { ...snapshot, previews: {} }
  }

  async function call<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload) as RpcResult<T>
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async function whileBusy(action: () => Promise<void>): Promise<void> {
    pendingOperations++
    publish()
    try {
      await action()
    } finally {
      pendingOperations--
      publish()
    }
  }

  function readStatus(endpoint: 'status' | 'recheck', clearPreviews: boolean): Promise<void> {
    const generation = ++statusGeneration
    return whileBusy(async () => {
      try {
        const status = await call<UnrestrictedStatus>(endpoint, {})
        if (generation !== statusGeneration) return
        if (clearPreviews) invalidatePreviews()
        snapshot = {
          ...snapshot,
          status,
          message: undefined,
        }
      } catch (error) {
        if (generation !== statusGeneration) return
        snapshot = { ...snapshot, message: messageOf(error) }
      }
    })
  }

  function refresh(clearPreviews = false): Promise<void> {
    return readStatus('status', clearPreviews)
  }

  /**
   * Write one session's flag. The settings service takes whole fields, so the
   * current map is merged into a fresh object; disarming deletes the key
   * instead of storing `false`, keeping the persisted map as the armed set.
   */
  function setSessionEnabled(sessionId: string, enabled: boolean): Promise<void> {
    return whileBusy(async () => {
      try {
        const next: Record<string, boolean> = {}
        for (const [id, value] of Object.entries(settings.getSnapshot().value?.sessions ?? {})) {
          if (value === true) next[id] = true
        }
        if (enabled) next[sessionId] = true
        else delete next[sessionId]
        await settings.set('sessions', next)
        await refresh(true)
      } catch (error) {
        snapshot = { ...snapshot, message: messageOf(error) }
      }
    })
  }

  function recheck(): Promise<void> {
    return readStatus('recheck', true)
  }

  /**
   * Fetch one preset's deploy preview.
   * @param presetId - preset id from the card's row.
   */
  async function loadPreview(presetId: string): Promise<void> {
    const request = Symbol(presetId)
    previewRequests.set(presetId, request)
    snapshot = {
      ...snapshot,
      previews: { ...snapshot.previews, [presetId]: { status: 'loading' } },
    }
    publish()
    try {
      const preview = await call<UnrestrictedPreview>('preview', { presetId })
      if (previewRequests.get(presetId) !== request) return
      snapshot = {
        ...snapshot,
        previews: { ...snapshot.previews, [presetId]: { status: 'ready', preview } },
      }
    } catch (error) {
      if (previewRequests.get(presetId) !== request) return
      snapshot = {
        ...snapshot,
        previews: {
          ...snapshot.previews,
          [presetId]: {
            status: 'failed',
            errorCode: 'preview-failed',
            message: messageOf(error),
          },
        },
      }
    }
    publish()
  }

  /** The store one composer occurrence renders from, created on first ask. */
  function composerStore(sessionId: string): Store<ComposerToggleState> {
    let store = composerStores.get(sessionId)
    if (store === undefined) {
      const settingsSnapshot = settings.getSnapshot()
      store = createStore<ComposerToggleState>({
        enabled: settingsSnapshot.value?.sessions?.[sessionId] === true,
        writable: settingsSnapshot.writable,
        loading: settingsSnapshot.status !== 'ready',
      })
      composerStores.set(sessionId, store)
    }
    return store
  }

  ctx.effect(
    () => settings.subscribe(publish),
    'dsh-unrestricted: settings mirror',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', (namespace?: string) => {
      if (namespace === undefined || namespace === SETTINGS_NS) void refresh(true)
    }),
    'dsh-unrestricted: settings invalidations',
  )

  publish()
  void refresh()
  return {
    face: (): UnrestrictedCardInjected => ({
      hooks: { view },
      setSessionEnabled,
      recheck,
      refresh: () => refresh(true),
      loadPreview,
    }),
    composer: (sessionId: string): ComposerInjected => ({
      hooks: { unrestrictedSession: composerStore(sessionId) },
      sessionId,
      setEnabled: (enabled: boolean) => { void setSessionEnabled(sessionId, enabled) },
    }),
  }
}
