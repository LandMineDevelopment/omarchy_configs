import {readFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source=readFileSync(new URL('./extension/theme.js',import.meta.url),'utf8');
const start=source.indexOf('  function controlCSS('),end=source.indexOf('  function setPalette(',start);
const scope={theme:{darkSchemeBackgroundColor:'#000000'},ICON_ATTR:'data-brave-media-icon-button',CHECK_ATTR:'data-brave-media-check-indicator',COMPACT_ATTR:'data-brave-media-compact-button',POPUP_ATTR:'data-brave-media-popup-panel',CONTAINED_FIELD_ATTR:'data-brave-media-contained-field',LABEL_FILL_ATTR:'data-brave-media-label-fill',BOUNDARY_ATTR:'data-brave-media-control-boundary'};
vm.runInNewContext(source.slice(start,end),scope);
const css=scope.controlCSS('#ffcc66','#e6e6e6');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function pixels(png) {
  let width,height,channels;const chunks=[];
  for(let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);}
    if(type==='IDAT')chunks.push(data);offset+=length+12;
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
test('browser paint preserves semantic edges and adapts authored Dark Reader opt-out without altering it', {timeout:30000,skip:!existsSync('/usr/bin/brave')}, async()=>{
  const profile=mkdtempSync(path.join(tmpdir(),'brave-theme-paint-'));
  const child=spawn('/usr/bin/brave',['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--mute-audio',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
  const exited=new Promise(resolve=>child.once('exit',resolve));let socket;let logs='';child.stderr.on('data',chunk=>{if(logs.length<2000)logs+=chunk;});
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<500&&!existsSync(portFile)&&child.exitCode===null;i++)await delay(20);
    assert.ok(existsSync(portFile),`isolated headless browser failed to start: ${logs}`);
    const port=readFileSync(portFile,'utf8').split('\n')[0];
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let id=0;const pending=new Map();
    socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(!pending.has(reply.id))return;const {resolve,reject,timer}=pending.get(reply.id);pending.delete(reply.id);clearTimeout(timer);reply.error?reject(new Error(reply.error.message)):resolve(reply.result);});
    const call=(method,params={})=>{
      // Replacing fixture HTML retires its old document owner. Reinject the
      // controller just as the extension does for a freshly loaded page.
      if(method==='Runtime.evaluate' && params.expression?.includes('SemanticTheme.enable(') && !params.expression.includes('const VERSION =')) params={...params,expression:source+'\n'+params.expression};
      return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP ${method} timed out: ${params.expression?.slice(-220) || ""}`));},5000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
    };
    await call('Network.enable');await call('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:160,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await call('Page.getFrameTree');
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>body{margin:0;background:#000}button{position:absolute;top:20px;width:120px;height:40px;padding:0;border:0;border-radius:0;background:#111;color:white}#selected{left:20px}#icon{left:180px;width:40px}#focus{left:260px;width:40px}button>div{width:100%;height:100%;background:#000;position:relative;transform:translateZ(0);border-radius:8px}${css}</style><button id="selected" aria-selected="true"><div>Selected</div></button><button id="icon" data-brave-media-icon-button="true" aria-label="Search"><div></div></button><button id="focus" data-brave-media-icon-button="true" aria-label="Close"><div></div></button><a id="cta" data-brave-media-compact-button="true" href="#jobs" style="position:absolute;left:20px;top:100px;width:120px;height:40px;display:inline-flex;color:white;background:black"><div style="width:100%;height:100%;background:black">Search jobs</div></a><div data-brave-media-popup-panel="true" style="position:absolute;left:180px;top:100px;width:120px;height:40px;background:black"><div role="listbox" style="width:100%;height:100%;background:black"><div role="option" style="width:100%;height:100%;background:black">Chart type</div></div></div>`});
    const screenshot=async()=>{await call('Runtime.evaluate',{expression:'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',awaitPromise:true});return pixels(Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));};
    const bounds=await call('Runtime.evaluate',{expression:'JSON.stringify([document.querySelector("#selected").getBoundingClientRect().width,document.querySelector("#selected").getBoundingClientRect().height])'});assert.equal(bounds.result.value,'[120,40]','outer outlines do not change authored layout');
    let pixel=await screenshot();
    for(const [x,y] of [[19,40],[140,40],[80,19],[80,60]])assert.deepEqual(pixel(x,y),[255,204,102],`selected full perimeter at ${x},${y} paints outside positioned/composited black child`);
    for(const [x,y] of [[179,40],[220,40],[200,19],[200,60]])assert.deepEqual(pixel(x,y),[0,0,0],'pure icon resting edge stays quiet');
    for(const [x,y] of [[19,120],[140,120],[80,99],[80,140]])assert.ok(pixel(x,y).every(channel=>channel>=55&&channel<=57),'compact text anchor has a subtle perimeter above child');
    for(const [x,y] of [[179,120],[300,120],[240,99],[240,140]])assert.ok(pixel(x,y).every(channel=>channel>=55&&channel<=57),'owned outer popup has the same subtle perimeter above nested listbox');
    for(const [x,y] of [[180,120],[299,120],[240,100],[240,139]])assert.deepEqual(pixel(x,y),[0,0,0],'nested listbox adds no duplicated inner perimeter');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:200,y:40});pixel=await screenshot();
    for(const [x,y] of [[179,40],[220,40],[200,19],[200,60]])assert.deepEqual(pixel(x,y),[72,72,72],'icon hover has a neutral edge instead of an accent box');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await call('Runtime.evaluate',{expression:'document.querySelector("#focus").focus()'});
    const focus=await call('Runtime.evaluate',{expression:'document.querySelector("#focus").matches(":focus-visible")'});assert.equal(focus.result.value,true);
    pixel=await screenshot();assert.deepEqual(pixel(258,40),[255,204,102],'keyboard focus remains stronger outside the child fill');
    // Reproduce a static fractional chip with a clipped ancestor and nested
    // absolute feedback paint, rather than a positioned test button alone.
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:160,deviceScaleFactor:1.484375,mobile:false});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>body{margin:0;background:black}#clip{position:relative;left:96px;top:56px;width:300px;height:56px;overflow:hidden}button{margin-top:12px;border:0;padding:0;width:40.410526px;height:32px;border-radius:0;background:black}button>div{position:relative;background:black;border-radius:8px;width:100%;height:100%}x-feedback,x-feedback>div{position:absolute;inset:0;border-radius:8px}x-feedback>div:last-child{background:black}${css}button{outline-width:.673684px!important}</style><div id="clip"><button aria-selected="true"><div>All<x-feedback><div></div><div></div></x-feedback></div></button></div>`});
    pixel=await screenshot();
    let edgePixels=0;for(let x=161;x<185;x++)for(let y=97;y<102;y++){const c=pixel(x,y);if(c[0]>120&&c[1]>70&&c[2]<150)edgePixels++;}
    assert.ok(edgePixels>=20,`fractional top perimeter remains visible above nested absolute feedback: ${edgePixels}`);
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:160,deviceScaleFactor:1,mobile:false});
    // A website's upstream Dark Reader opt-out is authored data. It must remain
    // untouched while the user-enabled adaptation owns its own engine lifecycle.
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><head><meta name="darkreader-lock" content="authored"><style>body{background:#323437;color:rgb(100,102,105)}#label{color:rgb(100,102,105)}</style></head><body><p id="label">Secondary readable label</p><button id="palette">Palette control</button></body>'});
    const vendor=readFileSync(new URL('./extension/vendor/darkreader.js',import.meta.url),'utf8');
    const applied=await call('Runtime.evaluate',{expression:vendor+'\n'+source+`\nSemanticTheme.enable({background:"#000000",foreground:"#e6e6e6"});new Promise(resolve=>setTimeout(()=>resolve({color:getComputedStyle(document.querySelector("#label")).color,canvas:getComputedStyle(document.body).backgroundColor,styles:document.querySelectorAll(".darkreader").length,owner:!!document.querySelector('meta[name="darkreader"]'),authored:document.querySelector('meta[name="darkreader-lock"]')?.content}),150))`,awaitPromise:true,returnByValue:true});
    assert.equal(applied.exceptionDetails,undefined);const actual=applied.result.value;
    assert.equal(actual.authored,'authored');assert.equal(actual.owner,true);assert.ok(actual.styles>0);
    assert.equal(actual.canvas,'rgb(0, 0, 0)');assert.ok(actual.color.match(/\d+/g).every(channel=>Number(channel)>=184),'authored lock cannot leave gray labels unadapted');
    const paletteChange=await call('Runtime.evaluate',{expression:`SemanticTheme.setPalette({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66',selection:'#223344',selectionForeground:'#ffffff'});document.querySelector('#palette').focus();new Promise(resolve=>setTimeout(()=>resolve({focus:getComputedStyle(document.querySelector('#palette')).outlineColor,selection:getComputedStyle(document.querySelector('#label'),'::selection').backgroundColor,selectedText:getComputedStyle(document.querySelector('#label'),'::selection').color}),150))`,awaitPromise:true,returnByValue:true});
    assert.equal(paletteChange.exceptionDetails,undefined);assert.deepEqual(paletteChange.result.value,{focus:'rgb(255, 204, 102)',selection:'rgb(34, 51, 68)',selectedText:'rgb(255, 255, 255)'},'changed fixes must reach the actual vendor rather than its palette-only shortcut');
    const off=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({color:getComputedStyle(document.querySelector("#label")).color,authored:document.querySelector('meta[name="darkreader-lock"]')?.content,styles:document.querySelectorAll(".darkreader").length})`,returnByValue:true});
    assert.deepEqual(off.result.value,{color:'rgb(100, 102, 105)',authored:'authored',styles:0});
    // Fulfil a single isolated fixture PNG locally; no website/image network is
    // involved. This exercises real bounded raster proof and owned CSS paint.
    const generated=await call('Runtime.evaluate',{expression:'(()=>{const c=document.createElement("canvas");c.width=c.height=20;const x=c.getContext("2d");x.fillStyle="black";x.beginPath();x.moveTo(4,7);x.lineTo(16,7);x.lineTo(10,13);x.fill();return c.toDataURL("image/png").split(",")[1]})()'});
    const image=generated.result.value;
    socket.addEventListener('message',event=>{const request=JSON.parse(event.data);if(request.method==='Fetch.requestPaused')call('Fetch.fulfillRequest',{requestId:request.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Access-Control-Allow-Origin',value:'*'}],body:image}).catch(()=>{});});
    await call('Network.setBlockedURLs',{urls:[]});await call('Fetch.enable',{patterns:[{urlPattern:'https://glyph.fixture.test/arrow.png'}]});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>body{background:black;color:white}#field{position:absolute;left:20px;top:20px;width:120px;height:40px}#arrow{position:absolute;left:70px;top:10px;width:20px;height:20px;background:url("https://glyph.fixture.test/arrow.png") center/20px 20px no-repeat}button{position:absolute;top:20px;left:180px;width:40px;height:40px;padding:8px;border:0;background:black}button:last-child{left:260px}svg{width:24px;height:24px}</style><div id="field" role="listbox"><div id="arrow" aria-hidden="true"></div></div><button aria-label="Alert"><svg id="neutral" aria-hidden="true" viewBox="0 0 24 24"><path fill="black" d="M8 6H16V18H8Z"/></svg></button><button aria-label="Logo"><svg id="colored" aria-hidden="true" viewBox="0 0 24 24"><path fill="red" d="M8 6H16V18H8Z"/></svg></button>'});
    const glyphModule=readFileSync(new URL('./extension/media.js',import.meta.url),'utf8');
    const glyphState=await call('Runtime.evaluate',{expression:glyphModule+'\nSemanticTheme.enable({background:"#000000",foreground:"#e6e6e6"});'+`new Promise(resolve=>{const end=Date.now()+2000;const done=()=>{const arrow=document.querySelector('#arrow');if(!SemanticTheme.isControlGlyph(arrow)&&Date.now()<end){setTimeout(done,20);return;}resolve({png:SemanticTheme.isControlGlyph(arrow),svg:SemanticTheme.isControlGlyph(document.querySelector('#neutral')),colored:SemanticTheme.isControlGlyph(document.querySelector('#colored')),mask:getComputedStyle(arrow).maskImage,fill:getComputedStyle(arrow).backgroundColor,coloredPaint:getComputedStyle(document.querySelector('#colored path')).fill});};done();})`,awaitPromise:true,returnByValue:true});
    assert.equal(glyphState.exceptionDetails,undefined);assert.deepEqual(glyphState.result.value,{png:true,svg:true,colored:false,mask:'url("https://glyph.fixture.test/arrow.png")',fill:'rgb(230, 230, 230)',coloredPaint:'rgb(255, 0, 0)'});
    pixel=await screenshot();assert.deepEqual(pixel(100,39),[230,230,230],'dark PNG alpha paints readable palette glyph');assert.deepEqual(pixel(199,39),[255,255,255],'neutral SVG glyph becomes readable');assert.deepEqual(pixel(279,39),[255,0,0],'colored SVG paint remains exact');
    const restored=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({png:document.querySelector('#arrow').hasAttribute('data-brave-media-control-glyph'),svg:document.querySelector('#neutral').hasAttribute('data-brave-media-control-glyph'),mask:getComputedStyle(document.querySelector('#arrow')).maskImage,filter:getComputedStyle(document.querySelector('#neutral')).filter})`,returnByValue:true});
    assert.deepEqual(restored.result.value,{png:false,svg:false,mask:'none',filter:'none'});
    // Short/small artwork and default controls inside a shadow root are not
    // size-based icons. CurrentColor control glyph proof must remain authored
    // after every engine refresh instead of alternating black/white ownership.
    await call('Emulation.setDeviceMetricsOverride',{width:640,height:320,deviceScaleFactor:1,mobile:false});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>
body{margin:0;background:white;color:black}button{font:18px system-ui}
#default{position:absolute;left:20px;top:20px;width:140px;height:40px}
#glyphButton{position:absolute;left:180px;top:20px;width:44px;height:40px;color:black}
#wide{position:absolute;left:20px;top:80px;color:rgb(18,52,86)}
#small{position:absolute;left:180px;top:80px;color:rgb(18,52,86)}
x-review{position:absolute;left:20px;top:150px;width:580px;height:140px}
</style><button id="default">Default action</button><button id="glyphButton" aria-label="Search"><svg id="glyph" aria-hidden="true" width="24" height="24"><path fill="currentColor" d="M8 6H16V18H8Z"/></svg></button>
<svg id="wide" width="120" height="40"><rect width="120" height="40" fill="currentColor"/></svg>
<svg id="small" width="24" height="24"><rect width="24" height="24" fill="currentColor"/></svg><x-review></x-review>`});
    await call('Runtime.evaluate',{expression:`document.querySelector('x-review').attachShadow({mode:'open'}).innerHTML='<style>header{display:flex;align-items:center;height:60px;gap:20px;background:rgba(30,80,100,.8)}button{font:18px system-ui;height:40px}#glyphButton{color:black;width:44px}#wide{color:rgb(18,52,86)}</style><header><button id="default">Shadow action</button><button id="glyphButton" aria-label="Search"><svg id="glyph" aria-hidden="true" width="24" height="24"><path fill="currentColor" d="M8 6H16V18H8Z"/></svg></button><svg id="wide" width="120" height="40"><rect width="120" height="40" fill="currentColor"/></svg></header>';globalThis.svgControlSource=[document,document.querySelector('x-review').shadowRoot].map(root=>getComputedStyle(root.querySelector('#default')).backgroundColor);`});
    const svgStateExpression=`(() => {const roots=[document,document.querySelector('x-review').shadowRoot];return roots.map(root=>({nativeFill:getComputedStyle(root.querySelector('#default')).backgroundColor,wideColor:getComputedStyle(root.querySelector('#wide')).color,wideOwned:root.querySelector('#wide').hasAttribute('data-brave-media-artwork'),glyph:SemanticTheme.isControlGlyph(root.querySelector('#glyph')),glyphArtwork:root.querySelector('#glyph').hasAttribute('data-brave-media-artwork'),glyphFilter:getComputedStyle(root.querySelector('#glyph')).filter,ua:root.querySelectorAll('style.darkreader--user-agent').length}));})()`;
    const svgPaint=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(${svgStateExpression}))))`,awaitPromise:true,returnByValue:true});
    assert.equal(svgPaint.exceptionDetails,undefined);
    const expectedSvgState={nativeFill:'rgb(0, 0, 0)',wideColor:'rgb(18, 52, 86)',wideOwned:true,glyph:true,glyphArtwork:false,glyphFilter:'brightness(0) invert(1)',ua:1};
    assert.deepEqual(svgPaint.result.value,[expectedSvgState,expectedSvgState]);
    for(const factor of [1,1.484375,2.5]) {
      await call('Emulation.setDeviceMetricsOverride',{width:640,height:320,deviceScaleFactor:factor,mobile:false});
      for(let refresh=0;refresh<4;refresh++) {
        const state=await call('Runtime.evaluate',{expression:`SemanticTheme.refresh();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(${svgStateExpression}))))`,awaitPromise:true,returnByValue:true});
        assert.deepEqual(state.result.value,[expectedSvgState,expectedSvgState],`stable SVG ownership after refresh ${refresh} at scale ${factor}`);
      }
      pixel=await screenshot();
      assert.deepEqual(pixel(Math.floor(80*factor),Math.floor(100*factor)),[18,52,86],'short SVG artwork pixels stay authored');
      assert.deepEqual(pixel(Math.floor(192*factor),Math.floor(92*factor)),[18,52,86],'small standalone SVG pixels stay authored');
    }
    const svgPalette=await call('Runtime.evaluate',{expression:`SemanticTheme.setPalette({background:'#101820',foreground:'#e6e6e6'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(${svgStateExpression}))))`,awaitPromise:true,returnByValue:true});
    assert.equal(svgPalette.exceptionDetails,undefined);assert.deepEqual(svgPalette.result.value,[{...expectedSvgState,nativeFill:'rgb(16, 24, 32)'},{...expectedSvgState,nativeFill:'rgb(16, 24, 32)'}]);
    const svgOff=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({fills:[document,document.querySelector('x-review').shadowRoot].map(root=>getComputedStyle(root.querySelector('#default')).backgroundColor),source:svgControlSource,sheets:[document,document.querySelector('x-review').shadowRoot].map(root=>root.querySelectorAll('style.darkreader').length)})`,returnByValue:true});
    assert.deepEqual(svgOff.result.value.fills,svgOff.result.value.source);assert.deepEqual(svgOff.result.value.sheets,[0,0]);
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:160,deviceScaleFactor:1,mobile:false});
    // Injection can occur in a background tab, then the tab becomes visible
    // before enable. No later visibility event should be needed to render.
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>@layer tokens{ :root{--bg:#323437;--ink:#646669} } @layer app { body{background:var(--bg);color:var(--ink)} .result{ & span {color:var(--ink)} } }</style><div class="result"><span id="result">56 wpm 96%</span></div>'});
    const freshVendor=vendor.replace(/const revision = '[^']+';/,"const revision = 'test-hidden-injection';"),freshController=source.replace(/const VERSION = '[^']+';/,"const VERSION = 'test-hidden-injection';");
    const visibleRace=await call('Runtime.evaluate',{expression:`globalThis.fixtureHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>globalThis.fixtureHidden});`+freshVendor+`\nglobalThis.fixtureHidden=false;`+freshController+`\nSemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});new Promise(resolve=>setTimeout(()=>resolve({fallback:document.querySelector('.darkreader--fallback')?.textContent,sync:[...document.querySelectorAll('.darkreader--sync')].some(style=>style.sheet?.cssRules.length>0),color:getComputedStyle(document.querySelector('#result')).color,result:document.querySelector('#result').textContent}),150))`,awaitPromise:true,returnByValue:true});
    assert.equal(visibleRace.exceptionDetails,undefined);assert.equal(visibleRace.result.value.fallback,'');assert.equal(visibleRace.result.value.sync,true);assert.equal(visibleRace.result.value.result,'56 wpm 96%');assert.ok(visibleRace.result.value.color.match(/\d+/g).every(channel=>Number(channel)>=184));
    const repeated=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});({fallback:document.querySelector('.darkreader--fallback')?.textContent,sync:[...document.querySelectorAll('.darkreader--sync')].some(style=>style.sheet?.cssRules.length>0)})`,returnByValue:true});
    assert.equal(repeated.result.value.fallback,'');assert.equal(repeated.result.value.sync,true);
    const deferredVendor=freshVendor.replace('test-hidden-injection','test-deferred-enable'),deferredController=freshController.replace('test-hidden-injection','test-deferred-enable');
    const deferred=await call('Runtime.evaluate',{expression:`globalThis.fixtureHidden=true;`+deferredVendor+deferredController+`\nSemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});const initialFallback=document.querySelector('.darkreader--fallback')?.textContent;globalThis.fixtureHidden=false;SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});new Promise(resolve=>setTimeout(()=>resolve({initialFallback:!!initialFallback,fallback:document.querySelector('.darkreader--fallback')?.textContent,sync:[...document.querySelectorAll('.darkreader--sync')].some(style=>style.sheet?.cssRules.length>0)}),150))`,awaitPromise:true,returnByValue:true});
    assert.equal(deferred.exceptionDetails,undefined);assert.equal(deferred.result.value.initialFallback,true);assert.equal(deferred.result.value.fallback,'');assert.equal(deferred.result.value.sync,true);
    await call('Runtime.evaluate',{expression:'SemanticTheme.disable()'});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>body{margin:0;background:black;color:white}#shell{position:absolute;left:20px;top:20px;box-sizing:border-box;width:280px;height:48px;padding:9px 16px;border:1px solid #888;border-radius:24px}input{padding:0;border:0;height:28px;background:transparent;color:white}#contained{width:200px}#alone{position:absolute;left:330px;top:30px;width:60px}</style><div id="shell"><input id="contained" type="search" placeholder="Search"></div><input id="alone" placeholder="Alone">'});
    const fields=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>resolve({owned:document.querySelector('#contained').getAttribute('data-brave-media-contained-field'),inner:getComputedStyle(document.querySelector('#contained')).outlineStyle,alone:getComputedStyle(document.querySelector('#alone')).outlineStyle,radius:getComputedStyle(document.querySelector('#shell')).borderRadius}),50))`,awaitPromise:true,returnByValue:true});
    assert.deepEqual(fields.result.value,{owned:'true',inner:'none',alone:'solid',radius:'24px'});
    pixel=await screenshot();assert.deepEqual(pixel(36,44),[0,0,0],'bare inner input has no duplicate resting rectangle');assert.ok(pixel(329,44).every(value=>value>=55&&value<=57),'standalone field keeps a subtle boundary');
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    const focused=await call('Runtime.evaluate',{expression:`document.querySelector('#contained').focus();({visible:document.querySelector('#contained').matches(':focus-visible'),outline:getComputedStyle(document.querySelector('#contained')).outlineColor,width:getComputedStyle(document.querySelector('#contained')).outlineWidth})`,returnByValue:true});
    assert.deepEqual(focused.result.value,{visible:true,outline:'rgb(255, 204, 102)',width:'2px'});
    const fieldOff=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({owned:document.querySelector('#contained').hasAttribute('data-brave-media-contained-field'),radius:getComputedStyle(document.querySelector('#shell')).borderRadius})`,returnByValue:true});assert.deepEqual(fieldOff.result.value,{owned:false,radius:'24px'});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>body{margin:0;background:black;color:white}button{position:absolute;left:20px;top:20px;width:180px;height:44px;padding:8px;border:0;border-radius:7px;background:#ddd;color:black}span{display:block;background:#ddd}#distinct{background:#aaa}</style><button id="selectedFill" aria-pressed="true"><span id="matched">Selected label</span><span id="distinct">Authored badge</span></button>'});
    const labels=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>resolve({matched:document.querySelector('#matched').getAttribute('data-brave-media-label-fill'),distinct:document.querySelector('#distinct').getAttribute('data-brave-media-label-fill'),parent:getComputedStyle(document.querySelector('#selectedFill')).backgroundColor,label:getComputedStyle(document.querySelector('#matched')).backgroundColor}),50))`,awaitPromise:true,returnByValue:true});
    assert.deepEqual(labels.result.value,{matched:'true',distinct:null,parent:'rgb(0, 0, 0)',label:'rgba(0, 0, 0, 0)'});
    pixel=await screenshot();assert.deepEqual(pixel(25,30),[0,0,0]);assert.deepEqual(pixel(175,30),[0,0,0],'matching label edge shares selected canvas without synthetic rectangle');
    const restoredLabel=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({owned:document.querySelector('#matched').hasAttribute('data-brave-media-label-fill'),fill:getComputedStyle(document.querySelector('#matched')).backgroundColor})`,returnByValue:true});assert.deepEqual(restoredLabel.result.value,{owned:false,fill:'rgb(221, 221, 221)'});
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:220,deviceScaleFactor:1,mobile:false});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>body{margin:0;background:black;color:white}button{position:absolute;top:20px;left:20px;width:120px;height:40px;padding:0;border:0;background:black}#bordered{left:180px;border:2px solid #888}input{position:absolute;top:100px;left:20px;width:120px;height:32px;padding:0;border:0;background:black;color:white}#underline{border-bottom:1px solid #777}#missing{left:180px}</style><button id="plain">Action</button><button id="bordered">Bordered</button><input id="underline" placeholder="Underlined"><input id="missing" placeholder="Bare">'});
    const controls=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#101820',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>resolve(Object.fromEntries(['plain','bordered','underline','missing'].map(id=>{const node=document.getElementById(id),paint=getComputedStyle(node);return [id,{owned:node.hasAttribute('data-brave-media-control-boundary'),outline:paint.outlineStyle,fill:paint.backgroundColor,border:paint.borderBottomWidth}]}))),80))`,awaitPromise:true,returnByValue:true});
    assert.equal(controls.exceptionDetails,undefined);
    assert.deepEqual(controls.result.value,{plain:{owned:false,outline:'solid',fill:'rgb(16, 24, 32)',border:'0px'},bordered:{owned:true,outline:'none',fill:'rgb(16, 24, 32)',border:'2px'},underline:{owned:true,outline:'none',fill:'rgb(16, 24, 32)',border:'1px'},missing:{owned:false,outline:'solid',fill:'rgb(16, 24, 32)',border:'0px'}});
    pixel=await screenshot();
    for(const [x,y] of [[179,40],[304,40],[240,19],[240,64]])assert.deepEqual(pixel(x,y),[16,24,32],'authored border has no added outside outline');
    const authorBorder=await call('Runtime.evaluate',{expression:`getComputedStyle(document.querySelector('#bordered')).borderLeftColor.match(/\\d+/g).slice(0,3).map(Number)`,returnByValue:true});
    assert.deepEqual(pixel(180,40),authorBorder.result.value,'the authored border itself paints without a second outline');
    assert.ok(pixel(180,40).some((value,i)=>Math.abs(value-[16,24,32][i])>=24),'the preserved authored border remains visible');
    assert.deepEqual(pixel(19,115),[16,24,32],'underlined field retains its open sides');
    assert.ok(pixel(179,115).every(value=>value>32),'bare field receives a visible fallback edge');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:80,y:40});
    const hovered=await call('Runtime.evaluate',{expression:`({fill:getComputedStyle(document.querySelector('#plain')).backgroundColor,edge:getComputedStyle(document.querySelector('#plain')).outlineColor})`,returnByValue:true});
    assert.deepEqual(hovered.result.value,{fill:'rgb(16, 24, 32)',edge:'rgba(160, 160, 160, 0.45)'});
    await call('Runtime.evaluate',{expression:`document.querySelector('#plain').setAttribute('aria-pressed','true')`});
    const selected=await call('Runtime.evaluate',{expression:`({fill:getComputedStyle(document.querySelector('#plain')).backgroundColor,edge:getComputedStyle(document.querySelector('#plain')).outlineColor})`,returnByValue:true});
    assert.deepEqual(selected.result.value,{fill:'rgb(16, 24, 32)',edge:'rgb(255, 204, 102)'});
    await call('Runtime.evaluate',{expression:`SemanticTheme.setPalette({background:'#152535'})`});
    const newCanvas=await call('Runtime.evaluate',{expression:`new Promise(resolve=>setTimeout(()=>resolve(getComputedStyle(document.querySelector('#plain')).backgroundColor),50))`,awaitPromise:true});
    assert.equal(newCanvas.result.value,'rgb(21, 37, 53)','selected and hover use the changed palette rather than a fixed gray');
    const restoredControls=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({boundary:document.querySelector('#bordered').hasAttribute('data-brave-media-control-boundary'),border:getComputedStyle(document.querySelector('#bordered')).borderBottomColor,outline:getComputedStyle(document.querySelector('#bordered')).outlineStyle})`,returnByValue:true});
    assert.deepEqual(restoredControls.result.value,{boundary:false,border:'rgb(136, 136, 136)',outline:'none'});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><style>body{margin:0;background:black;color:white}button{position:absolute;left:20px;top:20px;width:100px;height:28px}input{position:absolute;left:20px;top:80px;width:140px;height:24px}#styled{left:180px;border:2px solid #0f0}#colored{left:180px;top:80px;border:2px outset red}select{position:absolute;left:20px;top:140px}</style><button id="nativeButton">Default</button><input id="nativeInput" placeholder="Type here"><select id="nativeSelect"><option>First choice</option></select><button id="styled">Styled</button><button id="colored">Colored</button>'});
    const nativeBaseline=await call('Runtime.evaluate',{expression:`Object.fromEntries(['nativeButton','nativeInput','nativeSelect'].map(id=>{const node=document.getElementById(id),paint=getComputedStyle(node),rect=node.getBoundingClientRect();return [id,{appearance:paint.appearance,style:paint.borderTopStyle,width:rect.width,height:rect.height}]}))`,returnByValue:true});
    assert.equal(nativeBaseline.result.value.nativeButton.style,'outset');assert.equal(nativeBaseline.result.value.nativeInput.style,'inset');
    const nativePaint=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>resolve(Object.fromEntries(['nativeButton','nativeInput','nativeSelect','styled','colored'].map(id=>{const node=document.getElementById(id),paint=getComputedStyle(node),rect=node.getBoundingClientRect();return [id,{appearance:paint.appearance,style:paint.borderTopStyle,color:paint.borderTopColor,width:rect.width,height:rect.height}]}))),80))`,awaitPromise:true,returnByValue:true});
    for(const id of ['nativeButton','nativeInput']) {
      assert.equal(nativePaint.result.value[id].style,'solid');assert.equal(nativePaint.result.value[id].color,'rgba(160, 160, 160, 0.35)');
      for(const key of ['appearance','width','height'])assert.equal(nativePaint.result.value[id][key],nativeBaseline.result.value[id][key],`${id} retains ${key}`);
    }
    assert.equal(nativePaint.result.value.nativeSelect.appearance,nativeBaseline.result.value.nativeSelect.appearance,'native select interaction and arrow remain available');
    assert.equal(nativePaint.result.value.styled.style,'solid');assert.notEqual(nativePaint.result.value.styled.color,'rgba(160, 160, 160, 0.35)');
    assert.equal(nativePaint.result.value.colored.style,'outset');assert.notEqual(nativePaint.result.value.colored.color,'rgba(160, 160, 160, 0.35)');
    pixel=await screenshot();for(const [x,y] of [[20,34],[119,34],[70,20],[70,47]])assert.deepEqual(pixel(x,y),[56,56,56],'default bevel paints one consistent quiet color on every side');
    const repeatedNative=await call('Runtime.evaluate',{expression:`new Promise(resolve=>{let remaining=3;const next=()=>{SemanticTheme.refresh();setTimeout(()=>{if(--remaining)next();else resolve({style:getComputedStyle(document.querySelector('#nativeInput')).borderTopStyle,color:getComputedStyle(document.querySelector('#nativeInput')).borderTopColor});},20);};next();})`,awaitPromise:true,returnByValue:true});
    assert.deepEqual(repeatedNative.result.value,{style:'solid',color:'rgba(160, 160, 160, 0.35)'},'source recapture never oscillates between native bevel and owned solid border');
    const nativeOff=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({button:getComputedStyle(document.querySelector('#nativeButton')).borderTopStyle,input:getComputedStyle(document.querySelector('#nativeInput')).borderTopStyle,sheets:document.querySelectorAll('style[data-brave-media-theme-style="nativeStyle"]').length})`,returnByValue:true});
    assert.deepEqual(nativeOff.result.value,{button:'outset',input:'inset',sheets:0});
    // Exercise real Blink layout rounding, rather than supplying fractional
    // widths through a CSS declaration. CSS zoom models the layout scale;
    // the emulated DPR supplies the corresponding browser/output scale.
    const fractionalScale=1.85546875;
    await call('Emulation.setDeviceMetricsOverride',{width:640,height:300,deviceScaleFactor:fractionalScale,mobile:false});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>body{margin:0;background:black;color:white;font:18px sans-serif;zoom:${fractionalScale}}button,input{position:absolute;left:20px;font:inherit}button{top:20px}input{top:80px}</style><button id="scaledButton">Default</button><input id="scaledInput" placeholder="Type here">`});
    const scaledBaseline=await call('Runtime.evaluate',{expression:`Object.fromEntries(['scaledButton','scaledInput'].map(id=>{const node=document.getElementById(id),paint=getComputedStyle(node),rect=node.getBoundingClientRect();return [id,{appearance:paint.appearance,style:paint.borderTopStyle,borderWidth:paint.borderTopWidth,width:rect.width,height:rect.height}]}))`,returnByValue:true});
    assert.ok(Math.abs(parseFloat(scaledBaseline.result.value.scaledInput.borderWidth)-1.61684)<.00001,'real Blink reports the same fractional width as the desktop failure');
    const scaledPaint=await call('Runtime.evaluate',{expression:`SemanticTheme.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>resolve(Object.fromEntries(['scaledButton','scaledInput'].map(id=>{const node=document.getElementById(id),paint=getComputedStyle(node),rect=node.getBoundingClientRect();return [id,{appearance:paint.appearance,style:paint.borderTopStyle,color:paint.borderTopColor,borderWidth:paint.borderTopWidth,width:rect.width,height:rect.height,left:rect.left,top:rect.top}]}))),80))`,awaitPromise:true,returnByValue:true});
    for(const id of ['scaledButton','scaledInput']) {
      assert.equal(scaledPaint.result.value[id].style,'solid');assert.equal(scaledPaint.result.value[id].color,'rgba(160, 160, 160, 0.35)');
      for(const key of ['appearance','borderWidth','width','height'])assert.equal(scaledPaint.result.value[id][key],scaledBaseline.result.value[id][key],`${id} keeps ${key} at fractional scale`);
    }
    pixel=await screenshot();
    for(const id of ['scaledButton','scaledInput']) {
      const r=scaledPaint.result.value[id],inset=parseFloat(r.borderWidth)*fractionalScale/2;
      assert.deepEqual(pixel(Math.round((r.left+inset)*fractionalScale),Math.round((r.top+r.height/2)*fractionalScale)),[56,56,56],`${id} fractional border actually paints the quiet flat color`);
    }
    await call('Runtime.evaluate',{expression:'SemanticTheme.disable()'});
    await call('Emulation.setDeviceMetricsOverride',{width:420,height:220,deviceScaleFactor:1,mobile:false});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:410,y:210});
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>body{margin:0;background:black;color:white}#photo{position:absolute;left:20px;top:0;width:140px;height:140px}#glass{position:sticky;top:0;z-index:10;box-sizing:border-box;width:100%;height:56px;background:rgba(6,66,90,.9);padding:8px 20px}button{margin-left:80px;background:#bb2233;border:0;height:36px;color:white}ul{margin:110px 0 0;padding:0}li{list-style:none;width:120px;height:60px;background:#02655a}li a{color:white;display:block;height:100%}.icon{display:inline-block;width:20px;height:20px;background:#02655a}#status{width:100%;height:32px;background:#bb2233}#photo img{width:100%;height:100%}</style><div id="photo"><img id="picture" alt="Meaningful red picture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Crect width='140' height='140' fill='red'/%3E%3C/svg%3E"></div><div id="glass">Navigation<button id="action">Send</button></div><ul role="tablist"><li role="presentation" id="tile"><a role="tab" href="#panel"><span class="icon" id="brand"></span>Engage</a></li></ul><div id="status" role="status">Warning</div>`});
    const geometryModule=readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8');
    const surfaceState=await call('Runtime.evaluate',{expression:geometryModule+`\nSemanticTheme.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66'});new Promise(resolve=>setTimeout(()=>{const header=document.querySelector('#glass'),picture=document.querySelector('#picture'),bounds=picture.getBoundingClientRect();resolve({owners:Object.fromEntries(['glass','tile','action','status','brand','picture'].map(id=>[id,SemanticTheme.isSurface(document.getElementById(id))])),fill:getComputedStyle(header).backgroundColor,action:getComputedStyle(document.querySelector('#action')).backgroundColor,status:getComputedStyle(document.querySelector('#status')).backgroundColor,brand:getComputedStyle(document.querySelector('#brand')).backgroundColor,cutouts:MediaGeometry.opaqueUiRegions([header],getComputedStyle,null,[{element:picture,rect:bounds}]).length,source:picture.getAttribute('src')});},80))`,awaitPromise:true,returnByValue:true});
    assert.equal(surfaceState.exceptionDetails,undefined);
    assert.deepEqual(surfaceState.result.value.owners,{glass:true,tile:true,action:false,status:false,brand:false,picture:false});
    assert.equal(surfaceState.result.value.fill,'rgb(0, 0, 0)','the short sticky structural overlay owns an opaque source canvas');
    for(const owner of ['action','status','brand'])assert.notEqual(surfaceState.result.value[owner],'rgb(0, 0, 0)',`${owner} retains its meaningful colored paint`);
    assert.ok(surfaceState.result.value.cutouts>0,'opaque source canvas provides media occlusion evidence');
    assert.ok(surfaceState.result.value.source.startsWith('data:image/svg+xml,'));
    pixel=await screenshot();assert.deepEqual(pixel(40,30),[0,0,0],'header no longer shows tinted media through its translucent authored fill');assert.deepEqual(pixel(40,90),[255,0,0],'meaningful picture outside the header is unchanged');
    const transparentRelease=await call('Runtime.evaluate',{expression:`document.querySelector('#glass').style.backgroundColor='transparent';SemanticTheme.refresh();new Promise(resolve=>setTimeout(()=>resolve({owner:SemanticTheme.isSurface(document.querySelector('#glass')),fill:getComputedStyle(document.querySelector('#glass')).backgroundColor}),50))`,awaitPromise:true,returnByValue:true});
    assert.deepEqual(transparentRelease.result.value,{owner:false,fill:'rgba(0, 0, 0, 0)'},'owned styles do not conceal a source change to transparent');
    const restoredSurfaces=await call('Runtime.evaluate',{expression:`SemanticTheme.disable();({tile:document.querySelector('#tile').hasAttribute('data-brave-media-surface'),tileFill:getComputedStyle(document.querySelector('#tile')).backgroundColor,headerStyle:document.querySelector('#glass').style.backgroundColor,source:document.querySelector('#picture').getAttribute('src')})`,returnByValue:true});
    assert.equal(restoredSurfaces.result.value.tile,false);assert.equal(restoredSurfaces.result.value.tileFill,'rgb(2, 101, 90)');assert.equal(restoredSurfaces.result.value.headerStyle,'transparent');assert.equal(restoredSurfaces.result.value.source,surfaceState.result.value.source);
    // Reloading an extension replaces its isolated world, while the page and
    // previous engine's DOM remain. Exercise that ownership handoff without a
    // page reload: form state and the new controller's sheets must survive.
    await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><style>body{margin:0;background:#323437;color:#ccc}header{display:flex;position:fixed;top:0;left:0;right:0;height:50px;background:rgba(30,80,100,.8)}svg{position:absolute;top:80px;color:rgb(18,52,86)}</style><header>Navigation<input id="draft" value="Unsubmitted form draft"></header><svg width="200" height="100"><rect width="200" height="100" fill="currentColor"></rect></svg>`});
    const oldWorld=(await call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'retired-extension'})).executionContextId;
    const newWorld=(await call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'replacement-extension'})).executionContextId;
    const evaluateWorld=async(contextId,expression)=>{
      const result=await call('Runtime.evaluate',{contextId,expression,awaitPromise:true,returnByValue:true});
      assert.equal(result.exceptionDetails,undefined);return result.result.value;
    };
    const formState=`{value:document.querySelector('#draft').value,start:document.querySelector('#draft').selectionStart,end:document.querySelector('#draft').selectionEnd}`;
    // The previously installed engine cannot receive the new ownership fix.
    // Reproduce its broad cleanup instead of using a patched retiring engine.
    const retiringVendor=vendor.replace('.darkreader:not([data-brave-media-theme-style])','.darkreader');
    assert.notEqual(retiringVendor,vendor);
    const oldMarker=await evaluateWorld(oldWorld,retiringVendor+'\n'+source+`\nSemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});document.querySelector('#draft').setSelectionRange(3,8);new Promise(resolve=>setTimeout(()=>resolve(document.querySelector('meta[name="darkreader"]').content),80))`);
    const replacement=await evaluateWorld(newWorld,vendor+'\n'+source+`\nSemanticTheme.enable({background:'#000000',foreground:'#e6e6e6'});new Promise(resolve=>setTimeout(()=>resolve({marker:document.querySelector('meta[name="darkreader"]').content,fill:getComputedStyle(document.querySelector('header')).backgroundColor,art:getComputedStyle(document.querySelector('svg')).color,sheets:document.querySelectorAll('style[data-brave-media-theme-style]').length,form:${formState}}),100))`);
    assert.notEqual(replacement.marker,oldMarker,'the replacement engine owns the existing document');
    assert.equal(replacement.fill,'rgb(0, 0, 0)','retiring the previous engine cannot delete the replacement structural canvas sheet');
    assert.equal(replacement.art,'rgb(18, 52, 86)','replacement artwork source sheet remains attached');
    assert.ok(replacement.sheets>0,'semantic sheets are owned by their controller across engine takeover');
    assert.deepEqual(replacement.form,{value:'Unsubmitted form draft',start:3,end:8});
    pixel=await screenshot();assert.deepEqual(pixel(20,30),[0,0,0],'replacement header actually paints the canvas');assert.deepEqual(pixel(20,100),[18,52,86],'replacement artwork actually retains source paint');
    await evaluateWorld(oldWorld,'SemanticTheme.dispose();true');
    const retired=await evaluateWorld(newWorld,`SemanticTheme.refresh();new Promise(resolve=>setTimeout(()=>resolve({fill:getComputedStyle(document.querySelector('header')).backgroundColor,art:getComputedStyle(document.querySelector('svg')).color,sheets:document.querySelectorAll('style[data-brave-media-theme-style]').length,form:${formState}}),50))`);
    assert.equal(retired.fill,'rgb(0, 0, 0)');assert.equal(retired.art,'rgb(18, 52, 86)');assert.ok(retired.sheets>0);assert.deepEqual(retired.form,replacement.form);
    const handoffOff=await evaluateWorld(newWorld,`SemanticTheme.disable();({fill:getComputedStyle(document.querySelector('header')).backgroundColor,sheets:document.querySelectorAll('style[data-brave-media-theme-style]').length,surfaces:document.querySelectorAll('[data-brave-media-surface]').length,form:${formState}})`);
    assert.deepEqual(handoffOff,{fill:'rgba(30, 80, 100, 0.8)',sheets:0,surfaces:0,form:replacement.form},'OFF restores authored paint and form state without reloading');
  } finally {
    socket?.close();try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    let exitTimer;await Promise.race([exited,new Promise(resolve=>{exitTimer=setTimeout(resolve,3000);})]);clearTimeout(exitTimer);try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    rmSync(profile,{recursive:true,force:true});
  }
});
