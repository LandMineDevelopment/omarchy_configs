# Omarchy media-aware Brave transparency

A persistent toolbar switch adapts web-page backgrounds to the active Ghostty canvas and supplies Hyprland transparency and blur. The intended result keeps text readable and media opaque across HTTP/HTTPS pages, the local New Tab override and trusted native browser interfaces. There are no hostname-specific appearance rules or per-tab activation steps.

**The installed version remains an experimental checkpoint.** Separately published DOM media rectangles cannot guarantee correct protection during browser motion. The [architecture review](ARCHITECTURE.md) records the confirmed ownership problem and its browser-owned replacement. More rectangle padding or timer tuning is not the next step.

**Current delivery boundary:** a Brave extension and Hyprland plugin, with normal
Brave and Omarchy updates preserved. The source-build experiment below is
parked. [Existing-project research](PLUGIN_RESEARCH.md) records the closest
implementations and the media/frame limitations still to solve.

## Two-plugin checkpoint — 2026-10-03

The bounded current-frame signal experiments did not meet the requested media,
text-edge and scale quality. They are not installed. [The recorded checks and
failures](PLUGIN_RESEARCH.md#bounded-two-plugin-paint-experiments--2026-10-03)
distinguish renderer/GLES evidence from the desktop verification blocked by the
lock screen. The global scrolling/flicker task remains unresolved.

The compositor's ABI rejection guard is installed on disk for the next plugin
load, with the previous binary retained for rollback. The live plugin and browser
were not reloaded. Native/extension source now preserves actionable update errors;
OFF or successful reconnection clears them. Relevant ABI/control, host and worker
tests passed. Normal Brave/Omarchy update settings and packages remain unchanged.

## Native replacement experiment paused — 2026-10-03

The native-alpha capability proof passed on an isolated actual desktop Brave window: clearing Chromium and Brave content underlays plus the native opaque hint preserved actual GPU alpha 0/128/255. A single declaration engine then retained opaque media while the desktop appeared through neutral page backgrounds. A real H.264 video and a recorded typing/mouse/scroll/select/zoom check were exercised; the sampled frames were stable. The check also exposed a separate Blink select-popup white backing, now being repaired at its source boundary.

The matching Brave 1.95.101 / Chromium 153.0.8010.37 source build is **paused**. This experiment modifies the browser, beyond the extension/Hyprland-plugin boundary the user has questioned. No compiler is running. The source contains one persisted global switch, one CSS engine, native chrome/menu canvas ownership and a read-only Omarchy palette provider. It removes ordinary-page media rectangles, shader color classification and asynchronous geometry handoffs. Its focus policy follows Ghostty without fading text or media; compiled-source runtime acceptance remains pending.

**This replacement is not installed.** The implementation boundary must be resolved before resuming the source build or installing it. The complete source build, native C++ tests and actual desktop verification of menus, WebUI, focus and browser/video fullscreen remain required for that route. The current Brave process/profile stays on 0.2.54. The diagnostic byte-edited binary is a private proof, not an installed runtime.

## Architecture and theme integration

The extension uses a locally bundled, modified Dark Reader 4.9.133 engine for CSS colors. The native host validates browser-window ownership and publishes media protection rectangles to the HyprWindowShade plugin. The fragment shader handles RGBX padding separately from real RGBA alpha, changes background pixels and subtle control boundaries; whole-window opacity stays at 1 so foreground and artwork do not fade. The bundled engine's changes and license are documented in `extension/vendor/README.darkreader.txt`.

The host follows `~/.local/state/omarchy/current/theme/colors.toml` and `ghostty.conf`: background, foreground, accent, selection and terminal opacity. Reads are cached and coherent; a missing or partially replaced theme retains the last valid palette. No Omarchy theme files, hooks or updater scripts are modified.

With the current Ghostty opacity of 0.5, Brave background alpha is **0.48265 focused** (`0.5 × 0.985 × 0.98`), **0.432 unfocused** (`0.5 × 0.96 × 0.90`), and **0.5 in true fullscreen**. Terminal opacity follows theme changes automatically; the matching Ghostty/desktop multipliers in `media-backgrounds.frag` must be refreshed if those desktop settings change. Native blur follows the compositor's blur settings in both focus states. The owned rule in `~/.config/hypr/looknfeel.lua` prevents Omarchy's whole-window opacity from also fading Brave's media.

New Tab is an extension-owned local page with one accessible search/address field. Web and local addresses open directly; other text uses labeled Brave Search. It has no remote widgets or photo dashboard. Newly opened tabs use the override automatically. Controller health checks its actual version and disposal state, rather than a palette-only response. A reported obsolete or disposed controller can request its own document-scoped refresh after synchronously saving the latest search draft, selection and focus in per-tab session storage. Navigation and global activation changes cancel recovery. Older native dashboards or legacy overrides that cannot report their input are preserved with an explicit unavailable status; they need a deliberate refresh after checking their input. Their virtual New Tab URL alone is insufficient authorization to discard a draft. Reloading the unpacked extension makes Brave replace existing virtual New Tab documents with its native dashboard. The saved draft remains in the original tab's extension-origin session storage. Plain refresh stays on the native dashboard; fresh navigation to `chrome://newtab/` in that same tab restores the draft and selection. Newly opened tabs use the override. Existing native dashboards are not automatically migrated because their current input cannot be inspected safely.

## Controls, updates and removal

```sh
brave-transparency on
brave-transparency off
brave-transparency status
brave-transparency remove
```

The toolbar state persists across browser restarts. ON enables page adaptation and the native effect; OFF restores connected page styles, clears protection masks and unloads the owned plugin. ERR identifies native bridge/configuration failure in the tooltip. The New Tab override remains installed while the extension is installed, including when transparency is OFF.

After changing extension files, reload this unpacked extension through Brave's Extensions UI. Existing ordinary pages are reinjected when enabled. Pages opened before the document-start canvas tracker was installed need a normal page reload to identify existing canvas contexts; until then, unknown canvases remain protected. Forms and active media are not reloaded automatically.

`remove` deletes this installation's native-host registration, CLI launchers, extension flag entries and implementation directory. Restart Brave afterward to unload its extension. Other extensions and unrelated flag entries are preserved. Removal does not change history, passwords or profile data.

The owned Brave opacity rule is a separate compositor setting. To restore the previous whole-window opacity behavior, remove only that commented Brave rule from `~/.config/hypr/looknfeel.lua` and reload Hyprland. The original file is available at `backups/looknfeel-before-brave.lua`; **copy that backup somewhere outside this directory before running `remove`**, which deletes the directory and its backup. Preserve later unrelated edits when restoring the rule.

Rewards is hidden through Brave's toolbar settings. The enabled `brave-shields-page-info` flag moves Shields into site information. It has been applied by the browser restart; future changes to that flag require a normal Brave restart.

## Media and lifecycle ownership

Images, video, large SVG artwork, painted canvases, CSS image artwork, iframe/object/embed content and explicit custom media receive protected rectangles. SVG artwork paint and authored `currentColor` are preserved. A narrow control-glyph exception can recolor a small, unnamed PNG or SVG descendant of a semantic control only after positive neutral-dark pixel/paint proof. Unknown, colored, animated or unreadable image artwork remains protected; image URLs and image-set layers are otherwise preserved without inversion or image analysis. Open shadow roots are discovered and their owned styles and attributes are cleaned up when detached.

Decorative page backgrounds can become the shared canvas. Wallpaper ownership requires structural and paint-order evidence rather than a hostname or image filename. If a previously decorative image becomes meaningful artwork, it stays hidden until the native compositor acknowledges a matching protection mask. Release checks include publication sequence, ownership token, viewport and clipped bounds. Each controller has unique ownership markers, so delayed cleanup from an old extension context cannot remove a replacement controller’s wallpaper or artwork protection. OFF restores authored background styles and attributes.

Controller replacement uses a shared document claim and synchronous retirement event, including while OFF. Retirement also stops the dependent content pipeline, heartbeat and queued geometry callbacks. A document replacement retires surviving JavaScript closures even when it removed DOM event listeners; ordinary claim detachment within the same document is repaired. Older pre-claim controllers are fenced at their reserved markers and semantic styles without rescanning or reloading page forms. Source provenance and authored edits survive batched stale overwrites. This narrow cleanup remains active while OFF and across successive replacements; detached shadow roots release their observers. Backdrop and glyph media exclusions require the currently matching marker rather than cached map membership alone.

A document-start MAIN-world tracker records native canvas context creation without changing its return values or exceptions. Only confirmed 2D canvases verified entirely transparent can be excluded, using one bounded pixel-read budget per snapshot. Readback follows visibility and clipped viewport checks, so hidden and offscreen canvases do not consume that budget. Blank results are recomputed for each snapshot because canvas drawing does not emit DOM mutations. Scroll handoff coverage can still protect an offscreen canvas's former position without probing its bitmap. Unknown, WebGL, tainted, painted and over-budget canvases stay protected. PDF MIME documents protect the whole viewport and bypass page color adaptation; a `.pdf` URL alone does not classify an HTML page as a PDF.

Video masks follow the intrinsic displayed frame, including supported object-fit/object-position and clipping. Browser-created pillarboxes and letterboxes can show the wallpaper; black bars encoded in a video remain part of the protected image. Unknown metadata or transforms preserve the whole element until reliable geometry is available.

Each browser window binds to a verified native lifetime identity. Publication checks class, title, dimensions and freshness; identical titles may coexist after binding. Ambiguous initial mapping fails closed. Navigation and geometry invalidation retain the physical identity, while window close forgets it. A reused native address cannot inherit a previous window's mask.

Each native connection also owns a random token in the existing per-session state file. One flock serializes token claims, OFF and every compositor mutation. A replacement revokes the previous masks before acknowledging its claim. Obsolete EOF/reset and late OFF cannot clear or unload the replacement; stale publications cannot change its masks or palette. Explicit CLI OFF remains unconditional for this installation.

Candidate discovery and geometry publication have separate ownership. Idle heartbeats refresh cached media geometry, visibility and occlusion. Each synchronous snapshot measures a shared node's bounds and scrollport client metrics once for media, clipping and UI refinement; the next snapshot discards that cache so silent layout changes remain measurable. Animation discovery and rescheduling share one enumeration within the same synchronous frame. Ordinary significant-text updates retain those candidate records and refresh geometry without scanning unrelated page styles. Empty-text transitions, stylesheet/script text, form defaults, SVG, automatic directionality, custom-element state and unknown mutation history retain full source discovery. Slots and shadow hosts participate in that decision. DOM/style/source changes, open shadow roots, interaction state and image-related animations trigger discovery where needed. Typing, clicks, menus and ordinary focus changes do not revoke valid masks. Scrolling coalesces events into one update before paint. Protection covers one observed movement step, clipped to ancestor scrollports, and returns to exact bounds once scrolling settles and the compositor has accepted the handoff. It no longer extrapolates three steps into surrounding canvas. Structural headers and navigation panels share an opaque source canvas, which the compositor renders translucently; this prevents media underneath a translucent header from tinting it. Colored actions/status indicators and artwork retain their meaning. Hover/selected controls use that same canvas, with subtle resting boundaries and distinct keyboard focus. Theme-owned colored canvases qualify for UI cutouts only with opaque, image-free paint.

Full and partial UI coverage share one paint-order pass, bounded by 64 proofs and 50 ms of hit testing; incomplete proofs retain media protection. Fresh geometry publishes before expensive semantic refreshes, and an already published frame is reused unless a subsequent source change needs discovery. Theme and content refreshes reuse an already current geometry sample, while later input still marks it dirty. Equivalent palettes do not republish styles or rescan the document; actual changes publish immutable fixes, including palette-owned selection colors. Fullscreen and resize require current geometry. Global toggle generations, per-window epochs and acknowledgment sequences reject obsolete asynchronous work. Native authorization follows the applied root surface content revision. Unchanged root pixels retain their accepted mask through polling delays; the first unacknowledged content change starts a 500 ms deadline, and continued repaints cannot extend it. A fresh accepted snapshot acknowledges the current revision. Window identity, title, size, surface lifetime and reset checks still revoke mismatches immediately.

Theme-engine cleanup does not remove controller-owned styles. Style reconciliation checks attachment as well as text, including upgrades from an older engine that still performs broad cleanup; detached roots and disabled controllers cannot revive sheets. This lets existing pages receive updates without reloading forms.

Ordinary and adopted source stylesheet watchers share one engine-local animation-frame runner. Count changes remain detectable the next frame, and declaration fingerprints retain the existing 200 ms cadence. Individual stop/restart and proxy takeover remove their own subscriptions; final unsubscribe cancels the pending frame. Destroyed adopted managers reject already queued updates. A failing watcher remains reported without stopping unrelated subscriptions.

Surface-commit listeners are explicitly disconnected when a mask is discarded, reset or replaced, even if another shared owner still retains that mask. Lua validation returns from owning C++ frames before raising a Lua error, so Lua's longjmp cannot bypass listener cleanup. The unload regression uses real Hyprutils signals, Lua rejection and dynamically unmapped plugin code.

Trusted `brave://` and `chrome://` Settings, Extensions, Flags, History, Downloads and Bookmarks pages use browser-provided URL/window metadata to authorize native rendering. They are not scripted or identified by a page title. Owned native menus and popups use the same effect. Native dashboards, DevTools and arbitrary internal origins do not receive this authorization.

## Practical limits and rebuilding

DOM masks and browser frames travel independently; there is no shared presentation identifier. Rapid motion can still briefly expose bands beside media, and the bounded handoff is a compromise, not frame-exact rendering. Stress recordings reproduce this remaining limitation; passing unit tests does not establish flicker-free scrolling. The render hook receives a flattened RGBX texture with no per-pixel semantic ownership, so a dark video pixel and a dark page-background pixel can be identical. A color key would collide with media colors; a page-painted sequence marker alone would not track compositor-thread scrolling of cached layers. Further timer or rectangle-envelope adjustments cannot provide a general guarantee.

The next architectural investigation is browser-produced alpha or a semantic mask committed with the same rendered frame. An isolated stock-Brave capability check can start with [CDP's default-background override](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDefaultBackgroundColorOverride), but must inspect the real Wayland buffer and desktop result: a transparent screenshot does not prove the browser window preserves alpha. No debugger permission or browser flag changes have been added for this investigation.

Iframe documents and native PDF viewers are protected as a whole. Painted or unidentified canvases can retain an opaque rectangle even when that includes their own background. Closed shadow roots, pseudo-element artwork, unusual transforms and excessive geometry are conservative limits. Native widget textures do not expose DOM media rectangles: neutral artwork inside a browser-native widget cannot receive the same precise media classification as an ordinary page. Unsupported geometry, or content changes left unacknowledged for more than 500 ms, restore native opacity rather than exposing unprotected page media. A fullscreen/resize transition can therefore briefly remain opaque while its new geometry is accepted.

The installed plugin targets Hyprland **0.56.2**, commit `efb50993780079460b0cbed1363e2166a2de1d9f`. The control handshake refuses a different compositor version. A Hyprland update requires reviewing affected hooks, building against matching headers and updating the verified commit guard before enabling again; changing the guard alone is not sufficient. The source derives from HyprWindowShade `a4c6b8af424a189072427c4c90ef2938e1b481d3`, with its original license in `plugin/LICENSE`.

```sh
brave-transparency off
pkg-config --modversion hyprland
make -C plugin
brave-transparency on
```

The Makefile uses the header tree selected by `pkg-config`; do not combine installed and hyprpm header trees. It builds to a temporary shared object and replaces the result atomically, with checks against symbols that would prevent unloading the old build. Shader files are read at plugin activation; OFF/ON reloads them.

## Current checkpoint — 2026-10-03 (0.2.54 applied)

Revisions 0.2.48–0.2.53 improved owned New Tab recovery, global OFF ordering, controller injection and source/discovery caching. Those changes did not solve frame synchronization. The idle finance measurement still averaged about 127 ms per geometry callback; helper measurements did not justify further speculative caching.

Revision 0.2.54 adds a confirmed safety correction: discovering a new shadow root may synchronously initialize its theme and change ancestor paint, so the geometry pass discards computed-style samples taken before that initialization. The regression checks the first mask and a later silent opacity change. This is not a claim that the general flicker issue is fixed.

Desktop Extensions UI confirmed the applied version. The existing light/dark fixture retained its draft and select choice after reload; its opaque SVG, image and shadow artwork and stationary fullscreen canvas were visually inspected. A PageDown capture still showed displaced opaque protection beside moving media, consistent with the unresolved frame handoff. The browser was not restarted and user forms were not reloaded.

All **335 JavaScript tests passed**, with extension syntax and manifest validation. The last **87 Python/native tests passed** on the unchanged native/plugin code. The architecture review exercised an isolated actual desktop Brave window twice, including a transparent-visual startup option: renderer alpha values 0/128/255 all reached the custom shader as opaque alpha. Calibration verified execution and valid RGBA input. No user browser restart, debugger permission or browser flag changes were involved.

The browser-owned page underlay is the next capability boundary. Current-source reading identifies Chromium's `ContentsWebView` opaque solid-color layer and embedded-view background, alongside native opaque-region handling. A browser-side proof must succeed before the rectangle pipeline is removed; no browser patch or replacement architecture is installed yet. See [ARCHITECTURE.md](ARCHITECTURE.md) for scope, evidence and acceptance criteria.

## Previous checkpoint — 2026-10-02 (0.2.47)

Applied revision **0.2.47** includes the stale semantic controller ownership repair prepared in 0.2.46. Modern controllers and their content pipelines retire before replacement source capture, including while OFF. Compatibility cleanup also covers the actually installed older 0.2.45 controller, successive replacements, stale marker rewrites and late teardown. Engine OFF cleanup now removes the leftover shadow inversion sheet. Desktop Extensions UI confirmed 0.2.47 after reload; the browser and user pages were not restarted or reloaded.

Desktop inspection caught and corrected two additional defects before this release: a short SVG in an open shadow root was recolored, and a font-only native shadow button retained its gray fill. SVG dimensions no longer grant a UI-glyph exemption. Authored currentColor is preserved for every SVG except positively proven semantic control glyphs; glyph proof reads authored styles in one synchronous scope, preventing successive refreshes from alternately classifying adapted ink as artwork. Shadow roots receive the engine's existing native control defaults beneath authored styles, including palette updates and OFF cleanup.

The focused real-Brave regression uses the frozen 0.2.45 controller in a separate isolated world that remains enabled and repeatedly refreshes. It checks painted wallpaper/structural canvases, authored SVG and image pixels, open shadow roots, shared control flags, preserved drafts/selections, OFF/source restoration, replacement while OFF, batched authored changes, claim detachment and document replacement/reinjection. An idle observation confirms zero marker/style mutation churn and zero additional semantic refreshes. Permanent regression sources remain in this installation; their temporary browser profiles are removed by the tests.

All **274 JavaScript tests and 86 Python/native tests passed**, along with extension syntax and manifest checks. The painted SVG/shadow regressions cover device scales 1, 1.484375 and 2.5, source restoration and repeated glyph refreshes. An actual desktop OFF/ON comparison retained all **192,782 sampled SVG/image pixels**, with maximum channel difference zero. Typed fixture drafts and the native select choice survived extension reload and OFF/ON. The final fixture check inspected the repaired shadow SVG and button, light/dark canvases, controls, a dialog and F11.

Actual desktop review also inspected every original tab in the two Brave windows: both mail tabs, logistics, jobs, finance, government and authentication pages, the PDF, YouTube, Monkeytype, ChatGPT and New Tab. Mail search options, the native browser menu, Settings/Appearance and a native Settings select were opened and inspected without submitting user forms or changing preferences. Native menu/Settings backgrounds remained translucent with readable controls. These observations do not establish correctness on every site or every animation frame.

**Remaining defects and limits:** rapid-scroll media bands remain unresolved because browser paint and separately published media rectangles do not share a presentation frame. First-activation captures on several tabs were blank or opaque before settling; longer checks showed translucent Fairfax and tax canvases with valid, accepted geometry. The cause and first-frame duration are not established. Existing New Tab initially stayed opaque, then became translucent after window resize and remained translucent at normal width; live diagnostics showed a ready controller, valid empty geometry and native acceptance. Source review found a separate New Tab reload-recovery gap: owned URLs bypass content reinjection, an independent palette receiver does not prove content-controller liveness, and migration guards last for a whole tab rather than a document. That gap has not been established as the cause of the observed opacity and has not been patched by an automatic page reload. Native PDF margins remain opaque because the closed guest viewer is protected as a whole. The Extensions error list still contains the careers page's invalid downloaded-font/OTS warnings; no new runtime ownership error was observed.

The next work should measure cold theme initialization and the first geometry/native receipt across activation, repair owned New Tab recovery with a document-level liveness contract that preserves input, and pursue media ownership synchronized with browser presentation. Further scroll timers or rectangle padding cannot guarantee correct rendering. No native/plugin, browser-permission or desktop configuration changes were made in this pass.

## Previous checkpoint — 2026-10-02 (0.2.45)

Applied revision **0.2.45** fixes native default form bevels at fractional output/browser scale. The classifier recognizes both 2 CSS pixels and the browser's physical-pixel-rounded equivalent, while preserving authored borders, dimensions, native appearance and select arrows. This is the only behavioral change since 0.2.44.

All **268 JavaScript tests and 86 Python/native tests passed**, along with extension syntax/manifest validation. An isolated Brave regression reproduces 1.61684px borders at DPR 1.85546875 and checks quiet border pixels, unchanged dimensions and retained authored edges. The extension was then reloaded through the actual desktop Extensions UI and confirmed as 0.2.45. Desktop verification inspected light/dark source panels, default and authored borders, typed input, keyboard-operated native selection and F11. The bright default bevels are gone; the test canvas remains translucent and the stationary dark image stays opaque.

The user requested another stopping point. **Rapid-scroll bands and stale-controller ownership after extension reload remain unresolved.** An unverified ownership-loss/migration-fence prototype was removed before release. The remaining repair must cover old inactive controllers, later stale marker writes, OFF, late old disposal, and transfer across successive new instances. A narrow fix for future instances alone does not repair orphaned older contexts already installed in existing tabs.

An isolated native stock-Brave alpha test applied a successful CDP transparent background override with transparent html/body. Its renderer screenshot contained 1,302,524 fully transparent pixels, but the actual desktop displayed an opaque white canvas. The Wayland root submitted alpha-capable ABGR8888 buffers while retaining a full-window opaque region. This narrows the problem to the native composition/window path; it does not identify the exact flattening stage. No debugger permission, browser flags or profile settings were added to the user's installation. The isolated process/profile and all temporary verification artifacts were removed.

## Previous checkpoint — 2026-10-02 (0.2.44)

Applied extension revision: **0.2.44**. The user requested a stopping point before the remaining defects were resolved. This is a working checkpoint, not a claim of complete visual correctness.

This pass fixes duplicate geometry work, lost dirty geometry scheduling, detached controller-owned styles after old-engine teardown, consistent structural canvas paint, subtler control boundaries and bounded scroll-mask expansion. The installed source passed **267 JavaScript tests and 86 Python/native tests**, plus extension JavaScript and manifest syntax checks. No native/plugin changes were made in this pass.

Actual desktop review covered mail, logistics, jobs, finance, government and authentication pages, the PDF tab, YouTube, Monkeytype, ChatGPT and New Tab. The final fixture check exercised typing, keyboard selection in a native dropdown and F11; the canvas remained translucent and stationary image content remained opaque. These checks do not establish correctness on every site or every animation frame.

Remaining confirmed defects:

- Rapid scrolling still produces brief bands around moving media. One-step protection reduces excess opaque canvas compared with three-step expansion, but DOM/native publication is not synchronized with browser presentation. Exact-current masks were tested and rejected because they exposed more moving media pixels.
- Extension takeover can leave an older semantic controller enabled after its engine loses ownership. Gmail showed a decorative-image marker from one controller while the sole attached hiding rule belonged to another. The next repair must retire the semantic controller on engine ownership loss and cover migration from already installed older instances; a site-specific override is not appropriate.
- Native default form bevels remain too bright at fractional browser scale. The live default 2 CSS-pixel border computed as **1.61684px** with devicePixelRatio **1.85546875**, so the exact-width classifier missed it. This requires scale-aware classification and desktop verification.

Temporary screenshots, recordings, private DOM probes, local fixture files/server and verification tabs are removed at this checkpoint. Permanent regression tests and configuration backups remain for maintenance.

## Verification

Run from this directory:

```sh
node --test test-*.mjs
python3 -m unittest discover -p 'test_*.py'
make -C plugin
```

Current JavaScript/source validation is recorded in the current checkpoint above. Native tests also cover real library load/unload, accepted/rejected publications and post-unload signal emissions. An isolated headless compositor could not initialize its backend on this machine; it is not counted as a passed compositor check. Native code was last built and exercised against the installed desktop compositor.

Historical desktop checks covered original mail, logistics, jobs, finance, government, authentication, PDF, video, typing and chat tabs; native Settings/menus, selects, dialogs, focus, hover, clicks, scrolling, browser/video fullscreen and OFF/ON. Stationary pixel comparisons and some recordings passed, but later rapid-scroll recordings reproduced bands around moving media. Those successful local checks do not establish universal visual correctness or frame-synchronized protection.

Source regressions and the configuration backup remain installed for future updates. Temporary captures, private diagnostics, fixtures and verification windows are removed after the review.
