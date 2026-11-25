# Each example's regression test is an offline, byte-stable run diffed against `expected/`

Status: accepted · Decided: b26e6cd · Scope: repository · Amended by ADR-0018 (which examples CI runs on a pull request)

These examples are meant to show what Relate 1.2.0 actually does, and to notice when that changes.
Each example therefore has a `run.sh` that runs offline. It writes plain-text outputs to `out/` and
`diff -u`s them against the committed `expected/`. That diff is the test. Outputs contain no
timestamps, PIDs, temp paths or timings, so two runs produce the same bytes. Every engine or
library behaviour the code relies on is a `NOTES.md` row with a minimal repro. A row that stops
reproducing fails the run with `PIN: <row> changed` on stderr.

Some things cannot be byte-stable: a language model on a GPU (example 02), timings, and anything
online. These stay out of `run.sh`. They run as separate, opt-in commands whose output is never
diffed, such as `run.sh --llm-eval` and the `--smoke` checks against the deployed site.

## Consequences

- `expected/` is re-recorded only after reading the diff and classifying every change (AGENTS.md,
  "The `run.sh` contract").
- Every check passes offline. A missing optional dependency prints `SKIP:`, except in CI, where
  `EXAMPLES_REQUIRE` turns a skip into a failure.
- CI runs exactly what a developer runs: every `examples/*/run.sh`.

## Considered options

- **Unit-test frameworks with assertions**: they check only what someone thought to assert. A full
  diff also shows changes nobody predicted, such as a reworded engine error or a changed number.
- **Snapshot tests that update themselves**: rejected, because a silent update is how a behaviour
  change gets missed.
