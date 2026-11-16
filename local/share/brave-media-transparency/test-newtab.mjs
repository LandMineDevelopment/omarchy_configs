import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./extension/newtab.js', import.meta.url), 'utf8');
let nextDocument = 0;
function harness({storage = new Map(), controller, initialValue = '', blockedStorage = false} = {}) {
  let submit, message, focused = 0;
  const events = {}, windowEvents = {}, reloads = [];
  const destinations = [], properties = new Map(), changes = [];
  const input = { value: initialValue, selectionStart:0, selectionEnd:0, selectionDirection:'none',
    focus() { focused++; context.document.activeElement = input; events.focus?.(); },
    addEventListener(name, fn) { events[name] = fn; },
    setSelectionRange(start,end,direction) { input.selectionStart=start;input.selectionEnd=end;input.selectionDirection=direction; },
  };
  const context = {
    URL, crypto:{randomUUID:()=>`document-${++nextDocument}`}, __braveMediaTransparency:controller,
    addEventListener(name,fn) { windowEvents[name]=fn; },
    sessionStorage: {
      getItem(key) { if(blockedStorage) throw new Error('Storage unavailable');return storage.get(key) ?? null; },
      setItem(key,value) { if(blockedStorage) throw new Error('Storage unavailable');storage.set(key,value); },
      removeItem(key) { storage.delete(key); },
    },
    document: {
      activeElement:null,
      getElementById(id) { return id === 'navigation' ? { addEventListener(_event, fn) { submit = fn; } } : input; },
      documentElement: { style: {
        getPropertyValue(name) { return properties.get(name) || ''; },
        setProperty(name, value) { properties.set(name, value); changes.push([name, value]); },
      } },
    },
    location: { href:'chrome-extension://fixture/newtab.html',assign(url) { destinations.push(url); },reload() { reloads.push(true); } },
    chrome: { runtime: { onMessage: { addListener(fn) { message = fn; } } } },
  };
  vm.runInNewContext(source, context);
  return { destination: context.NewTabNavigation.destination, destinations, input, properties, changes, context, storage, reloads,
    focused: () => focused, event:name=>events[name](), windowEvent:name=>windowEvents[name](),
    message: value => {let response;message(value,{},value=>{response=value;});return response;},
    submit: () => submit({ preventDefault() {} }) };
}

test('explicit web addresses and local developer endpoints navigate directly', () => {
  const { destination } = harness();
  for (const [input, expected] of [
    ['https://example.com/path?q=1#anchor', 'https://example.com/path?q=1#anchor'],
    ['http://example.com', 'http://example.com/'],
    [' example.com/docs ', 'https://example.com/docs'],
    ['example.com:8443', 'https://example.com:8443/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['dashboard.localhost:8080/a', 'http://dashboard.localhost:8080/a'],
    ['127.0.0.1:5000', 'http://127.0.0.1:5000/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['https://münich.example', 'https://xn--mnich-kva.example/'],
  ]) assert.equal(destination(input), expected, input);
});

test('search text is encoded and executable or unknown schemes are never opened', () => {
  const { destination } = harness();
  for (const input of ['floating in space', 'C++ & CSS', 'javascript:alert(1)', 'data:text/html,hello',
    'file:///home/kasey', 'person@example.com', 'example.com:bad', 'https://', '2026', '.', 'foo..bar']) {
    const result = new URL(destination(input));
    assert.equal(result.origin, 'https://search.brave.com', input);
    assert.equal(result.searchParams.get('q'), input);
  }
  assert.equal(destination(' \n '), null);
});

test('submit navigates once and leaves the browser address bar focus alone on startup', () => {
  const h = harness();
  assert.equal(h.focused(), 0);
  h.input.value = 'localhost:5173'; h.submit();
  assert.deepEqual(h.destinations, ['http://localhost:5173/']);
  h.input.value = '   '; h.submit();
  assert.equal(h.focused(), 1);
  assert.equal(h.destinations.length, 1);
});

test('Omarchy palette updates are validated and do not repeat DOM mutations', () => {
  const h = harness();
  h.message({ type: 'media-theme-v1', enabled: true, palette: {
    background: '#181b25', foreground: '#cdd6f4', accent: '#f9e2af', selection: '#f9e2af', selectionForeground: '#111111',
  } });
  assert.equal(h.changes.length, 5);
  assert.equal(h.properties.get('background-color'), '#181b25');
  assert.equal(h.properties.get('--selection'), '#f9e2af');
  assert.equal(h.properties.get('--accent'), '#f9e2af');
  h.message({ type: 'media-theme-v1', palette: { foreground: '#cdd6f4', accent: '#f9e2af' } });
  assert.equal(h.changes.length, 5);
  h.message({ type: 'media-theme-v1', palette: { background: 'url(https://example.com)', foreground: 'url(https://example.com)', accent: '#fffff', selectionForeground: null } });
  h.message({ type: 'unrelated', palette: { accent: '#fff' } });
  assert.equal(h.changes.length, 5);
});

test('New Tab bundles local CSP-compatible files without photos, widgets, or autofocus', async () => {
  const html = await readFile(new URL('./extension/newtab.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="geometry\.js" defer><\/script>/);
  assert.match(html, /<script src="content\.js" defer><\/script>/);
  assert.match(html, /<script src="newtab\.js" defer><\/script>/);
  assert.match(html, /<label for="destination"/);
  assert.match(html, /id="search-provider">Brave Search/);
  assert.doesNotMatch(html, /autofocus|<img|<iframe|<canvas|<script\s*>|\bon\w+=|(?:src|href)="https?:/i);
});

test('health identifies the actual missing, obsolete and disposed geometry controller', () => {
  for (const [controller,version,disposed] of [
    [undefined,null,true],
    [{version:'0.2.45',isDisposed:()=>false},'0.2.45',false],
    [{version:'0.2.48',isDisposed:()=>true},'0.2.48',true],
    [{version:'0.2.48',isDisposed:()=>false},'0.2.48',false],
  ]) {
    const h=harness({controller}), response=h.message({type:'media-newtab-status-v1'});
    assert.equal(response.newtab,true);assert.equal(response.contract,1);
    assert.equal(response.url,h.context.location.href);
    assert.deepEqual({...response.controller},{version,disposed});
    assert.equal(response.draftSaved,true);assert.equal(h.reloads.length,0);
  }
});

test('recovery saves latest typing and restores exact draft, selection and focus in the replacement document', () => {
  const h=harness();
  const status=h.message({type:'media-newtab-status-v1'});
  h.input.value='  latest search & draft  ';
  h.input.setSelectionRange(3,15,'backward');h.input.focus();
  const result=h.message({type:'media-newtab-recover-v1',document:status.document,version:'0.2.48'});
  assert.equal(result.reloading,true);assert.equal(h.reloads.length,1);
  h.context.document.activeElement=null;h.input.setSelectionRange(0,0,'none');h.event('blur');h.event('select');
  h.message({type:'media-newtab-recover-v1',document:status.document,version:'0.2.48'});
  assert.equal(h.reloads.length,1);
  const replacement=harness({storage:h.storage});
  assert.equal(replacement.input.value,h.input.value);
  assert.equal(replacement.input.selectionStart,3);assert.equal(replacement.input.selectionEnd,15);
  assert.equal(replacement.input.selectionDirection,'backward');assert.equal(replacement.focused(),1);
  assert.notEqual(replacement.message({type:'media-newtab-status-v1'}).document,status.document);
});

test('draft DOM persistence remains independent of extension API invalidation', () => {
  const h=harness();
  delete h.context.chrome.runtime;
  h.input.value='survives an invalidated extension';h.input.setSelectionRange(4,9,'forward');
  h.event('input');
  const replacement=harness({storage:h.storage});
  assert.equal(replacement.input.value,h.input.value);
  assert.equal(replacement.input.selectionStart,4);assert.equal(replacement.input.selectionEnd,9);
  assert.equal(replacement.focused(),0,'address bar focus is preserved when the search input was not focused');
});

test('submitted or browser-started navigation and mismatched documents cannot be overwritten by recovery', () => {
  for (const action of ['submit','browser-navigation','different-document']) {
    const h=harness();h.input.value='example.com';
    const status=h.message({type:'media-newtab-status-v1'});
    if(action==='submit') h.submit();
    if(action==='browser-navigation') h.windowEvent('beforeunload');
    const response=h.message({type:'media-newtab-recover-v1',version:'0.2.48',
      document:action==='different-document'?'another-document':status.document});
    assert.equal(response.reloading,false);assert.equal(h.reloads.length,0);
    if(action==='submit') assert.deepEqual(h.destinations,['https://example.com/']);
  }
});

test('a controller repaired between status and recovery avoids an unnecessary refresh', () => {
  const h=harness(), status=h.message({type:'media-newtab-status-v1'});
  h.context.__braveMediaTransparency={version:'0.2.48',isDisposed:()=>false};
  const response=h.message({type:'media-newtab-recover-v1',document:status.document,version:'0.2.48'});
  assert.equal(response.reloading,false);assert.equal(response.controller.disposed,false);
  assert.equal(h.reloads.length,0);
});

test('storage failure preserves the live input without refreshing', () => {
  const h=harness({blockedStorage:true});h.input.value='unsaved user text';
  const status=h.message({type:'media-newtab-status-v1'});
  assert.equal(status.draftSaved,false);
  const response=h.message({type:'media-newtab-recover-v1',document:status.document,version:'0.2.48'});
  assert.equal(response.reloading,false);assert.equal(h.input.value,'unsaved user text');
  assert.equal(h.reloads.length,0);
});

test('stored drafts cannot replace browser-restored input, and malformed storage is ignored', () => {
  const first=harness();first.input.value='stored draft';first.event('input');
  assert.equal(harness({storage:first.storage,initialValue:'newer browser input'}).input.value,'newer browser input');
  first.storage.set('brave-media-newtab-draft-v1','{"value":"bad","start":0,"end":400,"direction":"none","focused":true}');
  const malformed=harness({storage:first.storage});
  assert.equal(malformed.input.value,'');assert.equal(malformed.focused(),0);
});

const braveExecutable = ['/opt/brave-bin/brave', '/usr/bin/brave'].find(existsSync);
test('real virtual New Tab reload falls back while deliberate same-tab navigation restores its isolated draft',
  {timeout:30000,skip:!braveExecutable}, async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'brave-newtab-reload-'));
  const extension=path.join(directory,'extension'), profile=path.join(directory,'profile');
  let child, socket, exited;
  const pending=new Map();
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const eventually=async(read,accept,label)=>{
    const deadline=Date.now()+7000;let value,error;
    do {
      try {value=await read();error=null;if(accept(value))return value;} catch(caught) {error=caught;}
      await delay(20);
    } while(Date.now()<deadline);
    assert.fail(`${label}: ${error?.message || JSON.stringify(value)}`);
  };
  try {
    await cp(new URL('./extension/',import.meta.url),extension,{recursive:true});
    // The fresh profile's default global switch is OFF. Do not connect to the
    // native host or use the user's flags, profile, tabs or compositor window.
    child=spawn(braveExecutable,['--headless=new','--disable-gpu','--disable-background-networking',
      '--disable-component-update','--no-first-run','--no-default-browser-check','--mute-audio',
      `--disable-extensions-except=${extension}`,`--load-extension=${extension}`,
      `--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],
      {stdio:['ignore','ignore','pipe'],detached:true});
    exited=new Promise(resolve=>child.once('exit',resolve));
    let logs='';child.stderr.on('data',chunk=>{if(logs.length<2000)logs+=chunk;});
    const portFile=path.join(profile,'DevToolsActivePort');
    await eventually(()=>existsSync(portFile),Boolean,`isolated Brave startup: ${logs}`);
    const [port,browserPath]=(await readFile(portFile,'utf8')).trim().split('\n');
    socket=new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});
    });
    let id=0;
    socket.addEventListener('message',event=>{
      const response=JSON.parse(event.data),request=pending.get(response.id);if(!request)return;
      pending.delete(response.id);clearTimeout(request.timer);
      response.error?request.reject(new Error(response.error.message)):request.resolve(response.result);
    });
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error(`${method}: browser response timed out`));},8000);
      pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params,sessionId}));
    });
    const attach=async targetId=>(await call('Target.attachToTarget',{targetId,flatten:true})).sessionId;
    const create=async url=>{
      const {targetId}=await call('Target.createTarget',{url});return {targetId,sessionId:await attach(targetId)};
    };
    const evaluate=async(sessionId,expression)=>{
      const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
      assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
      return result.result.value;
    };
    const pageState=sessionId=>evaluate(sessionId,`(() => {
      const input=document.getElementById('destination');
      return {href:location.href,ready:document.readyState,hasInput:!!input,value:input?.value,
        selection:[input?.selectionStart,input?.selectionEnd,input?.selectionDirection],
        draft:sessionStorage.getItem('brave-media-newtab-draft-v1')};
    })()`);
    const original=await create('chrome://newtab/');
    const initial=await eventually(()=>pageState(original.sessionId),state=>state.ready==='complete'&&state.hasInput,'virtual New Tab resolves to the override');
    const ownURL=initial.href;assert.match(ownURL,/^chrome-extension:\/\/[a-p]{32}\/newtab\.html$/);
    assert.equal((await call('Target.getTargetInfo',{targetId:original.targetId})).targetInfo.url,'chrome://newtab/',
      'browser-owned virtual URL differs from the loaded extension document');
    const worker=await eventually(async()=>{
      const {targetInfos}=await call('Target.getTargets');return targetInfos.find(target=>target.type==='service_worker'&&target.url===new URL('background.js',ownURL).href);
    },Boolean,'isolated extension worker starts');
    const workerSession=await attach(worker.targetId);
    assert.equal(await evaluate(workerSession,'mediaTransparencyDebugState().enabled'),false,'native effect stays OFF');
    const draft='isolated reload draft';
    await evaluate(original.sessionId,`(() => {
      const input=document.getElementById('destination');input.value=${JSON.stringify(draft)};
      input.focus();input.setSelectionRange(3,9,'backward');
      input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('select'));
      return true;
    })()`);
    const saved=await pageState(original.sessionId);
    assert.equal(saved.value,draft);assert.deepEqual(saved.selection,[3,9,'backward']);
    assert.equal(JSON.parse(saved.draft).value,draft);
    const extensions=await create('chrome://extensions/');
    await eventually(()=>evaluate(extensions.sessionId,'typeof chrome.developerPrivate?.getProfileConfiguration'),value=>value==='function','native Extensions API is ready');
    await evaluate(extensions.sessionId,`chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});true`);
    await eventually(()=>evaluate(extensions.sessionId,'new Promise(resolve=>chrome.developerPrivate.getProfileConfiguration(resolve))'),info=>info.inDeveloperMode===true,'isolated Developer mode enabled');
    const extensionId=new URL(ownURL).hostname;
    const result=await evaluate(extensions.sessionId,`new Promise(resolve=>chrome.developerPrivate.reload(${JSON.stringify(extensionId)},
      {failQuietly:true,populateErrorForUnpacked:true},()=>resolve({error:chrome.runtime.lastError?.message || null})))`);
    assert.equal(result.error,null,'Extensions UI backend completes the unpacked reload');
    const information=await evaluate(extensions.sessionId,`new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo(
      {includeDisabled:true,includeTerminated:true},items=>resolve(items.find(item=>item.id===${JSON.stringify(extensionId)}))))`);
    assert.equal(information.state,'ENABLED');assert.deepEqual(information.manifestErrors,[]);assert.deepEqual(information.runtimeErrors,[]);
    const fallback=await eventually(()=>pageState(original.sessionId),state=>state.ready==='complete'&&state.href==='chrome://newtab/'&&!state.hasInput,'unload falls back to native New Tab');
    assert.equal(fallback.draft,null,'native origin cannot read the extension-origin draft');
    await call('Page.reload',{},original.sessionId);
    const reloaded=await eventually(()=>pageState(original.sessionId),state=>state.ready==='complete'&&state.href==='chrome://newtab/','plain reload completes');
    assert.equal(reloaded.hasInput,false,'Reload retains the native internal entry rather than reapplying the override');
    // This deliberate fresh virtual navigation is an isolated test action, not
    // permission to migrate native dashboards or overwrite user input in production.
    await call('Page.navigate',{url:'chrome://newtab/'},original.sessionId);
    const restored=await eventually(()=>pageState(original.sessionId),state=>state.ready==='complete'&&state.hasInput,'same-tab fresh virtual navigation reapplies the override');
    assert.equal(restored.href,ownURL);assert.equal(restored.value,draft);assert.deepEqual(restored.selection,[3,9,'backward']);
    const fresh=await create('chrome://newtab/');
    const freshState=await eventually(()=>pageState(fresh.sessionId),state=>state.ready==='complete'&&state.hasInput,'fresh virtual New Tab resolves independently');
    assert.equal(freshState.href,ownURL);assert.equal(freshState.value,'');assert.equal(freshState.draft,null,'saved draft is scoped to its original browser tab');
    const newWorker=await eventually(async()=>{
      const {targetInfos}=await call('Target.getTargets');return targetInfos.find(target=>target.type==='service_worker'&&target.url===new URL('background.js',ownURL).href);
    },Boolean,'reloaded extension worker starts');
    assert.equal(await evaluate(await attach(newWorker.targetId),'mediaTransparencyDebugState().enabled'),false,'native effect remains OFF after reload');
  } finally {
    for(const {timer} of pending.values())clearTimeout(timer);pending.clear();socket?.close();
    if(child) {
      try {process.kill(-child.pid,'SIGTERM');} catch(error) {if(error.code!=='ESRCH')throw error;}
      let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);
      try {process.kill(-child.pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH')throw error;}
    }
    await rm(directory,{recursive:true,force:true});
  }
});
