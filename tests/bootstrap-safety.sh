#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
repo="$test_root/repo"
target_home="$test_root/home"
config="$target_home/custom-config"
mkdir -p "$repo/lib" "$repo/yazi" "$repo/local/bin" "$repo/local/share/example" "$target_home" "$config/yazi"
cp "$project_root/bootstrap.sh" "$repo/bootstrap.sh"
cp "$project_root/lib/components.sh" "$repo/lib/components.sh"
printf '%s\n' 'yazi|Test configuration|yazi' 'scripts|Local scripts|local/bin local/share' 'bash|Bash|bash' > "$repo/components.conf"
printf '%s\n' new > "$repo/yazi/theme.toml"
printf '%s\n' executable > "$repo/local/bin/example"
chmod +x "$repo/local/bin/example"
printf '%s\n' data > "$repo/local/share/example/config"
git -C "$repo" init -q
git -C "$repo" add .
run() { HOME="$target_home" XDG_CONFIG_HOME="$config" XDG_DATA_HOME="$target_home/.local/share" bash "$repo/bootstrap.sh" --profile omarchy "$@" > "$test_root/output"; }
printf '%s\n' existing > "$config/yazi/theme.toml"
run --component yazi
[[ "$(cat "$config/yazi/theme.toml")" == existing ]] || fail 'default overwrote existing file'
[[ ! -e "$target_home/.local/state" ]] || fail 'default created backups unnecessarily'
run --component yazi --overwrite --dry-run
[[ "$(cat "$config/yazi/theme.toml")" == existing ]] || fail 'dry run changed destination'
[[ ! -e "$target_home/.local/state" ]] || fail 'dry run wrote backup'
run --component yazi --overwrite
[[ "$(cat "$config/yazi/theme.toml")" == new ]] || fail 'overwrite did not replace file'
backup="$(find "$target_home/.local/state" -type f -name theme.toml -print -quit)"
[[ "$(cat "$backup")" == existing ]] || fail 'backup did not preserve previous file'
printf '%s\n' outside > "$test_root/outside"
rm "$config/yazi/theme.toml"
ln -s "$test_root/outside" "$config/yazi/theme.toml"
run --component yazi --overwrite
[[ ! -L "$config/yazi/theme.toml" ]] || fail 'overwrite retained destination symlink'
[[ "$(cat "$test_root/outside")" == outside ]] || fail 'overwrite followed destination symlink'
rm -r "$config/yazi"
mkdir "$test_root/external-parent"
ln -s "$test_root/external-parent" "$config/yazi"
run --component yazi --overwrite
[[ ! -e "$test_root/external-parent/theme.toml" ]] || fail 'restore escaped via parent symlink'
run --component scripts
[[ -x "$target_home/.local/bin/example" ]] || fail 'local executable not deployed'
[[ "$(cat "$target_home/.local/share/example/config")" == data ]] || fail 'local share data not deployed'
[[ ! -e "$config/local" ]] || fail 'local payload deployed into config directory'
printf '%s\n' custom > "$target_home/.local/bin/example"
run --component scripts
[[ "$(cat "$target_home/.local/bin/example")" == custom ]] || fail 'local payload overwrote existing executable'
run --component bash
grep -Fq 'source "${XDG_CONFIG_HOME:-$HOME/.config}/bash/portable.bash"' "$target_home/.bashrc" || fail 'Bash integration ignores XDG_CONFIG_HOME'
# Browser flags must refer to the restore user's extension location.
printf '%s\n' '--load-extension=/home/kasey/.local/share/brave-media-transparency/extension' > "$repo/brave-flags.conf"
printf '%s\n' 'browsers|Browser flags|brave-flags.conf' >> "$repo/components.conf"
git -C "$repo" add brave-flags.conf components.conf
run --component browsers
grep -Fq -- "$target_home/.local/share/brave-media-transparency/extension" "$config/brave-flags.conf" || fail 'Brave extension path not rendered'
grep -Fq -- '/home/kasey/' "$repo/brave-flags.conf" || fail 'source Brave flags changed'

# Package installation must distinguish installed, official, and AUR packages.
mkdir -p "$test_root/bin" "$repo/profiles/omarchy"
printf '%s\n' already-installed official-new aur-new > "$repo/packages.txt"
: > "$repo/profiles/omarchy/packages.txt"
cat > "$test_root/bin/pacman" <<'MOCK'
#!/usr/bin/env bash
case "$1:$2" in
  -Q:already-installed|-Si:official-new) exit 0 ;;
  *) exit 1 ;;
esac
MOCK
cat > "$test_root/bin/omarchy" <<'MOCK'
#!/usr/bin/env bash
printf 'omarchy %s\n' "$*" >> "$MOCK_LOG"
MOCK
cat > "$test_root/bin/yay" <<'MOCK'
#!/usr/bin/env bash
printf 'yay %s\n' "$*" >> "$MOCK_LOG"
MOCK
chmod +x "$test_root/bin/"*
PATH="$test_root/bin:$PATH" MOCK_LOG="$test_root/packages.log" run --install-packages
grep -Fxq 'omarchy pkg add official-new' "$test_root/packages.log" || fail 'official package not installed through Omarchy'
grep -Fxq 'yay -S --needed aur-new' "$test_root/packages.log" || fail 'AUR package not installed through yay'
! grep -q already-installed "$test_root/packages.log" || fail 'existing package reinstalled'
printf '%s\n' 'Bootstrap safety checks passed.' 
