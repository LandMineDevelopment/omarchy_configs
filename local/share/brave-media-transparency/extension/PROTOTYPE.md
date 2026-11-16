# Extension boundary

`background.js` owns the persistent global switch, theme distribution, active-tab geometry, and serialized native acknowledgement queue. Async transitions are token checked. Page styling remains enabled on background HTTP/HTTPS tabs; only selected tabs publish geometry. The exact owned New Tab page and native New Tab aliases use bundled scripts directly.

`theme.js` adapts CSS via a pinned local engine, protects large SVG authored colors, and owns root observers/styles. `canvas-context.js` records successful native context creation in MAIN world. `geometry.js` classifies and clips media without hostname rules. `content.js` publishes bounded geometry and forwards independent theme controls; its disposal removes owned listeners/observers/intervals.

Native messages contain title, browser dimensions, device scale, timestamp and rectangles only. Page URLs, markup, text and browsing history are not logged or sent to the host. The existing HTTP/HTTPS permission also permits bounded credential-free stylesheet-text fetches; no remote executable code is loaded. Cross-origin iframes are protected rather than restyled. See the parent README for controls, platform limits and verification.
