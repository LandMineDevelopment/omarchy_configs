import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./extension/vendor/darkreader.js',import.meta.url),'utf8');
const boundary=source.slice(source.indexOf('    const sourceChangeListeners'),source.indexOf('    const STYLE_SELECTOR'));
const adopted=source.slice(source.indexOf('    function createAdoptedStyleSheetOverride('),source.indexOf('    const hostsBreakingOnStylePosition'));
function harness() {
  let now=1000,next=0,cancelled=0;const frames=new Map(),tasks=[];
  const scope={Date:{now:()=>now},requestAnimationFrame:callback=>{frames.set(++next,callback);return next;},cancelAnimationFrame:id=>{cancelled++;frames.delete(id);},queueMicrotask:callback=>tasks.push(callback),canUseSheetProxy:false,canUseSheetProxy$1:false,
    overrides$1:new WeakSet(),overridesBySource:new WeakMap(),getAdoptedSheets:node=>node.adoptedStyleSheets,defineSheetScope(){},forEach:(items,callback)=>items.forEach(callback),isFirefox:false};
  vm.runInNewContext(boundary+adopted+'\nglobalThis.policy={createSheetWatcher,createAdoptedStyleSheetOverride,subscribeSourceChanges,notifySourceChanges};',scope);
  const takeFrame=(ms=201)=>{now+=ms;const callbacks=[...frames.values()];frames.clear();return callbacks;};
  const frame=(ms=201)=>takeFrame(ms).forEach(callback=>callback());
  const flush=()=>{while(tasks.length)tasks.shift()();};
  return {scope,policy:scope.policy,tick(ms=201){frame(ms);flush();},frame,takeFrame,flush,stats:()=>({frames:frames.size,queued:tasks.length,requested:next,cancelled})};
}
function element() {
  const listeners=new Map();
  return {sheet:{},listeners,addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},removeEventListener(type,callback){listeners.get(type)?.delete(callback);},emit(type){for(const callback of [...(listeners.get(type)||[])])callback();}};
}
function adoptedManager(h,cssText='.card{background-image:none}') {
  const source={cssRules:[{cssText}]},override={cssRules:[{cssText:'#owned{}'}]},node=Object.assign(element(),{adoptedStyleSheets:[source]});
  h.scope.overrides$1.add(override);h.scope.overridesBySource.set(source,override);
  const manager=h.policy.createAdoptedStyleSheetOverride(node);manager.render({},[]);
  return {source,override,node,manager,render(){h.scope.overridesBySource.set(source,override);manager.render({},[]);}};
}
test('source stylesheet CSSOM same-count declaration changes and replacement notify once, stable rules do not',()=>{
  const h=harness(),rules=[{cssText:'.card{background-image:none}'}];let updates=0,notified=0;
  const unsubscribe=h.policy.subscribeSourceChanges(()=>notified++);
  const watcher=h.policy.createSheetWatcher(element(),()=>rules,()=>updates++,()=>false);watcher.start();
  h.tick();assert.equal(updates,0);assert.equal(notified,0);
  rules[0].cssText='.card{background-image:url(photo.png)}';h.tick();assert.equal(updates,1);assert.equal(notified,1);
  h.tick();assert.equal(notified,1);
  rules.splice(0,1,{cssText:'.other{background-image:url(replaced.png)}'});h.tick();assert.equal(notified,2);
  rules.push({cssText:'.new{color:red}'});h.tick(1);assert.equal(notified,3,'insertRule count change is immediate');
  unsubscribe();rules.pop();h.tick(1);assert.equal(notified,3);watcher.stop();
});
test('same-count imported source CSSOM changes propagate while unchanged source is coalesced',()=>{
  const h=harness(),imported=[{cssText:'.card{background-image:none}'}],rules=[{cssText:'@import "local.css";',styleSheet:{cssRules:imported}}];let notified=0;
  h.policy.subscribeSourceChanges(()=>notified++);const watcher=h.policy.createSheetWatcher(element(),()=>rules,()=>{},()=>false);watcher.start();
  imported[0].cssText='.card{background-image:url(import-photo.png)}';h.tick();assert.equal(notified,1);
  h.policy.notifySourceChanges();h.policy.notifySourceChanges();h.flush();assert.equal(notified,2,'one source boundary per microtask');watcher.stop();
});
test('adopted and open-shadow source sheets notify changes while generated override rules are ignored',()=>{
  const h=harness(),sourceSheet={cssRules:[{cssText:'.card{background-image:none}'}]},override={cssRules:[{cssText:'#owned{}'}]};
  const node={adoptedStyleSheets:[sourceSheet],addEventListener(){},removeEventListener(){}};
  h.scope.overrides$1.add(override);h.scope.overridesBySource.set(sourceSheet,override);
  const manager=h.policy.createAdoptedStyleSheetOverride(node);manager.render({},[]);let updated=0,notified=0;
  h.policy.subscribeSourceChanges(()=>notified++);manager.watch(()=>updated++);
  override.cssRules[0].cssText='#owned{color:white}';h.tick();assert.equal(updated,0);assert.equal(notified,0);
  sourceSheet.cssRules[0].cssText='.card{background-image:url(shadow-photo.png)}';h.tick();assert.equal(updated,1);assert.equal(notified,1);
  manager.destroy();assert.equal(node.adoptedStyleSheets.length,1);assert.equal(node.adoptedStyleSheets[0],sourceSheet);
});

test('many normal and adopted source sheets share one frame while retaining CSSOM cadence and coalescing',()=>{
  const h=harness(),watchers=[],rules=[];let updates=0,adoptedUpdates=0,notified=0;
  h.policy.subscribeSourceChanges(()=>notified++);
  for(let i=0;i<100;i++) {
    const source=[{cssText:`.card${i}{background-image:none}`}];rules.push(source);
    const watcher=h.policy.createSheetWatcher(element(),()=>source,()=>updates++,()=>false);watchers.push(watcher);watcher.start();
  }
  const adopted=Array.from({length:3},()=>adoptedManager(h));
  for(const entry of adopted)entry.manager.watch(()=>{adoptedUpdates++;entry.render();});
  assert.equal(h.stats().frames,1,'103 pollers create one browser frame callback');
  const scheduled=h.stats().requested;h.tick(10);
  assert.equal(h.stats().requested,scheduled+1,'one replacement callback is scheduled per frame');
  assert.equal(updates,0);assert.equal(adoptedUpdates,0);assert.equal(notified,0);
  rules[0][0].cssText='.card0{background-image:url(same-count.png)}';
  rules[2][0].cssText='.card2{background-image:url(another.png)}';
  adopted[0].source.cssRules[0].cssText='.card{background-image:url(shadow.png)}';
  h.tick(10);assert.equal(updates,0);assert.equal(adoptedUpdates,0,'same-count changes retain the existing 200 ms serialization cadence');
  h.tick(181);assert.equal(updates,2);assert.equal(adoptedUpdates,1);assert.equal(notified,2,'normal sheet changes coalesce before the adopted manager’s existing deferred boundary');
  rules[1].push({cssText:'.inserted{color:red}'});h.tick(1);assert.equal(updates,3,'insertRule count change is checked next frame');
  rules[1].pop();h.tick(1);assert.equal(updates,4,'deleteRule count change is checked next frame');
  for(const watcher of watchers)watcher.stop();for(const entry of adopted)entry.manager.destroy();
  assert.equal(h.stats().frames,0,'last unsubscribe cancels the pending browser frame');
});

test('normal start and stop are idempotent and cancelled old frame delivery cannot revive a restarted subscription',()=>{
  const h=harness(),rules=[{cssText:'.card{color:red}'}];let updates=0,cancelled=false;
  const watcher=h.policy.createSheetWatcher(element(),()=>rules,()=>updates++,()=>cancelled);
  watcher.start();watcher.start();assert.equal(h.stats().frames,1);
  const oldFrame=h.takeFrame(201);watcher.stop();watcher.stop();assert.equal(h.stats().frames,0);
  watcher.start();rules.push({cssText:'.new{color:blue}'});
  oldFrame.forEach(callback=>callback());assert.equal(updates,0,'invalidated runner generation cannot poll a replacement subscription');
  assert.equal(h.stats().frames,1);h.tick(1);assert.equal(updates,1);
  cancelled=true;h.tick();assert.equal(h.stats().frames,0,'cancelled source manager retires its subscription');
  rules[0].cssText='.card{color:green}';h.tick();assert.equal(updates,1);
  cancelled=false;watcher.start();h.tick();assert.equal(updates,1,'restart captures the new baseline without a spurious source change');
  watcher.stop();assert.equal(h.stats().frames,0);
});

test('subscriptions stopped or restarted inside another source callback run at most once and new tokens begin next frame',()=>{
  const h=harness(),firstRules=[{cssText:'.first{color:red}'}],secondRules=[{cssText:'.second{color:red}'}],thirdRules=[{cssText:'.third{color:red}'}];let firstUpdates=0,secondUpdates=0,thirdReads=0;
  let second,third;
  const first=h.policy.createSheetWatcher(element(),()=>firstRules,()=>{firstUpdates++;second.stop();second.start();third.start();},()=>false);
  second=h.policy.createSheetWatcher(element(),()=>secondRules,()=>secondUpdates++,()=>false);
  third=h.policy.createSheetWatcher(element(),()=>{thirdReads++;return thirdRules;},()=>{},()=>false);
  first.start();second.start();firstRules.push({cssText:'.changed{}'});secondRules.push({cssText:'.changed{}'});
  h.tick(1);assert.equal(firstUpdates,1);assert.equal(secondUpdates,0,'old second token is removed and restart captures its new baseline');
  const initialThirdReads=thirdReads;assert.equal(h.stats().frames,1);
  h.tick(1);assert.equal(thirdReads,initialThirdReads+1,'new watcher is polled once on the following frame');
  secondRules.pop();h.tick(1);assert.equal(secondUpdates,1);
  first.stop();second.stop();third.stop();assert.equal(h.stats().frames,0);
});

test('self-restart in a source callback leaves one active subscription and stopping another preserves the runner',()=>{
  const h=harness(),rules=[{cssText:'.card{}'}];let reads=0,updates=0,otherReads=0;
  const watcher=h.policy.createSheetWatcher(element(),()=>{reads++;return rules;},()=>{updates++;watcher.stop();watcher.start();},()=>false);
  const other=h.policy.createSheetWatcher(element(),()=>{otherReads++;return [{cssText:'.other{}'}];},()=>{},()=>false);
  watcher.start();other.start();rules.push({cssText:'.new{}'});h.tick(1);assert.equal(updates,1);assert.equal(h.stats().frames,1);
  const afterRestart=reads;h.tick(1);assert.equal(reads,afterRestart+1,'restarted watcher has one polling token');
  const beforeOtherStop=otherReads;other.stop();h.tick(1);assert.equal(otherReads,beforeOtherStop);assert.equal(h.stats().frames,1);
  watcher.stop();assert.equal(h.stats().frames,0);
});

test('proxy takeover retires normal and adopted polling while live proxy updates stay coalesced',()=>{
  const h=harness(),node=element(),rules=[{cssText:'.card{}'}];let updates=0,adoptedUpdates=0;
  const watcher=h.policy.createSheetWatcher(node,()=>rules,()=>updates++,()=>false);watcher.start();
  const adopted=adoptedManager(h);adopted.manager.watch(()=>{adoptedUpdates++;adopted.render();});
  rules.push({cssText:'.new{}'});node.emit('__darkreader__updateSheet');node.emit('__darkreader__updateSheet');h.flush();
  assert.equal(updates,1);assert.equal(h.stats().frames,1,'adopted source still owns the shared runner');
  adopted.source.cssRules.push({cssText:'.new{}'});adopted.node.emit('__darkreader__adoptedStyleSheetChange');h.flush();
  assert.equal(adoptedUpdates,1);assert.equal(h.stats().frames,0,'last proxy takeover cancels polling');
  watcher.start();adopted.manager.watch(()=>adoptedUpdates++);assert.equal(h.stats().frames,0,'proxy-aware restart creates no fallback frame');
  watcher.stop();adopted.manager.destroy();
});

test('adopted repeated watch has one current callback and destroyed queued CSSOM updates cannot render or notify',()=>{
  const h=harness(),entry=adoptedManager(h);let retiredUpdates=0,currentUpdates=0,notified=0;
  h.policy.subscribeSourceChanges(()=>notified++);
  entry.manager.watch(()=>retiredUpdates++);entry.manager.watch(()=>{currentUpdates++;entry.render();});
  assert.equal(h.stats().frames,1);assert.ok([...entry.node.listeners.values()].every(listeners=>listeners.size===1));
  entry.source.cssRules[0].cssText='.card{background-image:url(new.png)}';h.frame();
  assert.equal(currentUpdates,0,'polling queues its existing microtask source boundary');
  entry.manager.watch(()=>{currentUpdates++;entry.render();});h.flush();
  assert.equal(retiredUpdates,0);assert.equal(currentUpdates,1,'already queued work uses the current watch callback');
  entry.source.cssRules.push({cssText:'.inserted{}'});h.frame(1);assert.equal(h.stats().queued,1);
  entry.manager.destroy();h.flush();assert.equal(currentUpdates,1);assert.equal(notified,1,'destroyed queued work never revives an old render or source notification');
  assert.equal(h.stats().frames,0);assert.equal(entry.node.adoptedStyleSheets.length,1);assert.equal(entry.node.adoptedStyleSheets[0],entry.source);
  entry.manager.watch(()=>currentUpdates++);entry.node.emit('__darkreader__adoptedStyleSheetChange');h.tick();assert.equal(currentUpdates,1,'destroy is an irreversible ownership boundary');
});

test('stopping a normal watcher fences an already queued proxy update before manager cancellation',()=>{
  const h=harness(),node=element(),rules=[{cssText:'.card{}'}];let updates=0,notified=0;
  h.policy.subscribeSourceChanges(()=>notified++);
  const watcher=h.policy.createSheetWatcher(node,()=>rules,()=>updates++,()=>false);watcher.start();
  node.emit('__darkreader__updateSheet');watcher.stop();h.flush();
  assert.equal(updates,0);assert.equal(notified,0);assert.equal(h.stats().frames,0);
  watcher.start();node.emit('__darkreader__updateSheet');h.flush();assert.equal(updates,1);assert.equal(notified,1,'live proxy updates remain available after restart');
  watcher.stop();
});

test('one failing sheet poller stops without starving unrelated stylesheet changes',()=>{
  const h=harness(),firstRules=[{cssText:'.first{}'}],secondRules=[{cssText:'.second{}'}];let updates=0;
  const first=h.policy.createSheetWatcher(element(),()=>firstRules,()=>{throw new Error('source render failed');},()=>false);
  const second=h.policy.createSheetWatcher(element(),()=>secondRules,()=>updates++,()=>false);
  first.start();second.start();firstRules.push({cssText:'.new{}'});secondRules.push({cssText:'.new{}'});
  h.frame(1);assert.equal(updates,1,'other source check runs despite the failing callback');
  assert.throws(()=>h.flush(),/source render failed/,'the failure remains visible rather than being swallowed');
  assert.equal(h.stats().frames,1);h.tick(1);assert.equal(updates,1,'failed poller does not retry while unchanged healthy source remains watched');
  first.stop();second.stop();assert.equal(h.stats().frames,0);
});
