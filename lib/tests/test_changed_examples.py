"""ci/changed-examples.sh: which examples a pull request needs run (ADR-0018).

The script reads changed paths on stdin and prints the examples to run. CI trusts it to skip an
example, so the cases that matter are the ones where it must not: a shared input, and a path it
has never heard of, both run everything.
"""

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "ci" / "changed-examples.sh"
ALL = sorted(p.parent.name for p in (ROOT / "examples").glob("*/run.sh"))


def pick(*paths: str, args: tuple[str, ...] = ()) -> list[str]:
    done = subprocess.run(
        ["bash", str(SCRIPT), *args], input="".join(f"{p}\n" for p in paths),
        capture_output=True, text=True, check=True,
    )
    return done.stdout.split()


def test_there_are_examples():
    assert len(ALL) >= 3
    assert pick(args=("--all",)) == ALL


def test_nothing_changed_runs_nothing():
    assert pick() == []


@pytest.mark.parametrize("name", ALL)
def test_a_file_of_one_example_runs_that_example(name):
    assert pick(f"examples/{name}/web/app.js") == [name]
    assert pick(f"examples/{name}/README.md", f"examples/{name}/expected/browser.txt") == [name]


def test_files_of_two_examples_run_both_once():
    a, b = ALL[0], ALL[-1]
    assert pick(f"examples/{b}/run.sh", f"examples/{a}/run.sh", f"examples/{b}/NOTES.md") == [a, b]


@pytest.mark.parametrize("path", [
    "README.md", "AGENTS.md", "CLAUDE.md", ".gitignore",
    "docs/adr/0018-ci-runs-what-a-pull-request-changed.md", "docs/adr/README.md",
    "site/index.template.html", "site/site.css", "site/README.md",
    "lib/tests/test_site_build.py", "lib/tests/fixtures/x.json",
    "ci/README.md", ".github/workflows/pages.yml",
])
def test_what_no_run_reads_runs_nothing(path):
    assert pick(path) == []
    # and takes nothing away from an example that did change
    assert pick(path, f"examples/{ALL[0]}/run.sh") == [ALL[0]]


@pytest.mark.parametrize("path", [
    "lib/relate_wasm.mjs", "lib/serve.mjs", "lib/replay.py", "lib/notes.md",
    "scripts/env.sh", "scripts/fetch-gliner.sh",
    "ci/relate-1.3.0.sha256", "ci/gliner2.5-small-v1.sha256", "ci/changed-examples.sh",
    "pyproject.toml", "uv.lock", ".github/workflows/examples.yml",
    "site/build.mjs",              # example 01's build imports it
    "examples/README.md",          # not inside any one example
    "a-new-top-level-file", "tools/new/thing.py",
])
def test_a_shared_or_unknown_path_runs_everything(path):
    assert pick(path) == ALL
    assert pick("docs/adr/README.md", path, f"examples/{ALL[0]}/run.sh") == ALL


def test_an_example_that_is_gone_has_nothing_to_run():
    assert pick("examples/99-removed/run.sh", "examples/99-removed/web/app.js") == []


def test_a_last_line_without_a_newline_counts():
    done = subprocess.run(["bash", str(SCRIPT)], input=f"examples/{ALL[0]}/run.sh",
                          capture_output=True, text=True, check=True)
    assert done.stdout.split() == [ALL[0]]


def test_an_unknown_argument_is_refused():
    done = subprocess.run(["bash", str(SCRIPT), "--everything"], input="", capture_output=True, text=True)
    assert done.returncode == 2
