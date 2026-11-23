#!/usr/bin/env bash
# Fetch a GLiNER2.5 checkpoint, pinned by Hugging Face revision, into .cache/gliner/, verified; print its env var.
#   scripts/fetch-gliner.sh small             fastino/gliner2.5-small-v1 @ 7132dc4 (304 MB in all; example 33's default)
#   scripts/fetch-gliner.sh base              fastino/gliner2.5-base-v1  @ ca90624 (783 MB in all; selectable in 33's page)
#   scripts/fetch-gliner.sh small --check     verify the cached copy only: no network, no writes; exit 1 if not
#   scripts/fetch-gliner.sh small --pin       write ci/gliner2.5-small-v1.sha256 from the HF API, once
#   eval "$(scripts/fetch-gliner.sh small)"   sets GLINER_SMALL_DIR (GLINER_BASE_DIR for base)
#
# Files: the four gliner-rs's WasmModel.load(weights, tokenizer, config_json,
# encoder_config_json) takes (model.safetensors, tokenizer.json, config.json,
# encoder_config/config.json), plus tokenizer_config.json, which only Python
# gliner2 reads (33's harness/reference.py patches a copy of it, finding G2).
# Each comes from https://huggingface.co/<repo>/resolve/<revision>/<file>.
#
# Trust anchor: ci/<model>.sha256 (sha256sum format, sorted by path). --pin writes
# it once from the HF API at the pinned revision: an LFS file must hash to the
# API's lfs.oid, any other file must match the API's git blob sha1, and the sha256
# of each is our own. Every run re-hashes every file (0.6 s for small) and fails
# closed: a file that does not match is never installed, and a cached file that
# no longer matches is fetched again. Before downloading, a file is copied from the
# Hugging Face cache (HF_HOME, default ~/.cache/huggingface) when a snapshot there
# holds the same bytes.
#
# Layout, under GLINER_CACHE_DIR (default <repo>/.cache/gliner, gitignored):
#   <model>@<rev7>/<files>     e.g. gliner2.5-small-v1@7132dc4/model.safetensors
#   <model>@<rev7>/.verified   a byte copy of the pin, written last: a directory whose
#                              .verified equals ci/<model>.sha256 is complete and checked
# Idempotent; one fetch per model at a time (<dir>/.lock.d). Only `export NAME=value`
# goes to stdout (and to $GITHUB_ENV in Actions); progress goes to stderr.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
endpoint="${HF_ENDPOINT:-https://huggingface.co}"
files=(config.json encoder_config/config.json model.safetensors tokenizer.json tokenizer_config.json)

say() { echo "fetch-gliner: $*" >&2; }
die() { echo "fetch-gliner: $*" >&2; exit 1; }
rel() { echo "${1#"$root"/}"; }

sha256_of() {  # <file> -> hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

gitsha1_of() {  # <file> -> its git blob sha1 (what the HF API reports for a non-LFS file)
  local size; size="$(wc -c < "$1" | tr -d ' ')"
  { printf 'blob %s\0' "$size"; cat "$1"; } | shasum -a 1 | cut -d' ' -f1
}

model_of() {  # <small|base> -> "repo revision"
  case "$1" in
    small) echo "fastino/gliner2.5-small-v1 7132dc4561c3f94563c6147e75ffa8ef34c4964a" ;;
    base)  echo "fastino/gliner2.5-base-v1 ca906247640776a07753514055be9726f9080ead" ;;
    *) return 1 ;;
  esac
}

pinned_sha() {  # <pin> <path> -> sha256; fails when the path is not listed
  awk -v n="$2" '$2 == n { print $1; found = 1 } END { exit !found }' "$1"
}

take_lock() {  # one fetch per model at a time; a lock left by a dead process is taken over
  local lock="$dir/.lock.d" pid n=0
  until mkdir "$lock" 2>/dev/null; do
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
    (( n++ < 1800 )) || die "another fetch still holds $(rel "$lock")"
    if (( n == 1 )); then say "waiting for another fetch of $name"; fi
    sleep 1
  done
  echo $$ > "$lock/pid"
}

from_hf_cache() {  # <path> <want sha256> <dest>: copy from a local HF snapshot holding the same bytes
  local hub="${HF_HOME:-$HOME/.cache/huggingface}/hub" snap cand real seen=" "
  local d="$hub/models--${repo//\//--}"
  [[ -d "$d/snapshots" ]] || return 1
  for snap in "$d"/snapshots/*/; do
    cand="$snap$1"
    [[ -f "$cand" ]] || continue
    real="$(realpath "$cand")" || continue
    [[ "$seen" == *" $real "* ]] && continue
    seen="$seen$real "
    # an LFS blob is named by its sha256; skip one whose name says it is another file
    if [[ "$(basename "$real")" =~ ^[0-9a-f]{64}$ && "$(basename "$real")" != "$2" ]]; then continue; fi
    [[ "$(sha256_of "$real")" == "$2" ]] || continue
    cp "$real" "$3"
    return 0
  done
  return 1
}

download() {  # <path> <dest>
  curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$endpoint/$repo/resolve/$rev/$1"
}

ensure_file() {  # <path>: $dir/<path> matching the pin, or die
  local f="$1" want got dest="$dir/$1" part
  want="$(pinned_sha "$pin" "$f")" || die "$f is not pinned in $(rel "$pin")"
  if [[ -f "$dest" ]]; then
    got="$(sha256_of "$dest")"
    if [[ "$got" == "$want" ]]; then say "$f  cached, matches the pin"; return 0; fi
    (( ! check )) || die "$f: cached sha256 $got does not match $(rel "$pin"); fix: scripts/fetch-gliner.sh $which"
    say "$f  cached copy does not match the pin ($got); fetching it again"
    rm -f "$dest" "$dir/.verified"
  fi
  (( ! check )) || die "$f is not in $(rel "$dir"); fix: scripts/fetch-gliner.sh $which"
  mkdir -p "$(dirname "$dest")" "$tmp/$(dirname "$f")"
  part="$tmp/$f"
  if from_hf_cache "$f" "$want" "$part"; then
    say "$f  copied from the Hugging Face cache"
  else
    say "$f  downloading $endpoint/$repo/resolve/${rev:0:7}/$f"
    download "$f" "$part" || die "download of $f failed (offline? scripts/fetch-gliner.sh $which needs $endpoint once)"
  fi
  got="$(sha256_of "$part")"
  [[ "$got" == "$want" ]] || die "$f: sha256 $got does not match $(rel "$pin") ($want); not installed"
  mv -f "$part" "$dest"
}

pin_model() {  # write ci/<model>.sha256 from the HF API at the pinned revision, or check it
  local f info kind oid size got
  curl -fsSL --retry 3 "$endpoint/api/models/$repo/tree/$rev?recursive=true" > "$tmp/tree.json" ||
    die "cannot read the file tree of $repo at $rev"
  : > "$tmp/pin"
  for f in "${files[@]}"; do
    info="$(python3 -I -c 'import json, sys
for e in json.load(open(sys.argv[1])):
    if e.get("type") == "file" and e["path"] == sys.argv[2]:
        lfs = e.get("lfs")
        print("lfs", lfs["oid"], lfs["size"]) if lfs else print("git", e["oid"], e["size"])
        break
else:
    sys.exit(1)' "$tmp/tree.json" "$f")" || die "$repo at $rev has no $f"
    read -r kind oid size <<< "$info"
    mkdir -p "$tmp/$(dirname "$f")"
    if [[ "$kind" == lfs ]] && from_hf_cache "$f" "$oid" "$tmp/$f"; then
      say "pin    $f  from the Hugging Face cache"
    else
      download "$f" "$tmp/$f" || die "download of $f failed"
    fi
    [[ "$(wc -c < "$tmp/$f" | tr -d ' ')" == "$size" ]] || die "$f: size differs from the HF API ($size)"
    got="$(sha256_of "$tmp/$f")"
    if [[ "$kind" == lfs ]]; then
      [[ "$got" == "$oid" ]] || die "$f: sha256 $got, HF API lfs.oid $oid"
    else
      [[ "$(gitsha1_of "$tmp/$f")" == "$oid" ]] || die "$f: git blob sha1 differs from the HF API ($oid)"
    fi
    printf '%s  %s\n' "$got" "$f" >> "$tmp/pin"
    say "pin    $f  $kind ${oid:0:12}… ok"
  done
  LC_ALL=C sort -k2,2 -o "$tmp/pin" "$tmp/pin"
  if [[ -f "$pin" ]]; then
    if ! cmp -s "$pin" "$tmp/pin"; then
      diff "$pin" "$tmp/pin" | sed 's/^/  /' >&2 || true
      die "$(rel "$pin") differs from $repo at ${rev:0:7} (< pinned, > served); to re-pin on purpose, delete it first"
    fi
    say "pin    $(rel "$pin") unchanged"
    return 0
  fi
  chmod 644 "$tmp/pin"
  mv "$tmp/pin" "$pin.tmp.$$"
  mv "$pin.tmp.$$" "$pin"
  say "pin    wrote $(rel "$pin")"
}

emit() {  # <name> <value>: an `export` line on stdout, and the variable in $GITHUB_ENV under Actions
  printf 'export %s=%q\n' "$1" "$2"
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$1=$2" >> "$GITHUB_ENV"; fi
}

main() {
  local arg do_pin=0 f
  which=""; check=0
  for arg in "$@"; do
    case "$arg" in
      --pin) do_pin=1 ;;
      --check) check=1 ;;
      -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      -*) die "unknown option $arg" ;;
      *) [[ -z "$which" ]] || die "one model only"; which="$arg" ;;
    esac
  done
  local spec; spec="$(model_of "$which")" || die "usage: scripts/fetch-gliner.sh small|base [--check | --pin]"
  if (( check && do_pin )); then die "--check and --pin do not go together"; fi
  read -r repo rev <<< "$spec"
  name="${repo#*/}"
  pin="$root/ci/$name.sha256"
  dir="${GLINER_CACHE_DIR:-$root/.cache/gliner}/$name@${rev:0:7}"
  if (( check )); then
    [[ -f "$pin" ]] || die "no $(rel "$pin")"
    cmp -s "$dir/.verified" "$pin" 2>/dev/null || die "no verified copy in $(rel "$dir"); fix: scripts/fetch-gliner.sh $which"
    for f in "${files[@]}"; do ensure_file "$f"; done
    emit "GLINER_$(echo "$which" | tr '[:lower:]' '[:upper:]')_DIR" "$dir"
    return 0
  fi
  mkdir -p "$dir"
  take_lock
  tmp="$(mktemp -d "$dir/.tmp.XXXXXX")"
  trap 'rm -rf "$tmp" "$dir/.lock.d"' EXIT
  if (( do_pin )); then pin_model; return 0; fi

  [[ -f "$pin" ]] || die "no $(rel "$pin"): run scripts/fetch-gliner.sh $which --pin, review it and commit it"
  # the pin must list exactly the files this script fetches
  [[ "$(awk '{ print $2 }' "$pin" | LC_ALL=C sort | tr '\n' ' ')" == "$(printf '%s\n' "${files[@]}" | LC_ALL=C sort | tr '\n' ' ')" ]] ||
    die "$(rel "$pin") does not list exactly: ${files[*]}"
  say "$repo @ ${rev:0:7} into $(rel "$dir")"
  for f in "${files[@]}"; do ensure_file "$f"; done
  cp "$pin" "$tmp/verified"
  chmod 644 "$tmp/verified"
  mv -f "$tmp/verified" "$dir/.verified"
  say "verified against $(rel "$pin")"
  local key; key="$(echo "$which" | tr '[:lower:]' '[:upper:]')"
  emit "GLINER_${key}_DIR" "$dir"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
