/* Local New Tab: navigation only; page geometry stays owned by content.js. */
(() => {
  const searchURL = query => {
    const url = new URL('https://search.brave.com/search');
    url.searchParams.set('q', query);
    return url.href;
  };
  function destination(value) {
    const text = String(value).trim();
    if (!text) return null;
    if (/^https?:/i.test(text)) {
      try {
        const url = new URL(text);
        if (url.hostname && (url.protocol === 'https:' || url.protocol === 'http:')) return url.href;
      } catch {}
      return searchURL(text);
    }
    if (!/\s/.test(text)) {
      try {
        const host = text.split(/[/?#]/, 1)[0];
        const url = new URL(`https://${text}`);
        const domain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/i.test(url.hostname);
        if (!url.username && !url.password &&
            (host.includes('.') || /^localhost(?::\d+)?$/i.test(host) || host.startsWith('[')) &&
            (domain || url.hostname === 'localhost' || url.hostname.startsWith('['))) {
          if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
              url.hostname === '127.0.0.1' || url.hostname === '[::1]') url.protocol = 'http:';
          return url.href;
        }
      } catch {}
    }
    return searchURL(text);
  }
  globalThis.NewTabNavigation = Object.freeze({ destination });

  const form = document.getElementById('navigation');
  const input = document.getElementById('destination');
  const documentToken = crypto.randomUUID();
  const draftKey = 'brave-media-newtab-draft-v1';
  let navigating = false, recovering = false, draftSaved = false;
  function saveDraft() {
    // Unload blur/selection events must not overwrite the recovery snapshot.
    if (navigating || recovering) return draftSaved;
    try {
      const draft = JSON.stringify({value:input.value,start:input.selectionStart,end:input.selectionEnd,
        direction:input.selectionDirection,focused:document.activeElement === input});
      if (sessionStorage.getItem(draftKey) !== draft) sessionStorage.setItem(draftKey, draft);
      draftSaved = sessionStorage.getItem(draftKey) === draft;
    } catch { draftSaved = false; }
    return draftSaved;
  }
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (input.value === '' && typeof draft?.value === 'string' && Number.isSafeInteger(draft.start) &&
        Number.isSafeInteger(draft.end) && draft.start >= 0 && draft.end >= draft.start &&
        draft.end <= draft.value.length && ['none','forward','backward'].includes(draft.direction) &&
        typeof draft.focused === 'boolean') {
      input.value = draft.value;
      if (draft.focused) input.focus();
      input.setSelectionRange(draft.start, draft.end, draft.direction);
    }
  } catch {} // Storage restrictions never replace input that is already present.
  // These DOM/storage listeners survive extension API invalidation. A later
  // user refresh can still restore their latest per-tab draft and selection.
  for (const event of ['input','select','focus','blur']) input.addEventListener(event, saveDraft);
  globalThis.addEventListener('beforeunload', () => { navigating = true; });
  function controllerState() {
    const controller = globalThis.__braveMediaTransparency;
    let disposed = true;
    try { disposed = controller?.isDisposed?.() !== false; } catch {}
    return {version:typeof controller?.version === 'string' ? controller.version : null,disposed};
  }
  function report() {
    return {newtab:true,contract:1,url:location.href,document:documentToken,
      controller:controllerState(),navigating,draftSaved:saveDraft()};
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const url = destination(input.value);
    if (url) {
      navigating = true;
      location.assign(url);
      try { sessionStorage.removeItem(draftKey);draftSaved = false; } catch {}
    }
    else input.focus();
  });

  const paletteProperties = {
    background: 'background-color',
    foreground: '--foreground', accent: '--accent',
    selection: '--selection', selectionForeground: '--selection-foreground',
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'media-newtab-status-v1') {
      sendResponse(report());
      return;
    }
    if (message?.type === 'media-newtab-recover-v1') {
      const state = report();
      const healthy = state.controller.version === message.version && !state.controller.disposed;
      if (message.document !== documentToken || navigating || recovering || !state.draftSaved || healthy) {
        sendResponse({...state,reloading:false,reason:healthy ? 'controller is current' :
          message.document !== documentToken ? 'document changed' : navigating ? 'navigation is in progress' :
          recovering ? 'refresh already requested' : 'search draft could not be saved'});
        return;
      }
      recovering = true;
      sendResponse({...state,reloading:true});
      location.reload();
      return;
    }
    if (message?.type !== 'media-theme-v1' || !message.palette) return;
    for (const [key, property] of Object.entries(paletteProperties)) {
      const value = message.palette[key];
      if (typeof value === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) &&
          document.documentElement.style.getPropertyValue(property) !== value)
        document.documentElement.style.setProperty(property, value);
    }
  });
})();
