import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const geometry = readFileSync(new URL('./extension/geometry.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./extension/content.js', import.meta.url), 'utf8');
const scope = vm.createContext({});
vm.runInContext(geometry, scope);
const G = scope.MediaGeometry;
const plain = value => JSON.parse(JSON.stringify(value));
function element(name, width = 100, height = 100, background = 'none', role = null) {
  return { localName:name, childNodes:[], shadowRoot:null, matches:()=>['img','video','canvas','svg','object','embed','iframe'].includes(name), getAttribute:key=>key==='role'?role:null, closest:()=>null, style:{visibility:'visible',opacity:'1',display:'block',backgroundImage:background}, getBoundingClientRect:()=>({left:10,top:20,right:10+width,bottom:20+height,width,height}) };
}
function sample(elements, animations = [], hostname = 'fixture.test', elementsFromPoint = undefined, styleReader = null) {
  const sent = [], frames = [];
  let message;
  const context = { location:{hostname}, innerWidth:1200,innerHeight:900,outerWidth:1200,outerHeight:1000,devicePixelRatio:1,screenX:0,screenY:0, document:{visibilityState:'visible',fullscreenElement:null,elementsFromPoint,querySelectorAll:()=>elements,getAnimations:()=>animations}, chrome:{runtime:{onMessage:{addListener:fn=>{message=fn;}},sendMessage:async packet=>{sent.push(packet);}}}, visualViewport:{scale:1,offsetLeft:0,offsetTop:0,addEventListener(){}},addEventListener(){},requestAnimationFrame:fn=>frames.push(fn),setInterval(){},MutationObserver:class{observe(){}},getComputedStyle:styleReader||((el)=>el.style) };
  vm.runInNewContext(geometry,context);
  vm.runInNewContext(content,context);
  message({type:'media-set-enabled-v2',enabled:true,zoom:1});
  frames.shift()();
  return { state:sent.find(m=>m.type==='media-content-state'), frames };
}
test('UI gradient fills do not create opaque image masks', () => {
  assert.equal(G.hasMediaBackground('linear-gradient(black, #222)'), false);
  assert.equal(G.hasMediaBackground('radial-gradient(circle, black, transparent)'), false);
  assert.equal(G.hasMediaBackground('none'), false);
  assert.equal(G.hasMediaBackground('linear-gradient(black, #222), url("art.jpg")'), true);
  assert.equal(G.hasMediaBackground('image-set(url("art.jpg") 1x, url("art@2x.jpg") 2x)'), true);
});
test('small SVG artwork remains protected when semantic glyph proof is unavailable', () => {
  const smallArtwork = element('svg',24,24);
  const illustration = element('svg',300,180);
  const result = sample([smallArtwork,illustration]);
  assert.equal(result.state.boxes.length,2);
  assert.deepEqual(plain(result.state.boxes),[{left:10,top:20,right:34,bottom:44},{left:10,top:20,right:310,bottom:200}]);
});
test('empty custom UI tags require an explicit media signal', () => {
  const backdrop = element('custom-backdrop',1200,900);
  const artwork = element('custom-art',300,200,'none','img');
  const cssImage = element('custom-card',300,200,'url("art.jpg")');
  assert.equal(G.isExplicitCustomMedia(backdrop),false);
  assert.equal(G.isExplicitCustomMedia(artwork),true);
  assert.equal(sample([backdrop,artwork,cssImage]).state.boxes.length,2);
});
test('real images, videos and CSS image layers retain their protection', () => {
  const result = sample([element('img'),element('video'),element('canvas'),element('div',300,200,'url("cover.jpg")'),element('button',120,40,'linear-gradient(black,#333)')]);
  assert.equal(result.state.valid,true);
  assert.equal(result.state.boxes.length,4);
});
test('decorative hover animation does not trigger repeated layout scans', () => {
  const video = element('video',600,400);
  const button = element('button',120,40,'linear-gradient(black,#333)');
  const animation = {playState:'running',effect:{target:button}};
  assert.equal(sample([video,button],[animation]).frames.length,0);
  assert.equal(sample([video], [{playState:'running',effect:{target:video}}]).frames.length,1);
});
test('ordinary text and gradient UI nodes avoid layout box measurements', () => {
  let uiMeasurements = 0;
  const ui = Array.from({length:200},()=>{
    const el = element('div',200,40,'linear-gradient(black,#333)');
    el.getBoundingClientRect = () => {uiMeasurements++;throw new Error('ordinary UI should not be measured');};
    return el;
  });
  assert.equal(sample([...ui,element('img')]).state.boxes.length,1);
  assert.equal(uiMeasurements,0);
});

function canvasInspector() {
  let allocations = 0, reads = 0;
  const context = vm.createContext({ OffscreenCanvas:class {
    constructor(width,height) { this.width=width; this.height=height; allocations++; }
    getContext(kind) {
      assert.equal(kind,'2d');
      let source;
      return {
        clearRect() { source=null; },
        drawImage(canvas) { source=canvas; if(canvas.drawError) throw new Error('unreadable drawing'); },
        getImageData(x,y,width,height) {
          reads++;
          if(source.readError) throw new Error('tainted bitmap');
          if(source.incomplete) return {width,height,data:new Uint8ClampedArray(4)};
          return {width,height,data:source.pixels};
        },
      };
    }
  } });
  vm.runInContext(geometry,context);
  return { G:context.MediaGeometry, stats:()=>({allocations,reads}) };
}
function canvasBitmap(width=2,height=2) {
  return {localName:'canvas',width,height,pixels:new Uint8ClampedArray(width*height*4),
    getAttribute:key=>key==='data-brave-media-canvas-context'?'2d':null,
    getContext() { throw new Error('must not initialize or touch page-owned context'); }};
}
test('fully transparent canvas is omitted only after complete alpha verification', () => {
  const probe=canvasInspector(), canvas=canvasBitmap();
  canvas.pixels[0]=240; // RGB in a transparent pixel still paints nothing.
  assert.equal(probe.G.isCanvasPaintEmpty(canvas),true);
  canvas.pixels[canvas.pixels.length-1]=1; // Even the final faint pixel must protect media.
  assert.equal(probe.G.isCanvasPaintEmpty(canvas),false);
  assert.deepEqual(probe.stats(),{allocations:1,reads:2});
});
test('canvas drawing and clearing are rechecked without stale blank-result caching', () => {
  const probe=canvasInspector(), canvas=canvasBitmap();
  assert.equal(probe.G.isCanvasPaintEmpty(canvas),true);
  canvas.pixels[3]=255;
  assert.equal(probe.G.isCanvasPaintEmpty(canvas),false);
  canvas.pixels[3]=0;
  assert.equal(probe.G.isCanvasPaintEmpty(canvas),true);
  assert.deepEqual(probe.stats(),{allocations:1,reads:3});
});
test('unreadable or incomplete canvas stays protected and taint does not contaminate later probes', () => {
  const probe=canvasInspector(), canvas=canvasBitmap();
  for(const failure of ['drawError','readError','incomplete']) {
    canvas[failure]=true;
    assert.equal(probe.G.isCanvasPaintEmpty(canvas),false);
    delete canvas[failure];
    assert.equal(probe.G.isCanvasPaintEmpty(canvas),true);
  }
});
test('canvas readback is bounded by a shared snapshot pixel budget', () => {
  const probe=canvasInspector(), canvas=canvasBitmap(), budget={remainingPixels:4};
  assert.equal(probe.G.isCanvasPaintEmpty(canvas,budget),true);
  assert.equal(budget.remainingPixels,0);
  assert.equal(probe.G.isCanvasPaintEmpty(canvas,budget),false);
  assert.equal(probe.stats().reads,1);
  assert.equal(probe.G.isCanvasPaintEmpty({...canvas,width:4096,height:4096}),false);
  assert.equal(probe.G.isCanvasPaintEmpty({...canvas,width:0}),false);
  assert.equal(probe.G.isCanvasPaintEmpty({...canvas,width:NaN}),false);
  assert.equal(probe.G.isCanvasPaintEmpty({...canvas,width:1.5}),false);
  assert.equal(probe.G.isCanvasPaintEmpty({...canvas,localName:'svg'}),false);
  assert.equal(probe.stats().reads,1);
});
test('missing readback facilities retain canvas protection', () => {
  assert.equal(G.isCanvasPaintEmpty(canvasBitmap()),false);
});

test('unknown and WebGL canvases never authorize emptiness or read pixels', () => {
  const probe=canvasInspector(), canvas=canvasBitmap();
  for(const mode of [null,'unknown','webgl','webgl2','experimental-webgl','bitmaprenderer']) {
    canvas.getAttribute=()=>mode;
    assert.equal(probe.G.isCanvasPaintEmpty(canvas),false);
  }
  assert.deepEqual(probe.stats(),{allocations:0,reads:0});
});
const trackerSource=readFileSync(new URL('./extension/canvas-context.js',import.meta.url),'utf8');
function contextTracker() {
  const calls=[];
  class Element {
    constructor() { this.attributes=new Map(); this.tagWrites=0; }
    setAttribute(key,value) { if(this.tagError) throw new Error('tag blocked'); this.tagWrites++; this.attributes.set(key,value); }
    getAttribute(key) { return this.attributes.get(key)??null; }
  }
  class CanvasRenderingContext2D {}
  class HTMLCanvasElement extends Element {
    getContext(mode,options) {
      calls.push({receiver:this,args:Array.from(arguments)});
      if(this.nativeError) throw this.nativeError;
      const id=String(mode);
      if(this.contextMode && this.contextMode!==id) return null;
      if(!['2d','webgl','webgl2','bitmaprenderer'].includes(id)) return null;
      this.contextMode=id;
      return this.context??=id==='2d'?new CanvasRenderingContext2D():{kind:id};
    }
  }
  const original=HTMLCanvasElement.prototype.getContext;
  const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'getContext');
  const realm=vm.createContext({Element,HTMLCanvasElement,CanvasRenderingContext2D});
  vm.runInContext(trackerSource,realm);
  return {realm,original,descriptor,HTMLCanvasElement,calls};
}
test('context tracker preserves native signature, descriptor, prototype and arguments', () => {
  const fixture=contextTracker(), method=fixture.HTMLCanvasElement.prototype.getContext;
  assert.equal(method.name,fixture.original.name);
  assert.equal(method.length,fixture.original.length);
  assert.equal(Object.getPrototypeOf(method),Object.getPrototypeOf(fixture.original));
  assert.equal(Object.hasOwn(method,'prototype'),false);
  const descriptor=Object.getOwnPropertyDescriptor(fixture.HTMLCanvasElement.prototype,'getContext');
  for(const key of ['writable','configurable','enumerable']) assert.equal(descriptor[key],fixture.descriptor[key]);
  const canvas=new fixture.HTMLCanvasElement(), options={alpha:true};
  const result=canvas.getContext('2d',options,'extra');
  assert.equal(result,canvas.context);
  assert.equal(canvas.getAttribute('data-brave-media-canvas-context'),'2d');
  assert.equal(fixture.calls[0].receiver,canvas);
  assert.deepEqual(fixture.calls[0].args,['2d',options,'extra']);
  vm.runInContext(trackerSource,fixture.realm);
  assert.equal(fixture.HTMLCanvasElement.prototype.getContext,method);
});
test('context tracker preserves null returns, native throws and tagging failures', () => {
  const fixture=contextTracker(), canvas=new fixture.HTMLCanvasElement();
  assert.equal(canvas.getContext('unsupported'),null);
  assert.equal(canvas.getAttribute('data-brave-media-canvas-context'),null);
  const context=canvas.getContext('webgl');
  assert.equal(canvas.getAttribute('data-brave-media-canvas-context'),'webgl');
  assert.equal(canvas.getContext('2d'),null);
  assert.equal(canvas.getAttribute('data-brave-media-canvas-context'),'webgl');
  assert.equal(canvas.getContext('webgl'),context);
  assert.equal(canvas.tagWrites,1); // Repeated access never triggers duplicate DOM mutations.
  const failing=new fixture.HTMLCanvasElement(), error=new Error('native failure');
  failing.nativeError=error;
  assert.throws(()=>failing.getContext('2d'),value=>value===error);
  const untaggable=new fixture.HTMLCanvasElement();
  untaggable.tagError=true;
  assert.equal(untaggable.getContext('2d'),untaggable.context);
  assert.equal(untaggable.getAttribute('data-brave-media-canvas-context'),null);
});
test('context tracker never repeats contextId conversion and leaves it unknown', () => {
  const fixture=contextTracker(), canvas=new fixture.HTMLCanvasElement();
  let conversions=0;
  const id={toString() { conversions++; return '2d'; }};
  const result=canvas.getContext(id);
  assert.equal(conversions,1);
  assert.equal(result,canvas.context);
  assert.equal(canvas.getAttribute('data-brave-media-canvas-context'),'unknown');
});

test('visible canvas artwork is protected without hostname or decorative-style exceptions', () => {
  const overlay=element('canvas',1200,900);
  overlay.style.position='fixed';
  overlay.style.pointerEvents='none';
  overlay.style.zIndex='-1';
  overlay.getAttribute=key=>key==='aria-hidden'?'true':null;
  overlay.closest=()=>{throw new Error('canvas protection must not inspect site-specific selectors');};
  const picture=element('img',300,200);
  let expected;
  for(const hostname of ['fixture.test','www.youtube.com','other.example']) {
    const result=sample([overlay,picture],[],hostname);
    assert.equal(result.state.valid,true);
    assert.equal(result.state.boxes.length,2);
    const boxes=plain(result.state.boxes);
    expected??=boxes;
    assert.deepEqual(boxes,expected);
  }
  assert.equal('shouldProtectMedia' in G,false);
});

function fullPageBackground(name='div',role=null) {
  const el=element(name,1200,900,'url("wallpaper.jpg")',role);
  el.getBoundingClientRect=()=>({left:0,top:0,right:1200,bottom:900,width:1200,height:900});
  return el;
}
test('document canvas backgrounds do not blanket-protect foreground media', () => {
  const image=element('img',300,200);
  const result=sample([fullPageBackground('html'),fullPageBackground('body'),image]);
  assert.equal(result.state.boxes.length,1);
  assert.deepEqual(plain(result.state.boxes[0]),{left:10,top:20,right:310,bottom:220});
});
test('explicit inert viewport backdrops are decorative without site selectors', () => {
  for(const role of ['presentation','none',null]) {
    const backdrop=fullPageBackground('div',role);
    backdrop.style.position='fixed'; backdrop.style.pointerEvents='none';
    if(role===null) backdrop.style.zIndex='-1';
    assert.equal(sample([backdrop,element('video')]).state.boxes.length,1);
  }
  const backdrop=fullPageBackground();
  backdrop.style.position='absolute'; backdrop.style.pointerEvents='none';
  backdrop.getAttribute=key=>key==='aria-hidden'?'true':null;
  assert.equal(sample([backdrop]).state.boxes.length,0);
});
test('large CSS artwork requires protection unless positive backdrop semantics exist', () => {
  const ordinary=fullPageBackground();
  ordinary.style.position='fixed'; ordinary.style.pointerEvents='none';
  assert.equal(sample([ordinary]).state.boxes.length,1);
  const explicit=fullPageBackground('div','img');
  explicit.style.position='fixed'; explicit.style.pointerEvents='none';explicit.style.zIndex='-1';
  assert.equal(sample([explicit]).state.boxes.length,1);
  const child=fullPageBackground();
  child.style.position='fixed';child.style.pointerEvents='none';child.style.zIndex='-1';
  child.parentElement=element('figure');
  assert.equal(sample([child]).state.boxes.length,1);
  const content=element('div',300,200,'url("artwork.jpg")','presentation');
  content.style.position='fixed';content.style.pointerEvents='none';content.style.zIndex='-1';
  assert.equal(sample([content]).state.boxes.length,1);
});
test('intrinsic media and explicitly labeled document artwork are never page backdrops', () => {
  for(const name of ['img','video','canvas','svg']) {
    const media=fullPageBackground(name,'presentation');
    media.style.position='fixed';media.style.pointerEvents='none';media.style.zIndex='-1';
    assert.equal(sample([media]).state.boxes.length,1);
  }
  assert.equal(sample([fullPageBackground('body','img')]).state.boxes.length,1);
});

function wallpaperFixture() {
  function node(name,role=null) {
    const value=fullPageBackground(name,role);
    value.children=[];value.textContent='';
    value.append=child=>{child.parentElement=value;value.children.push(child);return child;};
    value.contains=target=>target===value||value.children.some(child=>child.contains(target));
    value.querySelector=()=>null;
    value.querySelectorAll=selector=> {
      const descendants=[];
      function visit(parent) { for(const child of parent.children) { descendants.push(child);visit(child); } }
      visit(value);
      return descendants.filter(child=>selector==='img'?child.localName==='img':child.localName==='main'||['main','application'].includes(child.getAttribute('role')));
    };
    return value;
  }
  const scope=node('div'),layer=scope.append(node('div'));
  layer.style.position='fixed';
  const image=layer.append(node('img'));
  const app=scope.append(node('div')),main=app.append(node('main')),row=main.append(node('div'));
  const rect=image.getBoundingClientRect();
  const viewport={innerWidth:1200,innerHeight:900,elementsFromPoint:()=>[row,main,app,image,layer,scope]};
  return {scope,layer,image,app,main,row,rect,viewport};
}
test('dedicated unlabeled wallpaper behind semantic application content is decorative', () => {
  const f=wallpaperFixture();
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,f.viewport),true);
  // A transient menu above the application does not change wallpaper ownership.
  f.viewport.elementsFromPoint=()=>[element('div'),f.row,f.main,f.app,f.image,f.layer,f.scope];
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,f.viewport),true);
});
test('image size alone or sparse viewer controls never classify content artwork as wallpaper', () => {
  const f=wallpaperFixture();
  f.viewport.elementsFromPoint=()=>[f.image,f.layer,f.row,f.main,f.app,f.scope];
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,f.viewport),false);
  f.viewport.elementsFromPoint=(x,y)=>y<400?[f.row,f.main,f.app,f.image]:[f.image,f.layer,f.scope];
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,f.viewport),false);
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,{innerWidth:1200,innerHeight:900}),false);
});
test('labeled artwork, figures, interactive layers and missing paint evidence remain protected', () => {
  for(const mutation of [
    f=>{f.image.getAttribute=key=>key==='alt'?'Photo artwork':null;},
    f=>{f.image.getAttribute=key=>key==='role'?'img':null;},
    f=>{f.layer.localName='figure';},
    f=>{f.layer.style.position='absolute';},
    f=>{f.layer.querySelector=()=>element('button');},
    f=>{f.layer.textContent='Actual article content';},
    f=>{f.app.querySelectorAll=()=>[];f.scope.querySelectorAll=selector=>selector==='img'?[f.image]:[];},
    f=>{f.viewport.elementsFromPoint=()=>[f.row,f.main,f.app];},
    f=>{f.viewport.elementsFromPoint=()=>{throw new Error('paint unavailable');};},
  ]) {
    const f=wallpaperFixture();mutation(f);
    assert.equal(G.isDecorativeWallpaperImage(f.image,f.rect,node=>node.style,f.viewport),false);
  }
});
test('dedicated fixed wallpaper ownership survives a larger viewport than its intrinsic image',()=>{
  const f=wallpaperFixture();f.viewport.innerWidth=1719;f.viewport.innerHeight=859;
  f.layer.getBoundingClientRect=()=>({left:0,top:0,right:1719,bottom:859,width:1719,height:859});
  f.image.getBoundingClientRect=()=>({left:0,top:0,right:1440,bottom:900,width:1440,height:900});
  const points=[];f.viewport.elementsFromPoint=(x,y)=>{points.push([x,y]);return [f.row,f.main,f.app,f.image,f.layer,f.scope];};
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.image.getBoundingClientRect(),el=>el.style,f.viewport),true);
  assert.equal(points.length,9);assert.ok(points.every(([x,y])=>x>0&&x<1440&&y>0&&y<859));
  f.image.getAttribute=key=>key==='alt'?'Meaningful photo':null;
  assert.equal(G.isDecorativeWallpaperImage(f.image,f.image.getBoundingClientRect(),el=>el.style,f.viewport),false);
});
function occlusionFixture() {
  const image=element('img',16,16),panel=element('div',200,200);
  panel.getBoundingClientRect=()=>({left:0,top:0,right:200,bottom:200,width:200,height:200});
  panel.style={...panel.style,backgroundColor:'rgb(0, 0, 0)',backgroundClip:'border-box',borderTopLeftRadius:'0px',borderTopRightRadius:'0px',borderBottomLeftRadius:'0px',borderBottomRightRadius:'0px'};
  const viewport={innerWidth:1200,innerHeight:900,elementsFromPoint:()=>[panel,image]};
  return {image,panel,viewport,rect:image.getBoundingClientRect()};
}
test('fully covered underlying media does not own pixels of an unrelated opaque rectangular popup',()=>{
  const f=occlusionFixture();
  assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),true);
  f.viewport.elementsFromPoint=()=>[f.image,f.panel];assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),false);
});
test('partial coverage, alpha, rounded corners and unknown paint geometry retain media protection',()=>{
  for(const mutate of [
    f=>{f.panel.getBoundingClientRect=()=>({left:0,top:0,right:20,bottom:200});},
    f=>{f.panel.style.backgroundColor='rgba(0, 0, 0, 0.8)';},
    f=>{f.panel.style.opacity='.8';},
    f=>{f.panel.style.borderTopLeftRadius='8px';},
    f=>{f.panel.style.transform='matrix(1,0,0,1,0,0)';},
    f=>{f.panel.style.clipPath='circle(40%)';},
    f=>{f.panel.style.rotate='45deg';},
    f=>{f.panel.style.backgroundClip='text';},
    f=>{f.panel.style.backgroundClip='content-box';},
    f=>{f.panel.style.maskImage='url(mask.png)';},
    f=>{f.panel.style.backgroundColor='transparent';},
    f=>{f.viewport.elementsFromPoint=(x,y)=>x>20?[f.image,f.panel]:[f.panel,f.image];},
    f=>{f.viewport.elementsFromPoint=()=>[f.panel];},
    f=>{f.panel.contains=node=>node===f.image;},
    f=>{f.viewport.elementsFromPoint=()=>{throw new Error('unknown');};},
    f=>{const parent=element('div');parent.style.opacity='.5';f.panel.parentElement=parent;},
  ]) {const f=occlusionFixture();mutate(f);assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),false);}
});
test('overflow-clipped opaque popup cannot suppress media outside its painted region',()=>{
  const f=occlusionFixture(),parent=element('div',8,8);parent.style.overflow='hidden';parent.style.position='relative';
  f.panel.parentElement=parent;
  assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),false);
});

test('content snapshot omits fully covered attachment geometry and restores it when popup leaves',()=>{
  const f=occlusionFixture();
  assert.equal(sample([f.image,f.panel],[],'fixture.test',f.viewport.elementsFromPoint).state.boxes.length,0);
  const revealed=sample([f.image,f.panel],[],'fixture.test',()=>[f.image,f.panel]);
  assert.equal(revealed.state.boxes.length,1);
  assert.deepEqual(plain(revealed.state.boxes[0]),{left:10,top:20,right:26,bottom:36});
});

test('higher shared popup ancestor proves coverage through its controls, while contain paint remains clipped',()=>{
  const f=occlusionFixture(),control=element('button',10,10);control.parentElement=f.panel;
  f.viewport.elementsFromPoint=()=>[control,f.panel,f.image];
  assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),true);
  const parent=element('div',8,8);parent.style.contain='paint';parent.style.position='relative';f.panel.parentElement=parent;
  assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),false);
});

test('graphics or artwork CSS background declarations cannot prove an opaque HTML paint rectangle',()=>{
  const f=occlusionFixture();f.panel.localName='path';const svg=element('svg');f.panel.parentElement=svg;
  assert.equal(G.isFullyOccludedMedia(f.image,f.rect,el=>el.style,f.viewport),false);
});
test('content keeps actual icons protected while partial neutral sibling fills stop inheriting CSS photo masks',()=>{
  const photo=element('div',300,200,'url(photo.jpg)'),panel=element('div',200,160),icon=element('img',16,16);
  panel.style.backgroundColor='rgb(52, 52, 52)';panel.style.backgroundClip='border-box';
  panel.getBoundingClientRect=()=>({left:50,top:150,right:250,bottom:310,width:200,height:160});
  icon.getBoundingClientRect=()=>({left:80,top:170,right:96,bottom:186,width:16,height:16});icon.parentElement=panel;
  const result=sample([photo,panel,icon],[],'fixture.test',(x,y)=>x>=80&&x<=96&&y>=170&&y<=186?[icon,panel,photo]:[panel,photo]);
  const protectedAt=(x,y)=>result.state.boxes.some(rect=>x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom);
  assert.equal(protectedAt(180,180),false);assert.equal(protectedAt(88,178),true);assert.equal(protectedAt(20,80),true);
  assert.equal(result.state.valid,true);assert.ok(result.state.boxes.length<=128);
});

test('content uses distinct pseudo computed styles and does not cut a foreground with unclassified pseudo artwork',()=>{
  const photo=element('div',300,200,'url(photo.jpg)'),panel=element('div',200,160);
  panel.style.backgroundColor='rgb(52, 52, 52)';panel.style.backgroundClip='border-box';
  panel.getBoundingClientRect=()=>({left:50,top:150,right:250,bottom:310,width:200,height:160});
  const calls=[];
  const result=sample([photo,panel],[],'fixture.test',()=>[panel,photo],(el,pseudo)=> {
    calls.push([el,pseudo]);
    return pseudo?{content:'""',backgroundImage:pseudo==='::before'?'url(artwork.png)':'none',maskImage:'none'}:el.style;
  });
  assert.ok(calls.some(([el,pseudo])=>el===panel&&pseudo==='::before'));
  assert.equal(result.state.boxes.length,1);assert.deepEqual(plain(result.state.boxes[0]),{left:10,top:20,right:310,bottom:220});
  assert.equal(calls.filter(([el,pseudo])=>el===panel&&pseudo==='::before').length,1,'pseudo style cached once per snapshot');
});
