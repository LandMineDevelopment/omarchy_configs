"use strict";

const fs = require("node:fs");

// One tint layer beneath the UI. Changing alpha here never changes text opacity.
const css = `
html { background: color-mix(in srgb, var(--background, #000) 50%, transparent) !important; }
body, #root, .bg-background, .bg-chrome, .bg-sidebar {
  background-color: transparent !important;
  background-image: none !important;
}
/* Keep chat surfaces distinct with a tint, without covering the translucent root. */
[data-message-role="user"] .bg-message {
  background-color: color-mix(in srgb, var(--message-surface, var(--muted)) 20%, transparent) !important;
}
/* The app switches backdrop layers when banners attach. Reuse its alpha
   variable so nested composer surfaces do not accumulate a second tint. */
[data-slot="composer-shell"] {
  --glass-opacity: 20% !important;
}
[data-slot="composer-context-strip"]::before,
[data-composer-banner-surface]::before {
  background-image: none !important;
}

`;

exports.createWindow = function (electron, options) {
  const main = options.minWidth === 840 && options.minHeight === 620 &&
    options.autoHideMenuBar === true && options.webPreferences?.preload;
  if (!main) return new electron.BrowserWindow(options);
  const smoke = process.env.T3CODE_TRANSPARENCY_SMOKE;
  const win = new electron.BrowserWindow({
    ...options, transparent: true, backgroundColor: "#00000000",
    ...(smoke ? { show: false } : {}),
  });
  const nativeBackground = win.setBackgroundColor.bind(win);
  win.setBackgroundColor = () => nativeBackground("#00000000");
  if (smoke) {
    // Hidden native-window proof, isolated from the user's data and focus.
    win.show = () => {};
    win.showInactive = () => {};
    win.focus = () => {};
  }
  win.webContents.on("did-finish-load", async () => {
    try {
      await win.webContents.insertCSS(css, { cssOrigin: "user" });
      if (smoke) {
        const details = await win.webContents.executeJavaScript(`(() => {
          const text = document.createElement('p');
          text.textContent = 'Transparency smoke test: fully opaque text';
          text.style.cssText = 'color:white;font:24px monospace;position:fixed;top:120px;left:40px;z-index:99999';
          document.body.append(text);
          // Hidden fixtures exercise the real bubble/composer selectors.
          const probes = document.createElement('div');
          probes.innerHTML = '<div data-message-role="user" style="position:fixed;top:200px;left:40px"><div class="bg-message" style="width:300px;height:40px">Opaque message text</div></div><div data-slot="composer-shell" data-transparency-probe style="position:fixed;top:260px;left:40px;width:300px;height:40px">Opaque composer text</div>';
          const probeStyle = document.createElement('style');
          probeStyle.textContent = '[data-transparency-probe]::before {content:"";position:absolute;inset:0;z-index:-1;background:color-mix(in srgb,var(--chat-composer-glass-surface,var(--card)) var(--glass-opacity,100%),transparent)}';
          document.head.append(probeStyle);
          document.body.append(probes);
          const bubble = probes.querySelector('.bg-message');
          const composer = probes.querySelector('[data-slot="composer-shell"]');
          return {
            bubbleBackground: getComputedStyle(bubble).backgroundColor,
            bubbleOpacity: getComputedStyle(bubble).opacity,
            composerBackground: getComputedStyle(composer, '::before').backgroundColor,
            composerOpacity: getComputedStyle(composer).opacity,
            background: getComputedStyle(document.documentElement).backgroundColor,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            textOpacity: getComputedStyle(text).opacity,
            textColor: getComputedStyle(text).color,
            location: location.origin,
          };
        })()`);
        details.nativeBackground = win.getBackgroundColor();
        fs.writeFileSync(smoke + '.json', JSON.stringify(details, null, 2));
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(smoke + '.png', shot.toPNG());
      }
    } catch (error) {
      console.error("[local-transparency] Could not apply background style", error);
      if (smoke) fs.writeFileSync(smoke + '.error', String(error));
    }
  });
  return win;
};
