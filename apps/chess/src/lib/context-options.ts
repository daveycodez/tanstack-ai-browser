export type ContextFeatures = {
  relationships: boolean
  support: boolean
  mobility: boolean
  castling: boolean
}

export const BASE_CONTEXT_FEATURES: ContextFeatures = {
  relationships: false,
  support: false,
  mobility: false,
  castling: false
}

export const CONTEXT_VARIANTS = [
  { id: "baseline", label: "Baseline", features: { ...BASE_CONTEXT_FEATURES } },
  {
    id: "relationships",
    label: "Relationships",
    features: { ...BASE_CONTEXT_FEATURES, relationships: true }
  },
  {
    id: "support",
    label: "Support",
    features: { ...BASE_CONTEXT_FEATURES, support: true }
  },
  {
    id: "mobility",
    label: "Mobility",
    features: { ...BASE_CONTEXT_FEATURES, mobility: true }
  },
  {
    id: "castling",
    label: "Castling",
    features: { ...BASE_CONTEXT_FEATURES, castling: true }
  },
  {
    id: "all",
    label: "All context",
    features: {
      relationships: true,
      support: true,
      mobility: true,
      castling: true
    }
  }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  features: ContextFeatures
}>

export type ContextVariantId = (typeof CONTEXT_VARIANTS)[number]["id"]
