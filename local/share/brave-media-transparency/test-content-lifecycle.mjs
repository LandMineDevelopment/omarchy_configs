import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const content=readFileSync(new URL('./extension/content.js',import.meta.url),'utf8');
const geometry=readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8');
const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function harness() {
  const frames=[],events=new Map();let handler,cleared=0,disconnected=0,disposed=0,removed=0,retire,unsubscribed=0,animationReads=0;
  const video={localName:'video',childNodes:[],shadowRoot:null,matches:()=>true,getBoundingClientRect:()=>({left:10,top:20,right:210,bottom:120,width:200,height:100})};
  const document={contentType:'text/html',visibilityState:'visible',fullscreenElement:null,getAnimations:()=>{animationReads++;return [];},querySelectorAll:()=>[video]};
  const chrome={runtime:{sendMessage:()=>Promise.resolve(),onMessage:{addListener:fn=>handler=fn,removeListener:()=>{removed++;handler=null;}}}};
  const theme={enable(){},dispose(){disposed++;},onDispose(callback){retire=callback;return ()=>{unsubscribed++;retire=null;};},setFetchMethod(){},setBackdropChanged(){},ownsMutation:()=>false};
  const realm={document,chrome,SemanticTheme:theme,location:{hostname:'fixture.test'},innerWidth:1000,innerHeight:700,outerWidth:1000,outerHeight:800,devicePixelRatio:1,screenX:0,screenY:0,
    visualViewport:{scale:1,offsetLeft:0,offsetTop:0,addEventListener(){},removeEventListener(){}},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),
    requestAnimationFrame:fn=>frames.push(fn),cancelAnimationFrame(){},setInterval:()=>17,clearInterval:id=>{assert.equal(id,17);cleared++;},MutationObserver:class{observe(){}disconnect(){disconnected++;}},
    getComputedStyle:()=>({visibility:'visible',backgroundImage:'none',opacity:'1',display:'block'})};
  vm.createContext(realm);vm.runInContext(geometry,realm);vm.runInContext(content,realm);
  handler({type:'media-set-enabled-v2',enabled:true,zoom:1});
  return {realm,frames,chrome,events,retire:()=>retire(),unsubscribed:()=>unsubscribed,animationReads:()=>animationReads,counts:()=>({cleared,disconnected,disposed,removed})};
}
test('synchronous invalidated runtime send retires heartbeat observer and listeners once',async()=>{
  const h=harness();h.chrome.runtime.sendMessage=()=>{throw Error('Extension context invalidated.');};
  h.chrome.runtime.onMessage.removeListener=()=>{throw Error('Extension context invalidated.');};
  assert.doesNotThrow(()=>h.frames.shift()());await flush();
  assert.deepEqual(h.counts(),{cleared:1,disconnected:1,disposed:1,removed:0});assert.equal(h.events.size,0);
  h.realm.__braveMediaTransparency.dispose();assert.equal(h.counts().disposed,1);
});
test('rejected media send retires context and a later rejected send cannot dispose replacement twice',async()=>{
  const h=harness();let reject;
  h.chrome.runtime.sendMessage=()=>new Promise((resolve,no)=>reject=no);
  h.frames.shift()();h.realm.__braveMediaTransparency.dispose();
  reject(Error('Extension context invalidated.'));await flush();
  assert.deepEqual(h.counts(),{cleared:1,disconnected:1,disposed:1,removed:1});
});
test('asynchronous invalidated runtime send retires active content without waiting another heartbeat',async()=>{
  const h=harness();h.chrome.runtime.sendMessage=()=>Promise.reject(Error('Extension context invalidated.'));
  h.frames.shift()();await flush();assert.equal(h.counts().cleared,1);assert.equal(h.counts().disposed,1);
});
test('semantic replacement retires heartbeat listeners and queued geometry without relying on a failed runtime call',()=>{
  const h=harness();assert.equal(h.frames.length,1);
  h.retire();assert.deepEqual(h.counts(),{cleared:1,disconnected:1,disposed:1,removed:1});
  assert.equal(h.unsubscribed(),1);assert.equal(h.events.size,0);
  for(const frame of h.frames) frame();
  assert.equal(h.animationReads(),0,'a retired queued frame cannot read or rediscover page media');
  h.realm.__braveMediaTransparency.dispose();assert.equal(h.unsubscribed(),1);
});
