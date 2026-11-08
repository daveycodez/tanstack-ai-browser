/**
 * TanStack AI adapter for Apple's on-device Foundation Model, served by apfel.
 * The model catalog is in `@tanstack-ai-browser/apfel/model-meta`.
 */
export { ApfelTextAdapter, apfelText } from "./adapter.js"
export type {
  ApfelConfig,
  Availability,
  ApfelProviderUsageDetails,
  DownloadProgressCallback,
  ApfelTextModelOptions
} from "./adapter.js"
