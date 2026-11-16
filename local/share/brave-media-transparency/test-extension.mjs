import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('./extension/geometry.js', import.meta.url), 'utf8'), context);
const { normalize, disconnectedState } = context.MediaGeometry;
const vp = { innerWidth: 1000, innerHeight: 700, outerWidth: 1000, outerHeight: 800, dpr: 2, zoom: 1 };
function plain(value) { return JSON.parse(JSON.stringify(value)); }
test('media box maps below browser toolbar with 2px rounding guard', () => {
  assert.deepEqual(plain(normalize([{ left: 100, top: 100, right: 300, bottom: 200 }], vp).rects), [[.098, .2475, .204, .13]]);
});
test('guard clamps to content viewport and cannot spill into browser chrome', () => {
  const r = normalize([{ left: -10, top: -10, right: 1200, bottom: 900 }], vp).rects[0];
  assert.deepEqual(plain(r), [0, .125, 1, .875]);
});
test('partly scrolled image starts at the content viewport at fractional zoom', () => {
  const view = {...vp, innerWidth:800, innerHeight:560, zoom:1.25};
  const r = normalize([{left:20, top:-400, right:180, bottom:80}], view).rects[0];
  assert.equal(r[1], .125);
  assert.equal(r[3], .1275);
});
test('zoomed document CSS geometry converts to browser CSS coordinates', () => {
  const result = normalize([{ left: 50, top: 50, right: 150, bottom: 100 }], { ...vp, innerWidth: 500, innerHeight: 350, zoom: 2 });
  assert.deepEqual(plain(result.rects), [[.098, .2475, .204, .13]]);
});
test('side panel or impossible browser geometry disables effect', () => {
  assert.equal(normalize([], { ...vp, outerWidth: 1200 }).valid, false);
  assert.equal(normalize([], { ...vp, outerHeight: 500 }).valid, false);
  assert.equal(normalize([], { ...vp, dpr: NaN }).valid, false);
});
test('media overflow and invalid boxes revoke entire snapshot', () => {
  assert.equal(normalize(Array(129).fill({ left: 0, top: 0, right: 1, bottom: 1 }), vp).valid, false);
  assert.equal(normalize([{ left: 1, top: 1, right: NaN, bottom: 2 }], vp).valid, false);
});
test('disconnect drops all prior masks', () => {
  const s = disconnectedState({ enabled: true, valid: true, rects: [[0, 0, 1, 1]] });
  assert.equal(s.valid, false);
  assert.equal(s.enabled, false);
  assert.equal(s.rects.length, 0);
});
test('extension declares persistent global HTTP/HTTPS access', () => {
  const manifest = JSON.parse(readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['nativeMessaging', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});
function backgroundHarness(persisted = false, options = {}) {
  const events = {}, sent = [], badges = [], titles = [], updates = [], enabledMessages = [], themeMessages = [], injections = [], navigations = [];
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const tab = { id: 7, windowId: 2, title: 'Fixture', url: 'https://example.test/', active: true };
  const tabsById = new Map((options.tabs || [tab]).map(item => [item.id, item]));
  const windowsById = new Map((options.windows || [{id:2,focused:true,state:'normal',width:1000,height:800}]).map(item => [item.id,item]));
  const newTabPages = options.newTabPages || new Map([...tabsById.values()].filter(tab =>
    tab.url === 'chrome-extension://fixture/newtab.html' || ['chrome://newtab','chrome://newtab/','brave://newtab','brave://newtab/'].includes(tab.url))
    .map(tab => [tab.id,ownedNewTabPage()]));
  const chrome = {
    runtime: { getURL:path=>`chrome-extension://fixture/${path}`, getManifest:()=>JSON.parse(readFileSync(new URL('./extension/manifest.json',import.meta.url),'utf8')), connectNative: () => ({ postMessage: m => sent.push(m), onMessage: event('ack'), onDisconnect: event('disconnect') }), onMessage: event('content') },
    action: { onClicked: event('click'), setBadgeText: async ({text}) => badges.push(text), setBadgeBackgroundColor: async () => {}, setTitle: async ({title}) => titles.push(title) },
    storage: { local: { get: async () => ({ enabled: persisted }), set: async value => updates.push(value) } },
    scripting: { executeScript: async options => injections.push(options) },
    tabs: { get: async id => tabsById.get(id), update:async (id,change)=>navigations.push([id,change]), query: async (query = {}) => [...tabsById.values()].filter(t => (query.active === undefined || t.active === query.active) && (query.windowId === undefined || t.windowId === query.windowId)), getZoom: async () => 1, sendMessage: async (id, message) => {
      (message.type==='media-theme-v1' ? themeMessages : enabledMessages).push([id,message]);
      return newTabPages.get(id)?.receive(message);
    }, onActivated: event('activate'), onRemoved: event('remove'), onUpdated: event('update'), onZoomChange: event('zoom') },
    windows: { get: async id => windowsById.get(id), onFocusChanged: event('focus'), onRemoved:event('window-remove'),onBoundsChanged:event('bounds') }
  };
  const source = readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8').replace("import './geometry.js';", '');
  const global = { chrome, URL, ...(options.now ? {Date:{now:options.now}} : {}), setInterval:fn=>{events['native-ui-tick']=fn;}, MediaGeometry: context.MediaGeometry };
  vm.runInNewContext(source, global);
  const harness = { chrome, events, sent, badges, titles, updates, enabledMessages, themeMessages, injections, navigations, tab, global, tabsById, windowsById, newTabPages, sender: { frameId: 0, tab } };
  for(const [id,page] of newTabPages) page.connect?.(harness,id);
  return harness;
}
const sample = sequence => ({ type: 'media-content-state', valid: true, reason: 'settled', sequence, capturedAt: Date.now(), viewport: { ...vp }, boxes: [{left:100,top:100,right:300,bottom:200}] });
const microtasks = () => new Promise(resolve => setImmediate(resolve));
async function enable(h) {
  await microtasks();
  await h.events.click();
  h.events.ack({ accepted: true, enabled: true });
  await microtasks();
  h.events.ack({ accepted: true });
}
test('toolbar stores a global toggle and configures native backend', async () => {
  const h = backgroundHarness();
  await enable(h);
  assert.equal(h.updates[0].enabled, true);
  assert.equal(h.sent[0].type, 'configure');
  assert.equal(h.sent[0].enabled, true);
  assert.equal(h.badges.at(-1), 'ON');
  assert.equal(h.enabledMessages.at(-1)[1].enabled, true);
  await h.events.click();
  assert.equal(h.updates.at(-1).enabled, false);
  assert.equal(h.sent.at(-1).type, 'configure');
  assert.equal(h.sent.at(-1).enabled, false);
  assert.equal(h.badges.at(-1), 'OFF');
});
test('stored enabled state reconnects automatically on worker startup', async () => {
  const h = backgroundHarness(true);
  await microtasks();
  assert.equal(h.sent[0].type, 'configure');
  assert.equal(h.sent[0].enabled, true);
});
test('current global controls cannot reactivate an obsolete anonymous content listener', async () => {
  const h=backgroundHarness();
  let legacyEnabled=false;
  const send=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{
    if(message.type==='media-set-enabled') legacyEnabled=message.enabled;
    return send(id,message);
  };
  await enable(h);
  assert.equal(legacyEnabled,false);
  assert.equal(h.enabledMessages.at(-1)[1].type,'media-set-enabled-v2');
  await h.events.click();
  assert.equal(h.enabledMessages.at(-1)[1].enabled,false);
});
test('native bootstrap failure shows explicit ERR rather than waiting forever', async () => {
  const h = backgroundHarness();
  await microtasks();
  await h.events.click();
  h.events.ack({ accepted: false, error: 'configure-failed' });
  assert.equal(h.badges.at(-1), 'ERR');
  assert.equal(h.titles.at(-1), 'Transparency unavailable: native host unavailable. Click to turn off.');
});
test('ABI rejection preserves rebuild instructions in toolbar and OFF clears the error', async () => {
  const h = backgroundHarness();
  await microtasks();
  await h.events.click();
  const detail = 'Hyprland ABI mismatch; rebuild the plugin against the running Hyprland and dependency versions.';
  h.events.ack({accepted:false, error:'configure-failed', detail});
  assert.equal(h.badges.at(-1), 'ERR');
  assert.equal(h.global.mediaTransparencyDebugState().ready, false);
  assert.equal(h.global.mediaTransparencyDebugState().statusReason, detail);
  assert.equal(h.titles.at(-1), `Transparency unavailable: ${detail} Click to turn off.`);
  assert.equal(h.updates.at(-1).enabled, true, 'remember activation preference while native backend is unavailable');
  assert.equal(h.injections.length, 0, 'no page is adapted without a working compositor');
  await h.events.click();
  assert.equal(h.updates.at(-1).enabled, false);
  assert.equal(h.badges.at(-1), 'OFF');
  assert.equal(h.titles.at(-1), 'Transparency disabled globally; click to turn on');
  await enable(h);
  assert.equal(h.badges.at(-1), 'ON');
  assert.ok(!h.titles.at(-1).includes('ABI mismatch'), 'a successful new handshake clears the old reason');
});
test('updated compositor rejection replaces previous window status with the rebuild reason', async () => {
  const h = backgroundHarness();
  await enable(h);
  await h.events.click();
  h.events.ack({accepted:true});
  h.events.ack({accepted:true, enabled:false});
  const injections = h.injections.length;
  await h.events.click();
  const detail = 'Hyprland changed; rebuild the plugin before enabling.';
  h.events.ack({accepted:false, error:'configure-failed', detail});
  const state = h.global.mediaTransparencyDebugState();
  assert.equal(state.ready, false);
  assert.equal(state.statusReason, detail);
  assert.equal(state.windows[0].statusReason, detail);
  assert.equal(h.titles.at(-1), `Transparency unavailable: ${detail} Click to turn off.`);
  assert.equal(h.injections.length, injections);
});
test('invalid native error details retain a useful generic toolbar reason', async () => {
  for (const detail of [undefined, '', '  ', false, {message:'wrong shape'}]) {
    const h = backgroundHarness();
    await microtasks();
    await h.events.click();
    h.events.ack({accepted:false, error:'configure-failed', detail});
    assert.equal(h.badges.at(-1), 'ERR');
    assert.equal(h.titles.at(-1), 'Transparency unavailable: native host unavailable. Click to turn off.');
  }
});
test('navigation completes by automatically reactivating the new document', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.update(7, {status:'loading'}, h.tab);
  await microtasks();
  h.events.update(7, {status:'complete'}, h.tab);
  await microtasks();
  assert.equal(h.enabledMessages.at(-1)[1].enabled, true);
});
test('movement revokes an asynchronous older identity check', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  h.events.content({ ...sample(2), valid: false, reason: 'moving', boxes: [] }, h.sender);
  await microtasks();
  h.events.ack({ accepted: false });
  assert.equal(h.sent.filter(m => m.type === 'snapshot').length, 0);
});
test('authoritative window metadata overrides spoofed DOM outer dimensions', async () => {
  const h = backgroundHarness();
  await enable(h);
  const state = sample(1);
  state.viewport.outerWidth = 768; state.viewport.outerHeight = 469;
  h.events.content(state, h.sender);
  await microtasks();
  h.events.ack({ accepted: true });
  const packet = h.sent.find(m => m.type === 'snapshot');
  assert.equal(packet.outerWidth, 1000);
  assert.equal(packet.outerHeight, 800);
  assert.deepEqual(plain(packet.rects), [[.098, .2475, .204, .13]]);
});
test('manual controller OFF response persists global disabled state', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({ accepted: true });
  h.events.ack({ accepted: false, enabled: false, error: 'disabled' });
  await microtasks();
  assert.equal(h.updates.at(-1).enabled, false);
  assert.equal(h.badges.at(-1), 'OFF');
});
test('publication timings correlate capture, receipt, metadata, native post and reply without changing the packet', async () => {
  let now=1005;
  const h=backgroundHarness(false,{now:()=>now});await enable(h);
  let resolveMetadata;
  h.chrome.tabs.get=()=>new Promise(resolve=>{resolveMetadata=resolve;});
  const message={...sample(1),capturedAt:1000};
  h.events.content(message,h.sender);
  let record=plain(h.global.mediaTransparencyDebugState().publications[0]);
  assert.equal(record.sequence,1);assert.equal(record.capturedAt,1000);assert.equal(record.receivedAt,1005);
  assert.equal(record.metadataReadyAt,null);assert.equal(record.nativePostedAt,null);assert.equal(record.nativeReplyAt,null);
  now=1050;resolveMetadata(h.tab);await microtasks();
  record=plain(h.global.mediaTransparencyDebugState().publications[0]);
  assert.equal(record.metadataReadyAt,1050);assert.equal(record.nativePostedAt,1050);assert.equal(record.nativeReplyAt,null);
  assert.equal(record.outcome,'native-pending');
  const packet=h.sent.find(message=>message.type==='snapshot');
  assert.equal(packet.capturedAt,1000);
  assert.deepEqual(Object.keys(packet).sort(),['capturedAt','deviceScale','focused','outerHeight','outerWidth','rects','title','type','windowId']);
  now=1080;h.events.ack({accepted:true});
  record=plain(h.global.mediaTransparencyDebugState().publications[0]);
  assert.equal(record.nativeReplyAt,1080);assert.equal(record.finishedAt,1080);
  assert.equal(record.outcome,'native-accepted');assert.equal(record.accepted,true);assert.equal(record.obsolete,false);
  assert.deepEqual(plain(h.global.mediaTransparencyDebugState().lastNativeResult),{...record,at:1080});
});
test('expired pending publication records its sequence and timing without fabricating a native reply', async () => {
  let now=1000;
  const h=backgroundHarness(false,{now:()=>now});await enable(h);
  h.events.content({...sample(1),capturedAt:1000},h.sender);await microtasks();
  now=1010;h.events.content({...sample(2),capturedAt:1010},h.sender);await microtasks();
  assert.equal(h.global.mediaTransparencyDebugState().publications[1].outcome,'pending-native');
  now=1250;h.events.ack({accepted:true});
  const state=plain(h.global.mediaTransparencyDebugState()),record=state.publications[1];
  assert.equal(record.sequence,2);assert.equal(record.capturedAt,1010);assert.equal(record.receivedAt,1010);
  assert.equal(record.metadataReadyAt,1010);assert.equal(record.finishedAt,1250);
  assert.equal(record.nativePostedAt,null);assert.equal(record.nativeReplyAt,null);assert.equal(record.accepted,null);
  assert.equal(record.outcome,'expired-before-native');
  assert.equal(state.lastNativeResult.sequence,1,'last native reply and last attempted publication remain distinct');
  assert.equal(h.sent.filter(message=>message.type==='snapshot').length,1);
  assert.match(state.statusReason,/expired before native delivery/);
});
test('publication history preserves superseded metadata, replaced pending samples and obsolete native replies', async () => {
  let now=1000;
  const h=backgroundHarness(false,{now:()=>now});await enable(h);
  const get=h.chrome.tabs.get;let resolveOld;
  h.chrome.tabs.get=()=>new Promise(resolve=>{resolveOld=resolve;});
  h.events.content({...sample(1),capturedAt:1000},h.sender);
  h.chrome.tabs.get=get;
  now=1010;h.events.content({...sample(2),capturedAt:1010},h.sender);await microtasks();
  now=1020;h.events.content({...sample(3),capturedAt:1020},h.sender);await microtasks();
  now=1030;h.events.content({...sample(4),capturedAt:1030},h.sender);await microtasks();
  now=1040;resolveOld(h.tab);await microtasks();
  const records=h.global.mediaTransparencyDebugState().publications;
  assert.equal(records[0].outcome,'superseded');assert.equal(records[0].metadataReadyAt,1040);assert.equal(records[0].obsolete,true);
  assert.equal(records[0].nativePostedAt,null);
  assert.equal(records[2].outcome,'superseded');assert.equal(records[2].finishedAt,1030);assert.equal(records[2].obsolete,true);
  assert.equal(records[2].nativePostedAt,null);
  now=1050;h.events.ack({accepted:true});
  assert.equal(records[1].sequence,2);assert.equal(records[1].nativeReplyAt,1050);assert.equal(records[1].obsolete,true);
  assert.equal(records[3].nativePostedAt,1050);
  now=1060;h.events.ack({accepted:true});
  assert.equal(records[3].sequence,4);assert.equal(records[3].obsolete,false);assert.equal(records[3].nativeReplyAt,1060);
  assert.deepEqual(h.sent.filter(message=>message.type==='snapshot').map(message=>message.capturedAt),[1010,1030]);
});
test('native rejection remains sequence-correlated and does not look like publication expiry', async () => {
  let now=1000;
  const h=backgroundHarness(false,{now:()=>now});await enable(h);
  h.events.content({...sample(1),capturedAt:990},h.sender);await microtasks();
  now=1100;h.events.ack({accepted:false,error:'stale media snapshot'});
  const state=plain(h.global.mediaTransparencyDebugState()),record=state.publications[0];
  assert.equal(record.sequence,1);assert.equal(record.nativePostedAt,1000);assert.equal(record.nativeReplyAt,1100);
  assert.equal(record.outcome,'native-rejected');assert.equal(record.accepted,false);assert.equal(record.error,'stale media snapshot');
  assert.equal(state.lastNativeResult.sequence,1);assert.equal(state.lastNativeResult.capturedAt,990);
});
test('publication history is bounded to 64 metadata-only records per window', async () => {
  const h=backgroundHarness(false,{now:()=>1000});await enable(h);
  for(let sequence=1;sequence<=80;sequence++) {
    h.events.content({...sample(sequence),capturedAt:1000},h.sender);await microtasks();h.events.ack({accepted:true});
  }
  const state=plain(h.global.mediaTransparencyDebugState()),records=state.publications;
  assert.equal(records.length,64);assert.equal(records[0].sequence,17);assert.equal(records.at(-1).sequence,80);
  assert.deepEqual(records,state.windows[0].publications);
  const keys=['accepted','capturedAt','epoch','error','finishedAt','kind','metadataReadyAt','nativePostedAt','nativeReplyAt','obsolete','outcome','receivedAt','sequence'];
  for(const record of records) assert.deepEqual(Object.keys(record).sort(),keys);
  assert.equal(JSON.stringify(records).includes('Fixture'),false);assert.equal(JSON.stringify(records).includes('example.test'),false);
});
function contentHarness({ focused = true, visible = true, animated = false, elements = null, hostname = 'fixture.test', contentType = 'text/html', staleMarker = undefined } = {}) {
  const frames = [], sent = [], events = {};
  let discoveries = 0, mutation, now = Date.now();
  let handler;
  const video = { localName: 'video', childNodes: [], shadowRoot: null, matches: () => true, getBoundingClientRect: () => ({ left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 }) };
  const document = { contentType, hasFocus: () => focused, visibilityState: visible ? 'visible' : 'hidden', fullscreenElement: null, querySelectorAll: () => { discoveries++; return elements || [video]; }, getAnimations: () => animated ? [{ playState: 'running' }] : [] };
  const chrome = { runtime: { onMessage: { addListener: fn => { handler = fn; }, removeListener: fn => { if (handler === fn) handler = undefined; } }, sendMessage: async m => { sent.push(m); } } };
  const themeCalls=[];
  const SemanticTheme={enable:palette=>themeCalls.push(['enable',palette]),disable:()=>themeCalls.push(['disable']),dispose:()=>themeCalls.push(['dispose']),setFetchMethod(){},ownsMutation:record=>record.owned};
  const fixture = { Date:{now:()=>now}, SemanticTheme, __braveMediaTransparency: staleMarker, chrome, document, location: { hostname }, MediaGeometry: context.MediaGeometry, innerWidth: 1000, innerHeight: 700, outerWidth: 768, outerHeight: 469, devicePixelRatio: 2, screenX: 0, screenY: 0, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener(name, fn) { events['viewport-' + name] = fn; }, removeEventListener(name, fn) { if (events['viewport-' + name] === fn) delete events['viewport-' + name]; } }, addEventListener(name, fn) { events[name] = fn; }, removeEventListener(name, fn) { if (events[name] === fn) delete events[name]; }, requestAnimationFrame: fn => frames.push(fn), setInterval() {}, clearInterval() {}, MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} }, getComputedStyle: el => el.style || ({ visibility: 'visible', backgroundImage: 'none', opacity: '1', display: 'block' }) };
  vm.runInNewContext(readFileSync(new URL('./extension/content.js', import.meta.url), 'utf8'), fixture);
  handler({ type: 'media-set-enabled-v2', enabled: true, zoom: 1 });
  return { frames, sent, events, document, global:fixture, themeCalls, message:()=>handler, mutation:records => mutation(records), discoveries:() => discoveries, advanceTime:ms=>{now+=ms;} };
}
let newTabDocument = 0;
function ownedNewTabPage({controller='current',storage=new Map(),blockedStorage=false}={}) {
  // Execute the real geometry and New Tab controllers together. Palette delivery
  // alone never fabricates geometry or a current/disposed health reply.
  const content=contentHarness({elements:[]}), geometryHandler=content.message();
  geometryHandler({type:'media-set-enabled-v2',enabled:false});
  const inputEvents={}, requests=[], reloads=[];
  let submit, adapterHandler;
  const input={value:'',selectionStart:0,selectionEnd:0,selectionDirection:'none',
    addEventListener(name,fn){inputEvents[name]=fn;},
    focus(){content.document.activeElement=input;inputEvents.focus?.();},
    setSelectionRange(start,end,direction){input.selectionStart=start;input.selectionEnd=end;input.selectionDirection=direction;},
  };
  Object.assign(content.document,{activeElement:null,
    getElementById:id=>id==='navigation'?{addEventListener(_name,fn){submit=fn;}}:input,
    documentElement:{style:{getPropertyValue:()=>'',setProperty(){}}},
  });
  Object.assign(content.global,{URL,crypto:{randomUUID:()=>`newtab-document-${++newTabDocument}`},
    sessionStorage:{getItem(key){if(blockedStorage)throw new Error('Storage unavailable');return storage.get(key)??null;},
      setItem(key,value){if(blockedStorage)throw new Error('Storage unavailable');storage.set(key,value);},removeItem:key=>storage.delete(key)},
  });
  Object.assign(content.global.location,{href:'chrome-extension://fixture/newtab.html',
    assign(url){content.global.location.href=url;},reload(){reloads.push(true);}});
  content.global.chrome.runtime.onMessage.addListener=fn=>{adapterHandler=fn;};
  vm.runInNewContext(readFileSync(new URL('./extension/newtab.js',import.meta.url),'utf8'),content.global);
  if(controller==='missing'||controller==='disposed') content.global.__braveMediaTransparency.dispose();
  if(controller==='missing') delete content.global.__braveMediaTransparency;
  if(controller==='obsolete') content.global.__braveMediaTransparency.version='0.2.45';
  return {content,input,inputEvents,storage,requests,reloads,
    receive(message){
      requests.push(message);
      let response;
      geometryHandler(message);
      adapterHandler(message,{},value=>{response=value;});
      return response;
    },
    connect(h,id){content.global.chrome.runtime.sendMessage=async message=>h.events.content(message,{frameId:0,tab:h.tabsById.get(id)});},
    flushFrames(){while(content.frames.length)content.frames.shift()();},
    submit(){submit({preventDefault(){}});},
  };
}
test('SVG media masks follow exact semantic glyph proof rather than artwork dimensions',()=>{
  for(const [width,height] of [[120,40],[24,24],[300,12]]) for(const proven of [false,true]) {
    const svg={localName:'svg',childNodes:[],shadowRoot:null,matches:()=>true,
      getBoundingClientRect:()=>({left:10,top:20,right:10+width,bottom:20+height,width,height})};
    const h=contentHarness({elements:[svg]});h.global.SemanticTheme.isControlGlyph=el=>proven&&el===svg;
    h.frames.shift()();const state=h.sent.find(message=>message.type==='media-content-state');
    assert.equal(state.valid,true);
    assert.deepEqual(plain(state.boxes),proven?[]:[{left:10,top:20,right:10+width,bottom:20+height}]);
  }
});
test('PDF MIME documents protect the full viewport without inspectable media or DOM discovery',()=>{
  for(const contentType of ['application/pdf','APPLICATION/PDF',' Application/Pdf ; charset=binary']) {
    const h=contentHarness({contentType,elements:[]});
    h.frames.shift()();
    const state=h.sent.find(message=>message.type==='media-content-state');
    assert.equal(state.valid,true,contentType);
    assert.equal(state.reason,'uninspectable-pdf');
    assert.deepEqual(plain(state.boxes),[{left:0,top:0,right:1000,bottom:700}]);
    assert.equal(h.discoveries(),0,'native PDF artwork is not exposed as ordinary DOM media');
  }
});
test('ordinary HTML served at a PDF-looking URL retains normal media classification',()=>{
  const h=contentHarness({contentType:'text/html',elements:[]});
  h.global.location.href='https://fixture.test/annual-report.pdf';
  h.frames.shift()();
  const state=h.sent.find(message=>message.type==='media-content-state');
  assert.equal(state.valid,true);
  assert.equal(state.reason,'settled');
  assert.deepEqual(plain(state.boxes),[]);
  assert.equal(h.discoveries(),1);
});
test('decorative animation does not block first-frame media reporting', () => {
  const h = contentHarness({ animated: true });
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  const state = h.sent.find(m => m.type === 'media-content-state');
  assert.equal(state.valid, true);
  assert.equal(state.boxes.length, 1);
  assert.equal(h.frames.length, 0, 'unrelated UI animation does not rescan media every frame');
});
test('video snapshots protect displayed frames and refresh intrinsic metadata without clearing transparency', () => {
  const video = { localName:'video', childNodes:[], shadowRoot:null, matches:()=>true,
    videoWidth:0, videoHeight:0,
    style:{width:'800px',height:'300px',objectFit:'contain',objectPosition:'50% 50%',visibility:'visible',opacity:'1',display:'block',backgroundImage:'none'},
    getBoundingClientRect:()=>({left:10,top:20,right:810,bottom:320,width:800,height:300}) };
  const h = contentHarness({elements:[video]});
  h.frames.shift()();
  assert.deepEqual(plain(h.sent.at(-1).boxes),[{left:10,top:20,right:810,bottom:320}]);
  video.videoWidth=1920; video.videoHeight=1080;
  h.events.loadedmetadata({target:video});
  h.frames.shift()();
  const box = h.sent.at(-1).boxes[0];
  assert.ok(Math.abs(box.left-143.3333333333333)<1e-8);
  assert.ok(Math.abs(box.right-676.6666666666667)<1e-8);
  assert.equal(box.top,20); assert.equal(box.bottom,320);
  assert.ok(h.sent.filter(m=>m.type==='media-content-state').every(m=>m.valid));
});
test('video resize refreshes its frame while window resize still revokes incompatible viewport geometry', () => {
  const video={localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,
    getBoundingClientRect:()=>({left:10,top:20,right:210,bottom:120,width:200,height:100})};
  const h=contentHarness({elements:[video]});
  h.frames.shift()();
  h.events.resize({target:video});
  h.frames.shift()();
  assert.ok(h.sent.filter(m=>m.type==='media-content-state').every(m=>m.valid));
  h.global.innerWidth = 900;
  h.events.resize();
  assert.equal(h.sent.at(-1).valid,false);
});
test('visible page retains media protection while browser menu owns keyboard focus', () => {
  const h = contentHarness({ focused: false });
  h.frames.shift()();
  assert.equal(h.sent.find(m => m.type === 'media-content-state').valid, true);
  const count = h.sent.length;
  h.events.blur();
  assert.equal(h.sent.length, count, 'blur schedules refresh without invalidating the existing mask');
  h.frames.shift()();
  assert.equal(h.sent.at(-1).valid, true);
});
test('hidden document remains invalid even when browser page blur is allowed', () => {
  const h = contentHarness({ focused: false, visible: false });
  h.frames.shift()();
  const state = h.sent.find(m => m.type === 'media-content-state');
  assert.equal(state.valid, false);
  assert.equal(state.boxes.length, 0);
});
test('fractional browser zoom rounding up to two pixels is tolerated', () => {
  assert.equal(normalize([], { ...vp, innerWidth: 1001, innerHeight: 801 }).valid, true);
  assert.equal(normalize([], { ...vp, innerWidth: 1003 }).valid, false);
});
test('navigation clears stale active status even if an older native ack arrives', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({ accepted: true });
  h.events.update(7, {status:'loading'}, h.tab);
  await microtasks();
  h.events.ack({ accepted: true });
  const state = h.global.mediaTransparencyDebugState();
  assert.equal(state.chosenTab, null);
  assert.equal(state.lastSample, null);
  assert.match(state.statusReason, /navigation/);
  assert.doesNotMatch(state.statusReason, /media protection active/);
});
test('diagnostics expose media count, authoritative geometry, and native rejection', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({ accepted: false, error: 'no matching active window' });
  const state = h.global.mediaTransparencyDebugState();
  assert.equal(state.lastSample.boxCount, 1);
  assert.equal(state.lastNormalization.windowWidth, 1000);
  assert.equal(state.lastNormalization.rectCount, 1);
  assert.equal(state.lastNativeResult.error, 'no matching active window');
  assert.match(state.statusReason, /no matching active window/);
});
test('content injection failure reports actionable unavailable status', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.chrome.scripting.executeScript = async () => { throw new Error('restricted'); };
  h.events.update(7, {status:'complete'}, h.tab);
  await microtasks();
  assert.match(h.global.mediaTransparencyDebugState().statusReason, /content script could not activate/);
});
test('extension popup does not block active parent window media snapshots', async () => {
  const h = backgroundHarness();
  h.chrome.windows.get = async () => ({ focused: false, state: 'normal', width: 1000, height: 800 });
  await enable(h);
  assert.equal(h.enabledMessages.at(-1)[1].enabled, true);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({ accepted: true });
  assert.equal(h.sent.some(message => message.type === 'snapshot'), true);
  h.events.ack({ accepted: true });
  assert.equal(h.global.mediaTransparencyDebugState().statusReason, 'media protection active');
});
test('custom text elements are inspectable light DOM, not unknown media', () => {
  const unknown = context.MediaGeometry.unknownCustomElement;
  assert.equal(unknown({ localName: 'yt-formatted-string', shadowRoot: null, childNodes: [{nodeType:3, textContent:'Title'}] }), false);
  assert.equal(unknown({ localName: 'ytd-player', shadowRoot: null, childNodes: [{nodeType:1}] }), false);
  assert.equal(unknown({ localName: 'opaque-widget', shadowRoot: null, childNodes: [] }), true);
  assert.equal(unknown({ localName: 'open-widget', shadowRoot: {}, childNodes: [] }), false);
});
test('visible canvas artwork stays protected beside video regardless page metadata', () => {
  const media = (localName, box) => ({localName,childNodes:[],shadowRoot:null,matches:()=>true,
    id:'cinematics',ariaHidden:'true',style:{pointerEvents:'none',visibility:'visible',display:'block',opacity:'1',backgroundImage:'none'},
    closest:()=>({}),getAttribute:()=>null,getBoundingClientRect:()=>box});
  const video=media('video',{left:100,top:100,right:400,bottom:300,width:300,height:200});
  const canvas=media('canvas',{left:10,top:10,right:500,bottom:500,width:490,height:490});
  for(const hostname of ['www.youtube.com','fixture.example','evil-youtube.com']) {
    const h=contentHarness({hostname,elements:[canvas,video]});h.frames.shift()();
    const state=h.sent.find(m=>m.type==='media-content-state');
    assert.equal(state.valid,true);assert.equal(state.boxes.length,2);
    assert.deepEqual(plain(state.boxes[0]),{left:10,top:10,right:500,bottom:500});
    assert.deepEqual(plain(state.boxes[1]),{left:100,top:100,right:400,bottom:300});
  }
});
test('native snapshot includes browser device scale independent of page zoom', async () => {
  const h = backgroundHarness();
  h.chrome.tabs.getZoom = async () => 1.25;
  await enable(h);
  const state = sample(1);
  state.viewport = { ...state.viewport, innerWidth: 800, innerHeight: 560, zoom: 1.25, dpr: 1.85546875 };
  h.events.content(state, h.sender);
  await microtasks();
  h.events.ack({ accepted: true });
  const packet = h.sent.find(m => m.type === 'snapshot');
  assert.equal(packet.deviceScale, 1.484375);
  assert.equal(packet.outerWidth, 1000);
  assert.equal(packet.outerHeight, 800);
});
test('invisible unknown full-page backdrop does not protect the page background', () => {
  const backdrop = {localName:'efyt-backdrop',childNodes:[],shadowRoot:null,matches:()=>false,style:{visibility:'hidden',opacity:'0',display:'block',backgroundImage:'none'},getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:700,width:1000,height:700})};
  const h = contentHarness({elements:[backdrop]});
  h.frames.shift()();
  assert.equal(h.sent.find(m => m.type === 'media-content-state').boxes.length, 0);
  backdrop.style = {...backdrop.style,visibility:'visible',opacity:'1'};
  const visible = contentHarness({elements:[backdrop]});
  visible.frames.shift()();
  assert.equal(visible.sent.find(m => m.type === 'media-content-state').boxes.length, 0, 'empty custom UI backdrops are not media');
});
test('ancestor opacity zero excludes descendant media with cached effective visibility', () => {
  const parent = {style:{visibility:'visible',opacity:'0',display:'block'}};
  const child = {style:{visibility:'visible',opacity:'1',display:'block'},parentElement:parent};
  const cache = new WeakMap();
  let reads = 0;
  const read = el => {reads++;return el.style;};
  assert.equal(context.MediaGeometry.isPaintVisible(child,read,cache), false);
  const before = reads;
  assert.equal(context.MediaGeometry.isPaintVisible(child,read,cache), false);
  assert.equal(reads-before, 1, 'cached ancestors avoid repeat traversal');
  assert.equal(context.MediaGeometry.isPaintVisible({style:{visibility:'collapse',opacity:'1'}},read), false);
});
test('legacy injection marker does not prevent upgraded content script startup', () => {
  const h = contentHarness({staleMarker:true});
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  assert.equal(h.sent.find(m => m.type === 'media-content-state').valid, true);
});

test('valid changing media geometry is replaced without clearing transparency', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({accepted:true});
  const before = h.sent.length;
  const moved = sample(2);
  moved.boxes[0].right += 8;
  h.events.content(moved, h.sender);
  await microtasks();
  assert.deepEqual(h.sent.slice(before).map(m=>m.type), ['snapshot']);
  assert.equal(h.global.mediaTransparencyDebugState().statusReason, 'media protection active');
  h.events.ack({accepted:true});
  h.events.content({...sample(3),valid:false,reason:'moving'}, h.sender);
  assert.equal(h.sent.at(-1).type, 'invalidate', 'untrusted movement still revokes media mask');
});
test('asset loading refreshes media without revoking the current mask', () => {
  const h = contentHarness();
  h.frames.shift()();
  const count = h.sent.length;
  h.events.load();
  assert.equal(h.sent.length, count, 'load schedules a frame without an invalid packet');
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  assert.equal(h.sent.at(-1).valid, true);
});
test('wheel, document, nested and visual viewport scrolling refresh without opacity resets', () => {
  for (const event of ['wheel', 'scroll', 'viewport-scroll']) {
    let top = 20;
    const media = { localName:'img', childNodes:[], shadowRoot:null, matches:()=>true,
      getBoundingClientRect:()=>({left:10,top,right:210,bottom:top+100,width:200,height:100}) };
    const h = contentHarness({elements:[media]});
    h.frames.shift()();
    const count = h.sent.length;
    top = 5;
    for (let i=0;i<8;i++) h.events[event]();
    assert.ok(h.sent.slice(count).every(m => m.valid), event + ' must preserve the accepted mask');
    if (event === 'wheel') {
      assert.equal(h.sent.length, count, 'wheel anticipates movement without publishing old positions');
      assert.equal(h.frames.length, 1, 'wheel burst coalesces into one current-frame sample');
      h.frames.shift()();
    } else {
      assert.equal(h.frames.length, 1, 'actual scrolling also schedules the precise settled bounds');
      assert.equal(h.sent.length,count,'scroll bursts coalesce before paint');
      h.frames.shift()();
      assert.equal(h.sent.at(-1).boxes[0].top, -10, 'scroll covers one observed presentation step');
    }
    assert.equal(h.sent.at(-1).valid, true);
    if (event === 'wheel') assert.equal(h.sent.at(-1).boxes[0].top, 5);
  }
});
test('actual window and visual viewport resizing revoke changed geometry once', () => {
  for (const event of ['resize', 'viewport-resize']) {
    const h = contentHarness();
    h.frames.shift()();
    if (event === 'resize') h.global.innerWidth = 900;
    else h.global.visualViewport.height = 650;
    h.events[event]();
    assert.equal(h.sent.at(-1).valid, false);
    assert.equal(h.sent.at(-1).reason, 'moving');
    h.frames.shift()();
    const count = h.sent.length;
    h.events[event]();
    assert.equal(h.sent.length, count, 'unchanged duplicate resize only refreshes media');
  }
});
test('scroll remeasures cached candidates and mutations discover newly inserted media', () => {
  const elements = [];
  const h = contentHarness({elements});
  h.frames.shift()();
  assert.equal(h.discoveries(), 1);
  for (let i=0;i<8;i++) h.events.scroll();
  assert.equal(h.discoveries(), 1, 'position refresh does not scan all text/layout nodes');
  elements.push({localName:'img',childNodes:[],shadowRoot:null,matches:()=>true,
    getBoundingClientRect:()=>({left:10,top:20,right:210,bottom:120,width:200,height:100})});
  h.mutation(); h.frames.shift()();
  assert.equal(h.discoveries(), 2);
  assert.equal(h.sent.at(-1).boxes.length, 1);
});
test('scroll protection bounds reversals to one step and drops stationary excess after native acceptance', () => {
  let top = 100;
  const media = {localName:'img',childNodes:[],shadowRoot:null,matches:()=>true,
    getBoundingClientRect:()=>({left:10,top,right:210,bottom:top+100,width:200,height:100})};
  const h=contentHarness({elements:[media]}); h.frames.shift()();
  top=80; h.events.scroll();h.frames.shift()();
  assert.deepEqual(plain(h.sent.at(-1).boxes[0]), {left:10,top:60,right:210,bottom:200});
  top=100; h.events.scroll();h.frames.shift()();
  assert.deepEqual(plain(h.sent.at(-1).boxes[0]), {left:10,top:80,right:210,bottom:220});
  h.message()({type:'media-geometry-accepted',sequence:h.sent.at(-1).sequence});
  h.advanceTime(51); h.frames.shift()();
  assert.deepEqual(plain(h.sent.at(-1).boxes[0]), {left:10,top:100,right:210,bottom:200});
  assert.equal(h.frames.length,0,'motion sampling stops when precise geometry is restored');
});
test('incoming media receives protection when its observed bounds enter the viewport', () => {
  let top=720;
  const media={localName:'img',childNodes:[],shadowRoot:null,matches:()=>true,
    getBoundingClientRect:()=>({left:10,top,right:210,bottom:top+100,width:200,height:100})};
  const h=contentHarness({elements:[media]});h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes.length,0);
  top=710;h.events.scroll();h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes.length,0,'offscreen prediction must not obscure visible canvas');
  top=680;h.events.scroll();h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes[0].top,650,'newly visible artwork receives at most one observed step of protection');
});
test('media loading at a stationary origin expands protection during active scrolling', () => {
  let height=100;
  const media={localName:'img',childNodes:[],shadowRoot:null,matches:()=>true,
    getBoundingClientRect:()=>({left:10,top:20,right:210,bottom:20+height,width:200,height})};
  const h=contentHarness({elements:[media]});h.frames.shift()();h.events.scroll();
  height=200;h.events.load();h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes[0].bottom,220);
});
test('upgraded content script unregisters old handlers and cannot reactivate the disposed instance', () => {
  const h=contentHarness();h.frames.shift()();
  const oldMessage=h.message(), oldScroll=h.events.scroll;
  h.global.__braveMediaTransparency.version='previous';
  vm.runInNewContext(readFileSync(new URL('./extension/content.js', import.meta.url),'utf8'),h.global);
  h.message()({type:'media-set-enabled-v2',enabled:true,zoom:1});
  oldMessage({type:'media-set-enabled-v2',enabled:true,zoom:1});oldScroll();
  const count=h.sent.length;
  assert.equal(h.frames.length,1,'only the replacement instance schedules a snapshot');
  h.frames.shift()();
  assert.equal(h.sent.length,count+1);
  assert.equal(h.sent.at(-1).sequence,1,'replacement has a single sequence owner');
  h.global.__braveMediaTransparency.dispose();
  assert.equal(Object.keys(h.events).length,0,'both window and visual viewport listeners are removed');
  assert.equal(h.message(),undefined);
});
test('typing and clicking refresh media without clearing transparency', () => {
  for (const event of ['keydown', 'pointerdown', 'touchstart', 'input']) {
    const h = contentHarness();
    h.frames.shift()();
    const count = h.sent.length;
    h.events[event]();
    assert.equal(h.sent.length, count, event + ' must not send an invalidation');
    assert.equal(h.frames.length, 1);
    h.frames.shift()();
    assert.equal(h.sent.at(-1).valid, true);
  }
});
test('same-parent popup and another browser window preserve existing window media', async () => {
  const h = backgroundHarness();
  await enable(h);
  h.events.content(sample(1), h.sender);
  await microtasks();
  h.events.ack({accepted:true});
  const count = h.sent.length;
  h.events.focus(-1);
  await microtasks();
  assert.equal(h.sent.length, count, 'focus inside the same parent must not invalidate');
  h.tabsById.set(8,{...h.tab,id:8,windowId:3});
  h.windowsById.set(3,{id:3,focused:true,state:'normal',width:1000,height:800});
  h.events.focus(3);
  await microtasks();
  assert.equal(h.sent.at(-1).type, 'invalidate');
  assert.equal(h.sent.at(-1).windowId,3,'new owner initialization is scoped');
  const state=h.global.mediaTransparencyDebugState();
  assert.equal(state.chosenTab,8);
  assert.equal(state.windows.find(w=>w.windowId===2).tabId,7);
  assert.equal(state.windows.find(w=>w.windowId===2).statusReason,'media protection active');
});
test('collapsed details protect visible summary artwork but exclude hidden body media', () => {
  const style = {visibility:'visible',opacity:'1',display:'block'};
  const details = {localName:'details',open:false,style};
  const summary = {localName:'summary',parentElement:details,style};
  const image = {localName:'img',parentElement:details,style};
  const summaryImage = {localName:'img',parentElement:summary,style};
  details.children = [summary,image];
  const read = node => node.style;
  const cache = new WeakMap();
  assert.equal(context.MediaGeometry.isPaintVisible(summaryImage,read,cache), true);
  assert.equal(context.MediaGeometry.isPaintVisible(image,read,cache), false);
  details.open = true;
  assert.equal(context.MediaGeometry.isPaintVisible(image,read,new WeakMap()), true);
});

test('synthetic mini-player window resize refreshes media without clearing accepted geometry', () => {
  let top = 20;
  const video={localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,getBoundingClientRect:()=>({left:10,top,right:210,bottom:top+100,width:200,height:100})};
  const h=contentHarness({elements:[video]});
  h.frames.shift()();
  const count=h.sent.length;
  top=500;
  h.events.resize();
  assert.equal(h.sent.length,count,'unchanged viewport does not send an invalidation');
  h.frames.shift()();
  assert.equal(h.sent.at(-1).valid,true);
  assert.equal(h.sent.at(-1).boxes[0].top,500);
});
test('viewport DPI, scale and offset changes invalidate; spoofed outer dimensions alone do not', () => {
  for (const change of [h=>{h.global.devicePixelRatio=1.5;},h=>{h.global.visualViewport.scale=1.2;},h=>{h.global.visualViewport.offsetLeft=5;}]) {
    const h=contentHarness();
    h.frames.shift()();
    change(h);
    h.events['viewport-resize']();
    assert.equal(h.sent.at(-1).valid,false);
    assert.equal(h.sent.at(-1).reason,'moving');
  }
  const h=contentHarness();
  h.frames.shift()();
  const count=h.sent.length;
  h.global.outerWidth=1200;h.global.outerHeight=900;
  h.events.resize();
  assert.equal(h.sent.length,count,'native matching owns outer dimensions, not page-spoofed values');
});
function multipleWindows(options = {}) {
  const tabs=[{id:7,windowId:2,title:'Window A',url:'https://a.example/',active:true},{id:8,windowId:3,title:'Window B',url:'https://b.example/',active:true}];
  const windows=[{id:2,focused:true,state:'normal',width:1000,height:800},{id:3,focused:false,state:'normal',width:1000,height:800}];
  return backgroundHarness(false,{...options,tabs,windows});
}
async function drainNative(h) {
  await microtasks();
  for(let i=0;i<20 && h.global.mediaTransparencyDebugState().queued.length;i++) {
    h.events.ack({accepted:true});
    await microtasks();
  }
  assert.equal(h.global.mediaTransparencyDebugState().queued.length,0);
}
function publish(h,tabId,sequence,overrides={}) {
  h.events.content({...sample(sequence),...overrides},{frameId:0,tab:h.tabsById.get(tabId)});
}
const geometryAcks = h => h.enabledMessages.filter(([,message])=>message.type==='media-geometry-accepted');
test('publication timing history is independent for each window owner', async () => {
  const h=multipleWindows({now:()=>1000});await enable(h);await drainNative(h);
  for(let sequence=1;sequence<=65;sequence++) {
    publish(h,7,sequence,{capturedAt:1000});await drainNative(h);
  }
  publish(h,8,1,{capturedAt:1000});await drainNative(h);
  const states=plain(h.global.mediaTransparencyDebugState().windows),a=states.find(state=>state.windowId===2),b=states.find(state=>state.windowId===3);
  assert.equal(a.publications.length,64);assert.equal(a.publications[0].sequence,2);assert.equal(a.publications.at(-1).sequence,65);
  assert.equal(b.publications.length,1);assert.equal(b.publications[0].sequence,1);
  assert.equal(a.lastNativeResult.sequence,65);assert.equal(b.lastNativeResult.sequence,1);
});
test('accepted native geometry acknowledges the exact publication to its owning page only',async()=>{
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  assert.deepEqual(geometryAcks(h).map(([id,message])=>[id,message.sequence]).sort(),[[7,1],[8,1]]);
  assert.ok(h.sent.filter(message=>message.type==='snapshot').every(message=>!('sequence' in message)),
    'page sequence belongs to queue metadata, not the native protocol');
});
test('superseded geometry cannot release artwork until its newer publication is accepted',async()=>{
  const h=backgroundHarness();await enable(h);await drainNative(h);
  publish(h,7,1);await microtasks();
  publish(h,7,2);await microtasks();
  h.events.ack({accepted:true});
  assert.equal(geometryAcks(h).length,0);
  h.events.ack({accepted:true});
  assert.deepEqual(geometryAcks(h).map(([,message])=>message.sequence),[2]);
});
test('rejection, pending invalidation, navigation and OFF cannot acknowledge page geometry',async()=>{
  for(const reason of ['rejected','invalidated','navigation','off']) {
    const h=backgroundHarness();await enable(h);await drainNative(h);
    publish(h,7,1);await microtasks();
    if(reason==='invalidated')publish(h,7,2,{valid:false,reason:'moving'});
    if(reason==='navigation')h.events.update(7,{status:'loading'},h.tab);
    if(reason==='off')await h.events.click();
    h.events.ack({accepted:reason!=='rejected'});
    await drainNative(h);
    assert.equal(geometryAcks(h).length,0,reason);
  }
});
test('native WebUI acknowledgments cannot release page artwork',async()=>{
  const h=backgroundHarness();h.tab.url='brave://settings/';
  await enable(h);await drainNative(h);
  assert.ok(h.sent.some(message=>message.type==='native-ui'));
  assert.equal(geometryAcks(h).length,0);
});
test('each normal window active tab reports media independently including unfocused pages', async () => {
  const h=multipleWindows();
  await enable(h);await drainNative(h);
  assert.deepEqual(h.enabledMessages.filter(([,m])=>m.enabled).map(([id])=>id).sort(),[7,8]);
  publish(h,7,1);publish(h,8,1);
  await drainNative(h);
  const packets=h.sent.filter(m=>m.type==='snapshot');
  assert.deepEqual(packets.map(m=>m.windowId).sort(),[2,3]);
  assert.equal(packets.find(m=>m.windowId===3).focused,false);
  assert.ok(h.global.mediaTransparencyDebugState().windows.every(w=>w.statusReason==='media protection active'));
});
test('terminal focus retains both owners and their subsequent unfocused media heartbeats', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  const count=h.sent.length;
  h.windowsById.get(2).focused=false;
  h.events.focus(-1);await microtasks();
  assert.equal(h.sent.length,count);
  publish(h,7,2);publish(h,8,2);await drainNative(h);
  assert.ok(h.sent.filter(m=>m.type==='snapshot').slice(-2).every(m=>m.focused===false));
  assert.equal(h.enabledMessages.filter(([,m])=>m.type==='media-set-enabled-v2'&&!m.enabled).length,0);
});
test('tab navigation and invalid media clear only their browser window', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  h.events.update(7,{status:'loading'},h.tabsById.get(7));await drainNative(h);
  assert.equal(h.sent.at(-1).type,'invalidate');
  assert.equal(h.sent.at(-1).windowId,2);
  const other=h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3);
  assert.equal(other.tabId,8);assert.equal(other.statusReason,'media protection active');
  publish(h,8,2);await drainNative(h);
  assert.equal(h.sent.at(-1).type,'snapshot');assert.equal(h.sent.at(-1).windowId,3);
  publish(h,8,3,{valid:false,reason:'inactive'});await drainNative(h);
  assert.equal(h.sent.at(-1).windowId,3);assert.equal(h.sent.at(-1).type,'invalidate');
});
test('rejected publish for one window does not revoke the other accepted mask', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  publish(h,7,2);await microtasks();
  h.events.ack({accepted:false,error:'ambiguous browser window'});
  const states=h.global.mediaTransparencyDebugState().windows;
  assert.match(states.find(w=>w.windowId===2).statusReason,/ambiguous/);
  assert.equal(states.find(w=>w.windowId===3).statusReason,'media protection active');
  assert.notEqual(states.find(w=>w.windowId===3).acceptedGeometry,null);
});
test('older sample metadata failure cannot revoke newer accepted geometry', async () => {
  const h=backgroundHarness();await enable(h);await drainNative(h);
  const get=h.chrome.tabs.get;let rejectOld;
  h.chrome.tabs.get=()=>new Promise((resolve,reject)=>{rejectOld=reject;});
  h.events.content(sample(1),h.sender);await microtasks();
  h.chrome.tabs.get=get;
  h.events.content(sample(2),h.sender);await drainNative(h);
  const before=plain(h.global.mediaTransparencyDebugState());
  assert.equal(before.lastSequence,2);
  assert.equal(before.statusReason,'media protection active');
  assert.notEqual(before.windows[0].acceptedGeometry,null);
  const count=h.sent.length;
  rejectOld(new Error('obsolete metadata request failed'));await microtasks();
  assert.equal(h.sent.length,count);
  const after=plain(h.global.mediaTransparencyDebugState()),failed=after.publications.find(record=>record.sequence===1);
  assert.equal(failed.outcome,'metadata-unavailable');assert.equal(failed.obsolete,true);
  assert.equal(failed.nativePostedAt,null);assert.equal(failed.nativeReplyAt,null);
  assert.equal(Number.isFinite(failed.metadataReadyAt),true);assert.equal(Number.isFinite(failed.finishedAt),true);
  for(const state of [before,after]) {delete state.publications;for(const window of state.windows)delete window.publications;}
  assert.deepEqual(after,before,'obsolete lookup failure changes timing diagnostics only');
});
test('current sample metadata failure still revokes unavailable geometry', async () => {
  const h=backgroundHarness();await enable(h);await drainNative(h);
  h.events.content(sample(1),h.sender);await drainNative(h);
  h.chrome.tabs.get=async()=>{throw new Error('current metadata unavailable');};
  h.events.content(sample(2),h.sender);await microtasks();
  const state=h.global.mediaTransparencyDebugState();
  assert.equal(state.lastSequence,2);
  assert.equal(state.statusReason,'page identity or geometry unavailable');
  assert.equal(state.windows[0].acceptedGeometry,null);
  assert.equal(h.sent.at(-1).type,'invalidate');
  assert.equal(h.sent.at(-1).reason,'identity-unknown');
});
test('fair pending queue prevents a busy scrolling window from starving another window', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);await microtasks();
  publish(h,7,2);publish(h,8,1);await microtasks();
  publish(h,7,3);await microtasks();
  h.events.ack({accepted:true});
  assert.equal(h.sent.at(-1).windowId,2);
  publish(h,7,4);await microtasks();
  h.events.ack({accepted:true});
  assert.equal(h.sent.at(-1).windowId,3,'waiting second window retains its place despite busy first window');
  await drainNative(h);
});
test('global OFF disables every owner and sends an unscoped reset before unload', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  await h.events.click();
  const invalidate=h.sent.filter(m=>m.type==='invalidate').at(-1);
  assert.equal(invalidate.windowId,undefined);
  assert.equal(invalidate.reason,'global-disabled');
  assert.deepEqual(h.enabledMessages.filter(([,m])=>!m.enabled).map(([id])=>id).sort(),[7,8]);
  assert.equal(h.sent.at(-1).type,'configure');assert.equal(h.sent.at(-1).enabled,false);
  assert.ok(h.global.mediaTransparencyDebugState().windows.every(w=>w.tabId===null));
});
for(const stage of ['theme','geometry']) {
  test(`native OFF does not wait for a busy ${stage} cleanup reply`,async()=>{
    const h=backgroundHarness();await enable(h);await drainNative(h);
    const send=h.chrome.tabs.sendMessage, blocked=[];
    h.chrome.tabs.sendMessage=(id,message)=>{
      const result=send(id,message);
      if(!message.enabled && message.type===(stage==='theme'?'media-theme-v1':'media-set-enabled-v2'))
        return new Promise(resolve=>blocked.push(resolve));
      return result;
    };
    const before=h.sent.length,off=h.events.click();let completed=false;void off.then(()=>{completed=true;});
    try {
      await microtasks();assert.equal(blocked.length,1);assert.equal(completed,false);
      const native=h.sent.slice(before);
      assert.deepEqual(plain(native),[{type:'invalidate',reason:'global-disabled'},{type:'configure',enabled:false}],
        'native reset and disable are posted while page cleanup is still blocked');
      assert.equal(h.global.mediaTransparencyDebugState().enabled,false);
      assert.equal(h.global.mediaTransparencyDebugState().ready,false);
      assert.equal(h.global.mediaTransparencyDebugState().windows[0].tabId,null);
      assert.equal(h.themeMessages.at(-1)[1].enabled,false);
      assert.equal(h.enabledMessages.at(-1)[1].enabled,false,'theme and geometry cleanup begin independently');
      h.events.ack({accepted:false});h.events.ack({accepted:true,enabled:false});
      assert.equal(completed,false,'native OFF acknowledgment does not depend on the page acknowledgment');
    } finally {for(const finish of blocked)finish();await off;}
    assert.equal(h.sent.slice(before).filter(message=>message.type==='configure'&&!message.enabled).length,1,
      'finishing renderer cleanup does not post another native OFF');
  });
  test(`late ${stage} OFF cleanup cannot revoke a newer ON owner`,async()=>{
    const h=backgroundHarness();await enable(h);await drainNative(h);
    const send=h.chrome.tabs.sendMessage,blocked=[];
    h.chrome.tabs.sendMessage=(id,message)=>{
      const result=send(id,message);
      if(!message.enabled && message.type===(stage==='theme'?'media-theme-v1':'media-set-enabled-v2'))
        return new Promise(resolve=>blocked.push(resolve));
      return result;
    };
    const off=h.events.click();
    try {
      await microtasks();assert.equal(blocked.length,1);
      await h.events.click();
      // Old invalidation/configuration replies belong to the OFF generation.
      h.events.ack({accepted:false,error:'disabled'});
      h.events.ack({accepted:true,enabled:false});
      h.events.ack({accepted:true,enabled:true});await drainNative(h);
      h.events.content(sample(1),h.sender);await drainNative(h);
      const before=plain(h.global.mediaTransparencyDebugState()),packets=h.sent.length;
      assert.equal(before.enabled,true);assert.equal(before.ready,true);
      assert.equal(before.windows[0].tabId,7);assert.notEqual(before.windows[0].acceptedGeometry,null);
      for(const finish of blocked)finish();await off;await microtasks();
      assert.equal(h.sent.length,packets,'obsolete cleanup cannot issue a later native command');
      assert.deepEqual(plain(h.global.mediaTransparencyDebugState()),before,'the current owner and accepted geometry remain intact');
      assert.equal(h.enabledMessages.at(-1)[1].type,'media-geometry-accepted');
    } finally {for(const finish of blocked)finish();await off;}
  });
}
test('minimized windows are excluded without disabling other visible windows', async () => {
  const h=multipleWindows();h.windowsById.get(3).state='minimized';
  await enable(h);await drainNative(h);
  assert.deepEqual(h.enabledMessages.filter(([,m])=>m.enabled).map(([id])=>id),[7]);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  assert.deepEqual(h.sent.filter(m=>m.type==='snapshot').map(m=>m.windowId),[2]);
});
test('tab activation changes only that window and resets only its sequence', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,10);publish(h,8,10);await drainNative(h);
  h.tabsById.get(7).active=false;
  h.tabsById.set(9,{id:9,windowId:2,title:'New A',url:'https://new.example/',active:true});
  h.events.activate({windowId:2,tabId:9});await drainNative(h);
  const states=h.global.mediaTransparencyDebugState().windows;
  assert.equal(states.find(w=>w.windowId===2).tabId,9);
  assert.equal(states.find(w=>w.windowId===2).lastSequence,0);
  assert.equal(states.find(w=>w.windowId===3).tabId,8);
  assert.equal(states.find(w=>w.windowId===3).lastSequence,10);
  publish(h,9,1);await drainNative(h);
  assert.equal(h.sent.at(-1).windowId,2);assert.equal(h.sent.at(-1).title,'New A');
});
test('minimize and restore affect only the selected window owner', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  h.windowsById.get(3).state='minimized';
  h.events.bounds(h.windowsById.get(3));await drainNative(h);
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3).tabId,null);
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===2).tabId,7);
  h.windowsById.get(3).state='normal';
  h.events.bounds(h.windowsById.get(3));await drainNative(h);
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3).tabId,8);
  assert.equal(h.enabledMessages.at(-1)[0],8);assert.equal(h.enabledMessages.at(-1)[1].enabled,true);
});
test('activation metadata resolving after global OFF cannot revive a window owner', async () => {
  const h=backgroundHarness();
  let finish;
  h.chrome.windows.get=()=>new Promise(resolve=>{finish=resolve;});
  await microtasks();await h.events.click();
  h.events.ack({accepted:true,enabled:true});await microtasks();
  await h.events.click();
  finish({id:2,state:'normal',focused:true,width:1000,height:800});await microtasks();
  assert.equal(h.global.mediaTransparencyDebugState().windows[0].tabId,null);
  assert.equal(h.enabledMessages.some(([,message])=>message.enabled),false);
});

// Zoom changes supersede metadata requests already in progress for this owner.
test('zoom change discards delayed prezoom metadata without resetting page sequence or other windows', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  publish(h,7,1);publish(h,8,1);await drainNative(h);
  let finishPrezoom;
  let deferFirst=true;
  h.chrome.tabs.getZoom=async id => {
    if(id===7 && deferFirst) {
      deferFirst=false;
      return new Promise(resolve=>{finishPrezoom=resolve;});
    }
    return id===7 ? 1.25 : 1;
  };
  const oldEpoch=h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===2).epoch;
  publish(h,7,2);await microtasks();
  assert.equal(typeof finishPrezoom,'function');
  const beforeZoom=h.sent.length;
  h.events.zoom({tabId:7,newZoomFactor:1.25});
  finishPrezoom(1);
  await drainNative(h);
  const owner=h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===2);
  assert.equal(owner.epoch,oldEpoch+1);
  assert.equal(owner.lastSequence,2,'zoom retains the existing content-script sequence');
  assert.equal(h.sent.slice(beforeZoom).some(m=>m.type==='snapshot' && m.windowId===2),false,'delayed metadata cannot republish prezoom geometry');
  assert.equal(h.sent.slice(beforeZoom).filter(m=>m.type==='invalidate').every(m=>m.windowId===2),true);
  publish(h,8,2);await drainNative(h);
  assert.equal(h.sent.at(-1).windowId,3);
  publish(h,7,3,{viewport:{...vp,innerWidth:800,innerHeight:560,dpr:2.5,zoom:1.25}});
  await drainNative(h);
  assert.equal(h.sent.at(-1).type,'snapshot');
  assert.equal(h.sent.at(-1).windowId,2);
  assert.equal(h.sent.at(-1).deviceScale,2);
});

test('maximized and F11 fullscreen transitions keep every visible window active with zero toolbar offset', async () => {
  const h=multipleWindows();await enable(h);await drainNative(h);
  for (const state of ['maximized','fullscreen','normal']) {
    const window=h.windowsById.get(2);window.state=state;
    h.events.bounds(window);await drainNative(h);
    assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===2).tabId,7);
    publish(h,7,state==='maximized'?1:state==='fullscreen'?2:3,{viewport:{...vp,innerHeight:800}});
    publish(h,8,state==='maximized'?1:state==='fullscreen'?2:3);
    await drainNative(h);
    const packet=h.sent.filter(m=>m.type==='snapshot' && m.windowId===2).at(-1);
    assert.equal(packet.rects[0][1],.1225,'full-window content has no toolbar inset');
    assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3).tabId,8);
  }
});

test('DOM fullscreen protects only actual fullscreen media and restores sibling masks on exit', () => {
  const media=(left,width=200)=>({localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,getBoundingClientRect:()=>({left,top:20,right:left+width,bottom:120,width,height:100})});
  const fullscreen=media(100), sibling=media(0,1000);
  const h=contentHarness({elements:[fullscreen,sibling]});h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes.length,2);
  h.document.fullscreenElement=fullscreen;h.events.fullscreenchange();
  assert.equal(h.sent.at(-1).valid,false);
  h.frames.shift()();
  assert.equal(h.sent.at(-1).valid,true);
  assert.deepEqual(plain(h.sent.at(-1).boxes),[{left:100,top:20,right:300,bottom:120}]);
  h.document.fullscreenElement=null;h.events.fullscreenchange();h.frames.shift()();
  assert.equal(h.sent.at(-1).boxes.length,2);
});

test('fullscreen container includes open-shadow media while top-layer artwork escapes former clipping ancestors', () => {
  const hiddenAncestor={localName:'div',style:{display:'block',visibility:'visible',opacity:'0',overflow:'hidden'},getBoundingClientRect:()=>({left:0,top:0,right:10,bottom:10})};
  const root={localName:'div',parentElement:hiddenAncestor,style:{display:'block',visibility:'visible',opacity:'1',overflow:'visible'}};
  const video={localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,getRootNode:()=>({host:root}),getBoundingClientRect:()=>({left:100,top:20,right:300,bottom:120,width:200,height:100})};
  const h=contentHarness({elements:[video]});h.document.fullscreenElement=root;
  h.frames.shift()();
  assert.equal(h.sent.at(-1).valid,true);
  assert.deepEqual(plain(h.sent.at(-1).boxes),[{left:100,top:20,right:300,bottom:120}]);
});

test('zoomed fullscreen video preserves displayed content and leaves browser-generated side margins transparent', () => {
  const video={localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,videoWidth:400,videoHeight:300,
    style:{width:'800px',height:'480px',objectFit:'contain',objectPosition:'50% 50%',display:'block',visibility:'visible',opacity:'1',backgroundImage:'none'},
    getBoundingClientRect:()=>({left:0,top:0,right:800,bottom:480,width:800,height:480})};
  const h=contentHarness({elements:[video]});h.document.fullscreenElement=video;
  h.global.innerWidth=800;h.global.innerHeight=480;
  h.message()({type:'media-set-enabled-v2',enabled:true,zoom:1.25});h.frames.shift()();
  assert.deepEqual(plain(h.sent.at(-1).boxes),[{left:80,top:0,right:720,bottom:480}]);
  const result=context.MediaGeometry.normalize(h.sent.at(-1).boxes,{...h.sent.at(-1).viewport,outerWidth:1000,outerHeight:600});
  assert.equal(result.valid,true);
  assert.deepEqual(plain(result.rects),[[.098,0,.804,1]]);
});

test('global theme applies to background tabs and restores all pages on OFF', async () => {
  const h=backgroundHarness(false,{tabs:[
    {id:7,windowId:2,title:'Foreground',url:'https://one.example/',active:true},
    {id:8,windowId:2,title:'Background',url:'https://two.example/',active:false},
    {id:9,windowId:2,title:'Internal',url:'brave://settings/',active:false}
  ]});
  await enable(h);
  assert.deepEqual([...new Set(h.themeMessages.filter(([,m])=>m.enabled).map(([id])=>id))].sort(),[7,8]);
  assert.equal(h.enabledMessages.some(([id,m])=>id===8&&m.enabled),false,'background tab has no active geometry owner');
  const before=h.themeMessages.length;
  h.tabsById.get(7).active=false;h.tabsById.get(8).active=true;
  h.events.activate({windowId:2,tabId:8});await microtasks();
  assert.equal(h.themeMessages.slice(before).some(([id,m])=>id===7&&!m.enabled),false,'tab switch retains old theme');
  await h.events.click();
  assert.deepEqual(h.themeMessages.filter(([,m])=>!m.enabled).map(([id])=>id).sort(),[7,8]);
});
test('Omarchy palette is sent to all themed tabs only when it changes', async () => {
  const h=backgroundHarness();await enable(h);
  const palette={background:'#000000',foreground:'#e6e6e6',accent:'#ffdd80',opacity:.5};
  h.events.ack({accepted:true,palette});await microtasks();
  assert.deepEqual(plain(h.themeMessages.at(-1)[1].palette),palette);
  const count=h.themeMessages.length;
  h.events.ack({accepted:true,palette:{...palette}});await microtasks();
  assert.equal(h.themeMessages.length,count);
  h.events.ack({accepted:true,palette:{...palette,accent:'#aaccff'}});await microtasks();
  assert.equal(h.themeMessages.at(-1)[1].palette.accent,'#aaccff');
});
test('native failure restores page themes instead of leaving a forced dark page',async()=>{
  const h=backgroundHarness();await enable(h);
  h.events.disconnect();await microtasks();
  assert.equal(h.themeMessages.at(-1)[1].enabled,false);
  assert.equal(h.badges.at(-1),'ERR');
});
test('content keeps theme separate from geometry and ignores engine-owned mutations',()=>{
  const h=contentHarness();h.frames.shift()();
  h.message()({type:'media-theme-v1',enabled:true,palette:{accent:'#ffdd80'}});
  h.message()({type:'media-set-enabled-v2',enabled:false});
  assert.deepEqual(plain(h.themeCalls),[['enable',{accent:'#ffdd80'}]]);
  h.message()({type:'media-set-enabled-v2',enabled:true});h.frames.shift()();
  const count=h.discoveries();
  h.mutation([{owned:true}]);assert.equal(h.frames.length,0);
  h.mutation([{owned:false}]);h.frames.shift()();assert.equal(h.discoveries(),count+1);
  h.message()({type:'media-theme-v1',enabled:false});assert.equal(h.themeCalls.at(-1)[0],'disable');
  h.global.__braveMediaTransparency.dispose();assert.equal(h.themeCalls.at(-1)[0],'dispose');
});
test('bundled page scripts initialize canvas identity in MAIN before isolated theme',async()=>{
  const h=backgroundHarness();await enable(h);
  assert.equal(h.injections[0].world,'MAIN');assert.deepEqual(plain(h.injections[0].files),['canvas-context.js']);
  assert.deepEqual(plain(h.injections.find(i=>i.world!=='MAIN').files),['geometry.js','media.js','vendor/darkreader.js','theme.js','content.js']);
  assert.ok(h.injections.every(injection=>injection.injectImmediately===true),'both ordered stages avoid waiting for document idle');
});
test('an unfinished document initializes tracker and controllers without reaching document idle',async()=>{
  const h=backgroundHarness(),idleWaiters=[];let trackers=0,controllers=0;
  h.tab.status='loading';
  h.chrome.scripting.executeScript=options=>{
    h.injections.push(options);
    // Model the API boundary documented by Chrome: default execution waits
    // for document idle, while an immediate request can run on a loaded root.
    if(!options.injectImmediately)return new Promise(resolve=>idleWaiters.push(resolve));
    if(options.world==='MAIN')trackers++;
    else {assert.ok(trackers>controllers,'each controller follows its completed MAIN tracker');controllers++;}
    return Promise.resolve();
  };
  try {
    await enable(h);await drainNative(h);
    assert.equal(h.tab.status,'loading','no page completion event was fabricated');
    assert.equal(idleWaiters.length,0);assert.ok(trackers>0);assert.equal(controllers,trackers);
    assert.equal(h.enabledMessages.at(-1)[1].type,'media-set-enabled-v2');assert.equal(h.enabledMessages.at(-1)[1].enabled,true);
    assert.ok(h.themeMessages.some(([,message])=>message.enabled));
    assert.equal(h.navigations.length,0,'unfinished pages are initialized without refreshing their forms');
  } finally {for(const finish of idleWaiters)finish();await microtasks();}
});
test('injection completing after OFF cannot reenable page theme or geometry',async()=>{
  const h=backgroundHarness(),trackers=[];
  h.chrome.scripting.executeScript=options=>{
    h.injections.push(options);
    if(options.world==='MAIN')return new Promise(resolve=>trackers.push(resolve));
    return Promise.resolve();
  };
  try {
    await enable(h);await drainNative(h);assert.ok(trackers.length>0);
    await h.events.click();await drainNative(h);
    const packets=h.sent.length,messages=h.enabledMessages.length,themes=h.themeMessages.length;
    for(const finish of trackers)finish();await microtasks();
    assert.equal(h.sent.length,packets);assert.equal(h.enabledMessages.length,messages);assert.equal(h.themeMessages.length,themes);
    const state=h.global.mediaTransparencyDebugState();assert.equal(state.enabled,false);assert.equal(state.ready,false);
    assert.equal(state.windows[0].tabId,null);
  } finally {for(const finish of trackers)finish();await microtasks();}
});
test('stylesheet bridge rejects non-web sources and unauthorized senders before fetching',()=>{
  const h=backgroundHarness();const replies=[];
  for(const url of ['file:///etc/passwd','chrome://settings','https://user:secret@example.test/a.css']) {
    h.events.content({type:'theme-fetch-css',url},h.sender,value=>replies.push(value));
  }
  assert.equal(replies.length,3);assert.ok(replies.every(value=>value.ok===false));
});
test('delayed theme acknowledgement cannot reenable geometry after global OFF', async()=>{
  const h=backgroundHarness();await enable(h);await drainNative(h);
  let finish;
  const send=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=(id,message)=>{
    const result=send(id,message);
    if(message.type==='media-theme-v1' && message.enabled) return new Promise(resolve=>{finish=resolve;});
    return result;
  };
  h.events.focus(2);await microtasks();assert.equal(typeof finish,'function');
  await h.events.click();
  const count=h.enabledMessages.length;
  finish();await microtasks();
  assert.equal(h.enabledMessages.length,count);
  assert.equal(h.global.mediaTransparencyDebugState().windows[0].tabId,null);
});
test('new ON supersedes OFF waiting for page restoration and ignores obsolete native failures',async()=>{
  const h=backgroundHarness();await enable(h);await drainNative(h);
  let finish;
  const send=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=(id,message)=>{
    const result=send(id,message);
    if(message.type==='media-theme-v1' && !message.enabled) return new Promise(resolve=>{finish=resolve;});
    return result;
  };
  const off=h.events.click();await microtasks();assert.equal(typeof finish,'function');
  await h.events.click();
  h.events.ack({accepted:true,enabled:true});await drainNative(h);
  finish();await off;await microtasks();
  assert.equal(h.sent.at(-1).enabled===false && h.sent.at(-1).type==='configure',false);
  assert.equal(h.global.mediaTransparencyDebugState().enabled,true);
  assert.equal(h.global.mediaTransparencyDebugState().ready,true);
  h.chrome.tabs.sendMessage=send;
  await h.events.click(); // Complete an OFF request without delivering its replies.
  await h.events.click(); // Queue ON behind that old OFF.
  h.events.ack({accepted:false,error:'disabled'}); // Obsolete invalidation reply.
  h.events.ack({accepted:true,enabled:false}); // Obsolete configure reply.
  h.events.ack({accepted:true,enabled:true});
  await drainNative(h);
  assert.equal(h.global.mediaTransparencyDebugState().enabled,true);
  assert.equal(h.global.mediaTransparencyDebugState().ready,true);
  assert.equal(h.enabledMessages.at(-1)[1].enabled,true);
});
test('same-document URL updates retain theme ownership for global OFF restoration',async()=>{
  const h=backgroundHarness();await enable(h);await drainNative(h);
  h.tab.url='https://example.test/#next';
  h.events.update(7,{url:h.tab.url},h.tab);await microtasks();
  await h.events.click();
  assert.ok(h.themeMessages.some(([id,message])=>id===7&&!message.enabled));
});
test('window close permanently revokes native identity even after final tab removed its state',async()=>{
  const h=multipleWindows();await enable(h);await drainNative(h);
  h.events.remove(7,{isWindowClosing:true,windowId:2});await microtasks();
  assert.equal(h.global.mediaTransparencyDebugState().windows.some(w=>w.windowId===2),false);
  h.events['window-remove'](2);
  assert.equal(h.sent.at(-1).type,'invalidate');
  assert.equal(h.sent.at(-1).windowId,2);
  assert.equal(h.sent.at(-1).reason,'window-closed');
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3).tabId,8);
});
test('only owned New Tab URLs are accepted without native page script injection',async()=>{
  for(const url of ['chrome-extension://fixture/newtab.html','chrome://newtab','chrome://newtab/','brave://newtab','brave://newtab/']) {
    const h=backgroundHarness(false,{tabs:[{id:7,windowId:2,title:'New Tab',url,active:true}]});
    await enable(h);await drainNative(h);
    assert.equal(h.global.mediaTransparencyDebugState().windows[0].tabId,7);
    assert.equal(h.injections.length,0);
    assert.ok(h.themeMessages.some(([,m])=>m.enabled));
    h.newTabPages.get(7).flushFrames();await drainNative(h);
    assert.equal(h.sent.at(-1).type,'snapshot');
    assert.deepEqual(plain(h.sent.at(-1).rects),[]);
  }
  for(const url of ['chrome-extension://other/newtab.html','chrome-extension://fixture/options.html','brave://version/','brave://newtab/evil']) {
    const h=backgroundHarness(false,{tabs:[{id:7,windowId:2,title:'Other',url,active:true}]});
    await enable(h);await drainNative(h);
    assert.equal(h.global.mediaTransparencyDebugState().windows[0].tabId,null);
    assert.equal(h.injections.length,0);assert.equal(h.themeMessages.length,0);
  }
});
test('trusted native WebUI gets browser metadata heartbeat without injection or page theming',async()=>{
  for(const scheme of ['chrome','brave']) for(const host of ['settings','extensions','flags','history','downloads','bookmarks']) {
    const tab={id:7,windowId:2,title:'Internal UI',url:`${scheme}://${host}/subpage`,active:true};
    const h=backgroundHarness(false,{tabs:[tab]});await enable(h);await drainNative(h);
    const packet=h.sent.find(m=>m.type==='native-ui');
    assert.equal(packet.url,tab.url);assert.equal(packet.outerWidth,1000);assert.equal(packet.outerHeight,800);
    assert.equal('deviceScale' in packet,false);assert.equal('rects' in packet,false);
    assert.equal(h.injections.length,0);assert.equal(h.themeMessages.length,0);
    h.windowsById.get(2).focused=false;
    h.events['native-ui-tick']();await drainNative(h);
    assert.equal(h.sent.at(-1).focused,false);
    const count=h.sent.length;h.events.content(sample(1),{frameId:0,tab});await microtasks();
    assert.equal(h.sent.length,count,'DOM messages cannot override a browser-owned native UI policy');
    await h.events.click();
    h.events['native-ui-tick']();await microtasks();
    assert.equal(h.sent.at(-1).type,'configure');assert.equal(h.sent.at(-1).enabled,false);
  }
});
test('hostile page titles and lookalike internal origins cannot authorize native UI policy',async()=>{
  for(const url of ['https://evil.test/','chrome://settings.evil/','chrome://evil@settings/','chrome://settings:80/',
      'chrome://devtools/','chrome://pdf/','brave://wallet/','chrome-extension://other/settings/']) {
    const h=backgroundHarness(false,{tabs:[{id:7,windowId:2,title:'Settings',url,active:true}]});
    await enable(h);await drainNative(h);h.events['native-ui-tick']();await drainNative(h);
    assert.equal(h.sent.some(m=>m.type==='native-ui'),false);
  }
});
test('native UI navigation supersedes pending metadata and reactivates same-document settings routes',async()=>{
  const h=multipleWindows();h.tabsById.get(7).url='chrome://settings/';
  await enable(h);await drainNative(h);
  let finish;
  const get=h.chrome.tabs.get;
  let delay=true;
  h.chrome.tabs.get=id=>id===7&&delay ? (delay=false,new Promise(resolve=>{finish=resolve;})) : get(id);
  h.events['native-ui-tick']();await microtasks();
  const tab=h.tabsById.get(7);tab.url='chrome://settings/privacy';
  h.events.update(7,{url:tab.url},tab);await drainNative(h);
  const packet=h.sent.filter(m=>m.type==='native-ui').at(-1);
  assert.equal(packet.url,tab.url);
  const count=h.sent.length;
  finish({...tab,url:'chrome://settings/'});await microtasks();
  assert.equal(h.sent.length,count,'pre-navigation metadata cannot revive the obsolete policy');
  tab.url='chrome://devtools/';
  h.events.update(7,{url:tab.url},tab);await drainNative(h);
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===2).tabId,null);
  assert.equal(h.global.mediaTransparencyDebugState().windows.find(w=>w.windowId===3).tabId,8);
});
test('native UI polls reject older metadata and cannot publish after global OFF',async()=>{
  const tab={id:7,windowId:2,title:'Settings',url:'chrome://settings/',active:true};
  const h=backgroundHarness(false,{tabs:[tab]});await enable(h);await drainNative(h);
  const get=h.chrome.tabs.get;let finish;
  h.chrome.tabs.get=()=>new Promise(resolve=>{finish=resolve;});
  h.events['native-ui-tick']();await microtasks();const old=finish;
  h.chrome.tabs.get=get;
  h.events['native-ui-tick']();await drainNative(h);
  let count=h.sent.length;
  old({...tab,title:'Obsolete title'});await microtasks();assert.equal(h.sent.length,count);
  h.chrome.tabs.get=()=>new Promise(resolve=>{finish=resolve;});
  h.events['native-ui-tick']();await microtasks();
  await h.events.click();count=h.sent.length;
  finish(tab);await microtasks();assert.equal(h.sent.length,count);
  assert.equal(h.global.mediaTransparencyDebugState().ready,false);
});
test('native UI timing uses its browser-owned capture and preserves sequence metadata outside the protocol',async()=>{
  let now=1000;
  const tab={id:7,windowId:2,title:'Settings',url:'chrome://settings/',active:true};
  const h=backgroundHarness(false,{tabs:[tab],now:()=>now});await enable(h);await drainNative(h);
  const get=h.chrome.tabs.get;let resolveMetadata;
  h.chrome.tabs.get=()=>new Promise(resolve=>{resolveMetadata=resolve;});
  now=1100;h.events['native-ui-tick']();
  const publication=h.global.mediaTransparencyDebugState().publications.at(-1);
  assert.equal(publication.kind,'native-ui');assert.equal(publication.receivedAt,1100);assert.equal(publication.capturedAt,null);
  now=1150;resolveMetadata(tab);await microtasks();
  assert.equal(publication.metadataReadyAt,1150);assert.equal(publication.capturedAt,1150);assert.equal(publication.nativePostedAt,1150);
  assert.equal(h.sent.at(-1).capturedAt,1150);assert.equal(Object.hasOwn(h.sent.at(-1),'sequence'),false);
  h.chrome.tabs.get=get;
  now=1180;h.events.ack({accepted:true});
  assert.equal(publication.nativeReplyAt,1180);assert.equal(publication.obsolete,false);
  assert.equal(h.global.mediaTransparencyDebugState().lastNativeResult.sequence,publication.sequence);
});

test('working New Tab proves current geometry health before activation and publishes real empty geometry', async () => {
  const tabs=[{id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:true}];
  const h=backgroundHarness(false,{tabs}); await enable(h);await drainNative(h);
  const page=h.newTabPages.get(7);
  assert.ok(page.requests.some(message=>message.type==='media-newtab-status-v1'));
  assert.ok(page.requests.some(message=>message.type==='media-set-enabled-v2'&&message.enabled));
  page.flushFrames();await drainNative(h);
  assert.equal(h.global.mediaTransparencyDebugState().lastSample.valid,true);
  assert.equal(h.global.mediaTransparencyDebugState().lastSample.boxCount,0);
  assert.equal(h.global.mediaTransparencyDebugState().lastNativeResult.accepted,true);
  assert.equal(h.navigations.length,0);assert.equal(page.reloads.length,0);assert.equal(h.injections.length,0);
});
test('missing, disposed and obsolete geometry recover once per owned document despite an independent working palette listener', async () => {
  for(const controller of ['missing','disposed','obsolete']) for(const url of ['chrome://newtab/','chrome-extension://fixture/newtab.html']) {
    const tab={id:7,windowId:2,title:'New Tab',url,status:'complete',active:true};
    const page=ownedNewTabPage({controller}), h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])});
    page.input.value='unsubmitted search';page.input.setSelectionRange(2,8,'backward');page.input.focus();
    await enable(h);await drainNative(h);
    assert.equal(page.reloads.length,1,controller);
    assert.equal(page.requests.filter(message=>message.type==='media-newtab-recover-v1').length,1,'parallel theme and activation share recovery');
    assert.equal(h.injections.length,0);assert.equal(h.navigations.length,0,'the page owns its refresh');
    assert.equal(h.sent.some(message=>message.type==='snapshot'),false,'a successful palette receiver cannot fabricate geometry');
    const saved=JSON.parse(page.storage.get('brave-media-newtab-draft-v1'));
    assert.equal(saved.value,'unsubmitted search');assert.equal(saved.start,2);assert.equal(saved.end,8);
    h.events.focus(2);await microtasks();
    assert.equal(page.reloads.length,1,'same-document focus does not loop refresh');
    assert.match(h.global.mediaTransparencyDebugState().statusReason,/awaiting current controller/);
  }
});
test('new documents in the same browser tab get independent recovery and restore their saved draft', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:false};
  const first=ownedNewTabPage({controller:'disposed'}),pages=new Map([[7,first]]);
  first.input.value='saved through two replacements';first.inputEvents.input();
  const h=backgroundHarness(false,{tabs:[tab],newTabPages:pages});await enable(h);await microtasks();
  assert.equal(first.reloads.length,1);
  const second=ownedNewTabPage({controller:'missing',storage:first.storage});pages.set(7,second);second.connect(h,7);
  assert.equal(second.input.value,'saved through two replacements');
  h.events.update(7,{status:'complete'},tab);await microtasks();
  assert.equal(second.reloads.length,1);
  const third=ownedNewTabPage({storage:second.storage});pages.set(7,third);third.connect(h,7);
  h.events.update(7,{status:'complete'},tab);await microtasks();
  assert.equal(third.reloads.length,0);assert.equal(third.input.value,'saved through two replacements');
});
test('legacy palette-only and unavailable New Tab documents preserve unreported drafts without blind migration', async () => {
  for(const reply of ['legacy','none','reject']) for(const url of ['chrome://newtab/','chrome-extension://fixture/newtab.html']) {
    const tab={id:7,windowId:2,title:'New Tab',url,status:'complete',active:true};
    const h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map()});
    h.chrome.tabs.sendMessage=async()=>{
      if(reply==='reject')throw new Error('Extension context invalidated');
      return reply==='legacy'?{newtab:true}:undefined;
    };
    await enable(h);await drainNative(h);
    assert.equal(h.navigations.length,0);assert.equal(h.injections.length,0);
    assert.equal(h.sent.some(message=>message.type==='snapshot'),false);
    assert.match(h.global.mediaTransparencyDebugState().statusReason,/cannot report its search draft.*preserved/);
  }
});
test('failed ordinary pages and arbitrary internal URLs never trigger New Tab recovery', async () => {
  const tabs=['https://example.test/','chrome://newtab/?query=1','chrome://newtab/other','chrome://settings/','chrome-extension://other/newtab.html'].map((url,i)=>({id:7+i,windowId:2,title:'New Tab',url,status:'complete',active:i===0}));
  const h=backgroundHarness(false,{tabs});
  h.chrome.tabs.sendMessage=async()=>{throw new Error('No receiver');};
  await enable(h); await microtasks(); assert.equal(h.navigations.length,0);
});
test('owned New Tab recovery preserves loading documents and pending or completed user navigation', async () => {
  for (const current of [
    {url:'chrome://newtab/',status:'loading'},
    {url:'chrome://newtab/',status:'complete',pendingUrl:'https://example.test/'},
    {url:'https://example.test/',status:'complete'},
  ]) {
    const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:false};
    const page=ownedNewTabPage({controller:'disposed'});
    const h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])});
    h.chrome.tabs.get=async()=>({...tab,...current});
    await enable(h); await microtasks(); assert.equal(page.reloads.length,0);assert.equal(h.navigations.length,0);
  }
});
test('an OFF transition cancels pending owned New Tab recovery', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:false};
  const page=ownedNewTabPage({controller:'disposed'}),h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])}); let resolve;
  h.chrome.tabs.get=()=>new Promise(done=>{resolve=done;});
  await enable(h); assert.equal(typeof resolve,'function');
  await h.events.click(); resolve(tab); await microtasks();
  assert.equal(h.navigations.length,0);assert.equal(page.reloads.length,0);
});
test('a document replaced after health inspection cannot be refreshed by the old recovery request', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:false};
  const first=ownedNewTabPage({controller:'missing'}),second=ownedNewTabPage({controller:'disposed'}),pages=new Map([[7,first]]);
  const h=backgroundHarness(false,{tabs:[tab],newTabPages:pages});
  h.chrome.tabs.get=async()=>{pages.set(7,second);second.connect(h,7);return tab;};
  await enable(h);await microtasks();
  assert.equal(first.reloads.length,0);assert.equal(second.reloads.length,0);
});
test('search submission between background metadata validation and recovery message wins', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:false};
  const page=ownedNewTabPage({controller:'disposed'}),h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])});
  page.input.value='example.com';const send=h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage=async(id,message)=>{if(message.type==='media-newtab-recover-v1')page.submit();return send(id,message);};
  await enable(h);await microtasks();
  assert.equal(page.content.global.location.href,'https://example.com/');assert.equal(page.reloads.length,0);
});
test('healthy owned New Tab awaiting browser navigation is not reactivated', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:true};
  const page=ownedNewTabPage(),h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])});
  page.content.events.beforeunload();await enable(h);await drainNative(h);
  assert.equal(page.requests.some(message=>message.type==='media-set-enabled-v2'&&message.enabled),false);
  assert.equal(page.reloads.length,0);
  assert.match(h.global.mediaTransparencyDebugState().statusReason,/navigation is in progress/);
});
test('draft storage failure leaves unavailable owned New Tab input intact', async () => {
  const tab={id:7,windowId:2,title:'New Tab',url:'chrome://newtab/',status:'complete',active:true};
  const page=ownedNewTabPage({controller:'disposed',blockedStorage:true}),h=backgroundHarness(false,{tabs:[tab],newTabPages:new Map([[7,page]])});
  page.input.value='keep unsaved input';await enable(h);await drainNative(h);
  assert.equal(page.reloads.length,0);assert.equal(page.input.value,'keep unsaved input');
  assert.match(h.global.mediaTransparencyDebugState().statusReason,/could not be saved.*preserved/);
});
