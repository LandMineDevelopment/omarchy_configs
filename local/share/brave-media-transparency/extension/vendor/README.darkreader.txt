Dark Reader 4.9.133, MIT; bundled locally, no remote executable code.
Source: https://registry.npmjs.org/darkreader/-/darkreader-4.9.133.tgz
Verified npm SHA512 integrity:
sha512-d3dRGpVgoBnMXl9qfnTuRvrdtO/9e6puFbsDwxfycTwbRNFI+sNX+093h6qnNo4VosyHHUaIXyunDWvbEudTRQ==
Local audited changes (search "Brave media policy"):
1. _modifyBackgroundColor maps neutral RGB fills (channel spread <=12)
   to the configured dark canvas, retaining authored alpha.
2. getModifiableCSSDeclaration skips SVG artwork paint properties including
   fill/stroke/stop-color, including variable-driven declarations.
3. No disableConflictingPlugins call: do not change authored WordPress theme state.
Controller configuration disables all image analysis and inline SVG processing.
SVG inherited color is protected by extension/theme.js owned CSS, except for
positively proven semantic control glyphs. Glyph proof reads authored styling.
4. Ignored background image declarations split at top-level commas: URL and
   image-set layers stay exact; upstream gradient modification adapts color stops.
Limit: authored color animation inside protected SVG requires a refresh.
Do not update this dependency without reapplying and testing these boundaries.
5. The website API messaging shim uses a factory-local chrome runtime object;
   it never patches global chrome.runtime, native sendMessage or onMessage.
6. registerShadowRoot registers controller-discovered late open roots with
   upstream CSS managers, root observers, adopted sheets and inline adaptation.
7. createStaticStyleOverrides inserts the inline proxy script only when at
   least one proxy is enabled. Controller disables both proxies; extension
   discovery owns late open-root registration without executable DOM injection.
8. Neutral foreground has a minimum 0.72 HSL lightness and opaque nonzero
   color alpha; fully transparent colors stay hidden. Neutral borders retain
   at least 0.45 lightness. No element/media opacity is modified.
9. PDF special inversion is disabled: no PDF overlay, pixel filter or adopted
   inversion stylesheet. Document paint remains unchanged.
10. On a bundle revision upgrade, retire the old controller and enabled engine
    before replacing the global API. Same revision injections remain idempotent.
11. DOM-ready shadow-host scan treats absent document.body as an empty child
    list. Normal document tree observation handles a body inserted later.
12. Near-neutral text-shadow colors (RGB spread <=24) follow the configured
    dark canvas while retaining authored alpha and shadow geometry. Chromatic
    effects and all box-shadow colors continue through upstream processing.
    Text-shadow custom properties have their own upstream variable type, aliases
    and root declarations; colors shared with background/foreground remain
    independently adapted. Unparsed shadow terms retain their complete geometry.
13. A replacement engine claims its instance marker before creating theme styles.
    Retired isolated contexts stop local observers without deleting shared DOM
    owned by a newer marker. Controllers capture their engine and dispose once.
14. Engine opt-out/interception checks recognize only lifecycle locks carrying
    data-brave-media-lock. Authored darkreader-lock markers stay untouched and do
    not override the user's global ON preference. Interception retains the
    universal marker name so older engine versions can relinquish ownership.
15. Dynamic initialization checks current document.hidden as well as its cached
    visibility history. A bundle injected while hidden cannot defer a now-visible
    page indefinitely awaiting a past event. Visibility callbacks establish their
    visible state before rendering/loading readiness decisions.
    A same-palette enable also completes previously deferred dynamic styles when
    the document is now visible, before taking the palette-only shortcut. Explicit
    initialization state resets with engine teardown; no polling/retry is added.
    completeInitialization exposes that guarded continuation independently of
    palette publication, so unchanged controller activation avoids recomputation.
16. Existing authored stylesheet watchers also detect same-count CSSOM edits,
    imported rules and adopted sheets through cached 200 ms CSS-rule fingerprints.
    A private coalesced onSourceChange subscription informs media discovery and
    semantic theming; generated overrides never notify this source boundary.
    This adds no DOM/layout polling or MAIN-world prototype wrappers.
17. Engine teardown excludes styles carrying data-brave-media-theme-style;
    the semantic controller owns their lifetime. The controller also reconciles
    stylesheet attachment after takeover from older engines that still remove
    all .darkreader sheets. Same CSS text alone is not proof of a live style.
18. Shadow-root teardown also removes darkreader--invert, alongside inline and
    override sheets. OFF must not leave a generated static style behind.
19. Open shadow roots receive the same user-agent control defaults as the
    document, without a document canvas rule. Defaults remain in the UA layer
    below authored component styles, update with the palette, participate in
    delayed static-style restoration and are removed on OFF.
20. Ordinary and adopted source stylesheet watchers share one factory-local
    animation-frame runner. Individual subscriptions retain immediate count
    checks and the existing 200 ms declaration fingerprints. Stop/restart,
    proxy takeover and final unsubscribe cancel obsolete frames; destroyed
    adopted managers also reject already queued microtasks. An unexpected
    watcher failure is reported and retires that watcher without stopping
    other subscriptions.
