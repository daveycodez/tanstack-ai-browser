/** The version of `@mediapipe/tasks-text` this package depends on. */
export const MEDIAPIPE_VERSION = "1.2.2"

/** jsDelivr's folder of `@mediapipe/tasks-text`, without its version. */
export const MEDIAPIPE_CDN_PREFIX = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@"

/**
 * MediaPipe's WebAssembly folder on jsDelivr, for `MEDIAPIPE_VERSION`. Its
 * files have to match MediaPipe's JavaScript, so it's the same version.
 * jsDelivr sends CORS and `Cross-Origin-Resource-Policy: cross-origin`, so
 * it loads on cross-origin isolated pages too.
 */
export const MEDIAPIPE_WASM_URL = `${MEDIAPIPE_CDN_PREFIX}${MEDIAPIPE_VERSION}/wasm`
