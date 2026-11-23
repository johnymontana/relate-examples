# One Relate version across the CLI, the Python binding and the WASM build, upgraded together

Status: accepted · Decided: b26e6cd (example 01's D2) · Scope: repository

The examples compare surfaces against each other. Example 01's download opens in native Relate, the
browser's results are checked against the CLI's, and example 02's 32 reference queries return the
same rows natively and in WASM. Comparing surfaces only means something if they are the same
release. So every surface pins **Relate 1.2.0**: the `relate` CLI (`ci/relate-1.2.0.sha256`,
`RELATE_VERSION` in `examples.yml`), `relate-db==1.2.0` (`pyproject.toml`, `uv.lock`) and
`@relate/relate-wasm@1.2.0` (each browser example's `package.json` and lockfile). Code refuses a
different version at once. `lib/relate_wasm.mjs` checks `dbms.components()`, and `lib/opfsfmt.py`
has `VERIFIED`.

An upgrade moves every pin in one change. Then every `NOTES.md` row is re-verified on the new
release and `expected/` is re-recorded with every change classified. The list of files to touch is
in AGENTS.md, "Engine pins move together".

The Ontology Graph Spec SDK follows the same rule across its own surfaces (ADR-0007).

## Considered options

- **Each example on its own Relate version**: this would make adding an example easier, but no
  cross-surface claim could be trusted, and every behaviour row would need a version column.
  Rejected.
