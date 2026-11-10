/**
 * The way from the page to a handler (the chat model's, or Whisper's):
 * requests in, replies out. It's a Web Worker's messages, or for a handler
 * in the same process, direct calls.
 */

/** The way to a handler: requests in, and `close` when the client is done with it. */
export type Port<Request> = { post(request: Request, transfer?: Array<Transferable>): void; close(): void }

/** Opens the way to a handler, whose replies go to `onReply`. */
export type Open<Request, Reply> = (onReply: (reply: Reply) => void, onError: (message: string) => void) => Port<Request>

/** A worker of the caller's: it's left running, and its other listeners alone. */
export const givenWorker =
  <Request, Reply>(worker: Worker): Open<Request, Reply> =>
  (onReply, onError) => {
    const onMessage = ({ data }: MessageEvent<Reply>) => onReply(data)
    const onFailure = (event: ErrorEvent) => onError(event.message || "The worker failed.")
    worker.addEventListener("message", onMessage)
    worker.addEventListener("error", onFailure)
    return {
      post: (request, transfer) => worker.postMessage(request, transfer ?? []),
      close() {
        worker.removeEventListener("message", onMessage)
        worker.removeEventListener("error", onFailure)
      }
    }
  }

/**
 * A handler in this process, imported at the first request: `create` makes
 * it with the replies' way back, and `deliver` hands it a request.
 */
export const inProcess =
  <Request, Reply, Handler>(
    create: (onReply: (reply: Reply) => void) => Promise<Handler>,
    deliver: (handler: Handler, request: Request) => void
  ): Open<Request, Reply> =>
  (onReply, onError) => {
    const handler = create(onReply)
    return {
      post: (request) =>
        void handler
          .then((h) => deliver(h, request))
          .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error))),
      close: () => undefined
    }
  }
