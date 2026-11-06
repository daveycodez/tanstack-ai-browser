# Benchmark artifact retention

Track benchmark source, fixed regression fixtures, and one compact `bench/latest.json`
summary per project. Overwrite that summary for the next run. Raw transcripts,
screenshots, logs, numerical dumps and intermediate runs stay in ignored local
output paths or an external artifact store. Do not accumulate dated run folders.

Historical raw runs were moved out of the checkout to a local temporary archive;
previously committed copies also remain recoverable from Git history. No history
rewrite was performed. Small prompt/analysis golden fixtures used by tests live in
`apps/checkers/src/lib/__fixtures__`; benchmark source and suite cases remain intact.
Generated cache inputs such as `review-cache-fixtures.json` were recreated by preparation
scripts that moved with the WebGL engine to the webgllm repo. No model or UI QA was rerun for this cleanup.
