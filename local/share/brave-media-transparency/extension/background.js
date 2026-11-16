import './geometry.js';
let enabled = false;
let ready = false;
let port = null;
let queue = [];
let transition = 0;
let diagnosticWindowId = null;
let globalStatusReason = 'disabled';
const windowStates = new Map();
const themedTabs = new Set();
let themePalette = null;
const pageScripts = ['geometry.js', 'media.js', 'vendor/darkreader.js', 'theme.js', 'content.js'];
const ownedNewTab = chrome.runtime.getURL('newtab.html');
const isNativeNewTab = url => ['chrome://newtab', 'chrome://newtab/', 'brave://newtab', 'brave://newtab/'].includes(url);
const isOwnedNewTab = url => url === ownedNewTab || isNativeNewTab(url);
// Recovery belongs to an owned document, not the lifetime of its browser tab.
const newTabRecoveries = new Map();
const isSupportedPage = url => /^https?:/.test(url || '') || isOwnedNewTab(url);
function isTrustedNativeUI(value) {
  try {
    const url = new URL(value);
    return ['chrome:', 'brave:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
      ['settings', 'extensions', 'flags', 'history', 'downloads', 'bookmarks'].includes(url.hostname);
  } catch { return false; }
}
async function loadPage(tab) {
  if (isOwnedNewTab(tab.url)) return ensureNewTabController(tab);
  const tabId = tab.id;
  await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['canvas-context.js'],injectImmediately:true});
  await chrome.scripting.executeScript({target:{tabId},files:pageScripts,injectImmediately:true});
}
function newTabUnavailable(reason) {
  return new Error(`New Tab unavailable: ${reason}`);
}
function newTabReport(report) {
  return report?.newtab === true && report.contract === 1 && report.url === ownedNewTab &&
    typeof report.document === 'string' && report.document.length > 0 && report.document.length <= 128;
}
function currentNewTabController(report) {
  return newTabReport(report) && report.controller?.version === chrome.runtime.getManifest().version &&
    report.controller.disposed === false;
}
async function ensureNewTabController(tab) {
  const generation = transition;
  let report;
  try { report = await chrome.tabs.sendMessage(tab.id, {type:'media-newtab-status-v1'}); }
  catch { throw newTabUnavailable('controller cannot report its search draft; existing input was preserved'); }
  if (!enabled || !ready || generation !== transition) throw newTabUnavailable('activation changed');
  // The old {newtab:true} palette reply proves neither geometry health nor
  // draft preservation. Never refresh an unreported legacy/native document.
  if (!newTabReport(report)) throw newTabUnavailable('controller cannot report its search draft; existing input was preserved');
  if (report.navigating) throw newTabUnavailable('navigation is in progress');
  if (currentNewTabController(report)) return;
  if (report.draftSaved !== true) throw newTabUnavailable('search draft could not be saved; existing input was preserved');
  const previous = newTabRecoveries.get(tab.id);
  if (previous?.document === report.document && (previous.attempted || previous.generation === generation))
    return previous.promise;
  const operation = {document:report.document,generation,attempted:false,promise:null};
  newTabRecoveries.set(tab.id, operation);
  operation.promise = (async () => {
    try {
      const current = await chrome.tabs.get(tab.id);
      if (!enabled || !ready || generation !== transition || newTabRecoveries.get(tab.id) !== operation)
        throw newTabUnavailable('activation changed');
      if (current?.status !== 'complete' || current.pendingUrl || !isOwnedNewTab(current.url))
        throw newTabUnavailable('navigation is in progress');
      // The owning page verifies its document token and saves the latest input
      // synchronously before its own refresh. No API can inspect legacy drafts
      // with our existing grants, and tab-wide reload would race navigation.
      operation.attempted = true;
      const result = await chrome.tabs.sendMessage(tab.id, {
        type:'media-newtab-recover-v1', document:report.document,
        version:chrome.runtime.getManifest().version,
      });
      if (currentNewTabController(result) && result.document === report.document && !result.reloading && !result.navigating) {
        operation.attempted = false;
        return;
      }
      if (!newTabReport(result) || result.document !== report.document)
        throw newTabUnavailable('document changed before recovery; existing input was preserved');
      if (result.reloading === true) throw newTabUnavailable('refreshing the saved search draft; awaiting current controller');
      operation.attempted = false;
      throw newTabUnavailable(`${result.reason || 'refresh was cancelled'}; existing input was preserved`);
    } finally {
      if (!operation.attempted && newTabRecoveries.get(tab.id) === operation) newTabRecoveries.delete(tab.id);
    }
  })();
  return operation.promise;
}
async function themeTab(tab, inject = false) {
  if (!enabled || !ready || !tab?.id || !isSupportedPage(tab.url)) return;
  const token = transition;
  try {
    if (inject) await loadPage(tab);
    if (!enabled || !ready || token !== transition) return;
    themedTabs.add(tab.id);
    await chrome.tabs.sendMessage(tab.id, {type:'media-theme-v1', enabled:true, palette:themePalette});
  } catch (error) {
    const state = windowStates.get(tab.windowId);
    if (isOwnedNewTab(tab.url) && enabled && ready && token === transition && state?.tabId === tab.id)
      pageStatus(state, error.message);
  }
}
async function themeAllTabs() {
  const token = transition;
  const tabs = await chrome.tabs.query({});
  if (!enabled || !ready || token !== transition) return;
  await Promise.allSettled(tabs.map(tab => themeTab(tab, true)));
}
async function disableThemes() {
  const tabs = [...themedTabs];
  themedTabs.clear();
  await Promise.allSettled(tabs.map(tabId => chrome.tabs.sendMessage(tabId, {type:'media-theme-v1', enabled:false})));
}
function updatePalette(palette) {
  if (!palette || JSON.stringify(themePalette) === JSON.stringify(palette)) return;
  themePalette = palette;
  if (enabled && ready) for (const tabId of themedTabs)
    void chrome.tabs.sendMessage(tabId, {type:'media-theme-v1', enabled:true, palette}).catch(() => {});
}
// Insertion order makes the shared native port fair to each visible window.
// Frequent updates replace that window's pending sample without moving its turn.
const pendingWindows = new Set();
function stateFor(windowId) {
  if (!windowStates.has(windowId)) windowStates.set(windowId, {
    windowId, tabId: null, nativeUI: false, epoch: 0, lastSequence: 0, pending: null,
    acceptedGeometry: null, statusReason: 'awaiting page geometry',
    lastSample: null, lastNormalization: null, lastNativeResult: null, publications: []
  });
  return windowStates.get(windowId);
}
function publicationFor(state, sequence, capturedAt, kind = 'snapshot') {
  // Bounded timing metadata only: never retain page titles, URLs or media boxes.
  const publication = { kind, epoch: state.epoch, sequence,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : null,
    receivedAt: Date.now(), metadataReadyAt: null, nativePostedAt: null, nativeReplyAt: null,
    finishedAt: null, outcome: 'metadata-pending', accepted: null, error: null, obsolete: false };
  state.publications.push(publication);
  if (state.publications.length > 64) state.publications.shift();
  return publication;
}
function finishPublication(publication, outcome, { accepted = null, error = null, obsolete = false } = {}) {
  if (!publication) return;
  Object.assign(publication, { outcome, accepted, error, obsolete, finishedAt: Date.now() });
}
function diagnosticState() {
  return windowStates.get(diagnosticWindowId) || windowStates.values().next().value;
}
function updateTitle(error = false) {
  const reason = diagnosticState()?.statusReason || globalStatusReason;
  chrome.action.setTitle({ title: error ? `Transparency unavailable: ${reason.replace(/\.$/, '')}. Click to turn off.` : enabled ? `Transparency enabled globally: ${reason}. Click to turn off.` : 'Transparency disabled globally; click to turn on' });
}
function pageStatus(state, reason) {
  state.statusReason = reason;
  if (diagnosticState() === state) updateTitle();
}
function badge(error = false) {
  chrome.action.setBadgeText({ text: error ? 'ERR' : enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: error ? '#b13737' : enabled ? '#387946' : '#666666' });
  updateTitle(error);
}
function post(message, extra = {}) {
  if (!port) return false;
  try {
    queue.push({ message, transition, ...extra });
    if (extra.publication) {
      extra.publication.nativePostedAt = Date.now();
      extra.publication.outcome = 'native-pending';
    }
    port.postMessage(message); return true;
  }
  catch { fail(); return false; }
}
function fail(reason = 'native host unavailable') {
  transition++;
  const old = port;
  ready = false;
  port = null;
  try { old?.disconnect(); } catch {}
  for (const item of queue) finishPublication(item.publication, 'native-channel-closed');
  queue = [];
  pendingWindows.clear();
  for (const state of windowStates.values()) {
    finishPublication(state.pending?.publication, 'native-channel-closed');
    state.pending = null; state.acceptedGeometry = null; state.epoch++;
    state.statusReason = reason;
  }
  globalStatusReason = reason;
  void disableThemes();
  badge(enabled);
}
function invalidate(windowId, reason) {
  const affected = windowId === undefined ? windowStates.values() : [windowStates.get(windowId)].filter(Boolean);
  for (const state of affected) {
    finishPublication(state.pending?.publication, 'invalidated', { obsolete: true });
    state.pending = null; state.acceptedGeometry = null;
    pendingWindows.delete(state.windowId);
  }
  const covered = queue.some(item => item.message.type === 'invalidate' &&
    (item.message.windowId === undefined || item.message.windowId === windowId) &&
    // Scoped geometry resets retain physical identity. They cannot subsume a
    // later permanent-close reset, even while sharing the same native queue.
    (reason !== 'window-closed' || item.message.windowId === undefined || item.message.reason === 'window-closed'));
  if (!covered) post(windowId === undefined ? { type: 'invalidate', reason } : { type: 'invalidate', windowId, reason });
}
function flush() {
  if (!ready || queue.length) return;
  for (const windowId of pendingWindows) {
    pendingWindows.delete(windowId);
    const state = windowStates.get(windowId);
    const item = state?.pending;
    if (!item) continue;
    state.pending = null;
    if (Date.now() - item.message.capturedAt > 200) {
      finishPublication(item.publication, 'expired-before-native');
      pageStatus(state, 'page snapshot expired before native delivery');
      continue;
    }
    post(item.message, { geometry: item.geometry, sequence: item.sequence, publication: item.publication, owner: state, epoch: state.epoch, tabId: state.tabId, windowId });
    return;
  }
}
function connect() {
  if (port) return;
  try {
    const connected = chrome.runtime.connectNative('local.brave_media_transparency');
    port = connected;
    connected.onMessage.addListener(response => {
      if (port !== connected) return;
      const ack = queue.shift();
      if (ack?.publication) {
        ack.publication.nativeReplyAt = Date.now();
        const state = windowStates.get(ack.windowId);
        finishPublication(ack.publication, response.accepted ? 'native-accepted' : 'native-rejected', {
          accepted: !!response.accepted, error: response.error || null,
          obsolete: ack.transition !== transition || state !== ack.owner || ack.epoch !== state?.epoch ||
            ack.tabId !== state?.tabId || ack.sequence !== state?.lastSequence,
        });
      }
      // Replies from an earlier global toggle may finish after a new one.
      // They cannot change readiness, restore themes or disable the new owner.
      if (ack && ack.transition !== transition) { flush(); return; }
      if (response.accepted && response.palette) updatePalette(response.palette);
      if (response.error === 'disabled' && enabled) { void setEnabled(false); return; }
      if (ack?.message.type === 'configure') {
        ready = !!response.accepted && enabled && ack.message.enabled;
        if (enabled && ack.message.enabled && !response.accepted)
          return fail(typeof response.detail === 'string' && response.detail.trim() ? response.detail.trim() : undefined);
        globalStatusReason = ready ? 'awaiting visible page geometry' : 'disabled';
        badge();
        if (ready) { void themeAllTabs(); void activateAll(); }
        if (!enabled && !ack.message.enabled) {
          port = null; queue = []; pendingWindows.clear();
          try { connected.disconnect(); } catch {}
        }
      } else if (ack?.message.type === 'snapshot' || ack?.message.type === 'native-ui') {
        const state = windowStates.get(ack.windowId);
        if (state) state.lastNativeResult = { ...ack.publication, accepted: !!response.accepted, error: response.error || null, at: Date.now() };
        if (state && ack.epoch === state.epoch && ack.tabId === state.tabId && enabled && ready) {
          const invalidationPending = queue.some(item => item.message.type === 'invalidate' &&
            (item.message.windowId === undefined || item.message.windowId === state.windowId));
          state.acceptedGeometry = response.accepted && !invalidationPending ? ack.geometry : null;
          pageStatus(state, state.acceptedGeometry ? 'media protection active' : response.accepted ? 'page geometry updating' : `media protection unavailable (${response.error || 'snapshot rejected'})`);
          // A newly revealed backdrop must already be protected by the native
          // compositor. Acknowledge only the exact latest page publication;
          // obsolete replies cannot release artwork after navigation or OFF.
          if (response.accepted === true && !invalidationPending && ack.message.type === 'snapshot' &&
              ack.owner === state && !state.nativeUI && Number.isSafeInteger(ack.sequence) &&
              ack.sequence === state.lastSequence) {
            void chrome.tabs.sendMessage(ack.tabId, {type:'media-geometry-accepted', sequence:ack.sequence}).catch(() => {});
          }
        }
      }
      flush();
    });
    connected.onDisconnect.addListener(() => { if (port !== connected) return; void chrome.runtime.lastError; fail(); });
    post({ type: 'configure', enabled });
  } catch { fail(); }
}
async function deactivateWindow(windowId, reason, { remove = false, invalidateMask = true } = {}) {
  const state = windowStates.get(windowId);
  if (!state) return;
  state.epoch++;
  pageStatus(state, enabled ? `page protection inactive (${reason})` : 'disabled');
  state.lastSample = null; state.lastNormalization = null;
  if (invalidateMask) invalidate(windowId, reason);
  else { finishPublication(state.pending?.publication, 'invalidated', { obsolete: true }); state.pending = null; state.acceptedGeometry = null; pendingWindows.delete(windowId); }
  const previous = state.tabId;
  state.tabId = null;
  state.nativeUI = false;
  if (previous !== null) await chrome.tabs.sendMessage(previous, { type: 'media-set-enabled-v2', enabled: false }).catch(() => {});
  if (remove && windowStates.get(windowId) === state) windowStates.delete(windowId);
}
async function activate(tab) {
  if (!enabled || !ready || !tab?.id || !tab.active || !Number.isSafeInteger(tab.windowId) || tab.windowId <= 0) return;
  const state = stateFor(tab.windowId);
  if (!isSupportedPage(tab.url) && !isTrustedNativeUI(tab.url)) {
    await deactivateWindow(tab.windowId, 'unsupported-page');
    pageStatus(state, 'this page is unsupported (web pages or the owned New Tab required)');
    return;
  }
  const requestedEpoch = state.epoch;
  let token = requestedEpoch;
  try {
    const [window, currentTab] = await Promise.all([chrome.windows.get(tab.windowId), chrome.tabs.get(tab.id)]);
    if (!enabled || !ready || state.epoch !== requestedEpoch || windowStates.get(tab.windowId) !== state || !currentTab.active || currentTab.windowId !== tab.windowId) return;
    if (window.state === 'minimized' || (window.type && window.type !== 'normal')) {
      await deactivateWindow(tab.windowId, window.state || 'unsupported-window');
      pageStatus(state, `${window.state || 'unsupported'} window remains opaque`);
      return;
    }
    if (state.tabId !== tab.id) {
      const transitionEpoch = state.epoch + 1;
      await deactivateWindow(tab.windowId, 'active-tab-changed');
      if (!enabled || !ready || state.epoch !== transitionEpoch || windowStates.get(tab.windowId) !== state) return;
      state.tabId = tab.id;
      state.lastSequence = 0;
    }
    token = state.epoch;
    state.nativeUI = isTrustedNativeUI(currentTab.url);
    if (state.nativeUI) { await publishNativeUI(state); return; }
    pageStatus(state, 'activating current page; awaiting media geometry');
    await loadPage(tab);
    const zoom = await chrome.tabs.getZoom(tab.id);
    if (token !== state.epoch || !enabled || !ready || windowStates.get(tab.windowId) !== state) return;
    await themeTab(tab);
    if (token !== state.epoch || !enabled || !ready || windowStates.get(tab.windowId) !== state) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'media-set-enabled-v2', enabled: true, zoom });
  } catch (error) {
    if (!enabled || !ready || token !== state.epoch || windowStates.get(tab.windowId) !== state) return;
    pageStatus(state, isOwnedNewTab(tab.url) ? error.message : 'current page unavailable: content script could not activate');
    invalidate(tab.windowId, 'page-unavailable');
  }
}
async function publishNativeUI(state) {
  if (!enabled || !ready || !state.nativeUI || state.tabId === null) return;
  const token = state.epoch, generation = transition, tabId = state.tabId;
  const sequence = ++state.lastSequence;
  const publication = publicationFor(state, sequence, null, 'native-ui');
  try {
    const [tab, window] = await Promise.all([chrome.tabs.get(tabId), chrome.windows.get(state.windowId)]);
    publication.metadataReadyAt = Date.now();
    if (!enabled || !ready || generation !== transition || token !== state.epoch || sequence !== state.lastSequence ||
        windowStates.get(state.windowId) !== state || state.tabId !== tabId) {
      finishPublication(publication, 'superseded', { obsolete: true }); return;
    }
    if (!tab.active || tab.windowId !== state.windowId || !isTrustedNativeUI(tab.url) ||
        window.state === 'minimized' || (window.type && window.type !== 'normal')) {
      finishPublication(publication, 'owner-unavailable');
      await deactivateWindow(state.windowId, 'native-ui-changed'); return;
    }
    publication.capturedAt = Date.now();
    finishPublication(state.pending?.publication, 'superseded', { obsolete: true });
    publication.outcome = 'pending-native';
    state.pending = {geometry: `native-ui:${tab.url}`, sequence, publication, message: {
      type:'native-ui', windowId:state.windowId, url:tab.url, title:tab.title || '',
      focused:!!window.focused, outerWidth:window.width, outerHeight:window.height, capturedAt:publication.capturedAt
    }};
    pendingWindows.add(state.windowId); flush();
  } catch {
    publication.metadataReadyAt ??= Date.now();
    finishPublication(publication, 'metadata-unavailable', { obsolete: generation !== transition || token !== state.epoch || sequence !== state.lastSequence || windowStates.get(state.windowId) !== state });
    if (generation === transition && token === state.epoch && sequence === state.lastSequence && windowStates.get(state.windowId) === state)
      invalidate(state.windowId, 'native-ui-unavailable');
  }
}
// Native WebUI cannot run injected scripts. Browser-owned tab/window metadata
// supplies its policy heartbeat; ordinary web pages keep DOM media ownership.
setInterval(() => {
  if (enabled && ready) for (const state of windowStates.values())
    if (state.nativeUI) void publishNativeUI(state);
}, 200);
async function activateWindow(windowId) {
  if (!enabled || !ready) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs[0]) await activate(tabs[0]);
    else await deactivateWindow(windowId, 'no-active-tab');
  } catch { await deactivateWindow(windowId, 'identity-unknown'); }
}
async function activateAll() {
  if (!enabled || !ready) return;
  try {
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.allSettled(tabs.map(activate));
  } catch { globalStatusReason = 'active tab identity unavailable'; updateTitle(); }
}
async function setEnabled(value) {
  const token = ++transition;
  enabled = !!value;
  ready = false;
  await chrome.storage.local.set({ enabled });
  if (token !== transition) return;
  badge();
  if (enabled) {
    ready = false;
    pendingWindows.clear();
    for (const state of windowStates.values()) { finishPublication(state.pending?.publication, 'invalidated', { obsolete: true }); state.pending = null; state.acceptedGeometry = null; state.epoch++; }
    if (!port) connect(); else post({ type: 'configure', enabled: true });
  } else {
    // Native OFF must not depend on busy renderers restoring styles or
    // acknowledging geometry controls. Fence and reset the compositor first.
    invalidate(undefined, 'global-disabled');
    if (port) post({ type: 'configure', enabled: false });
    await Promise.allSettled([disableThemes(),
      ...[...windowStates.keys()].map(windowId => deactivateWindow(windowId, 'global-disabled', { invalidateMask: false }))]);
    if (token !== transition) return;
  }
}
chrome.action.onClicked.addListener(() => setEnabled(!enabled));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'theme-fetch-css') {
    // Only extension content scripts can request stylesheet text. Reuse the
    // existing HTTP/HTTPS grant, omit credentials, and bound each response.
    if (!enabled || !ready || sender.frameId !== 0 || !sender.tab || !/^https?:/.test(sender.tab.url || '')) {
      sendResponse?.({ok:false}); return;
    }
    let url;
    try { url = new URL(message.url); } catch { sendResponse?.({ok:false}); return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      sendResponse?.({ok:false}); return;
    }
    void (async () => {
      const response = await fetch(url.href, {credentials:'omit',signal:AbortSignal.timeout(10000)});
      if (!response.ok || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Stylesheet unavailable');
      const reader = response.body.getReader(), parts = [];
      let bytes = 0;
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Stylesheet too large'); }
        parts.push(value);
      }
      const text = await new Blob(parts).text();
      sendResponse?.({ok:true,text});
    })().catch(() => sendResponse?.({ok:false}));
    return true;
  }
  if (message.type === 'media-ready') {
    if (enabled && ready && sender.frameId === 0) void themeTab(sender.tab);
    if (enabled && sender.frameId === 0 && sender.tab?.active) void activate(sender.tab);
    return;
  }
  const state = windowStates.get(sender.tab?.windowId);
  if (message.type !== 'media-content-state' || !enabled || !ready || sender.frameId !== 0 || !state || state.nativeUI || sender.tab?.id !== state.tabId) return;
  if (!Number.isSafeInteger(message.sequence) || message.sequence <= state.lastSequence) return;
  state.lastSequence = message.sequence;
  const publication = publicationFor(state, message.sequence, message.capturedAt);
  state.lastSample = { valid: !!message.valid, reason: message.reason, boxCount: Array.isArray(message.boxes) ? message.boxes.length : null, viewport: { innerWidth: message.viewport?.innerWidth, innerHeight: message.viewport?.innerHeight, zoom: message.viewport?.zoom, dpr: message.viewport?.dpr }, sequence: message.sequence, capturedAt: message.capturedAt, snapshotDurationMs: message.snapshotDurationMs ?? null, themeRefreshDurationMs: message.themeRefreshDurationMs ?? null, snapshotPhases: message.snapshotPhases ?? null, themePhases: message.themePhases ?? null };
  const token = state.epoch;
  const geometry = JSON.stringify({ boxes: message.boxes, width: message.viewport.innerWidth, height: message.viewport.innerHeight, zoom: message.viewport.zoom });
  if (!message.valid) { finishPublication(publication, 'content-invalid'); pageStatus(state, `page protection unavailable (${message.reason})`); invalidate(state.windowId, message.reason); return; }
  Promise.all([chrome.tabs.get(state.tabId), chrome.windows.get(state.windowId), chrome.tabs.getZoom(state.tabId)]).then(([tab, window, zoom]) => {
    publication.metadataReadyAt = Date.now();
    if (token !== state.epoch || message.sequence !== state.lastSequence || !enabled || !ready || !tab.active || tab.windowId !== state.windowId || window.state === 'minimized' || zoom !== message.viewport.zoom) {
      finishPublication(publication, 'superseded', { obsolete: true }); return;
    }
    const normalized = MediaGeometry.normalize(message.boxes, { ...message.viewport, outerWidth: window.width, outerHeight: window.height });
    state.lastNormalization = { valid: normalized.valid, reason: normalized.reason, windowWidth: window.width, windowHeight: window.height, rectCount: normalized.rects.length, rects: normalized.rects };
    if (!normalized.valid) { finishPublication(publication, 'unsupported-geometry'); pageStatus(state, `page geometry unsupported (${normalized.reason})`); return invalidate(state.windowId, normalized.reason); }
    const deviceScale = message.viewport.dpr / zoom;
    if (!Number.isFinite(deviceScale) || deviceScale <= 0 || deviceScale > 8) { finishPublication(publication, 'unsupported-device-scale'); pageStatus(state, 'page device scale unsupported'); return invalidate(state.windowId, 'device-scale-unknown'); }
    finishPublication(state.pending?.publication, 'superseded', { obsolete: true });
    publication.outcome = 'pending-native';
    state.pending = { geometry, sequence: message.sequence, publication, message: { windowId: state.windowId, deviceScale, type: 'snapshot', capturedAt: message.capturedAt, title: tab.title || '', focused: !!window.focused, outerWidth: window.width, outerHeight: window.height, rects: normalized.rects } };
    pendingWindows.add(state.windowId);
    flush();
  }).catch(() => {
    publication.metadataReadyAt ??= Date.now();
    finishPublication(publication, 'metadata-unavailable', { obsolete: !enabled || !ready || token !== state.epoch || message.sequence !== state.lastSequence || windowStates.get(state.windowId) !== state });
    if (!enabled || !ready || token !== state.epoch || message.sequence !== state.lastSequence || windowStates.get(state.windowId) !== state) return;
    pageStatus(state, 'page identity or geometry unavailable'); invalidate(state.windowId, 'identity-unknown');
  });
});
chrome.tabs.onActivated.addListener(info => {
  if (!info) { void activateAll(); return; }
  void deactivateWindow(info.windowId, 'tab-switch').then(() => activateWindow(info.windowId));
});
chrome.tabs.onRemoved.addListener((id, info) => {
  themedTabs.delete(id);
  newTabRecoveries.delete(id);
  const state = [...windowStates.values()].find(item => item.tabId === id);
  if (state) void deactivateWindow(state.windowId, 'tab-closed', { remove: !!info?.isWindowClosing }).then(() => { if (!info?.isWindowClosing) return activateWindow(state.windowId); });
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  // URL updates also include same-document history/hash navigation. Those
  // pages still need their theme restored when the global switch turns off.
  if (change.status === 'loading') themedTabs.delete(id);
  const state = [...windowStates.values()].find(item => item.tabId === id);
  if (state && (change.status === 'loading' || change.url)) void deactivateWindow(state.windowId, 'navigation');
  if (enabled && tab.active && (change.status === 'complete' || (change.url && change.status !== 'loading'))) void activate(tab);
  else if (enabled && change.status === 'complete') void themeTab(tab, true);
});
chrome.tabs.onZoomChange.addListener(info => {
  const state = [...windowStates.values()].find(item => item.tabId === info.tabId);
  if (state) { state.epoch++; invalidate(state.windowId, 'zoom-changed'); void activateWindow(state.windowId); }
});
chrome.windows.onFocusChanged.addListener(windowId => {
  if (Number.isSafeInteger(windowId) && windowId > 0) {
    diagnosticWindowId = windowId; updateTitle();
    void activateWindow(windowId);
  }
  // Another desktop app becoming focused does not change the visible active tab.
});
chrome.windows.onRemoved?.addListener(windowId => {
  // The final tab-close event can remove this state first. Native identity
  // bindings still need the permanent window-close notification in that case.
  if (!windowStates.has(windowId)) invalidate(windowId, 'window-closed');
  else void deactivateWindow(windowId, 'window-closed', { remove: true });
});
chrome.windows.onBoundsChanged?.addListener(window => { if (enabled) void activateWindow(window.id); });
chrome.tabs.onDetached?.addListener((id, info) => { void deactivateWindow(info.oldWindowId, 'tab-detached').then(() => activateWindow(info.oldWindowId)); });
chrome.tabs.onAttached?.addListener((id, info) => { void activateWindow(info.newWindowId); });
chrome.storage.local.get({ enabled: false }).then(value => { if (transition !== 0) return; enabled = !!value.enabled; badge(); if (enabled) connect(); });
globalThis.enableMediaTransparencyForTest = async () => setEnabled(true);
globalThis.mediaTransparencyDebugState = () => {
  const current = diagnosticState();
  return { enabled, ready, chosenTab: current?.tabId ?? null, epoch: current?.epoch ?? 0, lastSequence: current?.lastSequence ?? 0, queued: queue.map(item => item.message.type), hasPending: pendingWindows.size > 0, statusReason: current?.statusReason || globalStatusReason, lastSample: current?.lastSample || null, lastNormalization: current?.lastNormalization || null, lastNativeResult: current?.lastNativeResult || null, publications: current?.publications || [], windows: [...windowStates.values()].map(({ pending, ...state }) => ({ ...state, hasPending: !!pending })) };
};
