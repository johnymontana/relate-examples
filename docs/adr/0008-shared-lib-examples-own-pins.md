# Shared code lives in a plain `lib/`, and each example owns its dependency pins

Status: accepted · Decided: b26e6cd; `lib/ogs.mjs` and `lib/serve.mjs` 2026-11-23 · Scope: repository

Code that more than one example (or more than one surface) needs lives in `lib/`, as plain files:
- `relate_wasm.mjs`;
- `ogs.mjs`;
- `serve.mjs`;
- `replay.mjs` and `replay.py`;
- `opfsfmt.py`.

`lib/` is not an npm package, a Python package or a workspace. It has no `package.json` and no
dependencies of its own. Each example keeps its own `package.json` and lockfile. A shared module
that needs a library takes it as an argument instead of importing it:
`createOgs({yaml, sdk, sdkVersion})` gets the example's own pinned js-yaml and SDK. Example 01's
build copies the `lib/` files it uses into a content-hashed `assets/lib-<sha8>/`. Example 02's build
bundles them into its own modules with esbuild.

This keeps each example self-contained, reproducible from its own lockfile, and free to upgrade
alone. The cost is that a shared module must stay dependency-free and work in Node and the browser.
Where Python and JavaScript must agree (`replay`), the two sides are tested byte for byte against
each other (`lib/tests/test_replay_js.py`).

## Considered options

- **An npm workspace or monorepo tool**: this hoists dependencies across examples, so one example's
  upgrade moves another's lockfile. Rejected.
- **Copying shared code into each example**: the copies drift apart. Rejected; `lib/ogs.mjs` exists
  so that both examples read ontologies identically.
