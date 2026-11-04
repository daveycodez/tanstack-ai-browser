# Mancala benchmark artifacts

Keep committed benchmark material comparable in size to Chess and Checkers:
the active suite, audits/tests, minimal deterministic regression fixtures, and a
compact latest-results summary.

Store raw run JSON, reasoning traces, per-turn logs, screenshots, verification
caches, and copied source snapshots under ignored `bench/artifacts/` or a task
temporary directory. Do not force-add them. Never save them to Downloads.

Keep `bench/latest.json` aggregate-only. Add new regression inputs to the reviewed
fixture files; extend the fixture allowlist only when a test needs another small
fixture. Reuse one browser benchmark tab.
