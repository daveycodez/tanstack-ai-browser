# The slots a run-time schema is put in (SchemaSlots.kt): ML Kit finds their providers through
# ServiceLoader, and fills the slot classes by reflection.
-keep class io.github.daveycodez.mlkit.Slot* { *; }
-keep class io.github.daveycodez.mlkit.SlotProvider { *; }
