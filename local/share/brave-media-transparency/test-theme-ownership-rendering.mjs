import {readFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {gunzipSync,inflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';

const theme=readFileSync(new URL('./extension/theme.js',import.meta.url),'utf8');
const legacyTheme=gunzipSync(readFileSync(new URL('./fixtures/theme-0.2.45.js.gz',import.meta.url))).toString('utf8');
const vendor=readFileSync(new URL('./extension/vendor/darkreader.js',import.meta.url),'utf8');
const geometry=readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const palette={background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'};
const image=color=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`)}`;

// Decode native Chromium paint rather than infer visible behavior from styles.
function pixels(png) {
  let width,height,channels;const chunks=[];
  for(let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+length);
    if(type==='IHDR') {width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);}
    if(type==='IDAT') chunks.push(data);offset+=length+12;
  }
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,result=Buffer.alloc(stride*height);let input=0;
  const paeth=(a,b,c)=>{const p=a+b-c,aa=Math.abs(p-a),bb=Math.abs(p-b),cc=Math.abs(p-c);return aa<=bb&&aa<=cc?a:bb<=cc?b:c;};
  for(let y=0;y<height;y++) {
    const filter=raw[input++];assert.ok(filter<=4);
    for(let x=0;x<stride;x++) {
      const at=y*stride+x,left=x>=channels?result[at-channels]:0,up=y?result[at-stride]:0,corner=y&&x>=channels?result[at-stride-channels]:0;
      result[at]=(raw[input++]+(filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,corner):0))&255;
    }
  }
  return (x,y)=>[...result.subarray((y*width+x)*channels,(y*width+x)*channels+3)];
}

const html=`<!doctype html><style>
html,body{margin:0;height:100%;background-color:#323437;color:#ccc}
body{background-image:url("${image('rgb(27,63,99)')}");background-size:20px 20px}
header{display:flex;align-items:center;position:fixed;top:0;left:0;right:0;height:50px;background:rgba(30,80,100,.8)}
#art{position:absolute;left:20px;top:80px;color:rgb(18,52,86)}
#photo{position:absolute;left:440px;top:80px;width:100px;height:80px}
#selected{position:absolute;left:20px;top:190px;width:160px;height:40px;padding:0;border:0;background:#ddd}
#selected-label{display:block;background:#ddd;color:#222;width:100%;height:100%}
#compact-slot{position:absolute;left:210px;top:190px}
#compact{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:160px;height:40px;padding:8px 20px;background:#ddd;color:#222;border-radius:24px}
#shell{position:absolute;left:20px;top:250px;box-sizing:border-box;width:220px;height:36px;border:1px solid #888;border-radius:18px;padding:3px 10px}
#field{box-sizing:border-box;width:190px;height:28px;border:0;background:transparent;color:#ccc}
x-controls{position:absolute;left:20px;top:310px;display:block;width:400px;height:140px}
</style><header id="header">Navigation<input id="draft" value="Unsubmitted form draft"></header>
<svg id="art" width="200" height="80"><rect width="200" height="80" fill="currentColor"></rect></svg>
<img id="photo" alt="Meaningful red picture" src="${image('red')}">
<button id="selected" aria-selected="true"><span id="selected-label">Selected label</span></button>
<div id="compact-slot"><a id="compact" href="#panel">Compact action</a></div><div id="shell"><input id="field" value="Field value"></div><x-controls></x-controls>`;

// All realms share this exact document and live markers, while each retains its
// own API closures, observers, engine and scheduled animation-frame callbacks.
const snapshotExpression=`(() => {
  const shadow=document.querySelector('x-controls').shadowRoot;
  const nodes={header:document.querySelector('#header'),body:document.body,art:document.querySelector('#art'),label:document.querySelector('#selected-label'),compact:document.querySelector('#compact'),field:document.querySelector('#field'),shadowHeader:shadow.querySelector('header'),shadowArt:shadow.querySelector('svg')};
  const attrs=node=>Object.fromEntries(node.getAttributeNames().filter(name=>name.startsWith('data-brave-media-')).map(name=>[name,node.getAttribute(name)]));
  const roots=[document,shadow],sheets=roots.flatMap(root=>[...root.querySelectorAll('style[data-brave-media-theme-style]')]);
  const draft=document.querySelector('#draft');
  return {
    markers:Object.fromEntries(Object.entries(nodes).map(([name,node])=>[name,attrs(node)])),
    fills:Object.fromEntries(['header','body','shadowHeader'].map(name=>[name,getComputedStyle(nodes[name]).backgroundColor])),
    art:getComputedStyle(nodes.art).color,shadowArt:getComputedStyle(nodes.shadowArt).color,
    wallpaper:getComputedStyle(document.body).backgroundImage,
    labelFill:getComputedStyle(nodes.label).backgroundColor,
    sheets:sheets.map(sheet=>({kind:sheet.getAttribute('data-brave-media-theme-style'),owner:sheet.getAttribute('data-brave-media-theme-owner'),shadow:sheet.getRootNode()===shadow})),
    generatedMarkers:roots.reduce((total,root)=>total+[...root.querySelectorAll('*')].filter(node=>Object.entries(attrs(node)).some(([name,value])=>name==='data-brave-media-theme-style'||/^bm-[a-z0-9-]+~/.test(value)||value==='true'||/^(before|after)-(checkbox|radio)-(checked|unchecked)$/.test(value))).length,0),
    engineSheets:roots.reduce((total,root)=>total+root.querySelectorAll('style.darkreader').length,0),
    engineSheetDetails:roots.flatMap(root=>[...root.querySelectorAll('style.darkreader')].map(sheet=>({classes:sheet.className,shadow:root===shadow,disabled:sheet.sheet?.disabled,text:sheet.textContent.slice(0,160)}))),
    form:{value:draft.value,start:draft.selectionStart,end:draft.selectionEnd},
    sourceSheet:document.querySelector('style:not(.darkreader)').textContent,
    image:document.querySelector('#photo').getAttribute('src')
  };
})()`;

test('real .45 stale controllers cannot overwrite replacement paint or resurrect markers while OFF', {timeout:40000,skip:!existsSync('/usr/bin/brave')}, async()=>{
  assert.match(legacyTheme,/const VERSION = '0\.2\.45'/,'the regression uses the frozen installed legacy theme');
  assert.doesNotMatch(legacyTheme,/brave-media-controller-claimed/,'legacy refresh cannot cooperate with the new retirement event');
  const profile=mkdtempSync(path.join(tmpdir(),'brave-theme-ownership-'));
  const child=spawn('/usr/bin/brave',['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--mute-audio',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
  const exited=new Promise(resolve=>child.once('exit',resolve));let socket,logs='',id=0;const pending=new Map();
  child.stderr.on('data',chunk=>{if(logs.length<2000)logs+=chunk;});
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<500&&!existsSync(portFile)&&child.exitCode===null;i++)await delay(20);
    assert.ok(existsSync(portFile),`isolated headless browser failed to start: ${logs}`);
    const port=readFileSync(portFile,'utf8').split('\n')[0];
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message',event=>{
      const reply=JSON.parse(event.data),request=pending.get(reply.id);if(!request)return;
      pending.delete(reply.id);clearTimeout(request.timer);
      reply.error?request.reject(new Error(reply.error.message)):request.resolve(reply.result);
    });
    const call=(method,params={},label=method)=>new Promise((resolve,reject)=>{
      const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error(`${label}: browser response timed out (possible ownership mutation loop)`));},5000);
      pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));
    });
    const evaluate=async(contextId,expression,label)=>{
      const result=await call('Runtime.evaluate',{contextId,expression,awaitPromise:true,returnByValue:true},label);
      assert.equal(result.exceptionDetails,undefined,`${label}: ${result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || ''}`);
      return result.result.value;
    };
    const settle=()=>evaluate(undefined,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>queueMicrotask(resolve))))','settle shared DOM ownership');
    const snapshot=async()=>{await settle();return evaluate(undefined,snapshotExpression,'read shared paint and ownership');};
    const screenshot=async()=>{await settle();return pixels(Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},'capture native Chromium paint')).data,'base64'));};
    const world=async name=>(await call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:name})).executionContextId;
    const install=(contextId,source,name)=>evaluate(contextId,geometry+'\n'+vendor+'\n'+source+`\nglobalThis.refreshCount=0;SemanticTheme.setBeforeRefresh(()=>refreshCount++);SemanticTheme.version`,`${name} isolated installation`);
    const pulseLegacy=async(count=3)=>{
      const before=await evaluate(legacy,'({enabled:SemanticTheme.isEnabled(),count:refreshCount})','read still-enabled legacy controller');
      assert.equal(before.enabled,true,'the obsolete theme remains enabled and must be fenced by the modern owner');
      for(let i=0;i<count;i++) {
        await evaluate(legacy,'SemanticTheme.refresh();new Promise(resolve=>requestAnimationFrame(()=>queueMicrotask(resolve)))',`legacy refresh ${i+1}`);
        await settle();
      }
      const after=await evaluate(legacy,'refreshCount','count real legacy refresh callbacks');
      assert.ok(after>=before.count+count,'actual legacy callbacks ran instead of testing a disposed or synthetic controller');
    };
    await call('Network.enable');await call('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await call('Emulation.setDeviceMetricsOverride',{width:640,height:500,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await call('Page.getFrameTree');
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
    await evaluate(undefined,`document.querySelector('x-controls').attachShadow({mode:'open'}).innerHTML='<style>:host{color:#ccc}header{height:50px;width:400px;background:rgba(30,80,100,.8)}svg{position:absolute;left:0;top:60px;color:rgb(18,52,86)}</style><header>Shadow navigation<button>Action</button></header><svg width="200" height="70"><rect width="200" height="70" fill="currentColor"></rect></svg>';document.querySelector('#draft').setSelectionRange(3,8);true`,'prepare authored shadow UI and draft');
    await evaluate(undefined,`Promise.all([...document.images].map(image=>image.decode())).then(()=>{const wallpaper=new Image();wallpaper.src=${JSON.stringify(image('rgb(27,63,99)'))};return wallpaper.decode();})`,'wait for authored fixture media decoding');
    const authored=await snapshot(),authoredPaint=await screenshot();
    const legacy=await world('installed-0.2.45'),modernA=await world('replacement-A'),modernB=await world('replacement-B');
    await install(legacy,legacyTheme,'legacy');
    await evaluate(legacy,`SemanticTheme.enable(${JSON.stringify(palette)})`,'enable exact legacy theme');
    await settle();
    const legacyState=await snapshot();
    for(const [node,attr] of [['header','data-brave-media-surface'],['body','data-brave-media-backdrop'],['art','data-brave-media-artwork'],['shadowHeader','data-brave-media-surface'],['shadowArt','data-brave-media-artwork']]) {
      assert.ok(legacyState.markers[node][attr],`legacy fixture positively owns ${node}`);
    }
    for(const [node,attr] of [['label','data-brave-media-label-fill'],['compact','data-brave-media-compact-button'],['field','data-brave-media-contained-field']]) {
      assert.equal(legacyState.markers[node][attr],'true',`legacy fixture positively exercises ${node} presence-marker cleanup`);
    }
    await install(modernA,theme,'modern A');
    await evaluate(modernA,`SemanticTheme.enable(${JSON.stringify(palette)})`,'enable modern A');
    const ownedA=await snapshot();
    for(const [node,attr] of [['header','data-brave-media-surface'],['body','data-brave-media-backdrop'],['art','data-brave-media-artwork'],['shadowHeader','data-brave-media-surface'],['shadowArt','data-brave-media-artwork']]) {
      assert.notEqual(ownedA.markers[node][attr],legacyState.markers[node][attr],`${node} moves to the replacement owner`);
    }
    const assertOwned=(state,expected,name)=>{
      assert.deepEqual(state.markers,expected.markers,`${name}: stale writes cannot replace current marker IDs or legacy flags`);
      assert.deepEqual(state.fills,{header:'rgb(0, 0, 0)',body:'rgb(0, 0, 0)',shadowHeader:'rgb(0, 0, 0)'},`${name}: structural surfaces share the canvas`);
      assert.equal(state.wallpaper,'none',`${name}: decorative CSS wallpaper stays hidden`);
      assert.equal(state.art,'rgb(18, 52, 86)',`${name}: currentColor artwork stays authored`);
      assert.equal(state.shadowArt,'rgb(18, 52, 86)',`${name}: shadow currentColor artwork stays authored`);
      assert.deepEqual(state.form,authored.form,`${name}: form value and selection survive ownership changes`);
      assert.equal(state.sourceSheet,authored.sourceSheet,`${name}: authored CSS stays intact`);
      assert.equal(state.image,authored.image,`${name}: meaningful media URL stays intact`);
      assert.ok(state.sheets.some(sheet=>sheet.shadow),`${name}: active shadow paint sheets remain attached`);
      assert.ok(state.sheets.every(sheet=>sheet.owner && expected.sheets.some(original=>original.owner===sheet.owner)),`${name}: no foreign semantic sheet survives`);
    };
    await pulseLegacy(4);
    assertOwned(await snapshot(),ownedA,'modern A after repeated legacy refresh');
    let pixel=await screenshot();
    for(const [x,y] of [[630,25],[600,250],[410,330]])assert.deepEqual(pixel(x,y),[0,0,0],`modern canvas actually paints at ${x},${y}`);
    for(const [x,y] of [[30,100],[30,390]])assert.deepEqual(pixel(x,y),[18,52,86],`authored SVG actually paints at ${x},${y}`);
    assert.deepEqual(pixel(460,100),[255,0,0],'meaningful image paint is unchanged');

    await evaluate(modernA,'SemanticTheme.disable();true','turn modern A OFF');
    await pulseLegacy(3);
    const assertOff=state=>{
      assert.deepEqual(state.markers,authored.markers,'OFF cannot resurrect legacy theme markers');
      assert.equal(state.generatedMarkers,0,'OFF has no generated markers in light or shadow DOM');
      assert.deepEqual(state.sheets,[],'OFF has no generated semantic style sheets');
      assert.equal(state.engineSheets,0,`OFF has no generated engine paint: ${JSON.stringify(state.engineSheetDetails)}`);
      assert.deepEqual(state.fills,authored.fills,'OFF restores authored structural colors');
      assert.equal(state.wallpaper,authored.wallpaper,'OFF restores authored decorative wallpaper');
      assert.equal(state.art,authored.art);assert.equal(state.shadowArt,authored.shadowArt);
      assert.deepEqual(state.form,authored.form,'OFF preserves draft and selection');
    };
    assertOff(await snapshot());
    pixel=await screenshot();
    for(const [x,y] of [[630,25],[600,250],[410,330],[30,100],[30,390],[460,100]])assert.deepEqual(pixel(x,y),authoredPaint(x,y),`OFF restores source paint at ${x},${y}`);

    // Both writes occur in one legacy callback before a MutationObserver can
    // run: first an authored source edit, then the real stale controller's own
    // generated ID. Reconciliation must preserve the latest authored value.
    await evaluate(legacy,`globalThis.sourceMarker='authored-header-source';SemanticTheme.setBeforeRefresh(()=>{refreshCount++;if(sourceMarker){document.querySelector('#header').setAttribute('data-brave-media-surface',sourceMarker);sourceMarker=null;}});true`,'prepare authored edit within the next legacy refresh batch');
    await pulseLegacy(1);
    authored.markers.header={'data-brave-media-surface':'authored-header-source'};
    assertOff(await snapshot());
    await pulseLegacy(2);
    assertOff(await snapshot());

    await install(modernB,theme,'modern B while OFF');
    assert.equal(await evaluate(modernA,`SemanticTheme.enable(${JSON.stringify(palette)})`,'retired A attempts to enable'),false,'creating B synchronously retires A even while both are OFF');
    assert.equal(await evaluate(modernA,'SemanticTheme.isEnabled()','check retired A state'),false);
    await pulseLegacy(2);
    assertOff(await snapshot());
    await evaluate(modernB,`SemanticTheme.enable(${JSON.stringify(palette)})`,'enable replacement B');
    const ownedB=await snapshot();
    assert.notEqual(ownedB.markers.header['data-brave-media-surface'],ownedA.markers.header['data-brave-media-surface'],'B claims distinct ownership');
    await pulseLegacy(3);
    assertOwned(await snapshot(),ownedB,'modern B after legacy refresh');
    // Teardown can run immediately after a stale writer schedules another pass.
    // The old cleanup must neither remove B's marker nor detach B's sheets.
    await evaluate(legacy,'SemanticTheme.refresh();SemanticTheme.disable();SemanticTheme.dispose();true','legacy refresh followed immediately by teardown');
    await evaluate(modernA,'SemanticTheme.disable();SemanticTheme.dispose();true','retired A teardown');
    assertOwned(await snapshot(),ownedB,'modern B after both previous controllers tear down');

    // Observe real DOM churn and real semantic callbacks, without a test-only
    // mutation-loop guard that could make an infinite loop falsely pass.
    await evaluate(undefined,`globalThis.ownershipMutationCount=0;globalThis.ownershipObserver=new MutationObserver(records=>ownershipMutationCount+=records.length);ownershipObserver.observe(document,{subtree:true,childList:true,attributes:true});ownershipObserver.observe(document.querySelector('x-controls').shadowRoot,{subtree:true,childList:true,attributes:true});true`,'observe settled ownership churn');
    const refreshBefore=await evaluate(modernB,'refreshCount','count settled semantic callbacks');
    await delay(450);
    assert.equal(await evaluate(undefined,'ownershipMutationCount','count idle DOM mutations'),0,'ownership reconciliation settles without marker/style ping-pong');
    assert.equal(await evaluate(modernB,'refreshCount','count idle semantic callbacks'),refreshBefore,'ownership cleanup cannot trigger repeated semantic rescans');
    await evaluate(undefined,'ownershipObserver.disconnect();true','stop diagnostic observer');
    await evaluate(undefined,'document.querySelector("meta[name=brave-media-controller]").remove();true','detach active claim during ordinary head rebuilding');
    await settle();
    assert.deepEqual(await evaluate(modernB,'({enabled:SemanticTheme.isEnabled(),disposed:SemanticTheme.isDisposed()})','read reattached claim owner'),{enabled:true,disposed:false},'removing a claim within the same document cannot retire its active owner');
    assert.equal(await evaluate(undefined,'document.querySelectorAll("meta[name=brave-media-controller]").length','count reattached ownership claims'),1,'head rebuilding restores exactly one current claim');
    assertOwned(await snapshot(),ownedB,'modern B after claim detachment');
    pixel=await screenshot();assert.deepEqual(pixel(630,25),[0,0,0],'claim reattachment preserves actual canvas paint');
    await evaluate(modernB,'SemanticTheme.disable();true','final OFF');
    assertOff(await snapshot());

    // document.open() removes document event listeners while leaving isolated
    // world globals alive. The DOM ownership claim must retire those closures,
    // and reinjecting the same current revision must construct a fresh owner.
    await evaluate(modernB,`globalThis.replacedController=SemanticTheme;document.open();document.write('<!doctype html><style>body{margin:0;background:rgb(70,80,90);color:rgb(150,160,170)}header{height:50px;background:rgb(40,70,90)}</style><header>Replacement document</header><input id="replacement-draft" value="Replacement draft">');document.close();true`,'replace document while isolated globals survive');
    await settle();
    assert.deepEqual(await evaluate(modernB,'({disposed:replacedController.isDisposed(),enabled:replacedController.isEnabled(),reenabled:replacedController.enable()})','read replaced document controller'),{disposed:true,enabled:false,reenabled:false},'document replacement retires the old owner despite missing retirement listeners');
    assert.equal(await evaluate(undefined,'document.querySelectorAll("style.darkreader,[data-brave-media-surface]").length','read unowned replacement document'),0,'retired owner cannot modify the replacement document');
    const replacementSourcePaint=await screenshot();
    await install(modernB,theme,'same-world reinjection');
    assert.deepEqual(await evaluate(modernB,`({fresh:SemanticTheme!==replacedController,disposed:SemanticTheme.isDisposed(),enabled:SemanticTheme.enable(${JSON.stringify(palette)})})`,'enable reinjected controller'),{fresh:true,disposed:false,enabled:true},'the same bundle revision can replace its disposed controller');
    await settle();
    assert.equal(await evaluate(undefined,'getComputedStyle(document.querySelector("header")).backgroundColor','read reinjected native paint'),'rgb(0, 0, 0)');
    pixel=await screenshot();assert.deepEqual(pixel(600,25),[0,0,0],'reinjected controller paints the replacement header');
    await evaluate(modernB,'SemanticTheme.disable();true','turn reinjected controller OFF');
    await settle();
    assert.equal(await evaluate(undefined,'document.querySelectorAll("style.darkreader,[data-brave-media-surface]").length','read final replacement cleanup'),0);
    pixel=await screenshot();assert.deepEqual(pixel(600,25),replacementSourcePaint(600,25),'reinjection OFF restores the replacement document paint');
    assert.equal(await evaluate(undefined,'document.querySelector("#replacement-draft").value','read replacement draft'),'Replacement draft');
  } finally {
    for(const request of pending.values())clearTimeout(request.timer);pending.clear();
    socket?.close();try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    let exitTimer;await Promise.race([exited,new Promise(resolve=>{exitTimer=setTimeout(resolve,3000);})]);clearTimeout(exitTimer);
    try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    rmSync(profile,{recursive:true,force:true});
  }
});
