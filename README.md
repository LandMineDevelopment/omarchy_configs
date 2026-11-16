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

Restore one or more application configurations without changing the others:

```bash
./configctl list
./bootstrap.sh --profile omarchy --component yazi --dry-run
./bootstrap.sh --profile omarchy --component yazi
./bootstrap.sh --profile arch --component ghostty --component yazi
```

Package installation remains repository-wide and is intentionally separate
from component restores, so `--component` and `--install-packages` cannot be
combined.

The restore is additive and idempotent. By default it adds missing files and
preserves existing differing files, reporting each conflict. Review a dry run
first. Use `--overwrite` only when you want the saved settings to replace those
files; originals are backed up to `~/.local/state/omarchy-config-backups/<timestamp>/`.
Destination symlinks are never followed for replacement, and parent symlinks
escaping the destination root are refused. No reset, pruning, service enabling,
or account/data restoration runs automatically.

```bash
./bootstrap.sh --profile omarchy --dry-run
./bootstrap.sh --profile omarchy --component hypr --overwrite --dry-run
```

`local/bin` and `local/share` hold reviewed source payloads restored to
`~/.local/bin` and `${XDG_DATA_HOME:-~/.local/share}`, separately from configuration.
[Custom setup](CUSTOM-SETUP.md) documents activation and manual dependencies.
[Software inventory](profiles/omarchy/installed-software.md) explains the curated
package manifest and hardware exclusions. Package installation is opt-in, adds
missing software only, and separates repository packages from AUR packages.

Install and apply the separately versioned theme:

```bash
omarchy theme install https://github.com/LandMineDevelopment/primary-space
omarchy theme set primary-space
```

## Included

- Hyprland Lua overrides, Super+Q window closing, and monitor scale
- Omarchy shell layout, custom plugins, idle settings, menu extension, and default agent
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

`components.conf` is the shared boundary used by the restore and maintenance
tools. Each component owns narrow base and profile paths. Use `configctl` to
work on one component without a hard reset or changes to other configurations:

```bash
./configctl status yazi
./configctl diff yazi
./configctl log yazi
./configctl stash yazi "Before trying alternate colors"
./configctl restore yazi <good-commit>
./configctl stage yazi
```

`restore` places the selected revision in the working tree for testing without
moving the branch or committing it. It refuses to overwrite existing component
changes; save them first with a named `configctl stash`. The stash command
prints the exact object ID and recovery command. To stop an experiment without
losing it, stash the trial and then restore the component from `HEAD`. Stage and
commit the component when the rollback should become durable. Keep commits
focused on one component whenever practical.

The Primary Space theme remains an independent repository at
`~/.config/omarchy/themes/primary-space` so it can keep its own release history.
It is deliberately absent from `components.conf` and remains ignored by the
parent repository. Run Git commands from that directory to maintain the theme.

## Safety

Browser profiles, Signal state, database connection files, cookies, tokens,
passwords, private keys, `dconf`, caches, logs, runtime sockets, generated state,
or Omarchy upgrade backups. Keep secret-bearing examples sanitized.
