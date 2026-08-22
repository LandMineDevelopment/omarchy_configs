#!/usr/bin/env bash

# Shared component boundary for bootstrap.sh and configctl. The caller must set
# repo_root before sourcing this file.

[[ -n "${repo_root:-}" ]] || {
  printf '%s\n' 'lib/components.sh requires repo_root to be set.' >&2
  return 1 2>/dev/null || exit 1
}

component_manifest="$repo_root/components.conf"

[[ -r "$component_manifest" ]] || {
  printf 'Component manifest is not readable: %s\n' "$component_manifest" >&2
  return 1 2>/dev/null || exit 1
}

component_paths() {
  local requested="$1" output_name="$2"
  local name description path_list path
  local -n output="$output_name"

  output=()
  while IFS='|' read -r name description path_list; do
    [[ -n "$name" && "$name" != \#* ]] || continue
    [[ "$name" == "$requested" ]] || continue

    read -r -a output <<< "$path_list"
    ((${#output[@]})) || {
      printf 'Component has no paths: %s\n' "$requested" >&2
      return 1
    }

    for path in "${output[@]}"; do
      if [[ -z "$path" || "$path" == /* || "$path" == . || "/$path/" == */../* \
        || "/$path/" == */./* || "$path" == *'*'* || "$path" == *'?'* \
        || "$path" == *'['* || "$path" == :* ]]; then
        printf 'Unsafe path for component %s: %s\n' "$requested" "$path" >&2
        return 1
      fi
    done
    return 0
  done < "$component_manifest"

  printf 'Unknown component: %s\n' "$requested" >&2
  return 1
}

component_list() {
  local name description path_list

  while IFS='|' read -r name description path_list; do
    [[ -n "$name" && "$name" != \#* ]] || continue
    printf '%-12s %s\n' "$name" "$description"
  done < "$component_manifest"
}
