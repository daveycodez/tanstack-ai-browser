/**
 * Each opponent model's loading status, for the game's progress line: built
 * from its adapter's `availability()` (whether it can run here), the
 * download progress `createSessionWithProgress` reports (only for files
 * that aren't on the device yet), and that load resolving or failing.
 */

export type ModelStatus =
  | { state: "idle" }
  | {
      state: "loading"
      /** 0-1 of the download; 0 while a model on the device loads. */
      progress: number
      /** True once its files are downloading: they weren't on the device. */
      downloading: boolean
    }
  | { state: "ready" }
  | { state: "error"; message: string }

export type LoadingStore = {
  get: () => ModelStatus
  subscribe: (listener: () => void) => () => void
}

/** What the status needs of an adapter: the runtime methods every package's adapters have. */
export type LoadableAdapter = {
  availability: () => Promise<"unavailable" | "downloadable" | "downloading" | "available">
  createSessionWithProgress: (onDownloadProgress?: (progress: number) => void) => Promise<unknown>
}

type Status = LoadingStore & { set: (next: ModelStatus) => void }

function createStatus(): Status {
  let value: ModelStatus = { state: "idle" }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const statuses = new Map<string, Status>()

/** The loading status of the model `key` names. */
export function modelStatus(key: string): Status {
  let status = statuses.get(key)
  if (!status) {
    status = createStatus()
    statuses.set(key, status)
  }
  return status
}

const loads = new Map<string, Promise<void>>()

/**
 * Loads `adapter`'s model (downloading it the first time), keeping the
 * status of `key` up to date. Calls while it loads share the load. A model
 * already ready only checks it still is (it may have been unloaded).
 */
export function loadWithStatus(key: string, adapter: LoadableAdapter): Promise<void> {
  const pending = loads.get(key)
  if (pending) return pending
  const status = modelStatus(key)
  const load = (async () => {
    if (status.get().state !== "ready") {
      // Where it can't run, the load says why (each package's own message).
      const availability = await adapter.availability()
      if (availability !== "unavailable") {
        status.set({ state: "loading", progress: 0, downloading: false })
      }
    }
    await adapter.createSessionWithProgress((progress) => {
      if (progress < 1) status.set({ state: "loading", progress, downloading: true })
    })
    status.set({ state: "ready" })
  })()
    .catch((error: unknown) => {
      status.set({ state: "error", message: error instanceof Error ? error.message : String(error) })
      throw error
    })
    .finally(() => loads.delete(key))
  load.catch(() => undefined)
  loads.set(key, load)
  return load
}

/** Marks the model `key` names as unloaded. */
export function markUnloaded(key: string) {
  const status = modelStatus(key)
  if (status.get().state === "ready") status.set({ state: "idle" })
}
