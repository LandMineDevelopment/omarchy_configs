# Plugin-only feasibility and existing projects

Reviewed on 2026-10-03. Delivery is a Brave extension plus a Hyprland plugin.
The custom Brave source-build experiment is parked, not installed, and is not
part of this delivery. Brave's packaged executable, profile and updater remain
the normal installed ones. No package version pins or updater replacements are
authorized.

## Existing implementations

| Project | Relevant capability | Media and rendering boundary |
| --- | --- | --- |
| [SeaGlass](https://github.com/alexhulbert/SeaGlass#background-transparency) | Modified Dark Reader for Chromium/Brave plus Hyprchroma; theme synchronization through native messaging. | Its author explicitly warns that videos can look washed out. This is a close architectural precedent, not evidence of selective media preservation. |
| [Hyprchroma](https://github.com/alexhulbert/Hyprchroma) | Makes pixels similar to a configured background color translucent. | Its shader tests RGB proximity. It receives no page-element classification or media rectangles. [Shader source](https://raw.githubusercontent.com/alexhulbert/Hyprchroma/HEAD/src/TexturesDark.h). |
| [Hypr-DarkWindow](https://github.com/micha4w/Hypr-DarkWindow) | Per-window shaders, Lua configuration, explicit transparency/blur integration. | Its chromakey shader also applies a color comparison to each pixel. It does not distinguish a background pixel from an equal media pixel. [Shader source](https://raw.githubusercontent.com/micha4w/Hypr-DarkWindow/HEAD/src/PredefinedShaders.h). |
| [HyprWindowShade](https://github.com/ManofJELLO/HyprWindowShade) | Per-window texture shaders and fullscreen/focus handling. | This installation already uses a fork of it. Shader transport is available; browser semantic/frame correspondence is the unresolved part. |
| [Hyprglass](https://github.com/hyprnux/hyprglass#how-it-works) | Samples and blurs the content behind a window, then adds glass effects. | Its window decoration paints below an already transparent application surface. It does not make opaque Brave page pixels semantically transparent. |

These are project documentation and inspected shader sources. No third-party
plugin was installed, and none was run as a claimed fix during this review.
The inspected projects do not establish a general solution for unchanged media
on every site while scrolling.

## CSS work and desktop composition

Updating CSS only when its source changes is appropriate. Browser layout,
scrolling and visible repaint should remain browser-owned. The prepared single
declaration engine follows that boundary and can be reused without the custom
native browser APIs.

However, a transparent CSS background does not expose the desktop on the
inspected stock Brave path. Browser-owned content backdrops supply opaque paint
behind it. The recorded private stock-browser proof had renderer alpha 0/128/255
but an opaque root texture at the compositor. The private browser-patch proof
removed those native owners and preserved real alpha. This is evidence for why
a browser patch was investigated; it is not authorization to install it.

A chromakey shader avoids cross-process rectangle timing by working directly on
the current texture, but identical background/media colors are indistinguishable
to that shader. Choosing an unusual key reduces collisions; it cannot guarantee
that arbitrary media is unchanged. Moving DOM rectangles through a separate
native-message connection supplies semantics but does not prove that their
geometry belongs to the currently presented browser frame. Matching titles,
timestamps, native window lifetime or acknowledgment counters does not supply
that proof.

Any proposed plugin-only replacement must first establish this correspondence
in a bounded capability test. A requestAnimationFrame callback is not itself a
native presentation identifier. The existing mask path must not be described as
frame-synchronized merely because the compositor acknowledges its publication.

## Updates

[Hyprland's plugin documentation](https://wiki.hypr.land/Plugins/Using-Plugins/)
recommends `hyprpm` and building against matching Hyprland headers. Plugins reach
internal compositor APIs and are therefore version-sensitive.

The existing Python helper refuses to load its plugin when the running Hyprland
commit differs from the recorded build. The targeted 15 control tests passed,
including the mismatch/no-load case. Plugin-local host/client ABI validation is
now implemented as the first operation in `PLUGIN_INIT`, before handle
publication, mask initialization or hook lookup. Five focused tests cover 11
scenarios: a matching build, commit/dependency mismatches and unavailable hashes.
The complete plugin built successfully into a temporary shared object. Its
ABI-guarded build is now atomically installed for the **next plugin load**; the
running compositor plugin was not reloaded. The previous binary remains at
`plugin/HyprWindowShade.pre-abi-20261003.so` for rollback. Installed build SHA-256:
`88b4cf17d78e5a37898b24eda1e0c8831c24b6e516988a7f761b52c9299f6933`.
This is update safety, not a scrolling fix. Live load verification remains unrun.

The native host now recognizes the loader's ABI rejection and returns a fixed,
actionable rebuild reason. The extension retains it in the toolbar title instead
of replacing it with a generic failure. OFF and a new successful handshake clear
the old reason. Fifty-five native-host tests and 112 extension tests passed;
20 ABI/control tests passed separately. The running browser was not restarted
or reloaded, so its existing worker has not adopted the updated error handling.

The inspected Hyprland loader catches initialization exceptions and ejects the
module without calling its exit function. The new rejection boundary therefore
does not enter teardown paths that assume successful initialization. This was a
source review, not a live incompatible-plugin test.

The proposed legacy `--disable-threaded-scrolling` shortcut has no implementation
in the pinned Chromium source. A requestAnimationFrame revision stamp also does
not certify the protected rectangles: later page callbacks or layout observers
can move media before paint, compositor animations can change transforms, and
child frames have independent surface activation. That approach was rejected
during read-only feasibility review; no browser flag or prototype was installed.

Updates must not be blocked or pinned to retain this customization. Incompatible
plugin builds must remain unloaded while the normal browser and desktop keep
working. The compositor customization may require a compatible rebuild after a
Hyprland update; this is different from changing Brave's executable or updater.

## Bounded two-plugin paint experiments — 2026-10-03

A separate stock-Brave Wayland window used a disposable profile and an actual
loaded extension, with the prepared single CSS engine. HTTP/HTTPS/file pages
were globally enabled in that private extension; the user's browser was
untouched. The fixture contained neutral light/dark surfaces, controls, authored
images/canvas, a moving video, nested scrolling and a compositor animation.
Its renderer capture was 1185×1192 at effective DPR 1.484375. Actual desktop
capture showed the lock screen, so **visible desktop interaction was blocked**.
No replacement render shader was installed on the user's windows.

### Spatial carrier

The extension painted alternating four-CSS-pixel bands of RGB `(1,254,127)` and
`(3,250,131)` on the cleared page canvas. A real GLES shader checked those colors
and their neighboring bands in the current texture, without geometry IPC.
Both plain color keying and the carrier detector were exercised. Measurement
rectangles were used only to compare output, never as shader inputs.

The carrier preserved measured dark artwork, solid key-colored media and the
captured moving-video region. However, it changed **64,296 of 78,584 pixels
(81.8%)** in media reproducing the carrier. Visual inspection of the actual
browser-derived GLES result showed tinted text/control edges and residual bands.
Half-pixel linear filtering left **23.96%** of a synthetic carrier opaque;
known antialiased white text differed by up to **234/255** from the desired RGBA.
Requiring more neighboring cells does not remove the media ambiguity.

### Exact-black reservation

A second bounded GLES experiment reserved exact black for the page canvas and
modeled a media RGB transfer `254/255 * RGB + 1/255` before composition. It must
use sRGB interpolation; SVG filters defaulting to linear RGB distort dark media.
Opaque black/dark/color media interiors remained opaque across 20 scale/filter
cases, with no more than one byte of RGB error. This removes green edge tint.

It still fails general authored-alpha behavior. Partly covered black media can
round back to the reserved black; measured alpha becomes 127 instead of 160, or
255 instead of 192. Crossing this threshold can produce edge flicker. Text alpha
also remains flattened, differing by up to 127 steps. Existing author filters,
CSS background-image layers, other media paint paths and native menus/chrome have
not been covered by a general encoding implementation. A desktop extension
filter injection was attempted, but the locked display prevented a new capture;
it is **not** claimed as a browser/native pass.

Thirteen probe checks passed by verifying both harness behavior and these
explicit failures. They are not transparency acceptance passes. Eight focused
CSS policy/renderer checks passed independently; those demonstrate browser
declaration ownership, not native window alpha.

Neither candidate is installed as a replacement or described as finished. The
disposable browser exited, its temporary profile/extension were removed, and
generated working captures/results were cleaned. Reproduction sources and
compact measurement reports are retained under `plugin-probe/`; those files are
not shipped in the production extension or compositor binary. The browser-painted
wallpaper alternative was not verified and has not been installed.
