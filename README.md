# Portable Omarchy / Arch configuration

Portable personal configuration for Omarchy and basic Arch workstations. This repository
uses an explicit allowlist because it lives at `~/.config`, alongside browser
profiles, credentials, caches, and other state that must never be published.

## Restore on a new machine

```bash
git clone git@github.com:LandMineDevelopment/omarchy_configs.git ~/omarchy-configs
cd ~/omarchy-configs
./bootstrap.sh --dry-run
./bootstrap.sh --install-packages
```

`--profile auto` is the default. It selects the full Omarchy integration when
`omarchy` and `/usr/share/omarchy` exist; otherwise it selects the standalone
Arch profile. You can choose explicitly:

```bash
./bootstrap.sh --profile omarchy --install-packages
./bootstrap.sh --profile arch --install-packages
```

The restore is additive and idempotent. Before replacing a differing file, it
copies the old version to `~/.local/state/omarchy-config-backups/<timestamp>/`.
It never deletes an existing `~/.config` repository or application state.

Install and apply the separately versioned theme:

```bash
omarchy theme install https://github.com/LandMineDevelopment/primary-space
omarchy theme set primary-space
```

## Included

- Hyprland Lua overrides and monitor scale
- Omarchy shell layout, idle settings, menu extension, and default agent
- Ghostty, Alacritty, Kitty, XTerm, Tmux, and Herdr configuration
- Neovim, Yazi, Starship, Git, Mise, btop, and Fcitx settings
- Default applications, browser flags, autostart overrides, and Bluetooth audio
- A reusable Bash fragment and a package manifest

The basic Arch profile additionally provides standalone Primary Space terminal
colors, Hyprland, Hypridle, Hyprlock, Waybar, Wofi, portals, PipeWire, and a
non-Omarchy Neovim theme. It does not copy Omarchy shell files or references to
`/usr/share/omarchy`. Packages available only through the AUR are installed with
`yay` when present and otherwise reported for manual installation.

`system/` contains reviewed copies of machine-level changes, currently the
NVIDIA GSP workaround and Docker graceful-shutdown timeout. They are deliberately
not installed by `bootstrap.sh`: hardware and system service changes must be
reviewed for each target machine.

## Updating

This checkout is the live `~/.config` worktree on the primary machine. Edit the
normal application files, review `git status` and `git diff`, then commit only
intentional changes. To add another config, explicitly allow its narrowest path
in `.gitignore`; never allow an entire application-state directory by default.

The Primary Space theme remains an independent repository at
`~/.config/omarchy/themes/primary-space` so it can keep its own release history.

## Safety

Browser profiles, Signal state, database connection files, cookies, tokens,
passwords, private keys, `dconf`, caches, logs, runtime sockets, generated state,
or Omarchy upgrade backups. Keep secret-bearing examples sanitized.
