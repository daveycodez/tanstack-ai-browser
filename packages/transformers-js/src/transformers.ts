/**
 * Transformers.js, imported when a worker handler first needs it, not when
 * this package is: an app's page and its server render import the handlers'
 * modules through the package's entry, and only the model's worker runs
 * them. (The Node build Transformers.js resolves to there fails in a server
 * render that isn't Node's own: Cloudflare's, for one.)
 */
export type Transformers = typeof import("@huggingface/transformers")

let loading: Promise<Transformers> | undefined

export const transformers = (): Promise<Transformers> => (loading ??= import("@huggingface/transformers"))
