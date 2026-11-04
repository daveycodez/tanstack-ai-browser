# Cross-game decision-log spillover

The first completed game captured 58 moves and embedded its 28 Human decisions
in `game.json`. After game 2 began, its controller continued appending decisions
to the external `game-01/decisions.json` and used game-01 input-file paths and
before-board metadata in those appended rows. The completed game-01 JSON's
embedded decisions remain the correct completion-time snapshot.

The verifier detected the count mismatch immediately when attempting the first
completed-game import. The following original bytes were preserved before any
recovery, without rewriting producer files:

- [`game-01-completed-state-before-recovery.json.gz`](game-01-completed-state-before-recovery.json.gz): full completed game state, with 28 embedded decisions.
- [`game-01-decisions-spillover-33.json.gz`](game-01-decisions-spillover-33.json.gz): 28 completed-game decisions plus the first five appended game-2 rows; raw SHA-256 `3cbb8d9c46d978b96d158954a1370e5c0d869a9a13422323efac3c1e6d40a54a`.
- [`game-01-decisions-spillover-37.json.gz`](game-01-decisions-spillover-37.json.gz): 28 completed-game decisions plus the first nine appended game-2 rows; raw SHA-256 `f25efcfe3f6f31f925f69251196d028db71b4df1ccb83b9f3b53d281a36726a8`.

Separate game-02 guidance files exist with the correct preassigned game-2
session and current boards. The first five appended answers are legal for those
actual game-02 inputs, follow their recommendations and map to their recorded UI
pits. This initially identifies a bookkeeping spillover rather than missing
guidance. The paused 19-move ledger subsequently established all nine Human-ply mappings,
full production inputs and unchanged answers. The separate
[recovery provenance](../logger-recovery/recovery-provenance.json) records the
metadata-only correction, original raw hashes and global row indices. Game 1
uses the authentic embedded completion snapshot; its contaminated external log
is retained, not silently truncated or relabeled as a completion-time record.
