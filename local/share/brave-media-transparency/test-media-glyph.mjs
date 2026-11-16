import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./extension/media.js',import.meta.url),'utf8');
function harness(extra={},capture) {const scope={URL,AbortController,setTimeout,clearTimeout,document:{baseURI:'https://fixture.test/'},...extra};vm.runInNewContext(source,scope);capture?.(scope);return scope.MediaGlyphs;}
const glyph=harness();
function node(localName,attrs={},parent=null) {return {localName,parentElement:parent,textContent:'',getAttribute:key=>attrs[key]??null,querySelector:()=>null,querySelectorAll:()=>[]};}
const rect={width:20,height:20};
function pixels(ink=[0,0,0,255]) {const data=new Uint8ClampedArray(16*16*4);for(let i=0;i<64;i++)data.set(ink,i*4);return data;}
test('only small unnamed decorative descendants of semantic controls qualify',()=>{
  const control=node('div',{role:'listbox'}),arrow=node('div',{'aria-hidden':'true'},control);
  assert.equal(glyph.isControlGlyph(arrow,rect),true);
  assert.equal(glyph.isControlGlyph(node('div',{},control),rect),false);
  assert.equal(glyph.isControlGlyph(node('div',{role:'presentation'},control),rect),true);
  assert.equal(glyph.isControlGlyph(node('img',{},node('a',{href:'/brand'})),rect),false);
  assert.equal(glyph.isControlGlyph(node('svg',{},node('button',{'aria-label':'Save'})),rect),true);
  assert.equal(glyph.isControlGlyph(node('div',{},node('main')),rect),false);
  assert.equal(glyph.isControlGlyph(arrow,{width:100,height:20}),false);
  assert.equal(glyph.isControlGlyph(node('img',{alt:'Actual content'},control),rect),false);
  assert.equal(glyph.isControlGlyph(node('svg',{},node('figure',{},control)),rect),false);
  assert.equal(glyph.isControlGlyph(node('svg',{role:'img'},control),rect),false);
});
test('raster evidence requires transparent sparse entirely neutral dark ink',()=>{
  assert.equal(glyph.analyzeGlyphPixels(pixels(),16,16),true);
  assert.equal(glyph.analyzeGlyphPixels(pixels([55,56,57,128]),16,16),true);
  assert.equal(glyph.analyzeGlyphPixels(pixels([20,90,180,255]),16,16),false);
  assert.equal(glyph.analyzeGlyphPixels(pixels([240,240,240,255]),16,16),false);
  assert.equal(glyph.analyzeGlyphPixels(new Uint8ClampedArray(16*16*4),16,16),false);
  const opaque=new Uint8ClampedArray(16*16*4);for(let i=3;i<opaque.length;i+=4)opaque[i]=255;
  assert.equal(glyph.analyzeGlyphPixels(opaque,16,16),false);
  assert.equal(glyph.analyzeGlyphPixels(pixels(),65,16),false);
  assert.equal(glyph.analyzeGlyphPixels([NaN,0,0,255],1,1),false);
});
test('SVG control evidence excludes colored paint, gradients, external shapes and authored artwork',()=>{
  const svg=node('svg',{},node('button')),path=node('path',{},svg);svg.querySelectorAll=()=>[path];
  const style=()=>({fill:'rgb(0, 0, 0)',stroke:'none',opacity:'1',filter:'none'});
  assert.equal(glyph.isDarkSvgGlyph(svg,rect,style),true);
  assert.equal(glyph.isDarkSvgGlyph(svg,rect,()=>({...style(),fill:'rgb(0, 6, 12)'})),true);
  assert.equal(glyph.isDarkSvgGlyph(svg,rect,()=>({...style(),fill:'rgba(0, 0, 0, 0)'})),false);
  assert.equal(glyph.isDarkSvgGlyph(svg,rect,el=>({...style(),fill:el===path?'rgb(255, 20, 20)':'none'})),false);
  assert.equal(glyph.isDarkSvgGlyph(svg,rect,()=>({...style(),fill:'url(#gradient)'})),false);
  svg.querySelector=()=>({});assert.equal(glyph.isDarkSvgGlyph(svg,rect,style),false);
});
// Chunk construction used by loader tests: decoder is injected; parser verifies
// bounds/type/animation while real createImageBitmap verifies PNG contents.
function validStructure(animated=false) {
  const chunk=(type,payload=[])=>[0,0,0,payload.length,...Array.from(type,char=>char.charCodeAt(0)),...payload,0,0,0,0];
  return new Uint8Array([137,80,78,71,13,10,26,10,...chunk('IHDR',Array(13).fill(0)),...(animated?chunk('acTL',[0]):[]),...chunk('IEND')]);
}
test('PNG ownership rejects animation and malformed or trailing chunk data',()=>{
  assert.equal(glyph.isStaticPng(validStructure()),true);
  assert.equal(glyph.isStaticPng(validStructure(true)),false);
  assert.equal(glyph.isStaticPng(new Uint8Array([...validStructure(),1])),false);
  assert.equal(glyph.isStaticPng(new Uint8Array([1,2,3])),false);
});
test('raster inspection is cached, bounded and releases its private decoder',async()=>{
  let fetched=0,closed=0;
  const bytes=validStructure();
  const api=harness({Blob,fetch:async()=>{fetched++;let done=false;return {ok:true,headers:{get:()=> 'image/png'},body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{done:false,value:bytes})})}};},
    createImageBitmap:async()=>({width:16,height:16,close(){closed++;}}),
    OffscreenCanvas:class {getContext(){return {drawImage(){},getImageData:()=>({data:pixels()})};}}});
  assert.equal(await api.loadDarkGlyph('/arrow.png'),true);assert.equal(await api.loadDarkGlyph('https://fixture.test/arrow.png'),true);
  assert.equal(fetched,1);assert.equal(closed,1);
  const denied=harness({fetch:async()=>{throw new Error('CORS');}});assert.equal(await denied.loadDarkGlyph('/unknown.png'),false);
  assert.equal(await denied.loadDarkGlyph('javascript:alert(1)'),false);
  assert.equal(await denied.loadDarkGlyph('https://fixture.test/'+ 'a'.repeat(8192)),false);
});
test('unknown MIME, oversized bodies and oversized decoded images remain unmodified',async()=>{
  let cancelled=0;
  const api=harness({fetch:async()=>({ok:true,headers:{get:()=> 'image/png'},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(262145)}),cancel:async()=>cancelled++})}})});
  assert.equal(await api.loadDarkGlyph('/huge.png'),false);assert.equal(cancelled,1);
  const unknown=harness({fetch:async()=>({ok:true,headers:{get:()=> 'image/gif'}})});assert.equal(await unknown.loadDarkGlyph('/animation.png'),false);
});

test('stalled image requests expire once and remain conservatively cached',async()=>{
  let signal,deadline;
  const api=harness({setTimeout:callback=>{deadline=callback;return 1;},clearTimeout(){},fetch:(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  const pending=api.loadDarkGlyph('/stalled.png');deadline();assert.equal(await pending,false);assert.equal(signal.aborted,true);
  assert.equal(await api.loadDarkGlyph('/stalled.png'),false);
});

test('same revision reinjection retains identity and bounded raster cache',async()=>{
  let scope,fetched=0;
  const api=harness({fetch:async()=>{fetched++;throw new Error('Unreadable');}},value=>scope=value);
  assert.equal(await api.loadDarkGlyph('/unreadable.png'),false);
  vm.runInNewContext(source,scope);
  assert.equal(scope.MediaGlyphs,api);assert.equal(await scope.MediaGlyphs.loadDarkGlyph('/unreadable.png'),false);assert.equal(fetched,1);
});
