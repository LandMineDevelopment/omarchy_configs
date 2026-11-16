import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const geometry=readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8');
const content=readFileSync(new URL('./extension/content.js',import.meta.url),'utf8');
function element(name='div') {
  let left=10;
  return {localName:name,nodeType:1,namespaceURI:'http://www.w3.org/1999/xhtml',parentElement:null,shadowRoot:null,childNodes:[],
    style:{display:'block',visibility:'visible',opacity:'1',backgroundImage:'none',backgroundColor:'rgba(0,0,0,0)'},
    getAttribute:()=>null,matches:()=>['img','video','svg','canvas','iframe','object','embed'].includes(name),querySelectorAll:()=>[],
    getBoundingClientRect:()=>({left,top:20,right:left+100,bottom:120,width:100,height:100}),move:x=>left=x};
}
function root(nodes=[]) {
  const events=new Map();let scans=0;
  return {nodes,querySelectorAll:()=>{scans++;return nodes;},get scans(){return scans;},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),events};
}
function harness(nodes,configureDocument=()=>{},configureScope=()=>{}) {
  const document=root(nodes);document.visibilityState='visible';document.fullscreenElement=null;
  configureDocument(document);
  let animations=[],animationReads=0;document.getAnimations=()=>{animationReads++;return animations;};
  const frames=[],sent=[],events={},observers=[];let handler,heartbeat,sourceListener,beforeRefresh,now=1000;
  const scope={SemanticTheme:{setBeforeRefresh:callback=>beforeRefresh=callback,setFetchMethod(){},ownsMutation:()=>false,dispose(){}},DarkReader:{onSourceChange:callback=>{sourceListener=callback;return ()=>sourceListener=null;}},Date:{now:()=>now},document,innerWidth:1200,innerHeight:900,outerWidth:1200,outerHeight:1000,devicePixelRatio:1,screenX:0,screenY:0,
    visualViewport:{scale:1,offsetLeft:0,offsetTop:0,addEventListener(){},removeEventListener(){}},
    getComputedStyle:(el,pseudo)=>pseudo?{content:'none',backgroundImage:'none',maskImage:'none'}:el.style,
    addEventListener:(name,fn)=>events[name]=fn,removeEventListener:name=>delete events[name],
    requestAnimationFrame:fn=>{frames.push(fn);},setInterval:fn=>{heartbeat=fn;return 1;},clearInterval(){},
    MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(root,options){this.root=root;this.options=options;}disconnect(){this.disconnected=true;}},
    chrome:{runtime:{sendMessage:async message=>{sent.push(message);},onMessage:{addListener:fn=>handler=fn,removeListener(){}}}}};
  configureScope(scope);
  vm.runInNewContext(geometry,scope);vm.runInNewContext(content,scope);handler({type:'media-set-enabled-v2',enabled:true,zoom:1});
  const frame=()=>{const fn=frames.shift();assert.ok(fn,'expected scheduled frame');fn();};frame();
  return {scope,document,events,observers,sent,frames,frame,beforeRefresh:()=>beforeRefresh?.(),hasBeforeRefresh:()=>!!beforeRefresh,message:value=>handler(value),heartbeat:()=>{now+=200;heartbeat();frame();},last:()=>sent.filter(message=>message.type==='media-content-state').at(-1),animate:value=>animations=value,animationReads:()=>animationReads,sourceChange:()=>sourceListener(),hasSourceListener:()=>!!sourceListener};
}

function measuredElement(name,rect,metrics={}) {
  const node=element(name),reads={bounds:0};
  node.rect=rect;node.metrics=metrics;node.reads=reads;
  node.getBoundingClientRect=()=>{reads.bounds++;return {...node.rect,width:node.rect.right-node.rect.left,height:node.rect.bottom-node.rect.top};};
  for(const key of ['offsetWidth','offsetHeight','clientLeft','clientTop','clientWidth','clientHeight']) {
    reads[key]=0;Object.defineProperty(node,key,{get(){reads[key]++;return node.metrics[key];}});
  }
  return node;
}
test('one snapshot shares nested scrollport bounds and client metrics while the next measures changed layout',()=>{
  const outer=measuredElement('div',{left:10.5,top:20.25,right:310.5,bottom:220.25},
    {offsetWidth:200,offsetHeight:100,clientLeft:2,clientTop:1,clientWidth:190,clientHeight:90});
  const inner=measuredElement('div',{left:30.5,top:40.25,right:270.5,bottom:200.25},
    {offsetWidth:160,offsetHeight:80,clientLeft:1,clientTop:1,clientWidth:150,clientHeight:70});
  outer.style.overflow='hidden';outer.style.transform='matrix(1.5, 0, 0, 2, 0, 0)';
  inner.style.overflow='auto';inner.parentElement=outer;
  const first=measuredElement('img',{left:0,top:0,right:400,bottom:250});first.parentElement=inner;
  const second=measuredElement('img',{left:100,top:100,right:400,bottom:300});second.parentElement=inner;
  const third=measuredElement('img',{left:0,top:0,right:500,bottom:500});third.parentElement=outer;
  const h=harness([outer,inner,first,second,third]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.last().boxes)),[
    {left:32,top:42.25,right:257,bottom:182.25},
    {left:100,top:100,right:257,bottom:182.25},
    {left:13.5,top:22.25,right:298.5,bottom:202.25},
  ]);
  for(const node of [outer,inner]) for(const [key,count] of Object.entries(node.reads))
    assert.equal(count,1,`shared scrollport ${key} measured once`);
  for(const node of [first,second,third]) {
    assert.equal(node.reads.bounds,1);
    for(const [key,count] of Object.entries(node.reads)) if(key!=='bounds') assert.equal(count,0,'media bounds do not request client metrics');
  }
  outer.rect.top+=10;outer.rect.bottom+=10;inner.rect.top+=20;inner.rect.bottom+=20;
  inner.metrics.clientWidth=120;second.rect.left=110;second.rect.right=410;
  h.heartbeat();
  assert.equal(h.document.scans,1,'silent layout changes need fresh geometry, not another candidate scan');
  assert.deepEqual(JSON.parse(JSON.stringify(h.last().boxes)),[
    {left:32,top:62.25,right:212,bottom:202.25},
    {left:110,top:100,right:212,bottom:202.25},
    {left:13.5,top:32.25,right:298.5,bottom:212.25},
  ]);
  for(const node of [outer,inner]) for(const [key,count] of Object.entries(node.reads)) assert.equal(count,2,`${key} refreshed next snapshot`);
  for(const node of [first,second,third]) assert.equal(node.reads.bounds,2);
});
test('media clipping and rounded UI cutouts share one scrollport sample',()=>{
  const scroller=measuredElement('div',{left:0,top:0,right:300,bottom:300},
    {offsetWidth:300,offsetHeight:300,clientLeft:0,clientTop:0,clientWidth:300,clientHeight:300});
  scroller.style.overflow='hidden';scroller.style.backgroundColor='rgb(52,52,52)';
  const first=measuredElement('img',{left:10,top:10,right:210,bottom:210});first.parentElement=scroller;
  const second=measuredElement('img',{left:0,top:0,right:280,bottom:280});second.parentElement=scroller;
  const panel=measuredElement('div',{left:50,top:70,right:180,bottom:180});panel.parentElement=scroller;
  panel.style.backgroundColor='rgb(52,52,52)';
  for(const key of ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']) panel.style[key]='20px';
  const h=harness([scroller,first,second,panel],document=>document.elementsFromPoint=()=>[panel,second,first]);
  const owns=(x,y)=>h.last().boxes.some(rect=>x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom);
  assert.equal(owns(100,100),false,'proved foreground canvas removes covered image pixels');
  assert.equal(owns(51,71),true,'rounded corners retain media protection');
  assert.equal(owns(200,200),true,'uncovered artwork remains protected');
  for(const [key,count] of Object.entries(scroller.reads)) assert.equal(count,1,`${key} shared between images and UI clips`);
  for(const node of [first,second,panel]) assert.equal(node.reads.bounds,1);
  panel.rect={left:200,top:200,right:280,bottom:280};h.heartbeat();
  assert.equal(owns(100,100),true,'a later snapshot releases the old UI cutout');
  for(const [key,count] of Object.entries(scroller.reads)) assert.equal(count,2,`${key} refreshed for changed UI geometry`);
});

test('shared ancestor style values are sampled once per snapshot and refreshed after silent style changes',()=>{
  const parent=measuredElement('div',{left:0,top:0,right:300,bottom:300},
    {offsetWidth:300,offsetHeight:300,clientLeft:0,clientTop:0,clientWidth:300,clientHeight:300});
  const values={...parent.style,overflow:'hidden',position:'static',opacity:'1'},reads={};
  parent.style={};
  for(const key of Object.keys(values)) Object.defineProperty(parent.style,key,{get(){reads[key]=(reads[key]||0)+1;return values[key];}});
  const images=[10,30,50].map(left=>{
    const image=measuredElement('img',{left,top:20,right:left+100,bottom:120});image.parentElement=parent;return image;
  });
  const h=harness([parent,...images]);
  assert.equal(h.last().boxes.length,3);
  for(const key of ['display','opacity','position','overflow','backgroundImage'])
    assert.equal(reads[key],1,`${key} is one scalar sample shared by discovery, visibility and clipping`);
  values.opacity='0';h.heartbeat();
  assert.equal(h.last().boxes.length,0,'a later snapshot sees changed ancestor paint');
  assert.equal(reads.opacity,2,'style values never survive across snapshots');
  values.opacity='1';h.heartbeat();
  assert.equal(h.last().boxes.length,3,'a later snapshot restores visible media');
  assert.equal(reads.opacity,3);
});

test('first geometry after shadow theme initialization discards earlier ancestor paint samples',()=>{
  const parent=element('div'),image=element('img'),host=element('x-panel');
  image.parentElement=parent;host.parentElement=parent;host.shadowRoot=root([]);
  let initialized=0;
  const h=harness([parent,image,host],()=>{},scope=>{
    scope.SemanticTheme.discoverRoot=()=>{initialized++;parent.style.opacity='0';return true;};
  });
  assert.equal(initialized,1);
  assert.equal(h.last().boxes.length,0,'initial shadow writes are visible to the first mask');
  parent.style.opacity='1';h.heartbeat();
  assert.equal(h.last().boxes.length,1,'later samples remain live');
  assert.equal(initialized,1,'retained roots are not initialized again by heartbeat');
});

function readableCanvas(width=2,height=2) {
  return {...element('canvas'),width,height,painted:false,
    getAttribute:key=>key==='data-brave-media-canvas-context'?'2d':null};
}
function canvasReadback(scope,reads) {
  scope.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(){let source;return {
      clearRect(){},drawImage(canvas){source=canvas;},
      getImageData(x,y,width,height){
        reads.push(source);const data=new Uint8ClampedArray(width*height*4);
        if(source.painted)data[data.length-1]=255;
        return {width,height,data};
      },
    };}
  };
}
test('hidden offscreen and fully clipped canvases spend no readback budget needed by visible empty canvas',()=>{
  const cases={
    display:canvas=>canvas.style.display='none',
    visibility:canvas=>canvas.style.visibility='hidden',
    opacity:canvas=>canvas.style.opacity='0',
    offscreen:canvas=>canvas.move(1300),
    zeroSize:canvas=>canvas.getBoundingClientRect=()=>({left:10,top:20,right:10,bottom:20,width:0,height:0}),
    hiddenAncestor:canvas=>{const parent=element();parent.style.opacity='0';canvas.parentElement=parent;},
    clipped:canvas=>{const parent=element();parent.style.overflow='hidden';parent.move(300);canvas.parentElement=parent;},
    clippedOutsideViewport:canvas=>{
      const parent=element();parent.style.overflow='hidden';parent.move(1300);canvas.parentElement=parent;
      canvas.getBoundingClientRect=()=>({left:0,top:20,right:2000,bottom:120,width:2000,height:100});
    },
  };
  for(const [name,configure] of Object.entries(cases)) {
    const invisible=readableCanvas(2048,2048),empty=readableCanvas(),reads=[];configure(invisible);
    const h=harness([invisible,empty],undefined,scope=>canvasReadback(scope,reads));
    assert.deepEqual(reads,[empty],name);
    assert.equal(h.last().boxes.length,0,`${name}: the visible empty canvas retains its full proof budget`);
  }
});
test('visible canvas emptiness is rechecked after painting clearing and returning from offscreen',()=>{
  const canvas=readableCanvas(),reads=[],h=harness([canvas],undefined,scope=>canvasReadback(scope,reads));
  assert.equal(h.last().boxes.length,0);assert.equal(reads.length,1);
  canvas.painted=true;h.heartbeat();assert.equal(h.last().boxes.length,1);assert.equal(reads.length,2);
  canvas.painted=false;h.heartbeat();assert.equal(h.last().boxes.length,0);assert.equal(reads.length,3);
  canvas.move(1300);canvas.painted=true;h.heartbeat();assert.equal(h.last().boxes.length,0);assert.equal(reads.length,3);
  canvas.move(10);h.heartbeat();assert.equal(h.last().boxes.length,1);assert.equal(reads.length,4);
});
test('canvas scroll handoff retains prior visible coverage without reading the offscreen bitmap',()=>{
  const canvas=readableCanvas(),reads=[];canvas.painted=true;
  const h=harness([canvas],undefined,scope=>canvasReadback(scope,reads));assert.equal(reads.length,1);
  canvas.move(1300);h.events.scroll();h.frame();
  assert.equal(reads.length,1,'swept geometry is not evidence the current canvas needs readback');
  assert.ok(h.last().boxes.some(box=>box.left<1200&&box.right>0),'the last presented onscreen content retains protection');
  h.message({type:'media-geometry-accepted',sequence:h.last().sequence});h.heartbeat();
  assert.equal(h.last().boxes.length,0);assert.equal(reads.length,1);
});
test('canvas with a CSS image stays protected even if its bitmap is empty',()=>{
  const canvas=readableCanvas(),reads=[];canvas.style.backgroundImage='url(artwork.png)';
  const h=harness([canvas],undefined,scope=>canvasReadback(scope,reads));
  assert.equal(h.last().boxes.length,1);assert.equal(reads.length,0);
});
test('one animation enumeration serves discovery and rescheduling in each dirty content frame',()=>{
  const card=element(),h=harness([card]);assert.equal(h.animationReads(),1);
  const animation={playState:'running',effect:{target:card,getKeyframes:()=>[{backgroundImage:'url(animated.png)'}]}};
  card.style.backgroundImage='url(animated.png)';h.animate([animation]);h.events.animationstart({target:card});
  h.frame();assert.equal(h.animationReads(),2);assert.equal(h.last().boxes.length,1);assert.equal(h.frames.length,1);
  animation.playState='finished';h.frame();assert.equal(h.animationReads(),3);assert.equal(h.frames.length,0);
  h.heartbeat();assert.equal(h.animationReads(),4);
});
test('semantic-first publication cannot lend a stale animation list to its queued or newly dirty frame',()=>{
  for(const dirty of [false,true]) {
    const card=element(),h=harness([card]);h.events.input();h.beforeRefresh();
    const published=h.last().sequence;assert.equal(h.animationReads(),2);
    const animation={playState:'running',effect:{target:card,getKeyframes:()=>[{backgroundImage:'url(late.png)'}]}};
    card.style.backgroundImage='url(late.png)';h.animate([animation]);
    if(dirty)h.events.animationstart({target:card});
    h.frame();assert.equal(h.animationReads(),3);assert.equal(h.frames.length,1);
    if(dirty){assert.equal(h.last().sequence,published+1);assert.equal(h.last().boxes.length,1);}
    else {assert.equal(h.last().sequence,published);h.frame();assert.equal(h.animationReads(),4);assert.equal(h.last().boxes.length,1);}
    animation.playState='finished';h.frame();assert.equal(h.frames.length,0);
  }
});
test('theme work receives a fresh geometry publication and coalesces redundant frame work',()=>{
  const image=element('img'),h=harness([image]);const initial=h.last().sequence;
  image.move(70);h.events.input();h.beforeRefresh();
  assert.equal(h.last().boxes[0].left,70);assert.equal(h.last().sequence,initial+1);
  h.frame();assert.equal(h.last().sequence,initial+1,'already published geometry needs no duplicate frame');
  h.events.input();h.beforeRefresh();h.document.nodes.push(element('img'));
  h.observers[0].callback([{type:'childList',target:h.document}]);h.frame();
  assert.equal(h.last().boxes.length,2,'source changes after the early publication are still discovered');
  h.scope.__braveMediaTransparency.dispose();assert.equal(h.hasBeforeRefresh(),false);
});
test('geometry changes after early theme publication are published by the already queued frame',()=>{
  for(const event of ['input','keydown','loadedmetadata']) {
    const image=element('img'),h=harness([image]);
    image.move(70);h.events.input();h.beforeRefresh();
    const early=h.last().sequence;
    assert.equal(h.last().boxes[0].left,70);
    image.move(90);h.events[event]({key:'a',target:image});
    assert.equal(h.frames.length,1,'later geometry coalesces into the pending frame');
    h.frame();
    assert.equal(h.last().sequence,early+1,event);
    assert.equal(h.last().boxes[0].left,90,event);
    assert.equal(h.document.scans,1,'geometry changes do not require new media discovery');
    assert.equal(h.frames.length,0,'one current publication settles the request');
  }
});
test('content-first geometry satisfies theme refresh unless a later request makes it stale',()=>{
  const image=element('img'),h=harness([image]);
  image.move(70);h.events.input();h.frame();
  const current=h.last().sequence;
  h.beforeRefresh();
  assert.equal(h.last().sequence,current,'theme refresh reuses current content-first publication');
  image.move(90);h.events.loadedmetadata({target:image});h.beforeRefresh();
  assert.equal(h.last().sequence,current+1,'a later geometry request still publishes before theme work');
  assert.equal(h.last().boxes[0].left,90);
  h.frame();
  assert.equal(h.last().sequence,current+1,'the early publication also satisfies its queued frame');
  h.document.nodes.push(element('img'));
  h.observers[0].callback([{type:'childList',target:h.document}]);h.beforeRefresh();
  assert.equal(h.last().boxes.length,2,'pending discovery still publishes before theme work');
  h.frame();
  assert.equal(h.document.scans,2);
});
test('one content publication removes completely covered media with one paint-order proof',()=>{
  const image=element('img'),panel=element();
  panel.style.backgroundColor='rgb(52,52,52)';panel.move(0);
  panel.getBoundingClientRect=()=>({left:0,top:0,right:200,bottom:200,width:200,height:200});
  let hits=0;
  const h=harness([image,panel],document=>document.elementsFromPoint=()=>{hits++;return [panel,image];});
  assert.equal(h.last().valid,true);assert.equal(h.last().boxes.length,0);assert.equal(hits,9);
  image.move(210);h.heartbeat();
  assert.equal(h.last().boxes.length,1,'moving artwork outside the cover restores protection');
  assert.equal(hits,9,'non-overlapping geometry needs no hit testing');
});
test('scroll bursts coalesce into one fresh publication before paint',()=>{
  const image=element('img'),h=harness([image]);const sequence=h.last().sequence;
  image.move(50);h.events.scroll();h.events.scroll();h.events.scroll();
  assert.equal(h.last().sequence,sequence,'scroll callbacks do not repeat synchronous geometry');
  assert.equal(h.frames.length,1);h.frame();
  assert.equal(h.last().sequence,sequence+1);assert.ok(h.last().boxes[0].left<=50);
});
test('scroll protection covers one observed step and releases stationary excess after native acceptance',()=>{
  const image=element('img'),h=harness([image]);
  let previous=10;
  for(const left of [50,90,40,10]) {
    image.move(left);h.events.scroll();h.frame();
    const box=h.last().boxes[0];
    const delta=Math.abs(left-previous);
    assert.equal(box.left,left-delta,'only one observed displacement covers asynchronous presentation');
    assert.equal(box.right,left+100+delta,'no three-step prediction extends into distant canvas');
    h.frame();
    assert.equal(h.last().boxes[0].left,left-delta,'retain the bounded handoff until native acceptance');
    h.message({type:'media-geometry-accepted',sequence:h.last().sequence-1});
    h.frame();
    assert.equal(h.last().boxes[0].left,left-delta,'an obsolete acknowledgment cannot release current coverage');
    h.message({type:'media-geometry-accepted',sequence:h.last().sequence});
    h.heartbeat();
    assert.equal(h.last().boxes[0].left,left,'accepted stationary geometry returns to exact bounds');
    assert.equal(h.last().boxes[0].right,left+100);
    previous=left;
  }
});
test('reaffirmed active controller publishes fresh geometry without repeating discovery',()=>{
  const image=element('img'),h=harness([image]);const sequence=h.last().sequence;
  image.move(70);h.message({type:'media-set-enabled-v2',enabled:true,zoom:1});h.frame();
  assert.equal(h.document.scans,1);assert.equal(h.last().boxes[0].left,70);assert.ok(h.last().sequence>sequence);
  const added=element('img');h.document.nodes.push(added);
  h.observers[0].callback([{type:'childList',target:h.document}]);
  h.message({type:'media-set-enabled-v2',enabled:true,zoom:1});h.frame();
  assert.equal(h.document.scans,2);assert.equal(h.last().boxes.length,2,'reaffirmation must retain real pending discovery');
});
test('zoom changes and OFF to ON still rediscover the document',()=>{
  const image=element('img'),h=harness([image]);
  h.message({type:'media-set-enabled-v2',enabled:true,zoom:1.25});h.frame();assert.equal(h.document.scans,2);
  h.message({type:'media-set-enabled-v2',enabled:false});h.document.nodes.push(element('img'));
  h.message({type:'media-set-enabled-v2',enabled:true,zoom:1.25});h.frame();
  assert.equal(h.document.scans,3);assert.equal(h.last().boxes.length,2);
});
test('idle heartbeat publishes fresh geometry and visibility without another document discovery',()=>{
  const image=element('img'),h=harness([image]);assert.equal(h.document.scans,1);const first=h.last();
  image.move(80);h.heartbeat();assert.equal(h.document.scans,1);assert.equal(h.last().boxes[0].left,80);assert.ok(h.last().capturedAt>first.capturedAt);
  image.style.visibility='hidden';h.heartbeat();assert.equal(h.last().boxes.length,0);assert.equal(h.document.scans,1);
  image.style.visibility='visible';h.heartbeat();assert.equal(h.last().boxes.length,1);assert.equal(h.document.scans,1);assert.ok(h.last().sequence>first.sequence);
});
test('ordinary nonempty text updates retain candidates and publish fresh layout before theme work',()=>{
  const price=element(),image=element('img'),others=Array.from({length:50},()=>element());let reads=0;
  const h=harness([price,image,...others],undefined,scope=>{
    const read=scope.getComputedStyle;scope.getComputedStyle=(...args)=>{reads++;return read(...args);};
  });
  assert.equal(h.observers[0].options.characterDataOldValue,true);
  const text={nodeType:3,data:'102.35',parentElement:price},beforeReads=reads,sequence=h.last().sequence;
  image.move(85);h.observers[0].callback([{type:'characterData',target:text,oldValue:'102.30'}]);
  h.beforeRefresh();
  assert.equal(h.document.scans,1);assert.equal(h.last().boxes[0].left,85);assert.equal(h.last().sequence,sequence+1);
  assert.ok(reads-beforeReads<5,'text update reads current media paint, not fifty unrelated styles');
  h.frame();assert.equal(h.last().sequence,sequence+1,'early geometry still satisfies the queued frame');
  image.style.visibility='hidden';text.data='102.40';h.observers[0].callback([{type:'characterData',target:text,oldValue:'102.35'}]);h.frame();
  assert.equal(h.document.scans,1);assert.equal(h.last().boxes.length,0,'retained candidates still get fresh visibility');
});
test('ordinary text mixed with owned mutations retains candidates under explicit direction',()=>{
  const label=element('bdi'),image=element('img');label.getAttribute=key=>key==='dir'?'rtl':null;
  const h=harness([label,image],undefined,scope=>scope.SemanticTheme.ownsMutation=record=>record.owned===true);
  image.move(75);
  h.observers[0].callback([
    {type:'attributes',target:image,attributeName:'data-darkreader-inline-fill',owned:true},
    {type:'characterData',target:{nodeType:3,data:'مرحبا',parentElement:label},oldValue:'hello'},
  ]);h.frame();
  assert.equal(h.document.scans,1,'owned changes do not make stable ordinary text rediscover the document');
  assert.equal(h.last().boxes[0].left,75,'geometry remains current even when direction is explicitly fixed');
});
test('nonempty text keeps CSS media discovery when a sibling query container can resize',()=>{
  for(const type of ['inline-size','size','scroll-state','inline-size scroll-state']) {
    const label=element('span'),panel=element(),card=element();
    panel.style.containerType=type;card.parentElement=panel;
    const text={nodeType:3,data:'1234567890',parentElement:label},h=harness([label,panel,card]);
    assert.equal(h.last().boxes.length,0);
    // A wider quote can shrink its flex sibling and activate a descendant
    // @container rule. The mutation owner need not contain that CSS artwork.
    card.style.backgroundImage='url(container-art.png)';
    h.observers[0].callback([{type:'characterData',target:text,oldValue:'1'}]);h.frame();
    assert.equal(h.document.scans,2,type);assert.equal(h.last().boxes.length,1,type);
    panel.style.containerType='normal';h.observers[0].callback([{type:'attributes',target:panel,attributeName:'style'}]);h.frame();
    const scans=h.document.scans;text.data='12345678901';
    h.observers[0].callback([{type:'characterData',target:text,oldValue:'1234567890'}]);h.frame();
    assert.equal(h.document.scans,scans,'removing the last query container restores retained text discovery');
  }
});
test('query containers in an open shadow root guard light-DOM text discovery',()=>{
  const host=element(),label=element('span'),panel=element(),card=element();
  panel.style.containerType='inline-size';card.parentElement=panel;
  const shadow=root([panel,card]);host.shadowRoot=shadow;
  const h=harness([host,label]);card.style.backgroundImage='url(shadow-query-art.png)';
  h.observers[0].callback([{type:'characterData',target:{nodeType:3,data:'long quote',parentElement:label},oldValue:'1'}]);h.frame();
  assert.equal(h.document.scans,2);assert.equal(shadow.scans,2);assert.equal(h.last().boxes.length,1);
});
test('empty and significant-text transitions preserve distant CSS media discovery',()=>{
  for(const [before,after] of [['ready',''],['','ready'],[' ','ready'],['ready',' ']]) {
    const trigger=element(),card=element(),text={nodeType:3,data:before,parentElement:trigger};
    const h=harness([trigger,card]);text.data=after;card.style.backgroundImage='url(relational-empty-rule.png)';
    h.observers[0].callback([{type:'characterData',target:text,oldValue:before}]);h.frame();
    assert.equal(h.document.scans,2,`${JSON.stringify(before)} to ${JSON.stringify(after)} keeps :empty/:has discovery`);
    assert.equal(h.last().boxes.length,1,'a distant selector-dependent image becomes protected');
  }
});
test('text source direction form SVG and custom-state contexts retain full discovery',()=>{
  const contexts={
    style:()=>element('style'),script:()=>element('script'),textarea:()=>element('textarea'),
    option:()=>element('option'),select:()=>element('select'),
    autoDirection:()=>{const node=element();node.getAttribute=key=>key==='dir'?'AUTO':null;return node;},
    implicitBdi:()=>element('bdi'),invalidBdiDirection:()=>{const node=element('bdi');node.getAttribute=key=>key==='dir'?'invalid':null;return node;},
    svgText:()=>({...element('text'),namespaceURI:'http://www.w3.org/2000/svg'}),
    foreignObject:()=>({...element('foreignObject'),namespaceURI:'http://www.w3.org/2000/svg'}),
    customElement:()=>element('price-display'),customizedBuiltin:()=>{const node=element('span');node.getAttribute=key=>key==='is'?'price-display':null;return node;},
    emptyIsAttribute:()=>{const node=element('span');node.getAttribute=key=>key==='is'?'':null;return node;},
  };
  for(const [name,create] of Object.entries(contexts)) {
    const ancestor=create(),parent=element(),card=element();parent.parentElement=ancestor;
    const h=harness([ancestor,parent,card]),text={nodeType:3,data:'updated',parentElement:parent};
    card.style.backgroundImage='url(source-or-state-rule.png)';
    h.observers[0].callback([{type:'characterData',target:text,oldValue:'initial'}]);h.frame();
    assert.equal(h.document.scans,2,name);assert.equal(h.last().boxes.length,1,`${name} may change distant media source state`);
  }
});
test('unknown text history and mixed structural mutations keep discovery dirty',()=>{
  for(const mixed of [false,true]) {
    const label=element(),card=element(),h=harness([label,card]),text={nodeType:3,data:'updated',parentElement:label};
    card.style.backgroundImage='url(new-source.png)';
    const records=[{type:'characterData',target:text,oldValue:mixed?'initial':null}];
    if(mixed)records.push({type:'attributes',target:card,attributeName:'style'});
    h.observers[0].callback(records);h.frame();assert.equal(h.document.scans,2);assert.equal(h.last().boxes.length,1);
  }
});
test('ordinary text retains open-shadow candidates while host direction and custom state keep discovery',()=>{
  for(const context of ['ordinary','autoDirection','customElement','assignedAutoSlot']) {
    const host=element(context==='customElement'?'price-display':'div'),label=element(),image=element('img'),shadow=root([label,image]);
    shadow.host=host;host.shadowRoot=shadow;label.getRootNode=()=>shadow;image.getRootNode=()=>shadow;
    if(context==='autoDirection')host.getAttribute=key=>key==='dir'?'auto':null;
    const h=harness([host]),watcher=h.observers.find(observer=>observer.root===shadow);
    assert.equal(watcher.options.characterDataOldValue,true);
    const text={nodeType:3,data:'updated',parentElement:label};
    if(context==='assignedAutoSlot') {
      const slot=element('slot');slot.getAttribute=key=>key==='dir'?'auto':null;slot.getRootNode=()=>shadow;text.assignedSlot=slot;
    }
    image.move(95);watcher.callback([{type:'characterData',target:text,oldValue:'initial'}]);h.frame();
    assert.equal(h.document.scans,context==='ordinary'?1:2,context);
    assert.equal(shadow.scans,context==='ordinary'?1:2,context);assert.equal(h.last().boxes[0].left,95);
    assert.equal(watcher.disconnected,undefined,'the existing root watcher remains attached');
  }
});
test('ordinary text mutation still discovers and reschedules a running image-source animation',()=>{
  const label=element(),card=element(),h=harness([label,card]),text={nodeType:3,data:'updated',parentElement:label};
  const animation={playState:'running',effect:{target:card,getKeyframes:()=>[{backgroundImage:'none'},{backgroundImage:'url(animated.png)'}]}};
  card.style.backgroundImage='url(animated.png)';h.animate([animation]);
  h.observers[0].callback([{type:'characterData',target:text,oldValue:'initial'}]);h.frame();
  assert.equal(h.document.scans,1,'animation target discovery stays scoped while ordinary text retains document candidates');
  assert.equal(h.last().boxes.length,1);assert.equal(h.frames.length,1);
  animation.playState='finished';h.frame();assert.equal(h.frames.length,0);
});
test('actual DOM source/style mutation discovers new media while subsequent beats retain the cache',()=>{
  const card=element(),h=harness([card]);assert.equal(h.last().boxes.length,0);
  card.style.backgroundImage='url(photo.png)';h.observers[0].callback([{type:'attributes',target:card,attributeName:'style'}]);h.frame();
  assert.equal(h.document.scans,2);assert.equal(h.last().boxes.length,1);h.heartbeat();assert.equal(h.document.scans,2);
  const photo=element('img');h.document.nodes.push(photo);h.observers[0].callback([{type:'childList',target:h.document}]);h.frame();assert.equal(h.last().boxes.length,2);
});
test('hover focus active and stylesheet load own CSS-media discovery instead of idle polling',()=>{
  for(const event of ['pointerover','focusin','pointerdown','load','transitionend']) {
    const card=element(),h=harness([card]);card.style.backgroundImage='url(state-photo.png)';h.events[event]({target:card});h.frame();
    assert.equal(h.document.scans,2,event);assert.equal(h.last().boxes.length,1,event);
  }
});
test('known open shadow roots observe mutations and release observers when detached',()=>{
  const host=element('div'),shadow=root([]);host.shadowRoot=shadow;const h=harness([host]);
  const watcher=h.observers.find(observer=>observer.root===shadow);assert.ok(watcher);
  const image=element('img');shadow.nodes.push(image);watcher.callback([{type:'childList',target:shadow}]);h.frame();assert.equal(h.last().boxes.length,1);
  const scanned=shadow.scans;h.heartbeat();assert.equal(shadow.scans,scanned,'fresh geometry does not query shadow subtree again');
  h.document.nodes.length=0;h.observers[0].callback([{type:'childList',target:h.document}]);h.frame();assert.equal(watcher.disconnected,true);assert.equal(shadow.events.has('load'),false);
});
test('late attachShadow is discovered by cached host inspection without full document style discovery',()=>{
  const host=element();host.attachShadow=()=>{};const h=harness([host]);const shadow=root([element('img')]);host.shadowRoot=shadow;
  h.heartbeat();assert.equal(h.document.scans,1);assert.equal(shadow.scans,1);assert.equal(h.last().boxes.length,1);assert.ok(h.observers.some(observer=>observer.root===shadow));
  h.heartbeat();assert.equal(shadow.scans,1);
});
test('noncomposed stylesheet loads in an open shadow root invalidate discovery',()=>{
  const host=element(),card=element(),shadow=root([card]);host.shadowRoot=shadow;const h=harness([host]);
  card.style.backgroundImage='url(shadow-css.png)';shadow.events.get('load')({target:card});h.frame();assert.equal(h.last().boxes.length,1);
});
test('image-related CSS animation discovers its target URL without rescanning ordinary page nodes every frame',()=>{
  const card=element(),h=harness([card]);const animation={playState:'running',effect:{target:card,getKeyframes:()=>[{backgroundImage:'none'},{backgroundImage:'url(animated.png)'}]}};
  h.animate([animation]);h.events.animationstart({target:card});h.frame();assert.equal(h.document.scans,2);
  card.style.backgroundImage='url(animated.png)';h.frame();assert.equal(h.document.scans,2);assert.equal(h.last().boxes.length,1);
  animation.playState='finished';h.frame();assert.equal(h.frames.length,0);
});

test('authored CSSOM source notification discovers new media and unsubscribes on disposal',()=>{
  const card=element(),h=harness([card]);card.style.backgroundImage='url(cssom-photo.png)';h.sourceChange();h.frame();
  assert.equal(h.document.scans,2);assert.equal(h.last().boxes.length,1);h.heartbeat();assert.equal(h.document.scans,2);
  h.scope.__braveMediaTransparency.dispose();assert.equal(h.hasSourceListener(),false);
});

test('idle media-only page publishes fifty fresh boxes without speculative occlusion hit testing',()=>{
  const images=Array.from({length:50},()=>element('img')),h=harness(images);let hits=0;
  h.document.elementsFromPoint=()=>{hits++;return images;};
  h.heartbeat();assert.equal(h.last().boxes.length,50);assert.equal(hits,0);assert.equal(h.document.scans,1);
  assert.ok(h.last().snapshotPhases);assert.ok('mediaGeometryMs' in h.last().snapshotPhases);assert.ok('occlusionMs' in h.last().snapshotPhases);
});
