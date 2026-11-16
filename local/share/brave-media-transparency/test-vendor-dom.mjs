import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source=readFileSync(new URL('./extension/vendor/darkreader.js',import.meta.url),'utf8');
const start=source.indexOf('    function watchForStylePositions('),end=source.indexOf('    function resetObservers()',start);
const actual=source.slice(start,end);
function watcher(body) {
  const treeCallbacks=new Map(),discoveries=[],updates=[],ready=[];
  const document={body,documentElement:null,addEventListener(){}};
  const scope={document,observedRoots:new WeakSet(),handledShadowHosts:new WeakSet(),observers:[],registerStyleShadowRoot:null,
    stopWatchingForStylePositions(){},forEach:(items,callback)=>Array.from(items).forEach(callback),
    createOptimizedTreeObserver:(root,callbacks)=>{treeCallbacks.set(root,callbacks);return {disconnect(){}};},
    MutationObserver:class{observe(){}disconnect(){}},
    iterateShadowHosts(node,callback){if(!node)return;if(node.shadowRoot)callback(node);for(const child of node.children||[])scope.iterateShadowHosts(child,callback);},
    handleIsDefined(){},watchWhenCustomElementsDefined(){},collectUndefinedElements(){},checkImageSelectors(){},
    addDOMReadyListener:callback=>{ready.push(callback);callback();},
    getManageableStyles:node=>node.styles||[],push:(into,items)=>into.push(...items),isCustomElement:()=>false,recordUndefinedElement(){}};
  vm.createContext(scope);vm.runInContext(actual,scope);
  scope.watchForStylePositions([],update=>updates.push(update),root=>discoveries.push(root));
  return {document,scope,treeCallbacks,discoveries,updates,ready};
}
test('DOM-ready stylesheet watcher accepts absent body and absent documentElement without throwing',()=>{
  const h=watcher(null);
  assert.equal(h.treeCallbacks.has(h.document),true);
  assert.equal(h.discoveries.length,0);assert.equal(h.ready.length,1);
  assert.equal(typeof h.scope.registerStyleShadowRoot,'function');
});
test('body arriving after readiness gets style and shadow-root observation through existing tree updates',()=>{
  const h=watcher(null),root={children:[]},host={shadowRoot:root,children:[]};
  const style={previousElementSibling:null,nextElementSibling:null};
  const body={children:[host],styles:[style]};h.document.body=body;
  h.treeCallbacks.get(h.document).onMinorMutations(h.document,{additions:new Set([body]),moves:new Set(),deletions:new Set()});
  assert.equal(h.updates.length,1);assert.deepEqual(Array.from(h.updates[0].created),[style]);
  assert.deepEqual(h.discoveries,[root]);assert.equal(h.treeCallbacks.has(root),true);
});
test('ordinary ready body still registers existing child shadow roots exactly once',()=>{
  const root={children:[]},host={shadowRoot:root,children:[]};const h=watcher({children:[host]});
  assert.deepEqual(h.discoveries,[root]);
  h.ready[0]();assert.deepEqual(h.discoveries,[root]);
});
