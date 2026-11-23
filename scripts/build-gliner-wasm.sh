#!/usr/bin/env bash
# Build gliner-rs's WASM package from a pinned commit into .cache/gliner-wasm/<rev7>/; print its env var.
#   scripts/build-gliner-wasm.sh               v0.3.1 = 4fa741e, example 33's revision (D4)
#   scripts/build-gliner-wasm.sh <tag|sha>     another revision of apiplant/gliner-rs
#   scripts/build-gliner-wasm.sh --check       verify a cached build only: no network, no build; exit 1 if none
#   scripts/build-gliner-wasm.sh --force       rebuild even when a verified build is cached
#   eval "$(scripts/build-gliner-wasm.sh)"     sets GLINER_WASM_DIR
#
# gliner-rs (Apache-2.0) publishes no WASM artifact, so example 33 builds it the way the
# repo's website does (`wasm-pack build --target web --release`), made reproducible:
#   - the GitHub source archive of the full commit sha; its pax header must name that commit;
#   - cargo --locked (the commit's Cargo.lock) on Rust 1.97.1: GLINER_RUST_TOOLCHAIN names the
#     rustup toolchain (default 1.97.1); its rustc must report 1.97.1 and have wasm32-unknown-unknown;
#   - wasm-pack 0.15.0 exactly: the one on PATH, else `cargo install --locked` into
#     .cache/wasm-tools/. wasm-pack would `cargo install` wasm-bindgen-cli without --locked (on
#     macOS and Linux alike), resolving its dependencies afresh, so the script installs the
#     version the commit's Cargo.lock names (0.2.128) itself, --locked, into .cache/wasm-tools/,
#     and wasm-pack picks it up from PATH. wasm-pack downloads binaryen's wasm-opt (version_117)
#     into .cache/wasm-tools/wasm-pack/ (WASM_PACK_CACHE). It runs with PATH cut down to cargo,
#     rustc, rustup, that wasm-bindgen and /usr/bin:/bin, so no other wasm-opt or wasm-bindgen is used;
#   - every CARGO_* and RUST* variable but CARGO_HOME/RUSTUP_HOME is cleared, and
#     --remap-path-prefix for the source tree and CARGO_HOME is merged into the crate's own
#     wasm32 rustflags (.cargo/config.toml), so no absolute path reaches the .wasm.
# What that buys (2026-10-08, v0.3.1): builds from two directories and two rustup toolchain names
# on one host are byte-identical, and a linux/amd64 build has the same glue, .d.ts, package.json
# and LICENSE. Its .wasm differs from a macOS arm64 one, though: cargo hashes the host triple
# into the crate metadata of build scripts and proc macros, which renames symbols and so moves
# functions. Both give byte-identical extractCli JSON on every reference case, so the bytes are
# not pinned (no ci/gliner-rs-<rev7>.sha256) and example 33's expected/model.txt pins the
# behaviour against a Python reference instead (D4). Should a pin file appear, a build or a
# cached copy that differs from it fails closed and is not installed.
#
# Layout, under the gitignored .cache/ (GLINER_BUILD_DIR moves gliner-src/ and gliner-wasm/):
#   gliner-src/<rev7>/     unpacked source; target/ inside it, so a rebuild is incremental
#   wasm-tools/            bin/wasm-bindgen (+ bin/wasm-pack if PATH has no 0.15.0), and wasm-pack's
#                          tool cache wasm-pack/ (wasm-opt)
#   gliner-wasm/<rev7>/    gliner_rs.js, gliner_rs_bg.wasm, gliner_rs.d.ts, gliner_rs_bg.wasm.d.ts,
#                          package.json ("type": "module", so Node imports the glue as ESM), LICENSE,
#                          THIRD_PARTY-crates.txt (below), and .built (commit, toolchain, each file's
#                          sha256), written last
# THIRD_PARTY-crates.txt lists every crate linked into the .wasm (name, version, licence
# expression, repository; sorted), for the licence notices example 33's site ships: the
# gliner-rs package's normal dependency edges in `cargo metadata --filter-platform
# wasm32-unknown-unknown`, transitively, leaving out build- and dev-dependencies (they run on the
# build host or only in tests) and proc-macro crates with whatever only they need (compiled for
# the host, run by the compiler, never linked). cargo metadata unifies features across every
# platform, so it also lists crates only another platform's features pull in (onig, through
# candle-core's tokenizers/onig): the list keeps only what `cargo tree -e normal,no-proc-macro
# --target wasm32-unknown-unknown` (per-target features, as the build resolves them) also names,
# and fails if cargo tree names a crate the walk lacks. The file's header says what was left out.
# The pin covers the six build outputs only. A .built from before the crate list existed still
# passes --check (with a note: the site then ships no crate list); a plain run adds the list to
# such a build from its source tree, offline, and rewrites .built.
# Idempotent: a cached build whose files match .built (and any pin) is reused (the files are
# re-hashed on every run). Only the export line goes to stdout (and to $GITHUB_ENV in Actions);
# cargo and wasm-pack output goes to stderr. Needs the network for the first build only.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo=apiplant/gliner-rs
default_tag=v0.3.1
default_sha=4fa741eec466660daf4adc8703210138295e0b1b
want_rustc=1.97.1
want_wasm_pack=0.15.0
outputs=(LICENSE gliner_rs.d.ts gliner_rs.js gliner_rs_bg.wasm gliner_rs_bg.wasm.d.ts package.json)
crate_list=THIRD_PARTY-crates.txt   # hashed into .built after the outputs; not part of any pin

say() { echo "build-gliner-wasm: $*" >&2; }
die() { echo "build-gliner-wasm: $*" >&2; exit 1; }
rel() { echo "${1#"$root"/}"; }

sha256_of() {  # <file> -> hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

sums_of() {  # <dir> -> "sha256  name" per output file, sorted by name
  local f
  for f in "${outputs[@]}"; do
    [[ -f "$1/$f" ]] || return 1
    printf '%s  %s\n' "$(sha256_of "$1/$f")" "$f"
  done | LC_ALL=C sort -k2,2
}

resolve_rev() {  # <tag|sha> -> full commit sha
  local r="$1" sha=""
  if [[ "$r" =~ ^[0-9a-f]{40}$ ]]; then echo "$r"; return; fi
  if [[ "$r" == "$default_tag" ]]; then echo "$default_sha"; return; fi
  if command -v gh >/dev/null 2>&1; then sha="$(gh api "repos/$repo/commits/$r" --jq .sha 2>/dev/null || true)"; fi
  if [[ -z "$sha" ]]; then
    sha="$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$repo/commits/$r" |
      python3 -I -c 'import json, sys; print(json.load(sys.stdin)["sha"])')" || die "cannot resolve $r in $repo"
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "cannot resolve $r in $repo"
  echo "$sha"
}

marker_sums() {  # <dir> -> the sha256 lines of its .built
  sed -n '/^---$/,$p' "$1/.built" | sed 1d
}

cached_ok() {  # the output dir holds a complete build matching .built and, if present, the pin;
  # sets has_crate_list=0 for a .built written before the crate list existed (still accepted)
  local sums listed
  has_crate_list=0
  [[ -f "$out/.built" ]] || return 1
  grep -qx "gliner-rs $sha" "$out/.built" || { say "$(rel "$out/.built") is for another commit"; return 1; }
  sums="$(sums_of "$out")" || { say "$(rel "$out") is incomplete"; return 1; }
  [[ "$sums" == "$(marker_sums "$out" | grep -v "  $crate_list\$" || true)" ]] ||
    { say "$(rel "$out") does not match its .built"; return 1; }
  listed="$(marker_sums "$out" | grep "  $crate_list\$" || true)"
  if [[ -n "$listed" ]]; then
    [[ -f "$out/$crate_list" && "$listed" == "$(sha256_of "$out/$crate_list")  $crate_list" ]] ||
      { say "$(rel "$out/$crate_list") does not match its .built"; return 1; }
    has_crate_list=1
  fi
  if [[ -f "$pin" && "$sums" != "$(cat "$pin")" ]]; then
    say "$(rel "$out") does not match $(rel "$pin")"; return 1
  fi
  return 0
}

cargo_clean() {  # cargo <args> in $src with the pinned toolchain and no CARGO_*/RUST* knobs but the homes
  local unset=() name
  for name in $(compgen -e); do
    case "$name" in CARGO_HOME|RUSTUP_HOME) ;; CARGO_*|RUST*) unset+=(-u "$name") ;; esac
  done
  (cd "$src" && env ${unset[@]+"${unset[@]}"} RUSTUP_TOOLCHAIN="$toolchain" cargo "$@")
}

write_crate_list() {  # <dest> <rustc version line>: THIRD_PARTY-crates.txt of the wasm32 build of $src
  local dest="$1" rustc_line="$2" work
  work="$(mktemp -d "${TMPDIR:-/tmp}/gliner-crates.XXXXXX")"
  local args=(--locked --offline) ok=0 attempt
  for attempt in offline online; do  # offline first (the build fetched everything); then online, should cargo want a manifest
    if cargo_clean metadata --format-version 1 --filter-platform wasm32-unknown-unknown "${args[@]}" \
         > "$work/metadata.json" 2> "$work/err" &&
       cargo_clean tree "${args[@]}" --target wasm32-unknown-unknown -e normal,no-proc-macro --prefix none \
         --format '{p}' > "$work/tree.txt" 2>> "$work/err"; then ok=1; break; fi
    args=(--locked)
  done
  if (( !ok )); then sed 's/^/  /' "$work/err" >&2; rm -rf "$work"; return 1; fi
  python3 -I - "$work/metadata.json" "$work/tree.txt" "$sha" "$rustc_line" > "$work/list.txt" <<'PY' ||
import json, re, sys, textwrap
meta, tree_txt, sha, rustc = sys.argv[1:]
m = json.load(open(meta))
pkgs = {p["id"]: p for p in m["packages"]}
nodes = {n["id"]: n for n in m["resolve"]["nodes"]}
root = m["resolve"]["root"]
macro = lambda p: any("proc-macro" in t["kind"] for t in p["targets"])
linked, todo, macros = {root}, [root], set()
while todo:  # normal edges only (dep_kinds kind null); stop at proc macros
    for d in nodes[todo.pop()]["deps"]:
        if not any(k["kind"] is None for k in d["dep_kinds"]):
            continue
        if macro(pkgs[d["pkg"]]):
            macros.add(d["pkg"])
        elif d["pkg"] not in linked:
            linked.add(d["pkg"])
            todo.append(d["pkg"])
key = lambda i: (pkgs[i]["name"], pkgs[i]["version"])
built = set()
for line in open(tree_txt):
    hit = re.match(r"(\S+) v(\S+)", line.strip())
    if hit:
        built.add(hit.groups())
walked = {key(i) for i in linked}
if built - walked:
    sys.exit(f"cargo tree names crates the cargo metadata walk lacks: {sorted(built - walked)}")
dropped = sorted(walked - built)
rows = sorted(key(i) + (pkgs[i]["license"] or f"see {pkgs[i]['license_file']}", pkgs[i]["repository"] or "-")
              for i in linked if key(i) in built)
fmt = lambda pairs: ", ".join(f"{n} {v}" for n, v in pairs) or "none"
for para in (
    f"Crates linked into gliner_rs_bg.wasm: gliner-rs {sha} built for wasm32-unknown-unknown with its default "
    "features, as `wasm-pack build --target web --release` builds it (written by scripts/build-gliner-wasm.sh).",
    "How the list is made: `cargo metadata --format-version 1 --filter-platform wasm32-unknown-unknown` on the "
    "built source tree, from the gliner-rs package along normal dependency edges, transitively. Left out:",
    "- build- and dev-dependencies: they run on the build host, or only in tests;",
    "- proc-macro crates and what only they need (compiled for the host and run by the compiler, never linked): "
    + (", ".join(sorted({pkgs[i]["name"] for i in macros})) or "none") + ";",
    "- crates cargo metadata lists only because it unifies features across platforms, which `cargo tree -e "
    "normal,no-proc-macro --target wasm32-unknown-unknown` (per-target features, as the build resolves them) "
    f"does not name: {fmt(dropped)}.",
    f"Also linked: the Rust standard library (core, alloc, std and their own dependencies) of {rustc}; "
    "MIT OR Apache-2.0, https://github.com/rust-lang/rust.",
    "Licence texts: each crate's LICENSE* files, as published on crates.io in its .crate archive "
    "(https://crates.io/crates/<name>/<version>; cargo unpacks them under $CARGO_HOME/registry/src). "
    "A '/' in a licence means OR (the pre-SPDX form crates.io still accepts).",
    "Tab-separated columns:",
):
    indent = "  " if para.startswith("- ") else ""
    for line in textwrap.wrap(para, 100, subsequent_indent=indent, break_on_hyphens=False):
        print(f"# {line}")
print("name\tversion\tlicense\trepository")
for row in rows:
    print("\t".join(row))
PY
    { rm -rf "$work"; return 1; }
  mv "$work/list.txt" "$dest"
  rm -rf "$work"
}

add_crate_list() {  # give a build cached before the crate list existed its list, from its source tree; 1 if impossible
  local rustc_line all
  [[ -f "$src/.source-commit" && "$(cat "$src/.source-commit")" == "$sha" ]] ||
    { say "no source tree for ${sha:0:7} in $(rel "$src")"; return 1; }
  command -v rustup >/dev/null 2>&1 && rustup run "$toolchain" cargo --version >/dev/null 2>&1 ||
    { say "no Rust toolchain '$toolchain' for cargo metadata"; return 1; }
  rustc_line="$(grep -m1 '^rustc ' "$out/.built")" || { say "$(rel "$out/.built") names no rustc"; return 1; }
  write_crate_list "$out/$crate_list.tmp" "$rustc_line" || { rm -f "$out/$crate_list.tmp"; return 1; }
  mv "$out/$crate_list.tmp" "$out/$crate_list"
  all="$( { sums_of "$out"; printf '%s  %s\n' "$(sha256_of "$out/$crate_list")" "$crate_list"; } | LC_ALL=C sort -k2,2)"
  { sed '/^---$/,$d' "$out/.built"; echo "---"; echo "$all"; } > "$out/.built.tmp"
  mv "$out/.built.tmp" "$out/.built"
}

emit() {  # <name> <value>: an `export` line on stdout, and the variable in $GITHUB_ENV under Actions
  printf 'export %s=%q\n' "$1" "$2"
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$1=$2" >> "$GITHUB_ENV"; fi
}

find_wasm_pack() {  # -> path of a wasm-pack $want_wasm_pack, installing one into .cache/wasm-tools if needed
  local wp
  for wp in "$(command -v wasm-pack 2>/dev/null || true)" "$tools/bin/wasm-pack"; do
    if [[ -n "$wp" && -x "$wp" && "$("$wp" --version 2>/dev/null)" == "wasm-pack $want_wasm_pack" ]]; then
      echo "$wp"; return 0
    fi
  done
  say "no wasm-pack $want_wasm_pack on PATH: cargo install --locked into $(rel "$tools") (a few minutes)"
  env RUSTUP_TOOLCHAIN="$toolchain" cargo install --locked --root "$tools" wasm-pack --version "$want_wasm_pack" >&2 ||
    die "cargo install wasm-pack $want_wasm_pack failed"
  [[ "$("$tools/bin/wasm-pack" --version)" == "wasm-pack $want_wasm_pack" ]] || die "the installed wasm-pack is not $want_wasm_pack"
  echo "$tools/bin/wasm-pack"
}

ensure_wasm_bindgen() {  # -> path of wasm-bindgen at the version $src/Cargo.lock names, installed --locked
  local want wb="$tools/bin/wasm-bindgen"
  want="$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print; exit }' "$src/Cargo.lock")"
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "cannot read the wasm-bindgen version from $(rel "$src")/Cargo.lock"
  if [[ -x "$wb" && "$("$wb" --version 2>/dev/null)" == "wasm-bindgen $want" ]]; then echo "$wb"; return 0; fi
  say "cargo install --locked wasm-bindgen-cli $want into $(rel "$tools") (once)"
  env RUSTUP_TOOLCHAIN="$toolchain" cargo install --locked --root "$tools" wasm-bindgen-cli --version "$want" >&2 ||
    die "cargo install wasm-bindgen-cli $want failed"
  [[ "$("$wb" --version 2>/dev/null)" == "wasm-bindgen $want" ]] || die "the installed wasm-bindgen is not $want"
  echo "$wb"
}

check_toolchain() {  # sets $rustc_version; dies with the fix when the toolchain or its wasm32 target is missing
  local sysroot
  command -v rustup >/dev/null 2>&1 || die "needs rustup (https://rustup.rs): toolchain $toolchain with wasm32-unknown-unknown"
  rustc_version="$(rustup run "$toolchain" rustc --version 2>/dev/null)" ||
    die "no Rust toolchain '$toolchain'; fix: rustup toolchain install $want_rustc --profile minimal --target wasm32-unknown-unknown"
  [[ "$rustc_version" == "rustc $want_rustc "* ]] ||
    die "toolchain '$toolchain' is $rustc_version, not $want_rustc (the pinned build needs exactly $want_rustc)"
  sysroot="$(rustup run "$toolchain" rustc --print sysroot)"
  [[ -d "$sysroot/lib/rustlib/wasm32-unknown-unknown" ]] ||
    die "toolchain '$toolchain' has no wasm32-unknown-unknown; fix: rustup target add wasm32-unknown-unknown --toolchain $toolchain"
}

unpack_source() {  # $src: the GitHub archive of $sha, checked against its pax commit id
  local a="$tmp/src.tar.gz" id
  [[ -f "$src/Cargo.lock" && -f "$src/.source-commit" && "$(cat "$src/.source-commit")" == "$sha" ]] && return 0
  say "downloading $repo at ${sha:0:7}"
  curl -fsSL --retry 3 -o "$a" "https://codeload.github.com/$repo/tar.gz/$sha" ||
    die "download of $repo ${sha:0:7} failed (offline? the first build needs github.com)"
  archive_sha="$(sha256_of "$a")"
  gzip -dc "$a" > "$tmp/src.tar" || die "the source archive is not gzip"
  id="$(head -c 1536 "$tmp/src.tar" | LC_ALL=C tr -c '0-9a-z=\n' '\n' | sed -n 's/^comment=\([0-9a-f]\{40\}\)$/\1/p' | head -1)"
  [[ "$id" == "$sha" ]] || die "the source archive names commit '${id:-none}', not $sha"
  mkdir "$tmp/tree"
  tar -xf "$tmp/src.tar" -C "$tmp/tree" --strip-components=1
  [[ -f "$tmp/tree/Cargo.lock" ]] || die "the source archive has no Cargo.lock"
  echo "$sha" > "$tmp/tree/.source-commit"
  echo "$archive_sha" > "$tmp/tree/.source-archive-sha256"
  mkdir -p "$(dirname "$src")"
  rm -rf "$src"; mv "$tmp/tree" "$src"
  say "source archive sha256 $archive_sha (GitHub archives are not pinned; the commit id is)"
}

toml_str() {  # <s> -> a TOML basic string
  local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"
}

build() {
  local bin="$tmp/bin" sys_path=/usr/bin:/bin:/usr/sbin:/sbin clean_path flags t v start keep=() name
  for t in wasm-opt wasm-bindgen; do
    if v="$(PATH="$sys_path" command -v "$t")"; then
      die "$v would be used by wasm-pack instead of the pinned $t; remove it from $sys_path"
    fi
  done
  mkdir -p "$bin" "$tools/wasm-pack"   # wasm-pack fails to fetch wasm-opt into a cache dir it has not made
  for t in cargo rustc rustup; do ln -s "$(command -v "$t")" "$bin/$t"; done
  ln -s "$wasm_pack" "$bin/wasm-pack"
  ln -s "$wasm_bindgen" "$bin/wasm-bindgen"
  clean_path="$bin:$sys_path"
  # remap both the spelling cargo is given and the physical path, should either be a symlink
  local remaps=() p
  for p in "${CARGO_HOME:-$HOME/.cargo}" "$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"; do
    remaps+=("$(toml_str "--remap-path-prefix=$p=/cargo")")
  done
  for p in "$src" "$(cd "$src" && pwd -P)"; do
    remaps+=("$(toml_str "--remap-path-prefix=$p=/gliner-rs")")
  done
  flags="target.wasm32-unknown-unknown.rustflags=[$(IFS=,; echo "${remaps[*]}")]"
  # keep CARGO_HOME and RUSTUP_HOME; drop every other CARGO_*/RUST* knob (RUSTFLAGS, profiles, wrappers, target dir)
  for name in $(compgen -e); do
    case "$name" in CARGO_HOME|RUSTUP_HOME) ;; CARGO_*|RUST*) keep+=(-u "$name") ;; esac
  done
  say "wasm-pack build --target web --release, cargo --locked, $rustc_version, remapped paths"
  start=$SECONDS
  (cd "$src" && env ${keep[@]+"${keep[@]}"} PATH="$clean_path" RUSTUP_TOOLCHAIN="$toolchain" CARGO_INCREMENTAL=0 \
     CARGO_TARGET_DIR="$src/target" WASM_PACK_CACHE="$tools/wasm-pack" \
     wasm-pack build --target web --release --out-dir "$tmp/pkg" . -- --locked --config "$flags") >&2 ||
    die "wasm-pack build failed"
  say "built in $((SECONDS - start)) s"
  mkdir "$tmp/out"
  cp "$tmp/pkg/gliner_rs.js" "$tmp/pkg/gliner_rs_bg.wasm" "$tmp/pkg/gliner_rs.d.ts" "$tmp/pkg/gliner_rs_bg.wasm.d.ts" \
     "$tmp/pkg/package.json" "$tmp/out/"
  cp "$src/LICENSE" "$tmp/out/LICENSE"
}

tool_version() {  # <name> -> "<version line>" of wasm-pack's cached tool
  local p
  p="$(find "$tools/wasm-pack" -type f -perm -u+x -name "$1" 2>/dev/null | LC_ALL=C sort | head -1)"
  [[ -n "$p" ]] && "$p" --version 2>/dev/null | head -1 || echo "$1 unknown"
}

main() {
  local arg rev="" force=0 check=0 sums
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --check) check=1 ;;
      -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      -*) die "unknown option $arg" ;;
      *) [[ -z "$rev" ]] || die "one revision only"; rev="$arg" ;;
    esac
  done
  sha="$(resolve_rev "${rev:-$default_tag}")"
  local short="${sha:0:7}" build_dir="${GLINER_BUILD_DIR:-$root/.cache}"
  src="$build_dir/gliner-src/$short"
  out="$build_dir/gliner-wasm/$short"
  tools="$root/.cache/wasm-tools"
  pin="$root/ci/gliner-rs-$short.sha256"
  toolchain="${GLINER_RUST_TOOLCHAIN:-$want_rustc}"

  if (( check )); then
    cached_ok || die "no verified build in $(rel "$out"); fix: scripts/build-gliner-wasm.sh${rev:+ $rev}"
    (( has_crate_list )) || say "note: $(rel "$out") predates $crate_list (no crate list to ship); add it: scripts/build-gliner-wasm.sh${rev:+ $rev}"
    emit GLINER_WASM_DIR "$out"; return 0
  fi
  if (( !force )) && cached_ok; then
    say "cached, matches .built$( [[ -f "$pin" ]] && echo " and $(rel "$pin")")"
    if (( !has_crate_list )); then
      if add_crate_list; then say "added $(rel "$out/$crate_list") and its sha256 to .built"
      else say "warning: could not add $crate_list to $(rel "$out"); --force rebuilds with it"; fi
    fi
    emit GLINER_WASM_DIR "$out"; return 0
  fi

  mkdir -p "$tools" "$build_dir/gliner-wasm"
  tmp="$(mktemp -d "$build_dir/gliner-wasm/.tmp.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  check_toolchain
  wasm_pack="$(find_wasm_pack)"
  archive_sha=""
  unpack_source
  [[ -n "$archive_sha" ]] || archive_sha="$(cat "$src/.source-archive-sha256" 2>/dev/null || echo unknown)"
  wasm_bindgen="$(ensure_wasm_bindgen)"
  build
  sums="$(sums_of "$tmp/out")" || die "wasm-pack did not write every expected file"

  if [[ -f "$pin" ]]; then
    if [[ "$sums" != "$(cat "$pin")" ]]; then
      diff "$pin" <(echo "$sums") | sed 's/^/  /' >&2 || true
      die "this build differs from $(rel "$pin") (< pinned, > built); not installed"
    fi
    say "matches $(rel "$pin")"
  fi
  write_crate_list "$tmp/out/$crate_list" "$rustc_version" || die "could not list the crates linked into the build"
  sums="$( { echo "$sums"; printf '%s  %s\n' "$(sha256_of "$tmp/out/$crate_list")" "$crate_list"; } | LC_ALL=C sort -k2,2)"

  {
    echo "gliner-rs $sha"
    echo "source https://codeload.github.com/$repo/tar.gz/$sha sha256:$archive_sha"
    echo "host $(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
    echo "$rustc_version"
    echo "wasm-pack $("$wasm_pack" --version | sed 's/^wasm-pack //')"
    "$wasm_bindgen" --version
    tool_version wasm-opt
    echo "command wasm-pack build --target web --release -- --locked (rustflags += --remap-path-prefix)"
    echo "pin $( [[ -f "$pin" ]] && rel "$pin" || echo none)"
    echo "---"
    echo "$sums"
  } > "$tmp/out/.built"
  rm -rf "$out.old.$$"
  if [[ -e "$out" ]]; then mv "$out" "$out.old.$$"; fi
  mv "$tmp/out" "$out"
  rm -rf "$out.old.$$"
  say "installed $(rel "$out") ($(wc -c < "$out/gliner_rs_bg.wasm" | tr -d ' ') B wasm)"
  emit GLINER_WASM_DIR "$out"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
