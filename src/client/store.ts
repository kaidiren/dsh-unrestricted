/**
 * Minimal observable snapshot store for slot hooks.
 *
 * The slot renderer subscribes through `useSyncExternalStore`, so the shape
 * only has to expose a stable `getSnapshot` plus `subscribe`. Snapshots are
 * replaced only when a field actually changes: an always-fresh object would
 * re-render on every publish and spin the external-store loop.
 */

/** Snapshot store handed to a slot through `hooks`. */
export interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
  update(mutator: (draft: T) => void): void
}

/**
 * @param initial - first snapshot published to subscribers.
 * @returns a store whose identity changes only when {@link Store.set} is called.
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    update(mutator) {
      const next = { ...value }
      mutator(next)
      value = next
      for (const listener of listeners) listener()
    },
  }
}
