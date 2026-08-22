#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

repo_root="$project_root"
# shellcheck source=../lib/components.sh
source "$project_root/lib/components.sh"

# Every portable configuration path must have exactly one component owner, and
# no parent component may cross into the independent theme repository.
mapfile -t component_names < <(
  while IFS='|' read -r name _; do
    [[ -n "$name" && "$name" != \#* ]] && printf '%s\n' "$name"
  done < "$project_root/components.conf"
)

while IFS= read -r -d '' tracked_path; do
  case "$tracked_path" in
    .gitignore|README.md|bootstrap.sh|components.conf|configctl|lib/*|packages.txt|profiles/*/packages.txt|tests/*) continue ;;
  esac

  owners=0
  for component_name in "${component_names[@]}"; do
    candidate_paths=()
    component_paths "$component_name" candidate_paths
    for candidate in "${candidate_paths[@]}"; do
      if [[ "$tracked_path" == "$candidate" || "$tracked_path" == "$candidate/"* ]]; then
        ((owners += 1))
        break
      fi
    done
  done
  ((owners == 1)) || fail "$tracked_path has $owners component owners"
done < <(git -C "$project_root" ls-files -z --cached --others --exclude-standard)

for component_name in "${component_names[@]}"; do
  candidate_paths=()
  component_paths "$component_name" candidate_paths
  for candidate in "${candidate_paths[@]}"; do
    [[ "$candidate" != omarchy/themes && "$candidate" != omarchy/themes/* ]] \
      || fail "$component_name crosses into the independent theme repository"
  done
done

assert_file_contains() {
  local file="$1" expected="$2"
  [[ -f "$file" ]] || fail "missing file $file"
  [[ "$(<"$file")" == "$expected" ]] || fail "$file does not contain $expected"
}

# bootstrap.sh must deploy only selected component paths.
target_home="$test_root/home"
target_config="$test_root/target-config"
mkdir -p -- "$target_home" "$target_config"

HOME="$target_home" XDG_CONFIG_HOME="$target_config" \
  "$project_root/bootstrap.sh" --profile omarchy --component yazi >/dev/null

[[ -f "$target_config/yazi/theme.toml" ]] || fail 'Yazi was not restored'
[[ ! -e "$target_config/nvim/init.lua" ]] || fail 'Neovim crossed the Yazi component boundary'
[[ ! -e "$target_config/omarchy/themes/primary-space" ]] || fail 'Primary Space crossed the parent boundary'

idempotent_output="$(HOME="$target_home" XDG_CONFIG_HOME="$target_config" \
  "$project_root/bootstrap.sh" --profile omarchy --component yazi)"
[[ "$idempotent_output" == *'Configuration is already current.'* ]] || fail 'component restore is not idempotent'

arch_target="$test_root/arch-config"
mkdir -p -- "$arch_target"
HOME="$target_home" XDG_CONFIG_HOME="$arch_target" \
  "$project_root/bootstrap.sh" --profile arch --component ghostty >/dev/null
cmp -s -- "$project_root/profiles/arch/ghostty/config" "$arch_target/ghostty/config" \
  || fail 'Arch profile did not override the base Ghostty configuration'
[[ ! -e "$arch_target/yazi/theme.toml" ]] || fail 'Yazi crossed the Ghostty component boundary'

if HOME="$target_home" XDG_CONFIG_HOME="$target_config" \
  "$project_root/bootstrap.sh" --profile omarchy --component missing >/dev/null 2>&1; then
  fail 'unknown component was accepted'
fi

unsafe_manifest="$test_root/unsafe-components.conf"
cp -- "$project_root/components.conf" "$unsafe_manifest"
printf '%s\n' 'unsafe|Unsafe path fixture|:(top)' >> "$unsafe_manifest"
if component_manifest="$unsafe_manifest" component_paths unsafe unsafe_paths 2>/dev/null; then
  fail 'Git pathspec magic was accepted as a component path'
fi

if HOME="$target_home" XDG_CONFIG_HOME="$target_config" \
  "$project_root/bootstrap.sh" --profile omarchy --component yazi --install-packages >/dev/null 2>&1; then
  fail 'component-scoped package installation was accepted'
fi

# configctl must restore and stage only the selected component.
fixture="$test_root/repository"
mkdir -p -- "$fixture/lib" "$fixture/yazi" "$fixture/nvim" "$fixture/omarchy/themes/primary-space"
cp -- "$project_root/configctl" "$fixture/configctl"
cp -- "$project_root/components.conf" "$fixture/components.conf"
cp -- "$project_root/lib/components.sh" "$fixture/lib/components.sh"
printf '%s\n' 'omarchy/themes/primary-space/' > "$fixture/.gitignore"
printf '%s\n' old-yazi > "$fixture/yazi/theme.toml"
printf '%s\n' old-nvim > "$fixture/nvim/init.lua"
printf '%s\n' old-shell > "$fixture/omarchy/shell.json"

theme_fixture="$fixture/omarchy/themes/primary-space"
git -C "$theme_fixture" init -q -b main
git -C "$theme_fixture" config user.name 'Theme Test'
git -C "$theme_fixture" config user.email 'theme-test@example.invalid'
printf '%s\n' theme-state > "$theme_fixture/state"
git -C "$theme_fixture" add state
git -C "$theme_fixture" commit -qm 'Initial theme state'

git -C "$fixture" init -q -b master
git -C "$fixture" config user.name 'Component Test'
git -C "$fixture" config user.email 'component-test@example.invalid'
git -C "$fixture" add .
git -C "$fixture" commit -qm 'Initial configuration'
old_revision="$(git -C "$fixture" rev-parse HEAD)"

printf '%s\n' new-yazi > "$fixture/yazi/theme.toml"
printf '%s\n' new-nvim > "$fixture/nvim/init.lua"
printf '%s\n' new-shell > "$fixture/omarchy/shell.json"
git -C "$fixture" add yazi nvim omarchy/shell.json
git -C "$fixture" commit -qm 'Update both fixtures'

printf '%s\n' dirty-theme > "$theme_fixture/state"
omarchy_status="$("$fixture/configctl" status omarchy)"
[[ "$omarchy_status" == *'Clean.'* ]] || fail 'nested theme dirtied the parent Omarchy component'

printf '%s\n' local-yazi > "$fixture/yazi/theme.toml"
printf '%s\n' untracked-yazi > "$fixture/yazi/local.toml"
printf '%s\n' local-nvim > "$fixture/nvim/init.lua"
nvim_status_before="$(git -C "$fixture" status --porcelain -- nvim)"
git -C "$fixture" add yazi/theme.toml
if "$fixture/configctl" restore yazi "$old_revision" >/dev/null 2>&1; then
  fail 'restore overwrote dirty component state'
fi

stash_output="$("$fixture/configctl" stash yazi 'Before fixture restore')"
[[ "$stash_output" == *'Recover with: git stash apply --index '* ]] || fail 'stash did not print exact recovery guidance'
stash_revision="$(git -C "$fixture" rev-parse refs/stash)"
stashed_paths="$(git -C "$fixture" stash show --include-untracked --name-only "$stash_revision")"
[[ "$stashed_paths" == *'yazi/theme.toml'* && "$stashed_paths" == *'yazi/local.toml'* ]] \
  || fail 'stash did not preserve staged and untracked component files'

"$fixture/configctl" restore yazi "$old_revision" >/dev/null
assert_file_contains "$fixture/yazi/theme.toml" old-yazi
assert_file_contains "$fixture/nvim/init.lua" local-nvim
assert_file_contains "$fixture/omarchy/shell.json" new-shell
assert_file_contains "$theme_fixture/state" dirty-theme
[[ "$(git -C "$fixture" status --porcelain -- nvim)" == "$nvim_status_before" ]] \
  || fail 'Yazi maintenance changed Neovim state'

"$fixture/configctl" stage yazi >/dev/null
staged_paths="$(git -C "$fixture" diff --cached --name-only)"
[[ "$staged_paths" == 'yazi/theme.toml' ]] || fail "unexpected staged paths: $staged_paths"

printf '%s\n' 'Component scoping checks passed.'
