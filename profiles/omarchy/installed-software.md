# Software audit — 2026-11-16

The manifest records explicitly installed personal software against the installed
Omarchy base and supplementary package lists. It deliberately does not turn the
whole pacman database into a restore requirement. `packages.txt` contains shared
requirements for the tracked configuration; `profiles/omarchy/packages.txt` adds
personal Omarchy applications. Packages already present should be left installed
without reinstalling or changing providers. Nothing should be removed by restore.

## Personal applications

The Omarchy manifest includes 1Password and its CLI, Brave, DBeaver, Kdenlive,
OBS Studio, Once, Codex desktop, Rainfrog, Signal, Spotify, Steam, Sunshine,
Synology Drive, T3 Code nightly, Tailscale, Typora, and Xournal++. It also records
explicit development tools, PostgreSQL, Rustup, compilers, language support,
fonts, and CLI utilities. Synology Drive is installed from outside the configured
pacman repositories and requires an AUR helper; it must not be sent blindly to
`pacman -S` together with repository packages.

`mise-bin` and `ttf-jetbrains-mono-nerd-basic` are the installed Omarchy providers.
Alacritty and Kitty have retained configurations but are currently absent; they
are optional and should not be installed solely because their configs exist.
Standalone Arch can use its own provider names for Mise and JetBrains Mono.

## Manual or machine-specific setup

- **Sabiql** is an installed foreign package without a configured repository
  candidate. Its installed package metadata identifies
  <https://github.com/riii111/sabiql>. Rebuild/install a reviewed package separately;
  do not guess that it exists in AUR or automatically execute a remote installer.
- **Smart-card support:** `ccid` and `pcsc-tools` are explicitly installed but
  hardware-related. Install only on machines that need the reader.
- **Firmware, GPU, boot and kernel packages:** Intel microcode, NVIDIA 580xx,
  firmware tools, Linux kernels/headers, bootloader tools, and related libraries
  stay under the target installation's hardware management.
- **Service state:** installing PostgreSQL, Tailscale, Sunshine, Synology Drive,
  Steam, or 1Password does not copy accounts, databases, pairing keys, library
  contents, firewall rules, remote routes, or enable services automatically.
  Configure those deliberately on the destination using supported tools.
- **Legacy applications:** Alacritty and Kitty can be installed independently
  if wanted. Their saved configuration remains available.

## Development tooling outside pacman

Omarchy now owns lazy Mise declarations for Node, UV, Playwright, Codex, Claude,
OpenCode, and other agent CLIs in `/etc/mise/conf.d`. Those system defaults are
not copied into this personal repository. The installed global npm packages
observed were `@anthropic-ai/claude-code`, `@openai/codex`, `@opencode/cli`,
`playwright`, and npm itself; no extra automatic global npm install is required
because they overlap those defaults. Avoid restoring version-specific Mise
installation paths or cached packages. Rust toolchains remain a separate
`rustup` setup step after installing the package.

Local launchers also exist for project-specific Schemii tools and workstation
session/streaming helpers. These are not pacman packages; their reviewed source
and portable entry points should be maintained separately from generated
launchers, session state, absolute project paths, and credentials. Desktop webapp
launchers likewise do not require copying browser profiles or account state.

## Re-auditing

Compare `pacman -Qqe` with `/usr/share/omarchy/install/omarchy-base.packages`
and `omarchy-other.packages`, then review every remaining item. The latter list
includes optional and hardware packages, not just mandatory desktop defaults.
Also account for provider names (`nvim` resolves to `neovim`) and migration-owned
packages such as `owe-lockfeed`, `omarchy-settings`, and `omarchy-keyring`.
`pacman -Qqm` identifies foreign packages; it is not proof of AUR availability.
