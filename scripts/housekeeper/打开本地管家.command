#!/bin/bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
node_bin=''
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [[ -x "$candidate" ]]; then node_bin="$candidate"; break; fi
done
if [[ -z "$node_bin" ]]; then printf '%s\n' '需要 Node.js 22.18 或更高版本。' >&2; exit 1; fi
# Keep only explicit Crew configuration; do not inherit runtime injection options.
crew_env=()
for name in CORPUS_HOME CORPUS_DB CREW_ASKKEY_HELPER CREW_ASKKEY_LAUNCHER CREW_SECURITY_SCANNER CREW_VAULT_DIR CREW_TASK_DB CREW_TASK_SNAPSHOT; do
  if [[ ${!name+x} ]]; then crew_env+=("$name=${!name}"); fi
done
# Bash 3.2 with nounset needs the conditional expansion for an empty array.
exec /usr/bin/env -i HOME="$HOME" PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG='en_US.UTF-8' ${crew_env[@]+"${crew_env[@]}"} "$node_bin" --no-warnings "$script_dir/housekeeper.ts" "$@"
