# Source from any run.sh:   source "$root/scripts/env.sh"
# Loads <repo>/.env without overriding variables already set in the shell (later lines
# win), then sets the Relate defaults every run needs. A default applies when the variable
# is unset or empty. Everything is exported so the relate CLI, uv/Python and Node all see
# the same values.
_env_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$_env_root/.env" ]]; then
  _preset=" $(compgen -e | tr '\n' ' ') "   # shell-exported vars win over .env
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    _line="${_line%$'\r'}"
    [[ "$_line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$_line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    _key="${BASH_REMATCH[2]}"; _val="${BASH_REMATCH[3]}"
    _val="${_val%"${_val##*[![:space:]]}"}"                       # trim trailing space
    if [[ "$_val" =~ ^\"(.*)\"$ || "$_val" =~ ^\'(.*)\'$ ]]; then _val="${BASH_REMATCH[1]}"; fi
    [[ "$_preset" == *" $_key "* ]] || export "$_key=$_val"   # later lines win
  done < "$_env_root/.env"
fi
# Under an agent harness (CLAUDECODE, CODEX_SANDBOX, CURSOR_AGENT, ...) with stdout piped,
# the relate CLI turns agent mode on: toon output instead of jsonl, and at most 100 rows per
# statement (a warning on stderr, exit 0). A run's diffed output must not depend on who
# started the shell, so both are forced off; explicit --mode flags are unaffected.
: "${RELATE_MAX_ROWS:=0}"
export RELATE_MAX_ROWS
: "${RELATE_AGENT_MODE:=0}"
export RELATE_AGENT_MODE
# Telemetry adds a network call to every CLI process; examples run offline.
: "${RELATE_TELEMETRY:=off}"
export RELATE_TELEMETRY
unset _env_root _line _key _val _preset
