import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const scope = vm.createContext({});
vm.runInContext(readFileSync(new URL('./extension/geometry.js', import.meta.url),'utf8'),scope);
const clip = scope.MediaGeometry.clipMediaRect;
const plain = value => JSON.parse(JSON.stringify(value));
const box = (left,top,right,bottom) => ({left,top,right,bottom,width:right-left,height:bottom-top});
function node(bounds, style = {}, parent = null, metrics = {}) {
  return {style:{position:'static',overflowX:'visible',overflowY:'visible',transform:'none',...style},parentElement:parent,getBoundingClientRect:()=>bounds,...metrics};
}
const read = el => el.style;
function clipped(el,rect) {return plain(clip(el,rect,read));}
test('nested scrollbox masks intersect the visible media portion only', () => {
  const scroller = node(box(100,100,400,300),{overflowY:'auto'});
  const image = node(box(150,250,350,450),{},scroller);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(150,250,350,300));
  assert.equal(clip(image,box(150,350,350,550),read),null);
});
test('horizontal and vertical overflow clip independently and compose', () => {
  const outer = node(box(100,0,300,800),{overflowX:'hidden'});
  const inner = node(box(0,100,800,250),{overflowY:'clip'},outer);
  const image = node(box(0,0,500,500),{},inner);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(100,100,300,250));
});
test('client scrollport excludes borders and scrollbar space', () => {
  const scroller = node(box(100,100,410,310),{overflowX:'auto',overflowY:'auto'},null,{offsetWidth:310,offsetHeight:210,clientLeft:2,clientTop:3,clientWidth:291,clientHeight:194});
  const image = node(box(0,0,1000,1000),{},scroller);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(102,103,393,297));
});
test('fractional CSS zoom scales client box and border offsets into viewport coordinates', () => {
  const scroller = node(box(50.5,75.25,325.5,212.75),{overflowX:'scroll',overflowY:'hidden'},null,{offsetWidth:200,offsetHeight:100,clientLeft:2,clientTop:2,clientWidth:194,clientHeight:96});
  const image = node(box(0,0,1000,1000),{},scroller);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(53.25,78,320,210));
});
test('absolute media escapes non-containing clipping ancestors but respects its containing block', () => {
  const cb = node(box(0,0,500,500),{position:'relative',overflowY:'hidden'});
  const staticScroller = node(box(100,100,200,200),{overflowY:'auto'},cb);
  const image = node(box(150,250,350,550),{position:'absolute'},staticScroller);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(150,250,350,500));
});
test('fixed media escapes ordinary scrollboxes but respects a transformed containing block', () => {
  const ordinary = node(box(100,100,200,200),{position:'relative',overflowX:'hidden',overflowY:'hidden'});
  const fixed = node(box(0,0,500,500),{position:'fixed'},ordinary);
  assert.deepEqual(clipped(fixed,fixed.getBoundingClientRect()),box(0,0,500,500));
  ordinary.style.transform='translateX(0px)';
  assert.deepEqual(clipped(fixed,fixed.getBoundingClientRect()),box(100,100,200,200));
});
test('an absolutely positioned wrapper also escapes unrelated ancestor overflow', () => {
  const cb = node(box(0,0,600,600),{position:'relative'});
  const unrelated = node(box(100,100,200,200),{overflowY:'hidden'},cb);
  const wrapper = node(box(100,250,400,500),{position:'absolute'},unrelated);
  const image = node(box(100,250,400,500),{},wrapper);
  assert.deepEqual(clipped(image,image.getBoundingClientRect()),box(100,250,400,500));
});
test('paint containment establishes the fixed-position containing block', () => {
  const container = node(box(100,100,300,300),{contain:'paint',overflowY:'clip'});
  const fixed = node(box(50,50,400,400),{position:'fixed'},container);
  assert.deepEqual(clipped(fixed,fixed.getBoundingClientRect()),box(100,100,300,300));
});
test('overflow clip margin expands only clip axes, not hidden axes', () => {
  const ancestor = node(box(100,100,300,300),{overflowX:'clip',overflowY:'hidden',overflowClipMargin:'10px'});
  const media = node(box(0,0,500,500),{},ancestor);
  assert.deepEqual(clipped(media,media.getBoundingClientRect()),box(90,100,310,300));
});
test('shadow slot ancestry follows the composed paint tree', () => {
  const scroller = node(box(100,100,300,300),{overflowY:'hidden'});
  const slot = node(box(0,0,0,0),{display:'contents'},scroller);
  const media = node(box(50,50,400,400));media.assignedSlot=slot;
  assert.deepEqual(clipped(media,media.getBoundingClientRect()),box(50,100,400,300));
});
const G=scope.MediaGeometry;
function ui(bounds,style={},parent=null) {
  return {...node(bounds,{opacity:'1',display:'block',visibility:'visible',backgroundColor:'rgb(52, 52, 52)',backgroundImage:'none',backgroundClip:'border-box',...style},parent),localName:'div',getAttribute:()=>null};
}
const viewport={innerWidth:1200,innerHeight:900};
const owns=(rects,x,y)=>rects.some(rect=>x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom);
test('independent later neutral UI subtracts only overlapping photo pixels and keeps photo elsewhere',()=>{
  const photo=ui(box(0,0,300,200),{backgroundImage:'url(horse.jpg)'}),panel=ui(box(50,150,250,300));
  const regions=G.opaqueUiRegions([panel],read),view={...viewport,elementsFromPoint:()=>[panel,photo]};
  const result=G.subtractOpaqueUi([{element:photo,rect:photo.getBoundingClientRect()}],regions,read,view);
  assert.equal(owns(result,100,180),false);assert.equal(owns(result,100,100),true);assert.equal(owns(result,20,180),true);
  assert.ok(result.every(rect=>rect.left>=0&&rect.top>=0&&rect.right<=300&&rect.bottom<=200));
});
test('rounded neutral fill cuts its guaranteed rectangular interiors and preserves corners and painted boundary',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(10,20,210,200),{borderTopLeftRadius:'25px',borderTopRightRadius:'25px',borderBottomLeftRadius:'25px',borderBottomRightRadius:'25px'});
  const result=G.subtractOpaqueUi([{element:photo,rect:photo.getBoundingClientRect()}],G.opaqueUiRegions([panel],read),read,{...viewport,elementsFromPoint:()=>[panel,photo]});
  assert.equal(owns(result,11,21),true);assert.equal(owns(result,100,60),false);assert.equal(owns(result,20,100),false);assert.equal(owns(result,10,100),true);
});
test('related descendant foreground is supported while genuine descendant image pixels are independently protected',()=>{
  const photo=ui(box(0,0,300,200),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(50,100,250,200),{},photo),image=ui(box(80,120,120,160),{},panel);image.localName='img';
  const paints=[{element:photo,rect:photo.getBoundingClientRect()},{element:image,rect:image.getBoundingClientRect()}];
  const view={...viewport,elementsFromPoint:(x,y)=>x>=80&&x<=120&&y>=120&&y<=160?[image,panel,photo]:[panel,photo]};
  const result=G.subtractOpaqueUi(paints,G.opaqueUiRegions([panel,image],read),read,view);
  assert.equal(owns(result,100,140),true);assert.equal(owns(result,180,140),false);assert.equal(owns(result,10,140),true);
});
test('translucent transformed masked clipped-image or authored-art fills never authorize neutral UI cuts',()=>{
  for(const style of [{opacity:'.8'},{backgroundColor:'rgba(52,52,52,.5)'},{transform:'matrix(1,0,0,1,0,0)'},{rotate:'20deg'},{clipPath:'inset(1px)'},{maskImage:'url(mask.png)'},{backgroundClip:'text'},{backgroundClip:'content-box'},{backgroundImage:'url(art.png)'},{backgroundImage:'linear-gradient(black,transparent)'},{backgroundColor:'rgb(0,60,100)'},{mixBlendMode:'multiply'},{display:'table-row'},{display:'inline'},{appearance:'auto'}]) {
    assert.equal(G.opaqueUiRegions([ui(box(0,0,200,200),style)],read).length,0);
  }
  const figure=ui(box(0,0,300,300));figure.localName='figure';assert.equal(G.opaqueUiRegions([ui(box(0,0,200,200),{},figure)],read).length,0);
});
test('overflow and rounded ancestor clipping limit cuts to provably opaque interiors',()=>{
  const parent=ui(box(40,40,160,160),{overflow:'hidden',borderTopLeftRadius:'20px',borderTopRightRadius:'20px',borderBottomLeftRadius:'20px',borderBottomRightRadius:'20px'}),panel=ui(box(0,0,200,200),{},parent);
  const regions=G.opaqueUiRegions([panel],read);assert.ok(regions.length>0);
  assert.ok(regions.every(({rect})=>rect.left>=61&&rect.top>=61&&rect.right<=139&&rect.bottom<=139));
});
test('unknown or lower paint order retains protection and fragmentation never consumes reserved media capacity',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(50,50,250,250));
  const paints=[{element:photo,rect:photo.getBoundingClientRect()}],regions=G.opaqueUiRegions([panel],read);
  for(const stack of [[photo,panel],[panel],[]]) {
    assert.deepEqual(plain(G.subtractOpaqueUi(paints,regions,read,{...viewport,elementsFromPoint:()=>stack})),[box(0,0,300,300)]);
  }
  assert.deepEqual(plain(G.subtractOpaqueUi(paints,regions,read,{...viewport,elementsFromPoint:()=>[panel,photo]},127)),[box(0,0,300,300)]);
});
test('foreground proof budget remains bounded across many overlapping UI candidates',()=>{
  const photo=ui(box(0,0,1200,900),{backgroundImage:'url(photo.jpg)'}),panels=Array.from({length:100},(_,i)=>ui(box(10+i*5,20,14+i*5,200)));
  const regions=G.opaqueUiRegions(panels,read);let calls=0;
  G.subtractOpaqueUi([{element:photo,rect:photo.getBoundingClientRect()}],regions,read,{...viewport,elementsFromPoint:()=>{calls++;return [...panels,photo];}});
  assert.ok(calls>0&&calls<=64*9);
});
test('slow paint-order queries stop on elapsed budget without exposing unproven media',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(20,20,200,200));
  let time=0,hits=0;
  const result=G.subtractOpaqueUi([{element:photo,rect:photo.getBoundingClientRect()}],G.opaqueUiRegions([panel],read),read,{...viewport,now:()=>time,elementsFromPoint:()=>{hits++;time+=10;return [panel,photo];}});
  assert.equal(hits,5);assert.deepEqual(plain(result),[box(0,0,300,300)]);
});

test('unclassified pseudo images or masks keep the underlying photo protection',()=>{
  const panel=ui(box(50,50,250,250));
  for(const paint of [{backgroundImage:'url(pseudo-photo.jpg)'},{content:'url(icon.png)'},{maskImage:'url(mask.svg)'}]) {
    assert.equal(G.opaqueUiRegions([panel],(el,pseudo)=>pseudo?paint:el.style).length,0);
  }
});

test('button appearance on non-native semantic action accepts authored neutral fill while native or unknown shapes remain protected',()=>{
  const action=ui(box(10,20,210,200),{appearance:'button',borderTopLeftRadius:'25px',borderBottomLeftRadius:'25px'});
  action.localName='a';action.getAttribute=key=>key==='role'?'tab':null;
  assert.ok(G.opaqueUiRegions([action],read).length>0);
  for(const mutate of [el=>el.localName='button',el=>el.localName='input',el=>{el.localName='div';el.getAttribute=()=>null;},el=>el.style.appearance='checkbox',el=>el.style.backgroundColor='rgba(52,52,52,.8)']) {
    const unknown={...action,style:{...action.style}};mutate(unknown);assert.equal(G.opaqueUiRegions([unknown],read).length,0);
  }
});

test('remote UI candidates reject by current bounds before pseudo or ancestry paint reads',()=>{
  const media=ui(box(0,0,40,40),{backgroundImage:'url(photo.jpg)'});
  const remote=ui(box(100,100,200,200));let styleReads=0;
  const result=G.opaqueUiRegions([remote],()=>{styleReads++;throw Error('remote paint proof is unnecessary');},null,[{element:media,rect:media.getBoundingClientRect()}]);
  assert.equal(result.length,0);assert.equal(styleReads,0);
  remote.getBoundingClientRect=()=>box(0,0,30,30);
  assert.ok(G.opaqueUiRegions([remote],read,null,[{element:media,rect:media.getBoundingClientRect()}]).length>0,'geometry remains current each publication');
});
test('prepared UI geometry avoids all full-occlusion hit tests when no fill can cover media',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(20,20,100,100));
  const regions=G.opaqueUiRegions([panel],read);let calls=0;
  for(let index=0;index<50;index++) assert.equal(G.isFullyOccludedMedia(photo,photo.getBoundingClientRect(),read,{...viewport,opaqueRegions:regions,elementsFromPoint:()=>{calls++;return [panel,photo];}}),false);
  assert.equal(calls,0);
});
test('prepared covering UI still requires positive paint order and removes only fully covered media',()=>{
  const image=ui(box(40,40,60,60));image.localName='img';const panel=ui(box(0,0,100,100));
  const regions=G.opaqueUiRegions([panel],read);
  for(const [stack,expected] of [[[panel,image],true],[[image,panel],false],[[panel],false]]) {
    assert.equal(G.isFullyOccludedMedia(image,image.getBoundingClientRect(),read,{...viewport,opaqueRegions:regions,elementsFromPoint:()=>stack}),expected);
  }
  panel.style.opacity='.8';assert.equal(G.isFullyOccludedMedia(image,image.getBoundingClientRect(),read,{...viewport,opaqueRegions:G.opaqueUiRegions([panel],read),elementsFromPoint:()=>[panel,image]}),false);
});
test('overlapping identical safe interiors do not repeat hit proofs after pixels are removed',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(20,20,200,200));
  const region=G.opaqueUiRegions([panel],read)[0];let calls=0;
  G.subtractOpaqueUi([{element:photo,rect:photo.getBoundingClientRect()}],Array(50).fill(region),read,{...viewport,elementsFromPoint:()=>{calls++;return [panel,photo];}});
  assert.equal(calls,9);
});

test('impossible full cover rejects numerically before any DOM containment query',()=>{
  const photo=ui(box(0,0,300,300),{backgroundImage:'url(photo.jpg)'}),panel=ui(box(20,20,100,100));let contains=0,hits=0;
  photo.contains=panel.contains=()=>{contains++;return false;};
  const regions=Array.from({length:256},()=>({element:panel,rect:panel.getBoundingClientRect()}));
  for(let i=0;i<50;i++) G.isFullyOccludedMedia(photo,photo.getBoundingClientRect(),read,{...viewport,opaqueRegions:regions,elementsFromPoint:()=>{hits++;return [panel,photo];}});
  assert.equal(contains,0);assert.equal(hits,0);
});
test('prepared full cover checks containment once and reuses relationships across all nine samples',()=>{
  const image=ui(box(40,40,60,60));image.localName='img';const panel=ui(box(0,0,100,100));let contains=0,hits=0;
  image.contains=panel.contains=()=>{contains++;return false;};
  assert.equal(G.isFullyOccludedMedia(image,image.getBoundingClientRect(),read,{...viewport,opaqueRegions:G.opaqueUiRegions([panel],read),elementsFromPoint:()=>{hits++;return [panel,image];}}),true);
  assert.equal(contains,2);assert.equal(hits,9);
});
test('enclosing normal and shadow-slot ancestor fills do not consume paint-order proofs',()=>{
  const body=ui(box(0,0,300,300)),control=ui(box(10,10,250,250),{},body),slot=ui(box(20,20,240,240),{},control);
  const image=ui(box(30,30,100,100),{},null);image.localName='img';image.assignedSlot=slot;
  let hits=0;const regions=G.opaqueUiRegions([body,control,slot],read);
  const result=G.subtractOpaqueUi([{element:image,rect:image.getBoundingClientRect()}],regions,read,{...viewport,elementsFromPoint:()=>{hits++;return [slot,control,body,image];}});
  assert.equal(hits,0);assert.deepEqual(plain(result),[box(30,30,100,100)]);
});
test('only live owned UI surfaces admit chromatic canvas into opaque cutout proof',()=>{
  const filled={backgroundColor:'rgb(7, 25, 38)',backgroundImage:'none'};
  assert.equal(scope.MediaGeometry.isOpaqueNeutralBackground(filled),false);
  assert.equal(scope.MediaGeometry.isOpaqueNeutralBackground(filled,true),true);
  assert.equal(scope.MediaGeometry.isOpaqueNeutralBackground({...filled,backgroundColor:'rgba(7,25,38,0.9)'},true),false);
  assert.equal(scope.MediaGeometry.isOpaqueNeutralBackground({...filled,backgroundImage:'url(art.png)'},true),false);
});
