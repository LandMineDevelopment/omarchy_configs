#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/components.sh
source "$repo_root/lib/components.sh"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
dry_run=false
install_packages=false
profile=auto
declare -a requested_components=()
declare -a selected_paths=()
declare -A selected_component_names=()

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [--profile auto|omarchy|arch] [--component NAME] [--dry-run] [--install-packages]

Restore the repository's portable user configuration into ~/.config.
Existing files are backed up before they are changed. Hardware-specific files
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

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_root="$HOME/.local/state/omarchy-config-backups/$timestamp"
changes=0

restore_file() {
  local source_relative="$1" destination_relative="${2:-$1}"
  local source="$repo_root/$source_relative" destination="$config_home/$destination_relative"

  [[ -e "$source" || -L "$source" ]] || return 0
  [[ "$source" != "$destination" ]] || return 0

  if [[ -L "$source" && -L "$destination" ]] \
    && [[ "$(readlink -- "$source")" == "$(readlink -- "$destination")" ]]; then
    return 0
  elif [[ ! -L "$source" ]] && cmp -s -- "$source" "$destination" 2>/dev/null; then
    return 0
  fi

  printf '%s %s\n' "$($dry_run && printf 'Would restore' || printf 'Restoring')" "$destination_relative"
  ((changes += 1))
  $dry_run && return 0

  if [[ -e "$destination" || -L "$destination" ]]; then
    mkdir -p -- "$backup_root/$(dirname -- "$destination_relative")"
    cp -a -- "$destination" "$backup_root/$destination_relative"
  fi

  mkdir -p -- "$(dirname -- "$destination")"
  cp -a -- "$source" "$destination"
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
    .gitignore|README.md|bootstrap.sh|components.conf|configctl|lib/*|packages.txt|profiles/*|system/*|tests/*) continue ;;
  esac
  path_is_selected "$path" || continue

  if [[ "$profile" == arch ]]; then
    case "$path" in
      alacritty/*|brave-flags.conf|chromium-flags.conf|ghostty/config|hypr/*|kitty/*|omarchy/*|nvim/lua/plugins/theme.lua) continue ;;
    esac
  fi

  restore_file "$path"
done < <(git -C "$repo_root" ls-files -z --cached --others --exclude-standard)

profile_prefix="profiles/$profile/"
while IFS= read -r -d '' path; do
  [[ "$path" == "$profile_prefix"* ]] || continue
  [[ "$path" == */packages.txt ]] && continue
  path_is_selected "$path" || continue
  restore_file "$path" "${path#"$profile_prefix"}"
done < <(git -C "$repo_root" ls-files -z --cached --others --exclude-standard)

bash_source='source "$HOME/.config/bash/portable.bash"'
if component_is_selected bash && ! grep -Fqx -- "$bash_source" "$HOME/.bashrc" 2>/dev/null; then
  printf '%s Bash integration\n' "$($dry_run && printf 'Would add' || printf 'Adding')"
  ((changes += 1))
  if ! $dry_run; then
    mkdir -p -- "$backup_root"
    [[ -f "$HOME/.bashrc" ]] && cp -a -- "$HOME/.bashrc" "$backup_root/bashrc"
    printf '\n# Portable personal settings\n%s\n' "$bash_source" >> "$HOME/.bashrc"
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
  elif [[ "$profile" == omarchy ]]; then
    omarchy pkg add "${packages[@]}"
  else
    official=()
    aur=()
    for package in "${packages[@]}"; do
      if pacman -Si "$package" >/dev/null 2>&1; then
        official+=("$package")
      else
        aur+=("$package")
      fi
    done

    ((${#official[@]} == 0)) || sudo pacman -S --needed "${official[@]}"
    if ((${#aur[@]})); then
      if command -v yay >/dev/null 2>&1; then
        yay -S --needed "${aur[@]}"
      else
        printf 'Install an AUR helper, then install these optional packages: %s\n' "${aur[*]}" >&2
      fi
    fi
  fi
fi

if ((changes == 0)); then
  printf 'Configuration is already current.\n'
elif $dry_run; then
  printf '\nDry run complete: %d change(s) would be made.\n' "$changes"
else
  printf '\nRestore complete: %d change(s) made.\n' "$changes"
  printf 'Backups, when needed, are in %s\n' "$backup_root"
fi

cat <<'EOF'

On Omarchy, the Primary Space theme is maintained as its own Git repository.
Install it with `omarchy theme install https://github.com/LandMineDevelopment/primary-space`
and apply it with `omarchy theme set primary-space`. The Arch profile includes
standalone Primary Space colors and does not require Omarchy theme state.
EOF
