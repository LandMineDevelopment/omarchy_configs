# Custom setup and activation

These are source/configuration payloads, not a clone of the workstation's private state.
No browser profiles, authentication, agent histories, saved window sessions, databases,
AppImages, compiled compositor plugins, old backups, or private project services are included.

## Shell and idle behavior

`omarchy/shell.json` uses the reviewed `kasey.idle` service plugin and
`kasey.codex-weekly` bar widget. Both plugin sources are included. The weekly widget
reads the existing Omarchy agent-usage collector's state, never credentials.
After reviewing a restore on Omarchy, load new unit files and enable the collector:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-weekly-usage.timer
```

Codex must already be signed in on the destination. No account files are transferred.
The optional Owe theme-set hook refreshes an existing daemon through its local socket;
it does nothing when the daemon is absent.

## Workspace sessions and safe logout

The `sessions` component includes the locally modified GPL-licensed
[dataforxyz/omarchy-session](https://github.com/dataforxyz/omarchy-session) script,
source attribution, autosave watcher, local application restore helper, post-boot hook,
and logout/reboot/shutdown helper. Dependencies are Python 3.10+, Hyprland, UWSM,
libnotify and Omarchy. Terminal restoration additionally needs the relevant terminal.
The menu calls the helper through `$HOME` rather than a fixed username.

Load unit files with `systemctl --user daemon-reload`. The post-boot hook restores a
saved session before starting autosave; it does not enable a timer that could overwrite
the last session before restoration. A new installation has no session snapshot to
restore. Use `omarchy-session deps` and `omarchy-session --help` to inspect support.
No session is restored or window closed by bootstrap itself.

## Brave experimental transparency

The `brave-transparency` component archives the active extension 0.2.54 source,
its modified Dark Reader engine and license, Python native host/controller, shader,
C++ compositor plugin source and existing regression tests. The existing project
README and architecture notes document known media/scrolling limitations. This is an
experimental checkpoint, not a fully verified portable browser feature.

No compiled `.so`, private browser profile, native-host registration or running-plugin
state is transferred. Native host registration contains an absolute executable path
and must be generated for the destination user. The extension manifest's public key
is included to retain its origin identity; it is not a private key.

Build only against the destination's matching Hyprland headers using the included
`plugin/Makefile` (C++23 compiler, pkg-config, Hyprland development headers and
EGL/GLES/OpenGL libraries). Review ABI compatibility before loading. This capture has not built or loaded the plugin against the current compositor. Then inspect
`brave-transparency --help` and the project README for native-host registration and
activation. This repository never loads the compositor plugin or restarts Brave.
The browser flags reference the included extension source; effect activation requires
the native bridge and successfully built plugin.

The paused browser-source/native-alpha experiments and diagnostic probes are excluded;
they are not the installed runtime. The old Brave workaround rollback hook is archived
as `brave-wayland-autofix.reference`, not installed as an update hook, because its
unconditional launcher deletion can erase another custom browser launcher.

## T3 Code transparency

The current packaged T3 protocol handler is retained separately from the optional
AppImage transparency experiment. `t3code-transparent` invokes the reviewed source
payload and expects an independently installed official AppImage at
`~/.local/opt/t3code-nightly/T3-Code.AppImage`. The AppImage and extraction cache are
excluded. A local `t3code.desktop` entry selects this optional launcher; review or
select the `t3-transparency` component explicitly only when using that AppImage.
It is excluded from the default full restore to avoid installing an unusable launcher.

The patch is guarded by known upstream constructor signatures. Newer versions can
require source review. The launcher preserves the original AppImage and creates a
separate cached extraction. It does not patch the packaged `/usr/lib/t3code-nightly`
application. Existing local desktop files are preserved by bootstrap's default policy.
The optional source includes isolated Python/Node tests. No T3 process is restarted.

## Streaming and notifications

The `sunshine` component includes a brightness/idle helper and user-service cleanup
override. It depends on Sunshine, brightnessctl, jq and Omarchy. Display brightness is
hardware dependent. Wire its `start`/`stop` commands into Sunshine only after reviewing
the target machine; no Sunshine pairing, credentials or application-state JSON is copied.
The cleanup override uses systemd `%h` rather than a specific user's home.

`t3-agent-notify` is an optional CLI agent completion helper. It suppresses duplicate
alerts in T3-owned sessions and uses libnotify. Agent credential/configuration files
are excluded; integrate it with the destination agent's supported notification hooks.

## Deliberately separate

Primary Space is an independent theme repository. Generated active-theme state stays
outside this repository. Hardware drivers, Windows VM images and commands, Schemii
project launchers, Tailscale identity/routes, SSH keys, Sunshine pairing, private API
services, Kimi/agent accounts and browser data require separate installation or sign-in.
The old local T3 AppImage server unit and one-off cutover scripts are not portable
workstation services and are not restored.
