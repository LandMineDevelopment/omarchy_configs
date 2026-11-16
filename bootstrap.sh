#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/components.sh
source "$repo_root/lib/components.sh"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
dry_run=false
install_packages=false
overwrite=false
skipped=0
profile=auto
declare -a requested_components=()
declare -a selected_paths=()
declare -A selected_component_names=()

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [--profile auto|omarchy|arch] [--component NAME] [--dry-run] [--overwrite] [--install-packages]

Restore the repository's portable user configuration into ~/.config.
Existing differing files are preserved unless --overwrite is passed; replacements
are backed up first. Hardware-specific files
under system/ are documented but are never installed automatically. The auto
profile uses Omarchy when available and otherwise selects basic Arch Linux.
Repeat --component to restore only named components. Component selection cannot
be combined with the repository-wide --install-packages operation. Run
`./configctl list` to see the available component names.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --overwrite) overwrite=true ;;
    --install-packages) install_packages=true ;;
    --component=*) requested_components+=("${1#*=}") ;;
    --component)
      shift
      (($#)) || { printf '%s\n' 'Missing value for --component' >&2; exit 2; }
      requested_components+=("$1")
      ;;
    --profile=*) profile="${1#*=}" ;;
    --profile)
      shift
      (($#)) || { printf '%s\n' 'Missing value for --profile' >&2; exit 2; }
      profile="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if $install_packages && ((${#requested_components[@]})); then
  printf '%s\n' '--install-packages is repository-wide and cannot be combined with --component.' >&2
  exit 2
fi

for component in "${requested_components[@]}"; do
  [[ -n "$component" ]] || { printf '%s\n' 'Component name cannot be empty.' >&2; exit 2; }
  [[ -z "${selected_component_names[$component]+set}" ]] || continue

  component_path_list=()
  component_paths "$component" component_path_list || exit 2
  selected_component_names["$component"]=1
  selected_paths+=("${component_path_list[@]}")
done

if [[ "$profile" == auto ]]; then
  if command -v omarchy >/dev/null 2>&1 && [[ -d /usr/share/omarchy ]]; then
    profile=omarchy
  elif [[ -f /etc/arch-release ]]; then
    profile=arch
  else
    printf '%s\n' 'Could not detect Omarchy or Arch Linux; pass --profile explicitly.' >&2
    exit 1
  fi
fi

[[ "$profile" == omarchy || "$profile" == arch ]] || {
  printf 'Unsupported profile: %s\n' "$profile" >&2
  exit 2
}

printf 'Using %s profile.\n' "$profile"
if ((${#requested_components[@]})); then
  printf 'Restoring components: %s\n' "${!selected_component_names[*]}"
fi

timestamp="$(date +%Y%m%d-%H%M%S-%N)"
backup_root="$HOME/.local/state/omarchy-config-backups/$timestamp"
changes=0
rendered_root=""
trap '[[ -z "$rendered_root" ]] || rm -rf -- "$rendered_root"' EXIT

restore_file() {
  local source_relative="$1" destination_relative="${2:-$1}" destination_root="${3:-$config_home}"
  local source="$repo_root/$source_relative" destination="$destination_root/$destination_relative"
  local root_resolved parent_resolved backup_relative="$source_relative"

  [[ -e "$source" || -L "$source" ]] || return 0
  [[ "$source" != "$destination" ]] || return 0

  # Chromium flags do not expand shell variables; render this known local path.
  if [[ "$source_relative" == brave-flags.conf ]]; then
    local flags
    flags="$(cat -- "$source")"
    flags="${flags//\/home\/kasey\/.local\/share\/brave-media-transparency/$HOME/.local/share/brave-media-transparency}"
    [[ -n "$rendered_root" ]] || rendered_root="$(mktemp -d)"
    printf '%s\n' "$flags" > "$rendered_root/brave-flags.conf"
    chmod --reference="$source" "$rendered_root/brave-flags.conf"
    source="$rendered_root/brave-flags.conf"
  fi

  # Resolve parents, not the leaf: overwrite must replace a destination symlink
  # itself, never write through it. Refuse parents escaping the target root.
  root_resolved="$(realpath -m -- "$destination_root")"
  parent_resolved="$(realpath -m -- "$(dirname -- "$destination")")"
  if [[ "$parent_resolved" != "$root_resolved" && "$parent_resolved" != "$root_resolved/"* ]]; then
    printf 'Preserving %s (parent symlink escapes destination root)\n' "$destination"
    ((skipped += 1))
    return 0
  fi

  if [[ -L "$source" && -L "$destination" ]] \
    && [[ "$(readlink -- "$source")" == "$(readlink -- "$destination")" ]]; then
    return 0
  elif [[ ! -L "$source" && ! -L "$destination" ]] && cmp -s -- "$source" "$destination" 2>/dev/null; then
    return 0
  fi

  if [[ -e "$destination" || -L "$destination" ]]; then
    if ! $overwrite || [[ -d "$destination" && ! -L "$destination" ]]; then
      printf 'Preserving existing %s\n' "$destination"
      ((skipped += 1))
      return 0
    fi
  fi

  printf '%s %s\n' "$($dry_run && printf 'Would restore' || printf 'Restoring')" "$destination"
  ((changes += 1))
  $dry_run && return 0

  if [[ -e "$destination" || -L "$destination" ]]; then
    mkdir -p -- "$backup_root/$(dirname -- "$backup_relative")"
    cp -a -- "$destination" "$backup_root/$backup_relative"
  fi

  mkdir -p -- "$(dirname -- "$destination")"
  cp -a --remove-destination -- "$source" "$destination"
}

path_is_selected() {
  local path="$1" selected

  ((${#selected_component_names[@]} == 0)) && return 0
  for selected in "${selected_paths[@]}"; do
    [[ "$path" == "$selected" || "$path" == "$selected/"* ]] && return 0
  done
  return 1
}

component_is_selected() {
  local component="$1"
  ((${#selected_component_names[@]} == 0)) || [[ -n "${selected_component_names[$component]+set}" ]]
}

while IFS= read -r -d '' path; do
  case "$path" in
    .gitignore|README.md|CUSTOM-SETUP.md|bootstrap.sh|components.conf|configctl|lib/*|packages.txt|profiles/*|system/*|tests/*) continue ;;
  esac
  path_is_selected "$path" || continue
  # The legacy AppImage experiment requires an independent binary; opt in explicitly.
  if ((${#requested_components[@]} == 0)); then
    case "$path" in
      local/bin/t3code-transparent|local/share/t3code-transparency/*|local/share/applications/t3code.desktop) continue ;;
    esac
  fi

  if [[ "$profile" == arch ]]; then
    case "$path" in
      alacritty/*|brave-flags.conf|chromium-flags.conf|ghostty/config|hypr/*|kitty/*|omarchy/*|nvim/lua/plugins/theme.lua) continue ;;
    esac
  fi

  # A selected profile owns its destination instead of the base version.
  [[ ! -e "$repo_root/profiles/$profile/$path" ]] || continue
  case "$path" in
    local/bin/*) restore_file "$path" "${path#local/bin/}" "$HOME/.local/bin" ;;
    local/share/*) restore_file "$path" "${path#local/share/}" "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
    *) restore_file "$path" ;;
  esac
done < <(git -C "$repo_root" ls-files -z --cached --others --exclude-standard)

profile_prefix="profiles/$profile/"
while IFS= read -r -d '' path; do
  [[ "$path" == "$profile_prefix"* ]] || continue
  [[ "$path" == */packages.txt || "$path" == */installed-software.md ]] && continue
  path_is_selected "$path" || continue
  restore_file "$path" "${path#"$profile_prefix"}"
done < <(git -C "$repo_root" ls-files -z --cached --others --exclude-standard)

bash_source='source "${XDG_CONFIG_HOME:-$HOME/.config}/bash/portable.bash"'
if component_is_selected bash && ! grep -Fqx -- "$bash_source" "$HOME/.bashrc" 2>/dev/null; then
  if [[ -L "$HOME/.bashrc" ]]; then
    printf '%s\n' 'Preserving Bash integration (existing .bashrc is a symlink).'
    ((skipped += 1))
  else
    printf '%s Bash integration\n' "$($dry_run && printf 'Would add' || printf 'Adding')"
    ((changes += 1))
    if ! $dry_run; then
      mkdir -p -- "$backup_root"
      [[ -f "$HOME/.bashrc" ]] && cp -a -- "$HOME/.bashrc" "$backup_root/bashrc"
      printf '\n# Portable personal settings\n%s\n' "$bash_source" >> "$HOME/.bashrc"
    fi
  fi
fi

if $install_packages; then
  mapfile -t packages < <(
    grep -Ehiv '^\s*(#|$)' \
      "$repo_root/packages.txt" \
      "$repo_root/profiles/$profile/packages.txt" 2>/dev/null \
      | sort -u
  )
  if $dry_run; then
    printf 'Would install packages: %s\n' "${packages[*]}"
  else
    official=()
    aur=()
    for package in "${packages[@]}"; do
      # Existing installs may be locally built or renamed providers; never
      # reinstall them or mistake them for unavailable repository packages.
      pacman -Q "$package" >/dev/null 2>&1 && continue
      if pacman -Si "$package" >/dev/null 2>&1; then
        official+=("$package")
      else
        aur+=("$package")
      fi
    done

    if ((${#official[@]})); then
      if [[ "$profile" == omarchy ]]; then
        omarchy pkg add "${official[@]}"
      else
        sudo pacman -S --needed "${official[@]}"
      fi
    fi
    if ((${#aur[@]})); then
      if command -v yay >/dev/null 2>&1; then
        yay -S --needed "${aur[@]}"
      else
        printf 'AUR packages were not installed because yay is unavailable: %s\n' "${aur[*]}" >&2
      fi
    fi
  fi
fi

if ((skipped)); then
  printf 'Preserved %d existing or unsafe destination(s); review before using --overwrite.\n' "$skipped"
fi

if ((changes == 0 && skipped == 0)); then
  printf 'Configuration is already current.\n'
elif $dry_run; then
  printf '\nDry run complete: %d change(s) would be made.\n' "$changes"
else
  printf '\nRestore complete: %d change(s) made, %d destination(s) preserved.\n' "$changes" "$skipped"
  printf 'Backups, when needed, are in %s\n' "$backup_root"
fi

cat <<'EOF'

On Omarchy, the Primary Space theme is maintained as its own Git repository.
Install it with `omarchy theme install https://github.com/LandMineDevelopment/primary-space`
and apply it with `omarchy theme set primary-space`. The Arch profile includes
standalone Primary Space colors and does not require Omarchy theme state.
EOF
