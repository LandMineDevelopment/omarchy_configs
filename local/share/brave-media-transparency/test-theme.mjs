import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const themeSource=readFileSync(new URL('./extension/theme.js',import.meta.url),'utf8');
const vendorSource=readFileSync(new URL('./extension/vendor/darkreader.js',import.meta.url),'utf8');
function engine() {
  let listeners=0;
  const scope={crypto:webcrypto,navigator:{userAgent:'Chrome/150.0',platform:'Linux'},document:{addEventListener(){listeners++;},createElement:()=>({style:{},classList:{add(){}}}),documentElement:{style:{}}},location:{protocol:'https:',hostname:'example.test'},matchMedia:()=>({matches:false,addListener(){}}),console};
  scope.window=scope;
  const instrumented=vendorSource.replace('    exports.auto = auto;','    exports.policy={getBgImageModifier,getShadowModifier,modifyShadowColor,getModifiableCSSDeclaration,_modifyBackgroundColor,_modifyForegroundColor,_modifyBorderColor,parseColorWithCache,VariablesStore,VAR_TYPE_TEXT_SHADOW,VAR_TYPE_BG_COLOR};\n    exports.auto = auto;');
  vm.createContext(scope);vm.runInContext(instrumented,scope);
  return {scope,reload:()=>vm.runInContext(instrumented,scope),listeners:()=>listeners};
}
const palette={mode:1,brightness:100,contrast:100,grayscale:0,sepia:0,darkSchemeBackgroundColor:'#101010',darkSchemeTextColor:'#eeeeee'};
function adapt(value) {
  return engine().scope.DarkReader.policy.getBgImageModifier(value,{selectorText:'.fixture'},['*'],()=>false)(palette);
}
test('repeated vendored script injection retains engine identity and existing subscriptions',()=>{
  const h=engine(),api=h.scope.DarkReader,count=h.listeners();h.reload();
  assert.equal(h.scope.DarkReader,api);assert.equal(h.listeners(),count);
});
test('website API leaves real extension chrome runtime functions and native promises untouched', async()=>{
  const sent=[];
  const sendMessage=message=>{sent.push(message);return Promise.resolve({native:true});};
  const addListener=()=>{};
  const native={runtime:{sendMessage,onMessage:{addListener}},dom:{marker:true}};
  const scope={crypto:webcrypto,navigator:{userAgent:'Chrome/150.0',platform:'Linux'},document:{addEventListener(){},createElement:()=>({style:{},classList:{add(){}}}),documentElement:{style:{}}},location:{protocol:'https:',hostname:'example.test'},matchMedia:()=>({matches:false,addListener(){}}),console,chrome:native};
  scope.window=scope;vm.runInNewContext(vendorSource,scope);
  assert.equal(scope.chrome,native);assert.equal(scope.chrome.runtime.sendMessage,sendMessage);
  assert.equal(scope.chrome.runtime.onMessage.addListener,addListener);
  assert.deepEqual(await scope.chrome.runtime.sendMessage({type:'media-ready'}).then(value=>value),{native:true});
  assert.deepEqual(sent,[{type:'media-ready'}]);
});
test('actual upstream background modifier adapts neutral gradients to canvas',()=>{
  const result=adapt('linear-gradient(45deg, white 0%, #323437 100%)');
  assert.ok(result.includes('#101010') || result.includes('rgb(16, 16, 16)'));
  assert.equal(result.includes('#323437'),false);assert.equal(result.includes('white'),false);
});
test('mixed gradient and URL layers preserve URL spelling and never analyze images',()=>{
  const image=' url("data:image/svg+xml,<svg title=\'a,b\'>gradient</svg>")';
  const result=adapt('linear-gradient(white, #eee),'+image);
  assert.ok(result.endsWith(','+image));
  assert.equal(adapt(image),image);
});
test('image-set and quoted commas remain exact beside radial/conic gradients',()=>{
  const layer='image-set("https://example.test/a,b.png" 1x, url(\'../two.png\') 2x)';
  const result=adapt(layer+', radial-gradient(white, rgba(240,240,240,.4)), conic-gradient(#fff, #ddd)');
  assert.ok(result.startsWith(layer+','));assert.equal(result.includes('240,240,240'),false);
  assert.equal(adapt(layer),layer);
});
test('SVG paint properties bypass transformations even when using CSS variables',()=>{
  const h=engine();
  for(const prop of ['fill','stroke','stop-color','flood-color','lighting-color']) {
    assert.equal(h.scope.DarkReader.policy.getModifiableCSSDeclaration(prop,'var(--art)',{},null,['*'],()=>false),null);
  }
});
test('neutral canvas adaptation preserves alpha and respects current palette',()=>{
  const h=engine();
  const result=h.scope.DarkReader.policy._modifyBackgroundColor({r:50,g:52,b:55,a:.4},{...palette,darkSchemeBackgroundColor:'#000000'});
  assert.equal(result,'rgba(0, 0, 0, 0.4)');
});
function harness({artwork=false,shadow=false,sourceChanges=false}={}) {
  const events={},frames=[],calls=[],observers=[],styles=[];let generated=false,disabledWrites=0;
  function node(tag,parent=null) {
    const attrs=new Map(),classes=new Set();
    return {nodeType:1,localName:tag,parentElement:parent,sourceColor:'rgb(10, 20, 30)',
      getAttribute:key=>attrs.has(key)?attrs.get(key):null,setAttribute:(key,value)=>attrs.set(key,value),removeAttribute:key=>attrs.delete(key),
      classList:{add:cls=>classes.add(cls)},
      closest(){let current=this;while(current){if(current.classList?.hasDark || current.getAttribute('data-brave-media-theme-style')!==null)return current;current=current.parentElement;}return null;},
      querySelectorAll:()=>[],getBoundingClientRect:()=>({width:200,height:100}),remove(){const index=styles.indexOf(this);if(index>=0)styles.splice(index,1);this.parentNode=null;},
      isDark:()=>classes.has('darkreader')};
  }
  const svg=node('svg'),child=node('path',svg);svg.querySelectorAll=()=>[child];
  const shadowRoot={querySelectorAll:selector=>selector==='svg'?[svg]:selector==='*'?[svg,child]:styles.filter(style=>style.root===shadowRoot),appendChild(style){style.remove();style.root=this;style.parentNode=this;styles.push(style);}};
  const host=node('x-chart');if(shadow)host.shadowRoot=shadowRoot;
  const document={querySelectorAll:selector=>selector==='svg'?(artwork&&!shadow?[svg]:[]):selector==='*'?(artwork?(shadow?[host]:[svg,child]):[]):styles.filter(style=>style.root===document),head:{appendChild(style){style.remove();style.root=document;style.parentNode=this;styles.push(style);}},documentElement:{}};
  document.createElement=tag=>{const result=node(tag);let disabled=false;result.sheet={get disabled(){return disabled;},set disabled(value){disabledWrites++;disabled=value;}};return result;};
  const scope={document,MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(root,options){this.root=root;this.ownership=!!options.attributeFilter;}disconnect(){this.disconnected=true;}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},getComputedStyle:element=>({color:generated&&styles.some(style=>!style.sheet.disabled)?'rgb(238, 238, 238)':element.sourceColor}),fetch:async()=>({}),addEventListener:(name,fn)=>events[name]=fn,removeEventListener:name=>delete events[name],DarkReader:{enable:(theme,fixes)=>{calls.push({theme:structuredClone(theme),fixes:structuredClone(fixes)});if(!generated){const style=document.createElement('style');style.classList.add('darkreader');document.head.appendChild(style);}generated=true;},disable:()=>{generated=false;for(const style of [...styles])if(style.isDark())style.remove();},isEnabled:()=>generated,setFetchMethod(){}}};
  let sourceListener=null;
  if(sourceChanges) scope.DarkReader.onSourceChange=callback=>{sourceListener=callback;return ()=>sourceListener=null;};
  vm.runInNewContext(themeSource,scope);
  return {api:scope.SemanticTheme,scope,svg,child,host,shadowRoot,events,calls,styles,get observers(){return observers.filter(observer=>!observer.ownership);},get ownershipObservers(){return observers.filter(observer=>observer.ownership);},frames,sourceChange:()=>sourceListener(),hasSourceListener:()=>!!sourceListener,disabledWrites:()=>disabledWrites,flush(){for(let n=0;n<20&&frames.length;n++)frames.shift()();}};
}
test('palette applies readable foreground, theme selection and existing focus outlines',()=>{
  const h=harness();h.api.enable({background:'#000000',foreground:'#e6e6e6',accent:'#ffcc66',selection:'#222222',selectionForeground:'#ffffff'});
  assert.equal(h.calls[0].theme.darkSchemeBackgroundColor,'#000000');assert.equal(h.calls[0].theme.darkSchemeTextColor,'#e6e6e6');
  assert.equal(h.calls[0].theme.selectionColor,'','the palette owns selection instead of the engine layered default');
  assert.ok(h.calls[0].fixes.css.includes('outline-color:#ffcc66'));assert.ok(h.calls[0].fixes.css.includes('color:#ffffff'));
  assert.equal(h.calls[0].fixes.disableStyleSheetsProxy,true);assert.equal(h.calls[0].fixes.disableCustomElementRegistryProxy,true);
  assert.deepEqual(h.calls[0].fixes.ignoreImageAnalysis,['*']);assert.deepEqual(h.calls[0].fixes.invert,[]);
  h.api.setPalette({background:'url(https://example.invalid)'});assert.equal(h.calls.at(-1).theme.darkSchemeBackgroundColor,'#000000');
});
test('repeated equivalent or invalid palettes do not re-render the engine or rescan semantic artwork',()=>{
  const h=harness({artwork:true}),initial={background:'#ABC',foreground:'#DEF'};
  h.api.enable(initial);h.flush();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].theme.darkSchemeBackgroundColor,'#aabbcc');
  assert.equal(h.calls[0].theme.darkSchemeTextColor,'#ddeeff');
  const phases=h.api.lastRefreshPhaseTimings(),writes=h.disabledWrites();
  for(let i=0;i<5;i++) {
    assert.equal(h.api.enable(initial),true);
    h.api.enable({background:'#AaBbCc',foreground:'#DDEEFF',accent:'#BBB',selection:'#333',selectionForeground:'#dEf'});
    h.api.setPalette({background:'url(https://example.invalid)',foreground:'rgba(0,0,0,1)',accent:42,selection:false});
    h.api.setPalette(null);
  }
  assert.equal(h.calls.length,1);assert.equal(h.frames.length,0);
  assert.equal(h.api.lastRefreshPhaseTimings(),phases);assert.equal(h.disabledWrites(),writes);
});
test('effective control and selection palette changes publish fresh fixes snapshots to the engine',()=>{
  const h=harness(),snapshots=[],render=h.scope.DarkReader.enable;
  h.scope.DarkReader.enable=(theme,fixes)=>{snapshots.push(fixes);render(theme,fixes);};
  const base={background:'#000000',foreground:'#eeeeee',accent:'#bbbbbb',selection:'#333333'};
  h.api.enable(base);h.flush();
  const previousCSS=snapshots[0].css;
  h.api.setPalette({...base,accent:'#ffcc66',selection:'#223344'});
  assert.equal(h.calls.length,2);assert.equal(h.frames.length,1);
  assert.notEqual(snapshots[0],snapshots[1]);assert.equal(snapshots[0].css,previousCSS);
  assert.notEqual(JSON.stringify(snapshots[0]),JSON.stringify(snapshots[1]),'the vendor compares current and previous fixes content');
  assert.ok(snapshots[1].css.includes('outline-color:#ffcc66'));
  assert.ok(snapshots[1].css.includes('background-color:#223344'));
  h.flush();
  h.api.setPalette({...base,accent:'#FFCC66',selection:'#234'});
  assert.equal(h.calls.length,2);assert.equal(h.frames.length,0);
  h.api.setPalette({...base,background:'#101010',foreground:'#dddddd',accent:'#ffcc66',selection:'#223344'});
  assert.equal(h.calls.length,3);assert.equal(h.frames.length,1);
  assert.equal(h.calls[2].theme.darkSchemeBackgroundColor,'#101010');
  assert.equal(h.calls[2].theme.darkSchemeTextColor,'#dddddd');
});
test('palette deduplication preserves first enable OFF/ON and retired controller lifecycles',()=>{
  const h=harness(),value={background:'#000',foreground:'#eee'};
  h.api.setPalette(value);assert.equal(h.calls.length,0);assert.equal(h.frames.length,0);
  assert.equal(h.api.enable(value),true);h.flush();assert.equal(h.calls.length,1);
  h.api.disable();h.api.setPalette(value);assert.equal(h.calls.length,1);assert.equal(h.frames.length,0);
  assert.equal(h.api.enable(value),true);h.flush();assert.equal(h.calls.length,2);
  h.api.dispose();h.api.setPalette({background:'#123456'});assert.equal(h.api.enable(value),false);
  assert.equal(h.calls.length,2);assert.equal(h.frames.length,0);assert.equal(h.styles.length,0);
});
test('an unchanged palette still retires page adaptation when the document becomes a native PDF',()=>{
  const h=harness(),value={background:'#000000',foreground:'#eeeeee'};
  h.api.enable(value);h.flush();assert.equal(h.calls.length,1);
  h.scope.document.contentType='APPLICATION/PDF; charset=binary';
  h.api.setPalette(value);
  assert.equal(h.api.isEnabled(),false);assert.equal(h.calls.length,1);assert.equal(h.frames.length,0);assert.equal(h.styles.length,0);
  h.scope.document.contentType='text/html';
  assert.equal(h.api.enable(value),true);h.flush();assert.equal(h.calls.length,2);
});
test('media publication runs before semantic DOM reads on first enable and each coalesced refresh',()=>{
  const h=harness({artwork:true}),order=[],query=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>{order.push('semantic-read');return query(selector);};
  h.api.setBeforeRefresh(()=>{
    order.push('media-publication');
    assert.ok(h.styles.every(style=>!style.sheet.disabled),'authored-style reads have not disabled theme sheets yet');
  });
  h.api.enable();assert.equal(order[0],'media-publication');assert.ok(order.includes('semantic-read'));
  order.length=0;h.flush();assert.equal(order[0],'media-publication');
  assert.equal(order.filter(step=>step==='media-publication').length,1);
  order.length=0;h.api.refresh();h.api.refresh();h.flush();
  assert.equal(order[0],'media-publication');assert.equal(order.filter(step=>step==='media-publication').length,1);
  h.api.setBeforeRefresh(null);order.length=0;h.api.refresh();h.flush();
  assert.equal(order.includes('media-publication'),false);assert.ok(order.includes('semantic-read'));
});
test('before-refresh root discovery queues a later pass without synchronous recursion',()=>{
  const h=harness({artwork:true,shadow:true}),registered=[];let depth=0,maxDepth=0,publications=0;
  h.scope.DarkReader.registerShadowRoot=root=>registered.push(root);
  h.api.setBeforeRefresh(()=>{
    depth++;maxDepth=Math.max(maxDepth,depth);publications++;
    h.api.discoverRoot(h.shadowRoot);
    depth--;
  });
  h.api.enable();assert.equal(publications,1);assert.equal(maxDepth,1);
  h.flush();assert.equal(publications,2);assert.equal(maxDepth,1);assert.equal(h.frames.length,0);
  assert.equal(registered.length,1);assert.equal(registered[0],h.shadowRoot);
});
test('short and small SVG artwork retains authored currentColor at every size in either DOM root',()=>{
  for(const shadow of [false,true]) for(const [width,height] of [[120,40],[24,24],[300,12]]) {
    const h=harness({artwork:true,shadow});h.svg.getBoundingClientRect=()=>({width,height});
    h.api.enable();h.flush();
    const marker=h.svg.getAttribute('data-brave-media-artwork');assert.ok(marker,`${width}x${height}, shadow=${shadow}`);
    assert.ok(h.styles.some(style=>style.textContent.includes('color:rgb(10, 20, 30)!important')));
    h.api.refresh();h.flush();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),marker);
    h.api.disable();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),null);
  }
});
test('before-refresh callback observes lifecycle guards and errors do not publish a partial theme',()=>{
  const h=harness();let publications=0;
  h.api.setBeforeRefresh(()=>{publications++;});h.api.enable();h.flush();assert.equal(publications,2);
  h.api.disable();h.api.refresh();h.flush();assert.equal(publications,2);
  h.api.enable();h.flush();assert.equal(publications,4);
  h.api.dispose();h.api.refresh();h.flush();assert.equal(publications,4);
  const stopped=harness();let semanticReads=0;
  stopped.scope.document.querySelectorAll=()=>{semanticReads++;return [];};
  stopped.api.setBeforeRefresh(()=>stopped.api.disable());assert.equal(stopped.api.enable(),false);stopped.flush();
  assert.equal(semanticReads,0,'a callback that retires adaptation cannot resume semantic writes');
  assert.equal(stopped.calls.length,0);assert.equal(stopped.styles.length,0);
  const failed=harness();failed.api.setBeforeRefresh(()=>{throw new Error('media publication failed');});
  assert.throws(()=>failed.api.enable(),/media publication failed/);
  assert.equal(failed.api.isEnabled(),false);assert.equal(failed.calls.length,0);assert.equal(failed.styles.length,0);
  failed.api.setBeforeRefresh(false);assert.equal(failed.api.enable(),true);failed.flush();assert.equal(failed.calls.length,1);
});
test('no-artwork pages never disable generated theme styles and ordinary hover/focus does not rescan',()=>{
  const h=harness();h.api.enable();h.flush();const count=h.disabledWrites();
  h.events.pointerover({type:'pointerover',composedPath:()=>[{}]});h.events.focusin({type:'focusin',composedPath:()=>[{}]});
  assert.equal(h.frames.length,0);assert.equal(h.disabledWrites(),count);assert.equal(count,0);
});
test('large currentColor artwork retains authored color and exact owned-attribute restoration',()=>{
  const h=harness({artwork:true});h.svg.setAttribute('data-brave-media-artwork','authored');
  h.api.enable();h.flush();
  const locks=h.styles.find(style=>style.getAttribute('data-brave-media-theme-style')!==null);
  assert.ok(locks.textContent.includes('color:rgb(10, 20, 30)!important'));
  assert.notEqual(h.svg.getAttribute('data-brave-media-artwork'),'authored');
  h.svg.sourceColor='rgb(100, 20, 30)';h.api.refresh();h.flush();assert.ok(locks.textContent.includes('color:rgb(100, 20, 30)!important'));
  h.api.disable();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'authored');assert.equal(h.child.getAttribute('data-brave-media-artwork'),null);
  assert.equal(h.styles.length,0);assert.equal(h.api.isEnabled(),false);assert.ok(h.observers.every(observer=>observer.disconnected));
});
test('open shadow artwork owns a root-local stylesheet and both roots are cleaned on dispose',()=>{
  const h=harness({artwork:true,shadow:true});h.api.enable();h.flush();
  assert.equal(h.observers.length,2);assert.ok(h.styles.some(style=>style.root!==h.scope.document));
  h.api.dispose();assert.equal(h.styles.length,0);assert.equal(Object.keys(h.events).length,0);
});
test('owned sheets reconcile attachment to their live root without republishing CSS or reviving detached roots',()=>{
  const h=harness({artwork:true,shadow:true});h.api.enable();h.flush();
  const sheet=h.styles.find(style=>style.getAttribute('data-brave-media-theme-style')==='style');
  const css=sheet.textContent;
  sheet.remove();assert.equal(sheet.parentNode,null);
  h.api.refresh();h.flush();assert.equal(sheet.parentNode,h.shadowRoot);assert.equal(sheet.textContent,css);
  assert.equal(h.styles.filter(style=>style===sheet).length,1,'the retained owned node is reattached once');
  h.scope.document.head.appendChild(sheet);assert.equal(sheet.parentNode,h.scope.document.head);
  h.api.refresh();h.flush();assert.equal(sheet.parentNode,h.shadowRoot,'the expected root retains stylesheet ownership');
  sheet.remove();h.shadowRoot.isConnected=false;h.api.refresh();h.flush();assert.equal(sheet.parentNode,null,'detached roots do not regain sheets');
  h.shadowRoot.isConnected=true;h.api.refresh();h.flush();
  const replacement=h.styles.find(style=>style.root===h.shadowRoot && style.getAttribute('data-brave-media-theme-style')==='style');
  assert.equal(replacement.parentNode,h.shadowRoot);assert.notEqual(replacement,sheet,'reattachment owns fresh state after the detached root was released');
  h.api.disable();h.api.refresh();h.flush();assert.equal(sheet.parentNode,null,'OFF never revives a retained sheet');assert.equal(h.styles.length,0);
});
test('owned style, attributes and engine mutations do not schedule observer loops',()=>{
  const h=harness({artwork:true});h.api.enable();h.flush();
  const target=h.svg;
  const record={type:'attributes',target,attributeName:'data-darkreader-inline-color'};
  assert.equal(h.api.ownsMutation(record),true);h.observers[0].callback([record]);assert.equal(h.frames.length,0);
  const lockStyle=h.styles.find(style=>style.getAttribute('data-brave-media-theme-style')!==null);
  assert.equal(h.api.ownsMutation({type:'characterData',target:{nodeType:3,parentElement:lockStyle}}),true);
  target.setAttribute('style','--darkreader-inline-color: #eee;');
  assert.equal(h.api.ownsMutation({type:'attributes',target,attributeName:'style'}),true);
  target.setAttribute('style','color: red; --darkreader-inline-color: #eee;');
  assert.equal(h.api.ownsMutation({type:'attributes',target,attributeName:'style'}),false);
  h.observers[0].callback([{type:'attributes',target,attributeName:'class'}]);assert.equal(h.frames.length,1);
  h.svg.setAttribute('data-brave-media-artwork','new-author-value');h.api.disable();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'new-author-value');
});

test('late root registration renders its existing CSS through upstream managers and retains update observers',()=>{
  const actual=engine().scope.DarkReader.policy;
  const css=[];let renders=0,watches=0,rootObservations=0,inlineObservations=0;
  const sourceStyle={fixture:true};const root={host:{},querySelectorAll:()=>[]};
  const scope={theme:palette,registerStyleShadowRoot:()=>rootObservations++,additionalShadowRoots:new WeakSet(),
    getManageableStyles:()=>[sourceStyle],styleManagers:new Map(),ignoredImageAnalysisSelectors:['*'],ignoredInlineSelectors:[],INLINE_STYLE_SELECTOR:'[style]',
    variablesStore:{addRulesForMatching(){},matchVariablesAndDependents(){}},forEach:(items,fn)=>items.forEach(fn),overrideInlineStyle(){},treeObservers:new Map(),
    deepWatchForInlineStyles:()=>inlineObservations++};
  scope.createManager=style=>{
    const manager={details:()=>({rules:[style]}),render:theme=>{
      renders++;
      const declaration=actual.getModifiableCSSDeclaration('background-color','white',{style:{getPropertyPriority:()=>''}},null,['*'],()=>false);
      css.push(declaration.value(theme));
    },watch:()=>watches++};scope.styleManagers.set(style,manager);return manager;
  };
  const start=vendorSource.indexOf('    function registerAdditionalShadowRoot('),end=vendorSource.indexOf('    function stopWatchingForUpdates()',start);
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);
  assert.equal(scope.registerAdditionalShadowRoot(root),true);
  assert.ok(css[0].includes('16, 16, 16') || css[0].includes('#101010'));
  assert.equal(renders,1);assert.equal(watches,1);assert.equal(rootObservations,1);assert.equal(inlineObservations,1);
  assert.equal(scope.registerAdditionalShadowRoot(root),false);assert.equal(renders,1);
});

test('controller registers each discovered open root once after engine startup and again after OFF/ON',()=>{
  const h=harness({artwork:true,shadow:true}),registered=[];
  h.scope.DarkReader.registerShadowRoot=root=>registered.push(root);
  h.api.enable();h.flush();assert.equal(registered.length,1);
  h.api.discoverRoot(registered[0]);assert.equal(registered.length,1);
  h.api.disable();h.api.enable();h.flush();assert.equal(registered.length,2);
});

test('detaching a shadow host releases root observer, owned styles and artwork attributes before OFF',()=>{
  const h=harness({artwork:true,shadow:true});h.svg.setAttribute('data-brave-media-artwork','authored');
  h.api.enable();h.flush();
  const observer=h.observers.find(item=>item.root===h.shadowRoot);
  assert.ok(h.styles.some(style=>style.root===h.shadowRoot));
  h.host.shadowRoot=null;h.api.refresh();h.flush();
  assert.equal(observer.disconnected,true);
  assert.equal(h.styles.some(style=>style.root===h.shadowRoot),false);
  assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'authored');
  assert.equal(h.child.getAttribute('data-brave-media-artwork'),null);
  const count=h.observers.length;h.host.shadowRoot=h.shadowRoot;h.api.refresh();h.flush();
  assert.equal(h.observers.length,count+1,'reattached root receives a fresh owned observer');
});

test('artwork moved out of a detached root retains its lock and gets a live-root stylesheet',()=>{
  const h=harness({artwork:true,shadow:true});h.svg.setAttribute('data-brave-media-artwork','authored');
  h.api.enable();h.flush();const lockId=h.svg.getAttribute('data-brave-media-artwork');
  const original=h.scope.document.querySelectorAll;
  h.host.shadowRoot=null;
  h.scope.document.querySelectorAll=selector=>selector==='svg'?[h.svg]:selector==='*'?[h.host,h.svg,h.child]:original(selector);
  h.observers.find(observer=>observer.root===h.scope.document).callback([{type:'childList',target:h.scope.document,addedNodes:[h.svg],removedNodes:[]}]);
  h.api.refresh();h.flush();
  assert.equal(h.svg.getAttribute('data-brave-media-artwork'),lockId);
  assert.equal(h.styles.some(style=>style.root===h.shadowRoot),false);
  assert.ok(h.styles.some(style=>style.root===h.scope.document && style.textContent?.includes(`[data-brave-media-artwork="${lockId}"]`)));
  h.api.disable();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'authored');
});

test('heartbeat discovery of a late root schedules authored currentColor locks once and OFF restores them',()=>{
  const h=harness();
  h.svg.setAttribute('data-brave-media-artwork','authored-late');
  const query=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>selector==='*'?[h.host]:query(selector);
  h.api.enable();h.flush();
  h.host.shadowRoot=h.shadowRoot;
  const registered=[];h.scope.DarkReader.registerShadowRoot=root=>registered.push(root);
  h.api.discoverRoot(h.shadowRoot);
  assert.equal(registered.length,1);assert.equal(h.frames.length,1);
  h.api.discoverRoot(h.shadowRoot);assert.equal(h.frames.length,1,'known-root heartbeat does not enqueue extra work');
  h.flush();
  const stylesheet=h.styles.find(style=>style.root===h.shadowRoot && style.getAttribute('data-brave-media-theme-style')!==null);
  assert.ok(stylesheet.textContent.includes('color:rgb(10, 20, 30)!important'),'capture reads authored color with generated styles disabled');
  assert.notEqual(h.svg.getAttribute('data-brave-media-artwork'),'authored-late');
  h.api.discoverRoot(h.shadowRoot);assert.equal(h.frames.length,0);
  h.api.disable();assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'authored-late');
  assert.equal(h.child.getAttribute('data-brave-media-artwork'),null);
});

test('actual static theme setup with both proxies disabled inserts CSS without inline executables',()=>{
  const createdStyles=[];let scriptCreates=0,scriptInserts=0;
  const scope={theme:{...palette,useFont:false,textStroke:0},fixes:{disableStyleSheetsProxy:true,disableCustomElementRegistryProxy:true,css:''},isIFrame$1:false,
    document:{head:{insertBefore(){scriptInserts++;},lastChild:null},dispatchEvent(){}},CustomEvent:class{},
    createOrUpdateStyle:name=>{const style={name,sheet:{},textContent:''};createdStyles.push(style);return style;},
    createOrUpdateScript:()=>{scriptCreates++;return {append(){},remove(){}};},
    injectStaticStyle(){},getModifiedFallbackStyle:()=>'',getModifiedUserAgentStyle:()=>'',createTextStyle:()=>'',setInversionStyleValue(){},getInlineOverrideStyle:()=>'',getSelectionColor:()=>null,
    parseColorWithCache:value=>value,modifyBackgroundColor:()=> '#101010',modifyForegroundColor:()=> '#eeeeee',registerVariablesSheet(){},replaceCSSTemplates:value=>value,injectProxy(){}};
  const start=vendorSource.indexOf('    function createStaticStyleOverrides() {'),end=vendorSource.indexOf('    const shadowRootsWithOverrides',start);
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);
  scope.createStaticStyleOverrides();
  assert.ok(createdStyles.some(style=>style.name==='darkreader--user-agent'));
  assert.ok(createdStyles.some(style=>style.name==='darkreader--override'));
  assert.equal(scriptCreates,0);assert.equal(scriptInserts,0);
});

test('neutral secondary text is opaque and readable while fully transparent text stays hidden',()=>{
  const p=engine().scope.DarkReader.policy;
  for(const value of [{r:100,g:102,b:105,a:.35},{r:125,g:125,b:125,a:1},{r:180,g:180,b:180,a:.1}]) {
    const result=p.parseColorWithCache(p._modifyForegroundColor(value,palette));
    assert.equal(result.a,1);assert.ok(Math.min(result.r,result.g,result.b)>=180);
  }
  const hidden=p.parseColorWithCache(p._modifyForegroundColor({r:0,g:0,b:0,a:0},palette));
  assert.equal(hidden.a,0);
  const border=p.parseColorWithCache(p._modifyBorderColor({r:230,g:230,b:230,a:1},palette));
  assert.ok(Math.min(border.r,border.g,border.b)>=114);
});

test('semantic controls retain minimal boundaries, distinct states and accessible native checks without media filters',()=>{
  const h=harness();h.api.enable({accent:'#ffcc66',foreground:'#e6e6e6',background:'#000000'});
  const css=h.calls.at(-1).fixes.css;
  assert.match(css,/role="combobox"/);assert.match(css,/outline:1px solid rgba\(160,160,160,.35\)/);
  for(const state of ['aria-selected','aria-pressed','aria-checked'])assert.ok(css.includes(`${state}="true"`));
  assert.match(css,/background-color:#000000!important;color:#e6e6e6!important/);
  assert.equal(css.includes('#242424'),false);assert.equal(css.includes('#343434'),false);
  assert.match(css,/accent-color:#ffcc66!important/);
  assert.match(css,/role="menu"/);assert.match(css,/0 12px 28px rgba\(0,0,0,.45\)/);
  assert.match(css,/:where\(:hover:not\(:disabled\)/);assert.match(css,/:not\(svg\):not\(svg \*\)/);
  assert.equal(css.includes('filter:'),false);assert.equal((css.match(/opacity:1!important/g)||[]).length,1,'opacity applies only to the identified control pseudo indicator');
  h.api.disable();assert.equal(h.styles.length,0);
});

test('PDF special handling does not create overlays, invert colors or rewrite adopted styles',()=>{
  const paints=new Uint8Array([255,255,255,255,0,0]);const original=paints.slice();
  let queried=0,overlay=0,sheets=0;
  const root={querySelector:()=>{queried++;return {};},adoptedStyleSheets:[]};
  const scope={document:{body:{},createElement:()=>{overlay++;return {};}},chrome:{dom:{openOrClosedShadowRoot:()=>root}},isChromium:true,isMobile:false,
    CSSStyleSheet:class{constructor(){sheets++;}},createPDFOverlay:()=>{overlay++;paints[0]=0;},cleaners:[]};
  const start=vendorSource.indexOf('    function tryInvertChromePDF() {'),end=vendorSource.indexOf('    let prevTheme = null;',start);
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);scope.tryInvertChromePDF();
  assert.equal(queried,0);assert.equal(overlay,0);assert.equal(sheets,0);assert.deepEqual(root.adoptedStyleSheets,[]);assert.deepEqual(paints,original);
});

test('upgraded vendor disposes old controller and enabled engine before replacing the global API',()=>{
  const h=engine(),old=h.scope.DarkReader,order=[];
  let active=true;
  old.isEnabled=()=>active;
  old.disable=()=>{assert.equal(h.scope.DarkReader,old);order.push('engine-disabled');active=false;};
  h.scope.BraveMediaTheme={dispose(){assert.equal(h.scope.DarkReader,old);order.push('controller-disposed');}};
  const next=vendorSource.replace(/const revision = '[^']+';/,"const revision = 'test-upgrade';");
  vm.runInContext(next,h.scope);
  assert.deepEqual(order,['controller-disposed','engine-disabled']);
  assert.notEqual(h.scope.DarkReader,old);assert.equal(h.scope.__braveDarkReaderRevision,'test-upgrade');
  const current=h.scope.DarkReader;vm.runInContext(next,h.scope);
  assert.equal(h.scope.DarkReader,current);assert.equal(order.length,2);
});

function wallpaperThemeHarness(kind='image') {
  const styles=[],frames=[],events={},observers=[];
  let generated=false, hitTests=0;
  function node(tag,role=null) {
    const attrs=new Map(),value={nodeType:1,localName:tag,children:[],textContent:'',matches:selector=>['img','video','canvas','svg','object','embed','iframe'].includes(tag),source:{visibility:'visible',opacity:'1',display:'block',backgroundImage:'none',position:'static'},
      getAttribute:key=>attrs.get(key)??null,setAttribute:(key,value)=>attrs.set(key,value),removeAttribute:key=>attrs.delete(key),
      getBoundingClientRect:()=>({left:0,top:0,right:1200,bottom:900,width:1200,height:900}),
      appendChild(child){child.parentElement=this;this.children.push(child);return child;},
      contains(other){return this===other||this.children.some(child=>child.contains(other));},
      closest(){return null;},querySelector:()=>null,
      querySelectorAll(selector) {
        const all=[];const walk=parent=>parent.children.forEach(child=>{all.push(child);walk(child);});walk(this);
        return all.filter(child=>selector==='img'?child.localName==='img':selector==='main,[role="main"],[role="application"]'?child.localName==='main'||['main','application'].includes(child.getAttribute('role')):false);
      }};
    if(role)value.setAttribute('role',role);
    return value;
  }
  const body=node('body'),scope=body.appendChild(node('div')),layer=scope.appendChild(node('div'));
  layer.source.position='fixed';
  const image=layer.appendChild(node('img')),app=scope.appendChild(node('div')),main=app.appendChild(node('main')),row=main.appendChild(node('div'));
  const artwork=app.appendChild(node('div','img'));artwork.source.backgroundImage='url("artwork.jpg")';
  artwork.getBoundingClientRect=()=>({left:10,top:10,right:310,bottom:210,width:300,height:200});
  if(kind==='css')body.source.backgroundImage='url("wallpaper.jpg")';
  let nodes=kind==='image'?[body,scope,layer,image,app,main,row,artwork]:[body,app,main,row,artwork];
  const activeOwned=()=>styles.some(style=>style.owned&&!style.sheet.disabled&&/visibility:hidden|background-image:none/.test(style.textContent || ''));
  const computed=element=>({...element.source,color:'rgb(238,238,238)',
    ...(activeOwned()&&element.getAttribute('data-brave-media-backdrop')!==null?
      element.localName==='img'?{visibility:'hidden'}:{backgroundImage:'none'}:{})});
  const document={body,documentElement:body,
    querySelectorAll:selector=>selector==='*'?nodes:selector==='svg'?[]:styles,
    head:{appendChild(style){style.remove();style.parentNode=this;styles.push(style);}},
    createElement:tag=>{const style=node(tag);style.classList={add(){}};style.sheet={disabled:false};style.remove=()=>{const i=styles.indexOf(style);if(i>=0)styles.splice(i,1);style.parentNode=null;};
      const write=style.setAttribute;style.setAttribute=(key,value)=>{write(key,value);if(key==='data-brave-media-theme-style')style.owned=true;};return style;},
    elementsFromPoint(){hitTests++;return computed(image).visibility==='hidden'?[row,main,app,scope,body]:[row,main,app,image,layer,scope,body];}};
  const realm={document,innerWidth:1200,innerHeight:900,getComputedStyle:computed,
    MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(root,options){this.ownership=!!options.attributeFilter;}disconnect(){this.disconnected=true;}},
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},
    addEventListener:(name,fn)=>events[name]=fn,removeEventListener:name=>delete events[name],
    DarkReader:{enable(){generated=true;},disable(){generated=false;},isEnabled:()=>generated,setFetchMethod(){}}};
  vm.createContext(realm);
  vm.runInContext(readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8'),realm);
  vm.runInContext(themeSource,realm);
  return {api:realm.BraveMediaTheme,realm,document,body,image,artwork,styles,computed,events,frames,get observers(){return observers.filter(observer=>!observer.ownership);},get ownershipObservers(){return observers.filter(observer=>observer.ownership);},
    flush(){for(let i=0;i<20&&frames.length;i++)frames.shift()();},hitTests:()=>hitTests,
    detach(){nodes=nodes.filter(node=>![image,layer].includes(node));
      for(const observer of observers.filter(observer=>!observer.ownership&&!observer.disconnected)) observer.callback([{type:'childList',target:scope,addedNodes:[],removedNodes:[layer]}]);}};
}
test('semantic wallpaper hiding remains stable on refresh and restores exact authored ownership on OFF',()=>{
  const h=wallpaperThemeHarness();h.image.setAttribute('data-brave-media-backdrop','authored');h.image.setAttribute('style','position:absolute;');
  h.api.enable({background:'#000000'});h.flush();
  const id=h.image.getAttribute('data-brave-media-backdrop');
  assert.notEqual(id,'authored');assert.equal(h.api.isBackdrop(h.image),true);
  assert.equal(h.computed(h.image).visibility,'hidden');assert.ok(h.styles.some(style=>style.textContent.includes('visibility:hidden!important')));
  assert.equal(h.artwork.getAttribute('data-brave-media-backdrop'),null);
  const count=h.hitTests();
  for(let pass=0;pass<3;pass++) { h.api.refresh();h.flush();assert.equal(h.image.getAttribute('data-brave-media-backdrop'),id);assert.equal(h.computed(h.image).visibility,'hidden'); }
  assert.equal(h.image.getAttribute('data-brave-media-backdrop'),id);assert.ok(h.hitTests()>count);
  assert.equal(h.computed(h.image).visibility,'hidden','authored stacking is checked without exposing an intervening paint');
  assert.equal(h.api.ownsMutation({type:'attributes',target:h.image,attributeName:'data-brave-media-backdrop'}),true);
  h.events.pointerover({type:'pointerover',composedPath:()=>[h.image]});assert.equal(h.frames.length,0);
  h.api.disable();assert.equal(h.image.getAttribute('data-brave-media-backdrop'),'authored');
  assert.equal(h.image.getAttribute('style'),'position:absolute;');assert.equal(h.computed(h.image).visibility,'visible');
  assert.equal(h.styles.length,0);assert.equal(h.api.isBackdrop(h.image),false);
});
test('decorative CSS canvas uses current palette while content artwork URL stays authored',()=>{
  const h=wallpaperThemeHarness('css');h.api.enable({background:'#000000'});h.flush();
  assert.equal(h.api.isBackdrop(h.body),true);assert.equal(h.computed(h.body).backgroundImage,'none');
  assert.ok(h.styles.some(style=>style.textContent.includes('background-image:none!important;background-color:#000000!important')));
  assert.equal(h.computed(h.artwork).backgroundImage,'url("artwork.jpg")');assert.equal(h.api.isBackdrop(h.artwork),false);
  h.api.setPalette({background:'#101010'});h.flush();assert.ok(h.styles.some(style=>style.textContent.includes('background-color:#101010!important')));
  h.api.disable();assert.equal(h.computed(h.body).backgroundImage,'url("wallpaper.jpg")');assert.equal(h.body.getAttribute('data-brave-media-backdrop'),null);
});
test('wallpaper that becomes labeled content releases ownership and detached wallpaper is restored',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();h.image.setAttribute('alt','Meaningful photo');
  h.api.refresh();h.flush();assert.equal(h.api.isBackdrop(h.image),true);assert.equal(h.computed(h.image).visibility,'hidden');
  const pending=h.api.pendingBackdropMedia();assert.equal(pending.length,1);
  h.api.acceptBackdropMedia(pending.map(entry=>({...entry,rect:entry.element.getBoundingClientRect()})));
  assert.equal(h.api.isBackdrop(h.image),false);assert.equal(h.computed(h.image).visibility,'visible');
  h.image.removeAttribute('alt');h.api.refresh();h.flush();assert.equal(h.api.isBackdrop(h.image),true);
  h.detach();h.api.refresh();h.flush();assert.equal(h.image.getAttribute('data-brave-media-backdrop'),null);assert.equal(h.api.isBackdrop(h.image),false);
  h.api.dispose();assert.ok(h.observers.every(observer=>observer.disconnected));assert.equal(h.styles.length,0);
});

function installMediaContent(h) {
  const sent=[];let message;
  Object.assign(h.realm,{outerWidth:1200,outerHeight:1000,devicePixelRatio:1,screenX:0,screenY:0,
    visualViewport:{scale:1,offsetLeft:0,offsetTop:0,addEventListener(){},removeEventListener(){}},
    chrome:{runtime:{sendMessage:async packet=>{sent.push(packet);},onMessage:{addListener:callback=>message=callback,removeListener(){}}}},
    setInterval(){return 1;},clearInterval(){}});
  h.document.visibilityState='visible';h.document.fullscreenElement=null;h.document.getAnimations=()=>[];
  vm.runInContext(readFileSync(new URL('./extension/content.js',import.meta.url),'utf8'),h.realm);
  message({type:'media-set-enabled-v2',enabled:true,zoom:1});h.flush();
  return {sent,message,observer:h.observers.at(-1),last:()=>sent.filter(packet=>packet.type==='media-content-state').at(-1)};
}
test('wallpaper-to-artwork rAF ordering protects hidden geometry and waits exact native acknowledgement before paint',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();const content=installMediaContent(h);
  h.image.setAttribute('alt','Actual photograph');
  const record={type:'attributes',target:h.image,attributeName:'alt'};
  // Media observer enqueues first, theme observer second: the confirmed race.
  content.observer.callback([record]);h.observers[0].callback([record]);
  h.frames.shift()();const obsolete=content.last().sequence;
  h.frames.shift()();const publication=content.last();
  assert.equal(h.computed(h.image).visibility,'hidden');assert.equal(h.api.pendingBackdropMedia().length,1);
  assert.ok(publication.boxes.some(rect=>rect.left===0&&rect.top===0&&rect.right===1200&&rect.bottom===900));
  content.message({type:'media-geometry-accepted',sequence:obsolete});assert.equal(h.computed(h.image).visibility,'hidden');
  content.message({type:'media-geometry-accepted',sequence:publication.sequence});
  assert.equal(h.computed(h.image).visibility,'visible');assert.equal(h.api.pendingBackdropMedia().length,0);
  assert.ok(content.last().boxes.some(rect=>rect.right===1200),'ordinary image protection follows the accepted handoff');
});
test('resize and changed pending geometry cannot reveal artwork under an old accepted mask',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();const themeResize=h.events.resize;const content=installMediaContent(h);
  h.realm.innerWidth=1400;themeResize({type:'resize'});h.events.resize({type:'resize'});h.flush();
  assert.equal(h.api.pendingBackdropMedia().length,1);assert.equal(h.computed(h.image).visibility,'hidden');
  const first=content.last();
  h.image.getBoundingClientRect=()=>({left:50,top:0,right:1250,bottom:900,width:1200,height:900});
  content.message({type:'media-geometry-accepted',sequence:first.sequence});
  assert.equal(h.computed(h.image).visibility,'hidden');assert.ok(content.last().sequence>first.sequence);
  content.message({type:'media-geometry-accepted',sequence:content.last().sequence});
  assert.equal(h.computed(h.image).visibility,'visible');
});
test('inactive pending artwork stays hidden until native acceptance or global OFF',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();h.image.setAttribute('alt','Photograph');h.api.refresh();h.flush();
  assert.equal(h.computed(h.image).visibility,'hidden');assert.equal(h.api.pendingBackdropMedia().length,1);
  h.api.disable();assert.equal(h.computed(h.image).visibility,'visible');assert.equal(h.image.getAttribute('data-brave-media-backdrop'),null);
});

function controlHarness(options) {
  const h=harness(options),nodes=[];
  function element(tag,attrs={},text='') {
    const map=new Map(Object.entries(attrs));
    const node={nodeType:1,localName:tag,textContent:text,
      getAttribute:key=>map.has(key)?map.get(key):null,setAttribute:(key,value)=>map.set(key,value),removeAttribute:key=>map.delete(key),
      querySelector:()=>null,closest:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({left:10,top:10,right:30,bottom:30,width:20,height:20})};
    nodes.push(node);return node;
  }
  const original=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>selector==='*'?nodes:selector==='svg'?nodes.filter(node=>node.localName==='svg'):original(selector);
  h.scope.getComputedStyle=(node,pseudo)=>pseudo?(node[pseudo]||{content:'none',backgroundImage:'none',width:'0px',height:'0px'}):(node.computed || {display:'block',visibility:'visible',opacity:'1',backgroundImage:'none'});
  h.scope.document.getElementById=id=>nodes.find(node=>node.getAttribute('id')===id);
  Object.assign(h.scope,{innerWidth:1000,innerHeight:800});
  return Object.assign(h,{element,nodes});
}
test('visible authored control borders suppress duplicate outlines without inferring borders on unrelated layout',()=>{
  const h=controlHarness(),button=h.element('button',{},'Action'),underline=h.element('input'),transparent=h.element('button',{},'No border'),sameFill=h.element('button',{},'Indistinct'),layout=h.element('div');
  const paint={display:'block',visibility:'visible',opacity:'1',backgroundImage:'none',backgroundColor:'rgb(0, 0, 0)',borderBottomWidth:'1px',borderBottomStyle:'solid',borderBottomColor:'rgb(120, 120, 120)'};
  button.computed={...paint};underline.computed={...paint};layout.computed={...paint};
  transparent.computed={...paint,borderBottomColor:'rgba(255, 255, 255, 0)'};
  sameFill.computed={...paint,borderBottomColor:'rgb(0, 0, 0)'};
  h.api.enable({background:'#000000'});h.flush();
  const attribute='data-brave-media-control-boundary',marker=button.getAttribute(attribute);
  assert.ok(marker?.startsWith('bm-'));assert.ok(underline.getAttribute(attribute)?.startsWith('bm-'));
  for(const node of [transparent,sameFill,layout])assert.equal(node.getAttribute(attribute),null);
  assert.equal(h.api.ownsMutation({type:'attributes',target:button,attributeName:attribute}),true);
  h.api.refresh();h.flush();assert.equal(button.getAttribute(attribute),marker,'unchanged border ownership is stable');
  button.computed.borderBottomWidth='0px';h.api.refresh();h.flush();assert.equal(button.getAttribute(attribute),null,'removed border restores the fallback outline');
  button.computed.borderBottomWidth='1px';button.setAttribute(attribute,'authored');h.api.refresh();h.flush();
  h.api.disable();assert.equal(button.getAttribute(attribute),'authored');assert.equal(underline.getAttribute(attribute),null);
});
test('hover uses the live palette canvas and a neutral edge while selected and keyboard focus retain accent',()=>{
  const h=harness();h.api.enable({background:'#101820',foreground:'#e6e6e6',accent:'#ffcc66'});
  const css=h.calls.at(-1).fixes.css;
  assert.match(css,/:where\(:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)\)\{background-color:#101820!important\}/);
  assert.match(css,/:hover[^\n]*outline:1px solid rgba\(160,160,160,.45\)/);
  assert.match(css,/aria-checked="true"[^\n]*background-color:#101820!important;color:#e6e6e6!important;outline:1px solid #ffcc66/);
  assert.match(css,/:focus-visible[^\n]*outline:2px solid #ffcc66/);
  h.api.setPalette({background:'#152535'});
  assert.ok(h.calls.at(-1).fixes.css.includes('background-color:#152535!important'));
  assert.equal(h.calls.at(-1).fixes.css.includes('background-color:#101820'),false);
});
test('native default bevel becomes a flat quiet border without changing styled or colored edges',()=>{
  const h=controlHarness(),native=h.element('button',{},'Default'),solid=h.element('button',{},'Styled'),colored=h.element('button',{},'Colored'),inline=h.element('button',{style:'border:2px outset #777'},'Inline'),custom=h.element('button',{},'Custom');
  const paint={display:'block',visibility:'visible',opacity:'1',backgroundImage:'none',backgroundColor:'rgb(0, 0, 0)',appearance:'auto'};
  for(const side of ['Top','Right','Bottom','Left'])Object.assign(paint,{[`border${side}Width`]:'2px',[`border${side}Style`]:'outset',[`border${side}Color`]:'rgb(118, 118, 118)'});
  for(const node of [native,solid,colored,inline,custom])node.computed={...paint};
  for(const side of ['Top','Right','Bottom','Left']) {solid.computed[`border${side}Style`]='solid';colored.computed[`border${side}Color`]='rgb(255, 0, 0)';}
  custom.computed.appearance='none';
  h.api.enable({background:'#000000'});h.flush();
  const css=h.styles.map(style=>style.textContent).filter(Boolean).join('\n');
  assert.ok(css.includes(`[data-brave-media-control-boundary="${native.getAttribute('data-brave-media-control-boundary')}"]{border-style:solid!important;border-color:rgba(160,160,160,.35)!important}`));
  for(const node of [solid,colored,inline,custom])assert.equal(css.includes(`[data-brave-media-control-boundary="${node.getAttribute('data-brave-media-control-boundary')}"]{border-style:solid`),false);
  for(let n=0;n<3;n++){h.api.refresh();h.flush();}assert.equal(native.computed.borderTopWidth,'2px');
  native.computed.borderTopColor='rgb(255, 0, 0)';h.api.refresh();h.flush();
  assert.equal(h.styles.some(style=>style.textContent?.includes('border-style:solid!important')),false,'changed source edge releases normalization');
  h.api.disable();assert.equal(native.getAttribute('data-brave-media-control-boundary'),null);
});
test('fractional browser scales recognize snapped native bevels while preserving nondefault border widths',()=>{
  for(const [dpr,width] of [[1,2],[1.25,1.6],[1.484375,1.34737],[1.85546875,1.61684],[2.375,1.68421]]) {
    const h=controlHarness(),input=h.element('input'),button=h.element('button',{},'Default'),other=h.element('button',{},'Different');
    h.scope.devicePixelRatio=dpr;
    const paint={display:'block',visibility:'visible',opacity:'1',backgroundImage:'none',backgroundColor:'rgb(0, 0, 0)',appearance:'auto'};
    for(const side of ['Top','Right','Bottom','Left'])Object.assign(paint,{[`border${side}Width`]:`${width}px`,[`border${side}Style`]:'inset',[`border${side}Color`]:'rgb(115, 115, 115)'});
    input.computed={...paint};button.computed={...paint};other.computed={...paint};
    for(const side of ['Top','Right','Bottom','Left']) {button.computed[`border${side}Style`]='outset';other.computed[`border${side}Width`]='2.4px';}
    h.api.enable({background:'#000000'});h.flush();
    const css=h.styles.map(style=>style.textContent).filter(Boolean).join('\n');
    for(const node of [input,button])assert.ok(css.includes(`[data-brave-media-control-boundary="${node.getAttribute('data-brave-media-control-boundary')}"]{border-style:solid!important`),`native control at DPR ${dpr}`);
    assert.equal(css.includes(`[data-brave-media-control-boundary="${other.getAttribute('data-brave-media-control-boundary')}"]{border-style:solid`),false);
    assert.equal(input.computed.borderTopWidth,`${width}px`,'normalization preserves the actual snapped layout width');
    h.api.disable();assert.equal(input.getAttribute('data-brave-media-control-boundary'),null);
  }
});
test('structural headers and presentation tab backings own one opaque palette canvas without coloring actions status glyphs or media',()=>{
  const h=controlHarness(),header=h.element('div',{},'Navigation'),search=h.element('div',{},'Search'),sticky=h.element('div',{},'Toolbar'),tile=h.element('li',{role:'presentation'},'Engage'),tab=h.element('a',{role:'tab'},'Engage'),icon=h.element('span'),action=h.element('button',{},'Send'),status=h.element('div',{role:'status'},'Warning'),child=h.element('section',{},'Warning detail'),photo=h.element('div',{},'Photo'),narrow=h.element('div',{},'Card'),short=h.element('div',{},'Stripe');
  const paint={display:'block',visibility:'visible',opacity:'1',position:'static',backgroundColor:'rgb(6, 66, 90)',backgroundImage:'none'};
  for(const node of h.nodes){node.computed={...paint};node.getBoundingClientRect=()=>({left:0,top:0,right:1000,bottom:78,width:1000,height:78});}
  search.computed.backgroundColor='rgba(6, 66, 90, 0.9)';
  sticky.computed.position='sticky';sticky.getBoundingClientRect=()=>({left:0,top:0,right:1000,bottom:56,width:1000,height:56});
  tile.getBoundingClientRect=()=>({left:0,top:0,right:225,bottom:180,width:225,height:180});tile.querySelector=selector=>selector==='[role~="tab"]'?tab:null;
  tab.parentElement=tile;icon.parentElement=tab;child.parentElement=status;
  photo.computed.backgroundImage='url("hero.jpg")';
  narrow.getBoundingClientRect=()=>({left:0,top:0,right:700,bottom:78,width:700,height:78});
  short.getBoundingClientRect=()=>({left:0,top:0,right:1000,bottom:31,width:1000,height:31});short.computed.position='fixed';
  header.setAttribute('data-brave-media-surface','authored');
  let updates=0;h.api.setBackdropChanged(()=>updates++);h.api.enable({background:'#000000'});h.flush();
  for(const node of [header,search,sticky,tile])assert.equal(h.api.isSurface(node),true,node.textContent);
  for(const node of [tab,icon,action,status,child,photo,narrow,short])assert.equal(h.api.isSurface(node),false,node.localName);
  assert.equal(h.api.isSurface(null),false);assert.equal(h.api.isSurface(undefined),false);
  const marker=header.getAttribute('data-brave-media-surface');assert.ok(marker.startsWith('bm-'));
  assert.ok(h.styles.some(style=>style.textContent?.includes('background-color:#000000!important')));
  assert.equal(h.api.ownsMutation({type:'attributes',target:header,attributeName:'data-brave-media-surface'}),true);
  assert.ok(updates>=1,'new opaque ownership republishes fresh occlusion geometry');
  header.setAttribute('data-brave-media-surface','foreign');assert.equal(h.api.isSurface(header),false,'marker ownership is positive proof');
  h.api.refresh();h.flush();assert.equal(h.api.isSurface(header),true);
  header.isConnected=false;assert.equal(h.api.isSurface(header),false);header.isConnected=true;
  search.computed.backgroundColor='rgba(0, 0, 0, 0)';h.api.refresh();h.flush();assert.equal(h.api.isSurface(search),false,'authored transparent surface releases the canvas');
  h.api.disable();assert.equal(header.getAttribute('data-brave-media-surface'),'authored');assert.equal(tile.getAttribute('data-brave-media-surface'),null);assert.equal(h.api.isSurface(header),false);
  assert.equal(search.computed.backgroundColor,'rgba(0, 0, 0, 0)');assert.equal(photo.computed.backgroundImage,'url("hero.jpg")');
});
test('icon-only semantic buttons lose resting edges while text buttons and native controls retain them',()=>{
  const h=controlHarness();
  const icon=h.element('div',{role:'button','aria-label':'Search'});icon.setAttribute('data-brave-media-icon-button','authored');
  const artworkIcon=h.element('button');artworkIcon.querySelector=()=>({localName:'svg'});
  const text=h.element('button',{'aria-label':'Add'},'Add');
  const native=h.element('input',{'aria-label':'Submit',role:'button'});native.type='submit';
  const unknown=h.element('div',{role:'button'});
  h.api.enable();h.flush();
  assert.equal(icon.getAttribute('data-brave-media-icon-button'),'true');
  assert.equal(artworkIcon.getAttribute('data-brave-media-icon-button'),'true');
  assert.equal(text.getAttribute('data-brave-media-icon-button'),null);
  assert.equal(native.getAttribute('data-brave-media-icon-button'),null);
  assert.equal(unknown.getAttribute('data-brave-media-icon-button'),null);
  const css=h.calls.at(-1).fixes.css;
  assert.ok(css.includes(':not(:where([data-brave-media-icon-button]))'));
  assert.ok(css.indexOf('outline:none!important')<css.indexOf('background-color:#101010!important;color:#eeeeee!important'));
  assert.equal(h.api.ownsMutation({type:'attributes',target:icon,attributeName:'data-brave-media-icon-button'}),true);
  icon.textContent='Search';h.api.refresh();h.flush();assert.equal(icon.getAttribute('data-brave-media-icon-button'),'authored');
  h.api.disable();assert.equal(artworkIcon.getAttribute('data-brave-media-icon-button'),null);
});
test('custom hidden-native checkbox gets an owned square pseudo indicator with reversible checked state',()=>{
  const h=controlHarness(),input=h.element('input'),label=h.element('label');input.type='checkbox';input.checked=false;
  input.getBoundingClientRect=()=>({left:-9700,top:0,right:-9699,bottom:1,width:1,height:1});
  label.control=input;label['::before']={content:'""',backgroundImage:'url("authored-control.png")',width:'20px',height:'20px',opacity:'.7'};
  label.setAttribute('data-brave-media-check-indicator','authored');
  h.api.enable({accent:'#ffcc66'});h.flush();
  assert.equal(label.getAttribute('data-brave-media-check-indicator'),'before-checkbox-unchecked');
  const css=h.calls.at(-1).fixes.css;assert.ok(css.includes('before-checkbox-checked'));assert.ok(css.includes('background-color:#ffcc66!important'));
  assert.ok(css.includes('box-shadow:inset 0 0 0 1px #b8b8b8!important;opacity:1!important'));
  assert.equal(css.includes('filter:'),false);assert.equal(label['::before'].backgroundImage,'url("authored-control.png")');
  input.checked=true;h.events.change({type:'change',target:input});h.flush();
  assert.equal(label.getAttribute('data-brave-media-check-indicator'),'before-checkbox-checked');
  input.checked=false;h.events.change({type:'change',target:input});h.flush();assert.equal(label.getAttribute('data-brave-media-check-indicator'),'before-checkbox-unchecked');
  h.api.disable();assert.equal(label.getAttribute('data-brave-media-check-indicator'),'authored');
});
test('control classification excludes visible native checks, unrelated pictures and oversized label artwork',()=>{
  const h=controlHarness(),input=h.element('input'),visible=h.element('label'),hidden=h.element('input'),large=h.element('label'),unrelated=h.element('label');
  input.type='checkbox';visible.control=input;
  const small={content:'""',backgroundImage:'url("image.png")',width:'20px',height:'20px'};
  visible['::before']=small;unrelated['::before']=small;
  hidden.type='radio';hidden.getBoundingClientRect=()=>({left:0,top:0,right:1,bottom:1,width:1,height:1});large.control=hidden;
  large['::before']={...small,width:'96px',height:'96px'};
  h.api.enable();h.flush();
  for(const label of [visible,large,unrelated])assert.equal(label.getAttribute('data-brave-media-check-indicator'),null);
  large['::before']={...small,width:'16px',height:'16px'};h.api.refresh();h.flush();
  assert.equal(large.getAttribute('data-brave-media-check-indicator'),'before-radio-unchecked');
  h.nodes.splice(h.nodes.indexOf(large),1);
  h.observers[0].callback([{type:'childList',target:h.scope.document,addedNodes:[],removedNodes:[large]}]);
  h.api.refresh();h.flush();assert.equal(large.getAttribute('data-brave-media-check-indicator'),null);
});
test('native PDF MIME disables page adaptation without relying on URL or inspectable guest DOM',()=>{
  const h=harness();h.scope.document.contentType='application/pdf';
  assert.equal(h.api.enable({background:'#000000'}),false);
  h.flush();assert.equal(h.calls.length,0);assert.equal(h.api.isEnabled(),false);assert.equal(h.styles.length,0);
  h.api.setPalette({foreground:'#ffffff'});assert.equal(h.calls.length,0);
  h.scope.document.contentType='text/html';assert.equal(h.api.enable(),true);h.flush();assert.equal(h.calls.length,1);
  h.scope.document.contentType='APPLICATION/PDF; charset=binary';
  h.api.setPalette({background:'#111111'});h.flush();assert.equal(h.api.isEnabled(),false);assert.equal(h.calls.length,1);assert.equal(h.styles.length,0);
});

test('compact filled rounded inline anchor receives reversible button states while prose and media cards do not',()=>{
  const h=controlHarness(),cta=h.element('a',{href:'/jobs'},'Search jobs');
  cta.computed={display:'inline-flex',paddingLeft:'20px',paddingRight:'20px',borderRadius:'34px',backgroundColor:'rgb(0, 0, 0)',backgroundImage:'none'};
  cta.getBoundingClientRect=()=>({left:20,top:20,right:129,bottom:63,width:109,height:43});
  cta.setAttribute('data-brave-media-compact-button','authored');
  const prose=h.element('a',{href:'/article'},'Read more');prose.computed={...cta.computed,display:'inline'};
  const card=h.element('a',{href:'/photo'},'Photo');card.computed=cta.computed;card.getBoundingClientRect=cta.getBoundingClientRect;card.querySelector=()=>({localName:'img'});
  const emptyFill=h.element('a',{href:'/next'},'Next');emptyFill.computed={...cta.computed,backgroundColor:'rgba(0, 0, 0, 0)'};emptyFill.getBoundingClientRect=cta.getBoundingClientRect;
  h.api.enable();h.flush();
  assert.equal(cta.getAttribute('data-brave-media-compact-button'),'true');
  for(const link of [prose,card,emptyFill])assert.equal(link.getAttribute('data-brave-media-compact-button'),null);
  assert.ok(h.calls.at(-1).fixes.css.includes('[data-brave-media-compact-button]'));
  assert.equal(h.api.ownsMutation({type:'attributes',target:cta,attributeName:'data-brave-media-compact-button'}),true);
  cta.computed.paddingLeft='0px';h.api.refresh();h.flush();assert.equal(cta.getAttribute('data-brave-media-compact-button'),'authored');
  cta.computed.paddingLeft='20px';h.api.refresh();h.flush();h.api.disable();assert.equal(cta.getAttribute('data-brave-media-compact-button'),'authored');
});

test('expanded ARIA popup owns outer panel and removes duplicate nested role boundary reversibly',()=>{
  const h=controlHarness(),owner=h.element('button',{'aria-expanded':'true','aria-haspopup':'listbox','aria-controls':'panel'}),panel=h.element('div',{id:'panel','aria-hidden':'false'}),list=h.element('div',{role:'listbox'});
  panel.querySelector=()=>list;panel.setAttribute('data-brave-media-popup-panel','authored');
  const accordion=h.element('button',{'aria-expanded':'true','aria-controls':'section'}),section=h.element('div',{id:'section'});
  h.api.enable();h.flush();
  assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'true');assert.equal(section.getAttribute('data-brave-media-popup-panel'),null);
  const css=h.calls.at(-1).fixes.css;
  assert.ok(css.includes(':not(:where([data-brave-media-popup-panel] *))'));
  assert.ok(css.includes('outline:1px solid rgba(160,160,160,.35)!important;outline-offset:0!important'));
  owner.setAttribute('aria-expanded','false');h.api.refresh();h.flush();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'authored');
  owner.setAttribute('aria-expanded','true');h.api.refresh();h.flush();h.api.disable();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'authored');
});


test('neutral text-shadow halo follows canvas while offsets alpha and colored effects remain intact',()=>{
  const policy=engine().scope.DarkReader.policy;
  const halo=policy.getShadowModifier('rgba(199, 207, 213, 0.6) 1px 0px 10px', 'text-shadow');
  assert.equal(halo({...palette,darkSchemeBackgroundColor:'#000000'}),'rgba(0, 0, 0, 0.6) 1px 0px 10px');
  assert.equal(halo({...palette,darkSchemeBackgroundColor:'#101010'}),'rgba(16, 16, 16, 0.6) 1px 0px 10px');
  const neon={r:255,g:0,b:160,a:.7};
  assert.equal(policy.modifyShadowColor(neon,palette,'text-shadow'),policy.modifyShadowColor(neon,palette,'box-shadow'),'colored text effects retain upstream shadow treatment');
  const nearNeutral={r:199,g:207,b:213,a:.6};
  assert.notEqual(policy.modifyShadowColor(nearNeutral,palette,'box-shadow'),'rgba(16, 16, 16, 0.6)','box-shadow behavior is unchanged');
  assert.equal(policy.getShadowModifier('rgba(220,220,220,0) -1.5px 2px 3px, red 0px 0px 5px','text-shadow')(palette).startsWith('rgba(16, 16, 16, 0) -1.5px 2px 3px,'),true);
});


test('retired controller disposal is idempotent and never disables a replacement engine',()=>{
  const h=harness(),retired=h.api,oldEngine=h.scope.DarkReader;
  let oldDisabled=0,newDisabled=0;
  const oldDisable=oldEngine.disable;oldEngine.disable=()=>{oldDisabled++;oldDisable();};
  retired.enable();retired.dispose();assert.equal(oldDisabled,1);
  h.scope.DarkReader={isEnabled:()=>true,disable:()=>newDisabled++};
  retired.dispose();retired.disable();assert.equal(oldDisabled,1);assert.equal(newDisabled,0);
});

test('controller uses its captured engine even if the global API changes before first disposal',()=>{
  const h=harness(),old=h.scope.DarkReader;let calls=0;
  h.api.enable();const disable=old.disable;old.disable=()=>{calls++;disable();};
  h.scope.DarkReader={isEnabled:()=>true,disable:()=>{throw Error('replacement engine was touched');}};
  h.api.dispose();assert.equal(calls,1);
});


test('shared CSS variable adapts independently for neutral text shadow and background with aliases and fallback',()=>{
  const p=engine().scope.DarkReader.policy,store=new p.VariablesStore();
  store.inspectVarDependant('text-shadow','var(--ltGray) 1px 0 10px');
  store.inspectVarDependant('background-color','var(--ltGray)');
  const declared=store.getModifierForVariable({varName:'--ltGray',sourceValue:'rgb(199,207,213)',rule:{selectorText:'.fixture'},ignoredImgSelectors:[],isCancelled:()=>false})(palette).declarations;
  const shadow=declared.find(item=>item.property==='--darkreader-text-shadow--ltGray');
  const bg=declared.find(item=>item.property==='--darkreader-bg--ltGray');
  assert.equal(shadow.value,'rgb(16, 16, 16)');assert.ok(bg);assert.notEqual(shadow.value,bg.value);
  const modified=store.getModifierForVarDependant('text-shadow','var(--ltGray) 1px 0 10px',{})(palette);
  assert.equal(modified,'var(--darkreader-text-shadow--ltGray) 1px 0 10px');
  assert.equal(store.getModifierForVarDependant('text-shadow','var(--missing, rgba(199,207,213,.6)) -1px 0px 8px',{})(palette),'var(--darkreader-text-shadow--missing, rgba(16, 16, 16, 0.6)) -1px 0px 8px');
  const alias=store.getModifierForVariable({varName:'--ltGray',sourceValue:'var(--base)',rule:{selectorText:'.fixture'},ignoredImgSelectors:[],isCancelled:()=>false})(palette).declarations.find(item=>item.property===shadow.property);
  assert.equal(alias.value,'var(--darkreader-text-shadow--base)');
});


test('retired isolated vendor instance stops its observers without deleting a foreign owner DOM',()=>{
  const start=vendorSource.indexOf('    function removeDynamicTheme() {'),end=vendorSource.indexOf('    function cleanDynamicThemeCache()',start);
  const order=[],owner={content:'replacement'};
  const scope={document:{querySelector:()=>owner,documentElement:{removeAttribute(){throw Error('foreign attributes removed');}}},INSTANCE_ID:'retired',cleanDynamicThemeCache:()=>order.push('local-cache'),metaObserver:{disconnect:()=>order.push('local-meta')},cleaners:[()=>order.push('local-cleaner')]};
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);scope.removeDynamicTheme();
  assert.deepEqual(order,['local-cache','local-meta','local-cleaner']);assert.equal(scope.cleaners.length,0);
});

test('instance takeover establishes its marker before publishing the replacement styles',()=>{
  const start=vendorSource.indexOf('        const ready = () => {',vendorSource.indexOf('    function createOrUpdateDynamicThemeInternal(')),end=vendorSource.indexOf('        if (document.head)',start);
  let owner='retired';const order=[];
  const scope={theme:{mode:1},document:{documentElement:{setAttribute(){order.push('attribute');}}},isDRLocked:()=>false,isAnotherDarkReaderInstanceActive:()=>{if(owner==='retired')return true;owner='replacement';order.push('marker');return false;},interceptOldScript:({success})=>{owner=null;order.push('retired-cleaned');success();},createThemeAndWatchForUpdates:()=>{assert.equal(owner,'replacement');order.push('styles');},removeDynamicTheme:()=>{throw Error('takeover failed');}};
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end)+'ready();',scope);
  assert.deepEqual(order,['retired-cleaned','marker','attribute','attribute','styles']);
});


test('only owned interception locks stop engine; authored opt-out is preserved and ignored',()=>{
  const start=vendorSource.indexOf('    const OWNED_LOCK_SELECTOR'),end=vendorSource.indexOf('    function disableConflictingPlugins()',start);
  const authored={name:'darkreader-lock',content:'authored'},appended=[],removed=[];let callback,stopped=0,lock;
  const doc={head:{querySelector:()=>({content:'retired'}),append:node=>{lock=node;appended.push(node);}},querySelector:selector=>selector.includes('[data-brave-media-lock]')?(lock&&!removed.includes(lock)?lock:null):authored,createElement:()=>({attributes:{},setAttribute(name,value){this.attributes[name]=value;},remove(){removed.push(this);}})};
  const queued=[],scope={document:doc,INSTANCE_ID:'replacement',removeDynamicTheme:()=>stopped++,queueMicrotask:fn=>queued.push(fn),MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){}}};
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);
  assert.equal(scope.isDRLocked(),false);scope.addMetaListener();callback();assert.equal(stopped,0);
  let accepted=0;scope.interceptOldScript({success:()=>accepted++,failure:()=>{throw Error('takeover failed');}});
  assert.equal(appended[0].name,'darkreader-lock');assert.equal(appended[0].attributes['data-brave-media-lock'],'replacement');
  assert.equal(scope.isDRLocked(),true);callback();assert.equal(stopped,1);
  queued.shift()();assert.equal(accepted,1);assert.equal(scope.isDRLocked(),false);assert.equal(authored.content,'authored');assert.deepEqual(removed,appended);
});


test('bounded elevated multi-action popup gets reversible outer ownership without structural or media panels',()=>{
  const h=controlHarness(),actions=[h.element('a',{href:'#a'},'Upload'),h.element('a',{href:'#b'},'Live')];
  const make=(attrs={},extra={})=>{
    const el=h.element('x-popup',attrs);el.computed={position:'fixed',zIndex:'2202',display:'block',visibility:'visible',opacity:'1'};
    el.getBoundingClientRect=()=>({width:177,height:96});
    el.querySelectorAll=selector=>['svg','img,video,canvas,object,embed,iframe'].includes(selector)?[]:actions;Object.assign(el,extra);return el;
  };
  const panel=make();panel.setAttribute('data-brave-media-popup-panel','authored');
  const nested=make({}, {parentElement:panel});
  const plain=make();plain.computed.position='static';
  const viewport=make({}, {getBoundingClientRect:()=>({width:1000,height:800})});
  const tooltip=make({role:'tooltip'}),navigation=make({role:'navigation'});
  const art=make({}, {querySelectorAll:selector=>selector==='img,video,canvas,object,embed,iframe'?[Object.assign(h.element('img',{src:'photo.png'}),{getBoundingClientRect:()=>({width:100,height:80})})]:selector==='svg'?[]:actions});
  const lone=make({}, {querySelectorAll:selector=>['svg','img,video,canvas,object,embed,iframe'].includes(selector)?[]:[actions[0]]});
  h.api.enable();h.flush();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'true');
  for(const el of [nested,plain,viewport,tooltip,navigation,art,lone])assert.equal(el.getAttribute('data-brave-media-popup-panel'),null);
  panel.computed.display='none';h.api.refresh();h.flush();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'authored');
  panel.computed.display='block';h.api.refresh();h.flush();h.api.disable();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'authored');
});


test('unlabelled popup recognizes source-less role links but ignores zero-size and hidden image placeholders',()=>{
  const h=controlHarness(),panel=h.element('x-dropdown'),link=h.element('a',{role:'link'}),second=h.element('a',{role:'link'}),empty=h.element('img'),hidden=h.element('img',{src:'hidden.png'});
  empty.getBoundingClientRect=()=>({width:0,height:0});hidden.computed={visibility:'hidden'};
  panel.computed={position:'fixed',zIndex:'2202',display:'block',visibility:'visible',opacity:'1'};panel.getBoundingClientRect=()=>({width:176.7,height:96});
  panel.querySelectorAll=selector=>selector==='svg'?[]:selector==='img,video,canvas,object,embed,iframe'?[empty,hidden]:[link,second];
  h.api.enable();h.flush();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),'true');
  hidden.computed.visibility='visible';h.api.refresh();h.flush();assert.equal(panel.getAttribute('data-brave-media-popup-panel'),null);
});


function glyphHarness() {
  const h=controlHarness(),glyph=h.element('div',{'aria-hidden':'true'});
  glyph.source={display:'block',visibility:'visible',opacity:'1',filter:'none',maskImage:'none',backgroundImage:'url("https://fixture.test/arrow.png")',backgroundColor:'rgba(0, 0, 0, 0)',backgroundSize:'20px 20px',backgroundPosition:'50% 50%',backgroundRepeat:'no-repeat'};
  glyph.computed=glyph.source;glyph.setAttribute('data-brave-media-control-glyph','authored');
  h.scope.URL=URL;h.scope.document.baseURI='https://fixture.test/';let loaded=0,accept;
  h.scope.MediaGlyphs={isControlGlyph:node=>node===glyph,isDarkSvgGlyph:()=>true,loadDarkGlyph:()=>{loaded++;return new Promise(resolve=>accept=resolve);}};
  return Object.assign(h,{glyph,loaded:()=>loaded,resolve:value=>accept(value)});
}
test('proven PNG glyph owns alpha-only palette paint reversibly and notifies media after stylesheet publication',async()=>{
  const h=glyphHarness(),notifications=[];h.api.setBackdropChanged(()=>notifications.push(h.styles.map(style=>style.textContent).join('')));
  h.api.enable({foreground:'#e6e6e6'});h.flush();assert.equal(h.api.isControlGlyph(h.glyph),false);assert.equal(h.loaded(),1);
  h.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(h.api.isControlGlyph(h.glyph),true);assert.equal(notifications.length,1);
  assert.ok(notifications[0].includes('mask-image:url("https://fixture.test/arrow.png")'));assert.ok(notifications[0].includes('background-color:#e6e6e6!important'));
  assert.ok(notifications[0].includes('mask-size:20px 20px'));assert.equal(notifications[0].includes('filter:'),false);
  h.api.refresh();h.flush();assert.equal(h.loaded(),1);assert.equal(h.api.isControlGlyph(h.glyph),true);
  assert.equal(h.api.ownsMutation({type:'attributes',target:h.glyph,attributeName:'data-brave-media-control-glyph'}),true);
  h.api.disable();assert.equal(h.glyph.getAttribute('data-brave-media-control-glyph'),'authored');assert.equal(h.api.isControlGlyph(h.glyph),false);
});
test('unknown or stale glyph analysis never recolors content after source change OFF or detach',async()=>{
  for(const outcome of ['unknown','source','off','detach']) {
    const h=glyphHarness();h.api.enable();h.flush();
    if(outcome==='source')h.glyph.source.backgroundImage='url("https://fixture.test/photo.png")';
    if(outcome==='off')h.api.disable();if(outcome==='detach')h.glyph.isConnected=false;
    h.resolve(outcome!=='unknown');await Promise.resolve();await Promise.resolve();
    assert.equal(h.api.isControlGlyph(h.glyph),false,outcome);assert.equal(h.glyph.getAttribute('data-brave-media-control-glyph'),'authored',outcome);
  }
});
test('SVG glyph repeated refresh reads authored filter and retains exact ownership until OFF',()=>{
  const h=glyphHarness();h.glyph.localName='svg';h.glyph.source.backgroundImage='none';
  h.scope.MediaGlyphs.isDarkSvgGlyph=(node,rect,readStyle)=>readStyle(node).filter==='none';
  h.scope.getComputedStyle=node=>({...node.source,filter:h.styles.some(style=>!style.sheet.disabled&&style.textContent?.includes('brightness(0)'))?'brightness(0) invert(1)':'none'});
  h.api.enable();h.flush();const marker=h.glyph.getAttribute('data-brave-media-control-glyph');
  assert.equal(h.api.isControlGlyph(h.glyph),true);
  for(let n=0;n<3;n++){h.api.refresh();h.flush();assert.equal(h.api.isControlGlyph(h.glyph),true);assert.equal(h.glyph.getAttribute('data-brave-media-control-glyph'),marker);}
  h.api.disable();assert.equal(h.glyph.getAttribute('data-brave-media-control-glyph'),'authored');
});

test('SVG proof and artwork source capture share one generated-sheet scope across shadow roots',()=>{
  const h=harness({artwork:true,shadow:true}),button=h.scope.document.createElement('button');
  const glyph=h.scope.document.createElement('svg'),smallArtwork=h.scope.document.createElement('svg');
  for(const node of [glyph,smallArtwork]) {
    node.parentElement=button;node.getBoundingClientRect=()=>({width:20,height:20});
  }
  glyph.sourceColor='rgb(20, 20, 20)';smallArtwork.sourceColor='rgb(220, 30, 40)';
  glyph.setAttribute('data-brave-media-control-glyph','source-glyph');
  h.svg.setAttribute('data-brave-media-artwork','source-artwork');
  h.shadowRoot.querySelectorAll=selector=>selector==='svg'?[h.svg,glyph,smallArtwork]:selector==='*'?[h.svg,h.child,button,glyph,smallArtwork]:h.styles.filter(style=>style.root===h.shadowRoot);
  const read=h.scope.getComputedStyle;
  h.scope.getComputedStyle=node=>({...read(node),display:'block',visibility:'visible',opacity:'1',filter:'none',maskImage:'none',backgroundImage:'none',backgroundColor:'rgba(0, 0, 0, 0)',fill:read(node).color,stroke:'none'});
  vm.runInNewContext(readFileSync(new URL('./extension/media.js',import.meta.url),'utf8'),h.scope);
  h.api.enable();h.flush();
  assert.equal(h.api.isControlGlyph(glyph),true,'inherited authored dark ink proves the action glyph');
  assert.equal(h.api.isControlGlyph(smallArtwork),false,'small colored artwork remains protected');
  const engineSheet=h.styles.find(style=>style.isDark()&&!style.getAttribute('data-brave-media-theme-style')).sheet;
  const artworkSheet=h.styles.find(style=>style.textContent?.includes('source-artwork')).sheet;
  const transitions=new Map();
  for(const sheet of [engineSheet,artworkSheet]) {
    let disabled=sheet.disabled;transitions.set(sheet,[]);
    Object.defineProperty(sheet,'disabled',{get:()=>disabled,set(value){if(value!==disabled)transitions.get(sheet).push(value);disabled=value;}});
  }
  h.svg.sourceColor='rgb(40, 50, 60)';h.api.refresh();h.flush();
  assert.deepEqual(transitions.get(engineSheet),[true,false],'all generated color rules are disabled only once per refresh');
  assert.deepEqual(transitions.get(artworkSheet),[true,false],'artwork protection shares that same source scope');
  assert.equal(h.api.isControlGlyph(glyph),true);assert.equal(h.api.isControlGlyph(smallArtwork),false);
  assert.ok(h.styles.some(style=>style.textContent?.includes('color:rgb(40, 50, 60)!important')));
  assert.ok(h.styles.some(style=>style.textContent?.includes('color:rgb(220, 30, 40)!important')));
  assert.ok(h.styles.every(style=>!style.sheet.disabled),'publication restores every generated sheet');
  engineSheet.disabled=true;transitions.get(engineSheet).length=0;
  h.api.refresh();h.flush();assert.deepEqual(transitions.get(engineSheet),[],'an already disabled engine sheet keeps its exact prior state');
  assert.equal(engineSheet.disabled,true);assert.equal(artworkSheet.disabled,false);
  engineSheet.disabled=false;
  h.api.disable();assert.equal(glyph.getAttribute('data-brave-media-control-glyph'),'source-glyph');
  assert.equal(h.svg.getAttribute('data-brave-media-artwork'),'source-artwork');
  assert.equal(smallArtwork.getAttribute('data-brave-media-artwork'),null);
});

test('removing the final SVG releases glyph ownership without opening an authored-style scope',()=>{
  const h=glyphHarness();h.glyph.localName='svg';h.glyph.source.backgroundImage='none';
  h.api.enable();h.flush();assert.equal(h.api.isControlGlyph(h.glyph),true);
  const engineSheet=h.styles.find(style=>style.isDark()&&!style.getAttribute('data-brave-media-theme-style')).sheet;
  let resets=0,disabled=engineSheet.disabled;
  Object.defineProperty(engineSheet,'disabled',{get:()=>disabled,set(value){if(value!==disabled)resets++;disabled=value;}});
  h.nodes.splice(h.nodes.indexOf(h.glyph),1);h.glyph.isConnected=false;
  h.api.refresh();h.flush();
  assert.equal(h.api.isControlGlyph(h.glyph),false);
  assert.equal(h.glyph.getAttribute('data-brave-media-control-glyph'),'authored');
  assert.equal(resets,0,'no remaining SVG requires no document-wide sheet reset');
  h.api.disable();
});


test('visible page initializes immediately after bundle created hidden without waiting a lost visibility event',()=>{
  const start=vendorSource.indexOf('    function documentIsVisible() {'),end=vendorSource.indexOf('    function getDuration(',start);
  const scope={document:{hidden:false},documentIsVisible_:false};
  vm.createContext(scope);vm.runInContext(vendorSource.slice(start,end),scope);
  assert.equal(scope.documentIsVisible(),true);scope.document.hidden=true;assert.equal(scope.documentIsVisible(),false);
  scope.documentIsVisible_=true;assert.equal(scope.documentIsVisible(),true,'already-rendered hidden pages keep upstream eager update policy');
});


test('bare field inside close rounded visible single-field shell suppresses only redundant resting boundary reversibly',()=>{
  const h=controlHarness(),shell=h.element('div'),field=h.element('input'),standalone=h.element('input');
  field.type='search';field.parentElement=shell;field.setAttribute('data-brave-media-contained-field','authored');
  field.getBoundingClientRect=()=>({left:30,top:24,right:430,bottom:52,width:400,height:28});
  shell.getBoundingClientRect=()=>({left:10,top:10,right:610,bottom:66,width:600,height:56});
  shell.computed={display:'flex',visibility:'visible',opacity:'1',borderRadius:'28px'};
  for(const side of ['Top','Right','Bottom','Left'])Object.assign(shell.computed,{[`border${side}Width`]:'1px',[`border${side}Style`]:'solid',[`border${side}Color`]:'rgb(120,120,120)'});
  shell.querySelectorAll=()=>[field];h.api.enable();h.flush();
  assert.equal(field.getAttribute('data-brave-media-contained-field'),'true');assert.equal(standalone.getAttribute('data-brave-media-contained-field'),null);
  const css=h.calls.at(-1).fixes.css;assert.ok(css.includes(':not(:where([data-brave-media-contained-field]))'));assert.ok(css.includes(':focus-visible:not(:disabled)'));
  shell.computed.borderRadius='0px';h.api.refresh();h.flush();assert.equal(field.getAttribute('data-brave-media-contained-field'),'authored');
  shell.computed.borderRadius='28px';shell.querySelectorAll=()=>[field,standalone];h.api.refresh();h.flush();assert.equal(field.getAttribute('data-brave-media-contained-field'),'authored','multiple-field panels retain input boundary');
  shell.querySelectorAll=()=>[field];shell.getBoundingClientRect=()=>({left:10,top:10,right:610,bottom:310,width:600,height:300});h.api.refresh();h.flush();assert.equal(field.getAttribute('data-brave-media-contained-field'),'authored','large cards retain input boundary');
  shell.getBoundingClientRect=()=>({left:10,top:10,right:610,bottom:66,width:600,height:56});h.api.refresh();h.flush();h.api.disable();assert.equal(field.getAttribute('data-brave-media-contained-field'),'authored');
});

test('resized full fixed wallpaper layer retains partial-width image across repeated refresh then respects meaningful-media handoff',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();
  const full=()=>({left:0,top:0,right:1719,bottom:900,width:1719,height:900});
  for(const node of h.document.querySelectorAll('*'))if(node!==h.image&&node!==h.artwork)node.getBoundingClientRect=full;
  h.image.getBoundingClientRect=()=>({left:0,top:0,right:1440,bottom:900,width:1440,height:900});h.realm.innerWidth=1719;
  for(let n=0;n<3;n++){h.api.refresh();h.flush();assert.equal(h.api.isBackdrop(h.image),true);assert.equal(h.api.pendingBackdropMedia().length,0);assert.equal(h.computed(h.image).visibility,'hidden');}
  h.image.setAttribute('alt','Meaningful photo');h.api.refresh();h.flush();assert.equal(h.api.pendingBackdropMedia().length,1);assert.equal(h.computed(h.image).visibility,'hidden');
  h.api.acceptBackdropMedia(h.api.pendingBackdropMedia().map(entry=>({...entry,rect:entry.element.getBoundingClientRect()})));assert.equal(h.api.isBackdrop(h.image),false);assert.equal(h.computed(h.image).visibility,'visible');
});


test('selected plain label matching authored neutral control fill shares state canvas without erasing distinct fills or art',()=>{
  const h=controlHarness(),owner=h.element('button',{'aria-pressed':'true'}),label=h.element('span',{},'Selected'),distinct=h.element('span',{},'Badge'),art=h.element('span',{},'Picture'),nested=h.element('div',{},'Nested');
  label.parentElement=distinct.parentElement=art.parentElement=nested.parentElement=owner;
  label.setAttribute('data-brave-media-label-fill','authored');
  owner.computed={backgroundColor:'rgb(221, 221, 221)',backgroundImage:'none'};
  label.computed={backgroundColor:'rgb(221, 221, 221)',backgroundImage:'none'};
  distinct.computed={backgroundColor:'rgb(180, 180, 180)',backgroundImage:'none'};
  art.computed={backgroundColor:'rgb(221, 221, 221)',backgroundImage:'url("badge.png")'};
  nested.querySelector=()=>({localName:'button'});nested.computed=label.computed;
  owner.querySelectorAll=selector=>selector==='span,div'?[label,distinct,art,nested]:[];
  h.api.enable();h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'true');
  for(const node of [distinct,art,nested])assert.equal(node.getAttribute('data-brave-media-label-fill'),null);
  assert.ok(h.calls.at(-1).fixes.css.includes('background-color:#101010!important'));assert.ok(h.calls.at(-1).fixes.css.includes('[data-brave-media-label-fill]'));
  const before=h.disabledWrites();for(let n=0;n<3;n++){h.api.refresh();h.flush();}assert.equal(h.disabledWrites(),before,'unchanged/typing refresh never disables generated page sheets');
  label.setAttribute('style','background-color:#bbb');label.computed.backgroundColor='rgb(187, 187, 187)';h.api.refresh();h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'authored');
  label.setAttribute('style','background-color:#ddd');label.computed.backgroundColor='rgb(221, 221, 221)';h.api.refresh();h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'true');
  label.computed.backgroundColor='rgb(255, 255, 255)';
  const authorStyle={nodeType:1,localName:'style',closest:()=>null};
  h.observers[0].callback([{type:'characterData',target:{nodeType:3,parentElement:authorStyle}}]);h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'authored','source stylesheet change invalidates cached neutral match');
  label.computed.backgroundColor='rgb(221, 221, 221)';let hovered=false;owner.matches=()=>hovered;
  hovered=true;h.events.pointerover({type:'pointerover',composedPath:()=>[label,owner]});h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'true');
  owner.setAttribute('aria-pressed','false');h.api.refresh();h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),'authored');
  owner.setAttribute('aria-pressed','true');h.api.refresh();h.flush();h.api.disable();assert.equal(label.getAttribute('data-brave-media-label-fill'),'authored');
});

test('retired isolated controller cannot remove replacement wallpaper ownership with a reused local counter',()=>{
  const h=wallpaperThemeHarness();h.image.setAttribute('data-brave-media-backdrop','authored \"source\"');h.api.enable();h.flush();const retired=h.api;
  const oldId=h.image.getAttribute('data-brave-media-backdrop');
  // Engine takeover removes old generated sheets while the old isolated
  // controller may still await its invalid-runtime retirement callback.
  for(const style of [...h.styles])style.remove();
  const nextRealm={...h.realm,BraveMediaTheme:undefined,SemanticTheme:undefined};
  vm.createContext(nextRealm);vm.runInContext(themeSource,nextRealm);
  const replacement=nextRealm.BraveMediaTheme;replacement.enable();h.flush();
  assert.equal(replacement.isBackdrop(h.image),true);
  assert.equal(h.computed(h.image).visibility,'hidden');
  retired.disable();
  assert.equal(replacement.isBackdrop(h.image),true);
  assert.equal(h.computed(h.image).visibility,'hidden','late old cleanup cannot reveal a replacement-owned wallpaper');
  assert.notEqual(h.image.getAttribute('data-brave-media-backdrop'),oldId);
  replacement.disable();assert.equal(h.image.getAttribute('data-brave-media-backdrop'),'authored \"source\"');
});

test('authored CSSOM source notification refreshes semantic artwork and retires its subscription on dispose',()=>{
  const h=harness({artwork:true,sourceChanges:true});h.api.enable();h.flush();h.svg.sourceColor='rgb(12, 34, 56)';
  h.sourceChange();h.flush();assert.ok(h.styles.some(style=>style.textContent?.includes('rgb(12, 34, 56)')));
  h.api.dispose();assert.equal(h.hasSourceListener(),false);
});

test('authored CSSOM changes invalidate cached matching label fills without rebuilding the element inventory',()=>{
  const h=controlHarness({sourceChanges:true}),owner=h.element('button',{'aria-pressed':'true'}),label=h.element('span',{},'Selected');
  label.parentElement=owner;owner.querySelectorAll=selector=>selector==='span,div'?[label]:[];
  owner.computed={backgroundColor:'rgb(221, 221, 221)',backgroundImage:'none'};label.computed={...owner.computed};
  let enumerations=0;const query=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>{if(selector==='*')enumerations++;return query(selector);};
  h.api.enable();h.flush();enumerations=0;
  assert.equal(label.getAttribute('data-brave-media-label-fill'),'true');
  label.computed.backgroundColor='rgb(180, 180, 180)';h.sourceChange();h.flush();
  assert.equal(label.getAttribute('data-brave-media-label-fill'),null,'CSSOM source paint releases the stale neutral-fill proof');
  label.computed.backgroundColor='rgb(221, 221, 221)';h.sourceChange();h.flush();
  assert.equal(label.getAttribute('data-brave-media-label-fill'),'true');assert.equal(enumerations,0);
  h.api.disable();label.computed.backgroundColor='rgb(180, 180, 180)';h.sourceChange();h.flush();
  assert.equal(h.frames.length,0);assert.equal(label.getAttribute('data-brave-media-label-fill'),null);
  h.api.enable();h.flush();assert.equal(label.getAttribute('data-brave-media-label-fill'),null);
  h.api.dispose();assert.equal(h.hasSourceListener(),false);
});

test('retained semantic inventory still reads current text, geometry and source styles on text and attribute changes',()=>{
  const h=controlHarness(),anchor=h.element('a',{href:'/jobs'},'Search jobs');
  anchor.computed={display:'inline-flex',paddingLeft:'20px',paddingRight:'20px',borderRadius:'34px',backgroundColor:'rgb(0, 0, 0)',backgroundImage:'none'};
  let width=109;anchor.getBoundingClientRect=()=>({left:20,top:20,right:20+width,bottom:63,width,height:43});
  const unrelated=Array.from({length:20},()=>h.element('div'));
  let enumerations=0;const query=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>{if(selector==='*')enumerations++;return query(selector);};
  const reads=new Set(),computed=h.scope.getComputedStyle;
  h.scope.getComputedStyle=(node,pseudo)=>{reads.add(node);return computed(node,pseudo);};
  h.api.enable();h.flush();enumerations=0;reads.clear();
  assert.equal(anchor.getAttribute('data-brave-media-compact-button'),'true');
  anchor.textContent='A'.repeat(65);
  h.observers[0].callback([{type:'characterData',target:{nodeType:3,parentElement:anchor}}]);h.flush();
  assert.equal(anchor.getAttribute('data-brave-media-compact-button'),null,'text-dependent classification stays fresh');
  assert.ok(unrelated.every(node=>reads.has(node)),'layout-dependent styles elsewhere still receive source reads');
  anchor.textContent='Search jobs';width=321;h.api.refresh();h.flush();
  assert.equal(anchor.getAttribute('data-brave-media-compact-button'),null,'retaining element identity does not retain its bounds');
  width=109;h.api.refresh();h.flush();assert.equal(anchor.getAttribute('data-brave-media-compact-button'),'true');
  anchor.computed.paddingLeft='0px';anchor.setAttribute('class','unfilled');
  h.observers[0].callback([{type:'attributes',target:anchor,attributeName:'class'}]);h.flush();
  assert.equal(anchor.getAttribute('data-brave-media-compact-button'),null);assert.equal(enumerations,0);
});

test('structural semantic mutations replace the root inventory and OFF clears retained element references',()=>{
  const h=controlHarness(),first=h.element('button',{},'First');
  const paint={display:'block',visibility:'visible',opacity:'1',backgroundImage:'none',backgroundColor:'rgb(0, 0, 0)',borderBottomWidth:'1px',borderBottomStyle:'solid',borderBottomColor:'rgb(120, 120, 120)'};
  first.computed={...paint};let enumerations=0;const query=h.scope.document.querySelectorAll;
  h.scope.document.querySelectorAll=selector=>{if(selector==='*')enumerations++;return query(selector);};
  h.api.enable({background:'#000000'});h.flush();enumerations=0;
  const next=h.element('button',{},'Next');next.computed={...paint};
  h.observers[0].callback([{type:'childList',target:h.scope.document,addedNodes:[next],removedNodes:[]}]);h.flush();
  assert.equal(enumerations,1);assert.ok(next.getAttribute('data-brave-media-control-boundary'));
  h.nodes.splice(h.nodes.indexOf(first),1);first.isConnected=false;
  h.observers[0].callback([{type:'childList',target:h.scope.document,addedNodes:[],removedNodes:[first]}]);h.flush();
  assert.equal(enumerations,2);assert.equal(first.getAttribute('data-brave-media-control-boundary'),null);
  h.api.disable();h.nodes.splice(h.nodes.indexOf(next),1);next.isConnected=false;
  const replacement=h.element('button',{},'After OFF');replacement.computed={...paint};
  h.api.enable();h.flush();assert.equal(enumerations,3);assert.ok(replacement.getAttribute('data-brave-media-control-boundary'));
  assert.equal(next.getAttribute('data-brave-media-control-boundary'),null);
  h.api.dispose();const before=enumerations;h.api.refresh();h.flush();assert.equal(enumerations,before);
});

test('owned generated sheets are excluded from retained source nodes and do not invalidate the inventory',()=>{
  const h=controlHarness(),button=h.element('button',{},'Action'),owned=h.element('style',{'data-brave-media-theme-style':'style'});
  owned.closest=()=>owned;
  let enumerations=0;const query=h.scope.document.querySelectorAll,computed=h.scope.getComputedStyle;
  h.scope.document.querySelectorAll=selector=>{if(selector==='*')enumerations++;return query(selector);};
  h.scope.getComputedStyle=(node,pseudo)=>{assert.notEqual(node,owned,'ignored generated sheets are never retained as source nodes');return computed(node,pseudo);};
  h.api.enable();h.flush();enumerations=0;
  h.nodes.splice(h.nodes.indexOf(owned),1);
  h.observers[0].callback([{type:'childList',target:h.scope.document,addedNodes:[],removedNodes:[owned]}]);
  assert.equal(h.frames.length,0);h.api.refresh();h.flush();assert.equal(enumerations,0);
  h.nodes.push(owned);
  h.observers[0].callback([{type:'childList',target:h.scope.document,addedNodes:[owned],removedNodes:[]}]);
  assert.equal(h.frames.length,0);h.api.refresh();h.flush();assert.equal(enumerations,0);
  button.textContent='Changed';h.observers[0].callback([{type:'characterData',target:{nodeType:3,parentElement:button}}]);h.flush();
  assert.equal(enumerations,0);h.api.dispose();
});

test('retained hosts discover late open roots, refresh only a structurally changed root and release detached roots',()=>{
  const h=harness(),document=h.scope.document;let hosts=[h.host],documentQueries=0,shadowQueries=0;
  const documentQuery=document.querySelectorAll,shadowQuery=h.shadowRoot.querySelectorAll;
  document.querySelectorAll=selector=>{if(selector==='*'){documentQueries++;return hosts;}return documentQuery(selector);};
  h.shadowRoot.querySelectorAll=selector=>{if(selector==='*')shadowQueries++;return shadowQuery(selector);};
  h.api.enable();h.flush();documentQueries=0;
  h.host.shadowRoot=h.shadowRoot;h.api.discoverRoot(h.shadowRoot);h.flush();
  assert.equal(documentQueries,0);assert.equal(shadowQueries,2,'new roots capture ownership once and build their semantic inventory once');assert.ok(h.svg.getAttribute('data-brave-media-artwork'));
  const shadowObserver=h.observers.find(observer=>observer.root===h.shadowRoot),added=document.createElement('path');added.parentElement=h.svg;
  h.svg.querySelectorAll=()=>[h.child,added];
  h.shadowRoot.querySelectorAll=selector=>selector==='*'?(shadowQueries++,[h.svg,h.child,added]):shadowQuery(selector);
  shadowObserver.callback([{type:'childList',target:h.svg,addedNodes:[added],removedNodes:[]}]);h.flush();
  assert.equal(documentQueries,0);assert.equal(shadowQueries,3);assert.ok(added.getAttribute('data-brave-media-artwork'));
  hosts=[];h.shadowRoot.isConnected=false;
  h.observers.find(observer=>observer.root===document).callback([{type:'childList',target:document,addedNodes:[],removedNodes:[h.host]}]);h.flush();
  assert.equal(documentQueries,1);assert.equal(shadowObserver.disconnected,true);
  assert.equal(h.svg.getAttribute('data-brave-media-artwork'),null);assert.equal(added.getAttribute('data-brave-media-artwork'),null);
  assert.equal(h.styles.some(style=>style.root===h.shadowRoot),false);
  hosts=[h.host];h.shadowRoot.isConnected=true;
  h.observers.find(observer=>observer.root===document).callback([{type:'childList',target:document,addedNodes:[h.host],removedNodes:[]}]);h.flush();
  assert.equal(documentQueries,2);assert.equal(shadowQueries,5);
  assert.equal(h.observers.filter(observer=>observer.root===h.shadowRoot).length,2);assert.ok(added.getAttribute('data-brave-media-artwork'));
  h.api.dispose();assert.ok(h.observers.every(observer=>observer.disconnected));
});

test('semantic disposal notifies dependent content once after retirement and releases its legacy observers',()=>{
  const h=harness({artwork:true});h.api.enable();h.flush();let retired=0,unsubscribed=0;
  const remove=h.api.onDispose(()=>unsubscribed++);remove();
  h.api.onDispose(()=>{retired++;assert.equal(h.api.isEnabled(),false);h.api.dispose();});
  h.api.dispose();h.api.dispose();assert.equal(retired,1);assert.equal(unsubscribed,0);
  assert.ok(h.ownershipObservers.every(observer=>observer.disconnected));
  h.api.onDispose(()=>retired++);assert.equal(retired,2,'late dependents observe an already retired controller');
});

test('semantic media exclusions require their live ownership markers before suppressing protection',()=>{
  const h=wallpaperThemeHarness();h.api.enable();h.flush();assert.equal(h.api.isBackdrop(h.image),true);
  h.image.setAttribute('data-brave-media-backdrop','foreign');assert.equal(h.api.isBackdrop(h.image),false);
  const glyph=glyphHarness();glyph.glyph.localName='svg';glyph.glyph.source.backgroundImage='none';glyph.api.enable();glyph.flush();
  assert.equal(glyph.api.isControlGlyph(glyph.glyph),true);
  glyph.glyph.setAttribute('data-brave-media-control-glyph','foreign');assert.equal(glyph.api.isControlGlyph(glyph.glyph),false);
});


test('glyph eligibility rejects ordinary empty leaves before geometry and reuses the retained DOM inventory',()=>{
  const h=glyphHarness();let bounds=0,enumerations=0;
  for(let i=0;i<200;i++){const leaf=h.element('div');leaf.getBoundingClientRect=()=>{bounds++;return {width:20,height:20};};}
  const query=h.scope.document.querySelectorAll;h.scope.document.querySelectorAll=selector=>{if(selector==='*')enumerations++;return query(selector);};
  h.api.enable();h.flush();bounds=0;enumerations=0;
  h.api.refresh();h.flush();assert.equal(bounds,0);assert.equal(enumerations,0);
  assert.deepEqual(Object.keys(h.api.lastRefreshPhaseTimings()),['roots','controls','glyphs','backgrounds','artworkDiscovery','sourceCapture','publication']);
  h.api.disable();
});
test('authored glyph recapture disables only glyph stylesheet and preserves wallpaper hiding sheet',async()=>{
  const h=wallpaperThemeHarness();const glyph=h.artwork;
  glyph.setAttribute('role','presentation');glyph.setAttribute('aria-hidden','true');
  glyph.getBoundingClientRect=()=>({left:10,top:10,right:30,bottom:30,width:20,height:20});
  Object.assign(glyph.source,{filter:'none',maskImage:'none',backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'url("https://fixture.test/arrow.png")'});
  h.realm.URL=URL;h.document.baseURI='https://fixture.test/';
  h.realm.MediaGlyphs={isControlGlyph:node=>node===glyph,loadDarkGlyph:()=>Promise.resolve(true)};
  h.api.enable();h.flush();await Promise.resolve();await Promise.resolve();
  const glyphStyle=h.styles.find(style=>style.textContent?.includes('mask-image:')),wallpaperStyle=h.styles.find(style=>style.textContent?.includes('visibility:hidden'));
  assert.equal(glyphStyle.getAttribute('data-brave-media-theme-style'),'glyphStyle');assert.ok(wallpaperStyle);
  const read=h.realm.getComputedStyle;let inspected=0;
  h.realm.getComputedStyle=node=>{if(node===glyph){inspected++;assert.equal(wallpaperStyle.sheet.disabled,false);}return read(node);};
  h.api.refresh();h.flush();assert.ok(inspected>0);assert.equal(h.api.isControlGlyph(glyph),true);assert.equal(h.computed(h.image).visibility,'hidden');h.api.disable();
});
