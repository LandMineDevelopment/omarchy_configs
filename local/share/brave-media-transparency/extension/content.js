(() => {
  const VERSION = '0.2.54';
  if (globalThis.__braveMediaTransparency?.version === VERSION && !globalThis.__braveMediaTransparency.isDisposed()) return;
  globalThis.__braveMediaTransparency?.dispose?.();
  const semanticTheme = globalThis.SemanticTheme;
  let enabled = false;
  let disposed = false;
  let stopThemeDisposal = null;
  const listeners = [];
  function listen(target, event, handler, options) {
    if (!target) return;
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }
  let zoom = 1;
  let sequence = 0;
  let acknowledgedSequence = 0;
  let motionPublication = 0;
  let backdropPublication = null;
  let inactiveReported = false;
  let scheduled = false;
  let snapshotNeeded = true;
  let mediaElements = new Set();
  let uiElements = new Set();
  let shadowHosts = new Set();
  const rootObservers = new Map();
  let discoveryNeeded = true;
  let hasQueryContainers = false;
  let positions = new WeakMap();
  let scrollingUntil = 0;
  let lastViewportGeometry = null;
  const selector = 'img,video,canvas,svg,object,embed,iframe';
  function viewport() {
    return { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, zoom, screenX, screenY };
  }
  function runtimeMessage(message) {
    // Reloaded extension contexts can throw synchronously as well as reject.
    // Retire their timers/listeners once; never let a stale send tear down a
    // replacement controller after this content instance has been disposed.
    if(disposed) return Promise.reject(new Error('Content instance disposed'));
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(error => { dispose();throw error; });
    } catch(error) { dispose();return Promise.reject(error); }
  }
  function send(valid, reason, boxes = [], pendingBackdrops = [], diagnostics = {}) {
    if (!enabled) return;
    if (document.visibilityState !== 'visible') {
      if (inactiveReported) return;
      inactiveReported = true;
      valid = false; reason = 'inactive'; boxes = [];
    } else inactiveReported = false;
    const sentSequence=++sequence;
    backdropPublication=valid&&pendingBackdrops.length?{sequence:sentSequence,entries:pendingBackdrops,viewport:viewportGeometry()}:null;
    runtimeMessage({ type: 'media-content-state', capturedAt: Date.now(), valid, reason, boxes, viewport: viewport(), sequence: sentSequence, ...diagnostics }).catch(() => {});
  }
  function moving() {
    if (!enabled) return;
    send(false, 'moving');
    schedule();
  }
  function viewportGeometry() {
    // Brave can spoof page outer dimensions. Inner geometry and visual viewport
    // measurements describe the submitted page; the native host owns outer size.
    return JSON.stringify([innerWidth, innerHeight, devicePixelRatio, zoom,
      visualViewport?.width ?? innerWidth, visualViewport?.height ?? innerHeight,
      visualViewport?.scale ?? 1, visualViewport?.offsetLeft ?? 0, visualViewport?.offsetTop ?? 0]);
  }
  function viewportResized() {
    if (!enabled) return;
    const current = viewportGeometry();
    if (current !== lastViewportGeometry) {
      lastViewportGeometry = current;
      discoveryNeeded=true;
      moving();
    } else schedule();
  }
  function imageStyleAnimation(animation) {
    if(animation.playState!=='running'||!animation.effect?.target||typeof animation.effect.getKeyframes!=='function') return false;
    try {return animation.effect.getKeyframes().some(frame=>Object.keys(frame).some(key=>key==='backgroundImage'||key==='background'||key.startsWith('--')));}
    catch {return false;}
  }
  function discoveryChanged() {discoveryNeeded=true;schedule();}
  function ordinaryTextMutation(record) {
    const text=record.target;
    if(record.type!=='characterData'||text?.nodeType!==3||typeof record.oldValue!=='string'||typeof text.data!=='string') return false;
    const parentOf=node=>node.assignedSlot||node.parentElement||node.getRootNode?.()?.host;
    let node=parentOf(text);
    if(!node) return false;
    for(;node;node=parentOf(node)) {
      // Source text, form defaults and custom state can introduce CSS media.
      // Follow slots/hosts too: :dir() may change outside this observed root.
      if(node.namespaceURI!=='http://www.w3.org/1999/xhtml'||
          ['style','script','textarea','option','select'].includes(node.localName)||
          node.localName.includes('-')||node.getAttribute?.('is')!=null) return false;
      const dir=(node.getAttribute?.('dir')||'').toLowerCase();
      if(dir==='auto'||node.localName==='bdi'&&!['ltr','rtl'].includes(dir)) return false;
    }
    // Both values contain text under either whitespace interpretation of :empty.
    // Its state, and relational selectors such as :has(:empty), remain unchanged.
    return !!record.oldValue.trim()&&!!text.data.trim();
  }
  function onMutation(records) {
    const external=records?.filter(record=>!semanticTheme?.ownsMutation(record));
    if(external?.length===0) return;
    // Text can resize a query container, including a sibling of its owner.
    // Its descendants may gain CSS artwork without any selector/DOM change.
    // Keep source discovery for these pages until their layout dependencies
    // have their own invalidation boundary; cached rectangles cannot prove it.
    if(!hasQueryContainers&&external?.length&&external.every(ordinaryTextMutation)) schedule();
    else discoveryChanged();
  }
  function observeRoot(root) {
    if(rootObservers.has(root)) return;
    const watcher=new MutationObserver(onMutation);
    watcher.observe(root,{subtree:true,childList:true,attributes:true,characterData:true,characterDataOldValue:true});
    root.addEventListener?.('load',discoveryChanged,true);
    rootObservers.set(root,{disconnect(){watcher.disconnect();root.removeEventListener?.('load',discoveryChanged,true);}});
  }
  function snapshot() {
    if (!enabled) return;
    snapshotNeeded=false;
    const startedAt=Date.now();
    const phases={};let phaseStarted=startedAt;
    function finishPhase(name) {const now=Date.now();phases[name]=now-phaseStarted;phaseStarted=now;}
    if (document.visibilityState !== 'visible') return send(false, 'inactive');
    const fullscreenRoot = document.fullscreenElement;
    if (visualViewport && (visualViewport.scale !== 1 || visualViewport.offsetLeft !== 0 || visualViewport.offsetTop !== 0)) return send(false, 'visual-viewport-unknown');
    // Native PDF guest content cannot be inspected through the page DOM.
    // Protect its entire content viewport; browser chrome stays outside the mask.
    if (String(document.contentType || '').split(';',1)[0].trim().toLowerCase() === 'application/pdf')
      return send(true,'uninspectable-pdf',[{left:0,top:0,right:innerWidth,bottom:innerHeight}]);
    const boxes = [], mediaPaints = [];
    let pendingMotion = false;
    const canvasBudget = { remainingPixels: MediaGeometry.MAX_CANVAS_PIXELS };
    let overflow = false;
    let styles = new WeakMap(), pseudoStyles = new WeakMap();
    const opacityCache = new WeakMap();
    function sampleStyle(el,pseudo) {
      const source=getComputedStyle(el,pseudo),values=Object.create(null);
      // CSSStyleDeclaration is live: caching the object still repeats native
      // property resolution for each media descendant of a shared ancestor.
      // Copy each requested value once; discard it with the snapshot. Late
      // shadow theme initialization invalidates these discovery samples before
      // the write-free geometry phase begins.
      return new Proxy(values,{get(cache,key) {
        if(!Object.hasOwn(cache,key)) {
          const value=source[key];
          cache[key]=typeof value==='function'?value.bind(source):value;
        }
        return cache[key];
      }});
    }
    function readStyle(el,pseudo=null) {
      if(pseudo) {
        if(!pseudoStyles.has(el)) pseudoStyles.set(el,new Map());
        const cached=pseudoStyles.get(el);
        if(!cached.has(pseudo)) cached.set(pseudo,sampleStyle(el,pseudo));
        return cached.get(pseudo);
      }
      if (!styles.has(el)) styles.set(el, sampleStyle(el));
      return styles.get(el);
    }
    const liveRoots=new Set([document]);
    let initializedRoot=false;
    function discoverElement(el) {
      const known=el.matches(selector),style=readStyle(el);
      if(style.containerType && style.containerType !== 'normal') hasQueryContainers=true;
      const customMedia=MediaGeometry.isExplicitCustomMedia(el);
      const backgroundMedia=MediaGeometry.hasMediaBackground(style.backgroundImage);
      if(uiElements.size<256&&MediaGeometry.isOpaqueNeutralBackground(style,semanticTheme?.isSurface?.(el))) uiElements.add(el);
      if(known||customMedia||backgroundMedia) mediaElements.add(el);
      if(typeof el.attachShadow==='function'||el.shadowRoot) shadowHosts.add(el);
      if(el.shadowRoot) {
        initializedRoot=semanticTheme?.discoverRoot?.(el.shadowRoot)===true||initializedRoot;
        observeRoot(el.shadowRoot);walk(el.shadowRoot);
      }
    }
    function walk(root) {
      liveRoots.add(root);
      if(root.localName) discoverElement(root);
      for(const el of root.querySelectorAll('*')) discoverElement(el);
    }
    if(discoveryNeeded) {
      discoveryNeeded=false;
      mediaElements=new Set();uiElements=new Set();shadowHosts=new Set();
      hasQueryContainers=false;
      walk(document);
      for(const [root,watcher] of rootObservers) if(!liveRoots.has(root)) {watcher.disconnect();rootObservers.delete(root);}
    } else {
      // attachShadow itself emits no DOM mutation. Inspect cached hosts without
      // style/layout reads, then discover/observe only newly attached open roots.
      for(const host of shadowHosts) if(host.shadowRoot&&!rootObservers.has(host.shadowRoot)) {
        initializedRoot=semanticTheme?.discoverRoot?.(host.shadowRoot)===true||initializedRoot;
        observeRoot(host.shadowRoot);walk(host.shadowRoot);
      }
    }
    // CSS can introduce a URL on an otherwise inert node without a DOM change.
    // Only animations of image/inherited style sources need target discovery.
    const animations=document.getAnimations();
    for(const animation of animations) if(imageStyleAnimation(animation)) walk(animation.effect.target);
    // Registering a new root can synchronously write its generated sheets and
    // inline overrides, including :host paint. Its first mask must use the
    // resulting ancestor paint rather than an earlier discovery sample.
    if(initializedRoot) {styles=new WeakMap();pseudoStyles=new WeakMap();}
    finishPhase('discoveryMs');
    // No layout writes occur in the geometry pass. Sample each shared box and
    // scrollport's client metrics once, then discard them with this snapshot.
    // Discovery freshness never authorizes reusing layout in a later frame.
    const boundsCache=new WeakMap(),metricsCache=new WeakMap();
    const readGeometry={
      bounds(el) {
        if(!boundsCache.has(el)) boundsCache.set(el,el.getBoundingClientRect());
        return boundsCache.get(el);
      },
      metrics(el) {
        if(!metricsCache.has(el)) metricsCache.set(el,{
          offsetWidth:el.offsetWidth,offsetHeight:el.offsetHeight,
          clientLeft:el.clientLeft,clientTop:el.clientTop,
          clientWidth:el.clientWidth,clientHeight:el.clientHeight,
        });
        return metricsCache.get(el);
      },
    };
    for (const el of mediaElements) {
      // Fullscreen paints its top-layer subtree, not measurable background
      // siblings. Include a fullscreen video itself and open-shadow media.
      if (fullscreenRoot) {
        let node = el;
        while (node && node !== fullscreenRoot) node = node.assignedSlot || node.parentElement || node.getRootNode?.()?.host;
        if (node !== fullscreenRoot) continue;
      }
      // Cached candidates may lose their authored image after page/theme edits.
      // Re-evaluate the media signal before protecting their old layout box.
      if (!el.matches(selector) && !MediaGeometry.isExplicitCustomMedia(el) &&
          !MediaGeometry.hasMediaBackground(readStyle(el).backgroundImage)) continue;
      if (semanticTheme?.isBackdrop?.(el)) continue;
      // Only theme-owned glyphs with positive monochrome evidence are UI ink.
      if (semanticTheme?.isControlGlyph?.(el)) continue;
      const bounds = readGeometry.bounds(el);
      if (MediaGeometry.isDecorativePageBackground(el, bounds, readStyle, { innerWidth, innerHeight }) ||
          MediaGeometry.isDecorativeWallpaperImage(el, bounds, readStyle, {
            innerWidth, innerHeight, elementsFromPoint: document.elementsFromPoint?.bind(document)
          })) continue;
      const r = el.localName === 'video' ? MediaGeometry.videoContentRect(el, bounds, readStyle) : bounds;
      if (!r) continue;
      // DOM geometry and browser buffers arrive independently. Cover one
      // observed scroll step on a moving frame, never the old three-step
      // extrapolation. Retain that single step until native acceptance, then
      // return to exact bounds when scrolling stops and native acceptance arrives.
      const previous=positions.get(el);
      let protectedRect=r;
      let motionSequence=0;
      if(Date.now()<scrollingUntil && previous && (r.left!==previous.left || r.top!==previous.top)) {
        const dx=Math.abs(r.left-previous.left),dy=Math.abs(r.top-previous.top);
        protectedRect={left:r.left-dx,top:r.top-dy,right:r.right+dx,bottom:r.bottom+dy};
        motionSequence=sequence+1;
      } else if(previous?.motionSequence && (previous.motionSequence>acknowledgedSequence || Date.now()<scrollingUntil)) {
        protectedRect={left:Math.min(r.left,previous.protectedRect.left),top:Math.min(r.top,previous.protectedRect.top),right:Math.max(r.right,previous.protectedRect.right),bottom:Math.max(r.bottom,previous.protectedRect.bottom)};
        motionSequence=previous.motionSequence;
      }
      pendingMotion ||= motionSequence>acknowledgedSequence;
      positions.set(el,{left:r.left,top:r.top,protectedRect,motionSequence});
      if (r.width && r.height && protectedRect.right > 0 && protectedRect.bottom > 0 && protectedRect.left < innerWidth && protectedRect.top < innerHeight && MediaGeometry.isPaintVisible(el, readStyle, opacityCache, fullscreenRoot)) {
        const paint = MediaGeometry.clipMediaRect(el, protectedRect, readStyle, fullscreenRoot, readGeometry);
        if (paint && paint.right>0 && paint.bottom>0 && paint.left<innerWidth && paint.top<innerHeight) {
          if(el.localName==='canvas' && !MediaGeometry.hasMediaBackground(readStyle(el).backgroundImage)) {
            // Read back only visible, clipped 2D artwork. Offscreen/hidden
            // canvases cannot spend the shared budget needed by visible ones.
            // Motion coverage may extend onscreen after the canvas left it;
            // retain that protection without probing its offscreen bitmap.
            const currentPaint=protectedRect===r?paint:MediaGeometry.clipMediaRect(el,r,readStyle,fullscreenRoot,readGeometry);
            if(currentPaint && currentPaint.right>0 && currentPaint.bottom>0 && currentPaint.left<innerWidth && currentPaint.top<innerHeight &&
                MediaGeometry.isCanvasPaintEmpty(el,canvasBudget)) continue;
          }
          const rect={left:paint.left,top:paint.top,right:paint.right,bottom:paint.bottom};
          boxes.push(rect);mediaPaints.push({element:el,rect});
        }
        if (boxes.length > MediaGeometry.MAX_RECTS) { overflow = true; break; }
      }
    }
    finishPhase('mediaGeometryMs');
    const pendingBackdrops=[];
    for (const entry of semanticTheme?.pendingBackdropMedia?.() || []) {
      const el=entry.element;
      if (fullscreenRoot) {
        let node=el;
        while(node&&node!==fullscreenRoot) node=node.assignedSlot||node.parentElement||node.getRootNode?.()?.host;
        if(node!==fullscreenRoot) continue;
      }
      const rect=readGeometry.bounds(el);
      if(!['left','top','right','bottom'].every(key=>Number.isFinite(rect[key]))) { overflow=true;break; }
      const paint=MediaGeometry.clipMediaRect(el,rect,readStyle,fullscreenRoot,readGeometry);
      if(paint) boxes.push({left:paint.left,top:paint.top,right:paint.right,bottom:paint.bottom});
      pendingBackdrops.push({...entry,rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},paint});
      if(boxes.length>MediaGeometry.MAX_RECTS) { overflow=true;break; }
    }
    let protectedBoxes=boxes;
    if(!overflow&&mediaPaints.length) {
      const reserved=boxes.slice(mediaPaints.length);
      finishPhase('pendingBackdropMs');
      const regions=MediaGeometry.opaqueUiRegions(uiElements,readStyle,fullscreenRoot,mediaPaints,el=>semanticTheme?.isSurface?.(el)===true,readGeometry);
      finishPhase('opaqueUiMs');
      const paintViewport={innerWidth,innerHeight,elementsFromPoint:document.elementsFromPoint?.bind(document)};
      // One bounded paint-order proof handles both complete and partial UI
      // coverage. A separate full-cover pass repeated the same hit tests.
      protectedBoxes=[...MediaGeometry.subtractOpaqueUi(mediaPaints,regions,readStyle,paintViewport,reserved.length),...reserved];
      finishPhase('occlusionMs');
    }
    motionPublication=pendingMotion&&!overflow?sequence+1:0;
    send(!overflow, overflow ? 'media-overflow' : 'settled', overflow ? [] : protectedBoxes,pendingBackdrops,{snapshotDurationMs:Date.now()-startedAt,snapshotPhases:phases,themePhases:semanticTheme?.lastRefreshPhaseTimings?.() ?? null,themeRefreshDurationMs:semanticTheme?.lastRefreshDurationMs?.() ?? null});
    return animations;
  }
  function scrolled() {
    // Coalesce wheel/scroll events into one publication before the next paint.
    // A synchronous snapshot followed by another animation-frame snapshot
    // duplicated expensive geometry while blocking further input.
    scrollingUntil = Date.now() + 50;
    schedule();
  }
  function schedule() {
    if (!enabled) return;
    // An early theme publication can satisfy the queued request. A later
    // geometry event must make that same queued frame publish current bounds.
    snapshotNeeded=true;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if(!enabled || disposed) return;
      // The semantic theme can publish geometry before its expensive refresh.
      // Reuse it only when no subsequent geometry or source change is pending.
      let animations;
      if(snapshotNeeded || discoveryNeeded) animations=snapshot();
      if(!enabled || disposed) return;
      // Reuse only this synchronous snapshot's animation list. An early
      // semantic publication does not lend its list to a later queued frame.
      animations ??= document.getAnimations();
      // Refresh per frame only when actual artwork or an ancestor moves.
      // Hover fades and loading spinners should not drive full-DOM scans.
      const mediaAnimation = animations.some(animation => {
        if (animation.playState !== 'running') return false;
        if(imageStyleAnimation(animation)) return true;
        const target = animation.effect?.target;
        return target && [...mediaElements].some(media => target === media || target.contains?.(media));
      });
      if (mediaAnimation || Date.now() < scrollingUntil) schedule();
    });
  }
  // Scroll changes media positions, not the identity or size of this surface.
  // Replace its geometry without making the entire window opaque between frames.
  listen(globalThis, 'scroll', scrolled, { capture: true, passive: true });
  listen(globalThis, 'wheel', schedule, { capture: true, passive: true });
  listen(globalThis, 'resize', event => {
    // A video's intrinsic dimensions can change without resizing this window.
    // Refresh its displayed frame; only window resizing revokes the viewport.
    if (event?.target && event.target !== globalThis) schedule();
    else viewportResized();
  }, { capture: true, passive: true });
  // Ordinary interaction is not evidence that media moved. Refresh its
  // geometry without clearing the accepted mask; resize owns invalidation.
  for(const event of ['pointerdown','touchstart']) listen(globalThis,event,discoveryChanged,{capture:true,passive:true});
  for(const event of ['keydown','keyup']) listen(globalThis,event,event => {
    if(['Enter',' ','Spacebar'].includes(event?.key)) discoveryChanged();
    else schedule();
  },{capture:true,passive:true});
  listen(globalThis,'input',schedule,{capture:true,passive:true});
  listen(globalThis, 'visibilitychange', moving, true);
  listen(globalThis, 'fullscreenchange', () => {
    discoveryNeeded = true;
    positions = new WeakMap();
    scrollingUntil = 0;
    moving();
  }, true);
  // Browser menus and the URL bar blur page focus without hiding the active
  // page. Native/window checks own focus; retain and refresh its media mask.
  for (const event of ['blur', 'focus']) listen(globalThis, event, schedule, true);
  listen(visualViewport, 'resize', viewportResized);
  listen(visualViewport, 'scroll', scrolled);
  const stopSourceChanges=globalThis.DarkReader?.onSourceChange?.(discoveryChanged);
  observeRoot(document);
  listen(globalThis,'load',discoveryChanged,true);
  listen(globalThis,'loadedmetadata',schedule,true);
  // Selector state and stylesheet/animation changes can add CSS URL media even
  // when no class attribute changes. Polling geometry does not own discovery.
  for(const event of ['pointerover','pointerout','pointerup','touchend','focusin','focusout','animationstart','animationend','animationcancel','transitionrun','transitionend','transitioncancel'])
    listen(globalThis,event,discoveryChanged,true);
  semanticTheme?.setBackdropChanged?.(() => {
    discoveryNeeded=true;
    // Theme applies its pending hiding rules first. Publish protection now,
    // before paint, then wait for native acceptance before revealing artwork.
    if(enabled&&!disposed) snapshot();
  });
  semanticTheme?.setBeforeRefresh?.(() => {
    // A fresh media mask must reach the compositor before semantic source
    // capture and control analysis. A content-first frame already satisfies it
    // unless a later geometry or source change requested another publication.
    if(enabled&&!disposed&&(snapshotNeeded||discoveryNeeded)) snapshot();
  });
  const setEnabled = message => {
    if (!disposed && message.type==='media-geometry-accepted') {
      if(enabled&&motionPublication===message.sequence&&sequence===message.sequence) {
        acknowledgedSequence=message.sequence;
        motionPublication=0;
        schedule();
      }
      const publication=backdropPublication;
      if(!enabled||document.visibilityState!=='visible'||!publication||publication.sequence!==message.sequence||sequence!==message.sequence) return;
      backdropPublication=null;
      if(publication.viewport!==viewportGeometry()) { snapshot();return; }
      const exact = (left,right) => left===null||right===null?left===right:['left','top','right','bottom'].every(key=>left[key]===right[key]);
      for(const entry of publication.entries) {
        const rect=entry.element.getBoundingClientRect();
        const paint=MediaGeometry.clipMediaRect(entry.element,rect,getComputedStyle,document.fullscreenElement);
        if(!exact(rect,entry.rect)||!exact(paint,entry.paint)) { snapshot();return; }
      }
      semanticTheme?.acceptBackdropMedia?.(publication.entries);
      return;
    }
    // Page styling stays active on background tabs; geometry is published only
    // for the selected page in each visible window. The global switch owns both.
    if (!disposed && message.type === 'media-theme-v1') {
      if (message.enabled) semanticTheme?.enable(message.palette);
      else semanticTheme?.disable();
      return;
    }
    // Older injected instances have anonymous listeners that cannot be removed
    // retroactively. A new control type keeps those disposed instances inert.
    if (disposed || message.type !== 'media-set-enabled-v2') return;
    const wasEnabled = enabled, previousZoom = zoom;
    zoom = message.zoom ?? zoom;
    enabled = !!message.enabled;
    if (enabled) {
      if (!wasEnabled || previousZoom !== zoom) {
        lastViewportGeometry = viewportGeometry();
        discoveryNeeded = true;
      }
      // Focus/tab metadata can reaffirm the same active controller. Refresh
      // geometry without discarding its discovered media or existing dirtiness.
      schedule();
    } else lastViewportGeometry = null;
  };
  chrome.runtime.onMessage.addListener(setEnabled);
  const heartbeat = setInterval(schedule, 200);
  function dispose() {
    if(disposed) return;
    disposed = true;
    enabled = false;
    clearInterval(heartbeat);
    stopThemeDisposal?.();
    stopSourceChanges?.();
    for(const watcher of rootObservers.values()) watcher.disconnect();
    rootObservers.clear();
    semanticTheme?.setBackdropChanged?.(null);
    semanticTheme?.setBeforeRefresh?.(null);
    semanticTheme?.dispose();
    try { chrome.runtime.onMessage.removeListener(setEnabled); }
    catch(error) { if(!/extension context invalidated/i.test(String(error?.message || error))) throw error; }
    for (const remove of listeners) remove();
  }
  globalThis.__braveMediaTransparency = { version: VERSION, dispose, isDisposed:()=>disposed };
  stopThemeDisposal=semanticTheme?.onDispose?.(dispose);
  if(disposed) return;
  semanticTheme?.setFetchMethod(async url => {
    const result = await runtimeMessage({type:'theme-fetch-css', url:String(url)});
    if (!result?.ok) throw new Error('Page stylesheet unavailable');
    return new Response(result.text, {status:200, headers:{'Content-Type':'text/css'}});
  });
  runtimeMessage({ type: 'media-ready' }).catch(() => {});
})();
