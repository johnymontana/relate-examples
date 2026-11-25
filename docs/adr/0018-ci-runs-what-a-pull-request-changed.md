# On a pull request, CI runs the examples whose inputs changed; on `main`, all of them

Status: accepted · Decided: 2026-11-24 · Scope: repository · Amends ADR-0004 (what CI runs)

ADR-0004 had CI run every `examples/*/run.sh` on every push and pull request. A run took 19
minutes, and example 01 was 16.5 of them: its run asks a model about a thousand questions and
scores them, while examples 02 and 03 take about 15 seconds each. A pull request that touched only
example 03 waited 19 minutes for a result that 03's own run gives in under one. And each push to a
branch with a pull request ran the whole thing twice, once per event.

So **a pull request runs only the examples whose inputs it changed**, and **a push to `main` and a
run started by hand run every example**. `ci/changed-examples.sh` decides, from the paths the pull
request changes:

- a file under `examples/<name>/` selects that example;
- a path no `run.sh` reads selects none: `docs/`, the root's `*.md`, `lib/tests/`, `site/` other
  than `site/build.mjs`, `ci/README.md`, the Pages workflow;
- anything else selects every example: `lib/`, `scripts/`, the pins in `ci/`, `pyproject.toml`,
  `uv.lock`, the workflow, the script itself, and any path the script does not know.

`uv run pytest -q` runs every time. A branch is tested through its pull request only: the workflow
no longer runs on a push to any branch but `main`.

The rest of ADR-0004 stands: the regression test is still each example's offline, byte-stable run,
and CI still runs it exactly as a developer does.

## Considered options

- **One job per example, in parallel**: no faster, since the slowest example sets the time.
- **Speeding up example 01's run itself** (its scoring phases run on one thread): worth doing, but
  it is work inside a long harness whose output must stay byte-identical, and it would still leave
  several minutes on every unrelated change. Not excluded by this decision.
- **Caching the model's answers between runs**: rejected. It caches the thing under test, and a
  wrong cache key would hide a regression.
- **Filtering on `main` too, with a nightly full run**: faster merges, but a break would surface up
  to a day late and Pages deploys from `main`'s run. Rejected: `main` is where a full run matters.

## Consequences

- A green pull request no longer means every example ran. The job summary lists each example as
  run or not run, and why. The full run happens when the pull request lands on `main`, and that
  run gates the Pages deploy (ADR-0002), so a break the filter missed stops there, not on the site.
- The filter is only as good as its list of shared inputs. It fails safe: an unknown path runs
  everything, and `lib/tests/test_changed_examples.py` pins the cases. A new example needs no
  change; a new shared directory needs none either, until someone wants it exempt.
- To run everything on a branch, start the workflow by hand (`workflow_dispatch`).
- A branch pushed without a pull request gets no CI run.
