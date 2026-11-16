Local T3 Code background transparency

Launch normally from the T3 Code desktop icon. The custom launcher is
`/home/kasey/.local/bin/t3code-nightly`; the packaged `/usr/bin/t3code-nightly`
continues to open the stock package.

The official update target remains
`~/.local/opt/t3code-nightly/T3-Code.AppImage`. The launcher extracts a separate
cached copy and patches only its window rendering and protocol launch routing.
Normal launches retain the existing profile, histories, projects, authentication,
and repositories. Background opacity is 50%; text keeps its original opacity.

After an official update, the updater's immediate restart is stock. Quit T3 Code
and reopen from its desktop icon to rebuild the patched copy. If a future version
changes the guarded patch points, the launcher reports the incompatibility and
opens the official AppImage. Repair the patch in `launcher.py` and/or
`local-transparency.cjs`; the next launch detects those changes automatically.

To open the stock AppImage intentionally, first quit T3 and then run
`/home/kasey/.local/bin/t3code-nightly --stock`.

Verification: `python test_launcher.py` and `node --test test_window.cjs`.
`python smoke.py` starts a hidden isolated native test; `python smoke.py stop`
stops only its recorded PID. Results live in
`~/.cache/t3code-transparency/smoke-profile/render.json` and `render.png`.

Chat message bubbles and composer surfaces now use a 20% tint over the translucent base. Text remains at its original opacity. Composer banner layers reuse T3's glass-opacity variable to preserve its conditional layering and mode borders. Apply on next restart; no active sessions were restarted.
