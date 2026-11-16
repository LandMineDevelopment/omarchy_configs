/* Semantic page theme; bundled Dark Reader owns CSS adaptation, compositor owns alpha. */
(() => {
  const VERSION = '0.2.54';
  if (globalThis.BraveMediaTheme?.version === VERSION && !globalThis.BraveMediaTheme.isDisposed()) return;
  globalThis.BraveMediaTheme?.dispose?.();
  // The DOM is shared across extension worlds. Retire modern controllers
  // synchronously, including OFF instances, before capturing authored markers.
  const CLAIM_EVENT = 'brave-media-controller-claimed';
  document.dispatchEvent?.(new Event(CLAIM_EVENT));
  // A retired controller must never resolve the engine installed by a newer bundle.
  const pageEngine = globalThis.DarkReader;
  const ATTR = 'data-brave-media-artwork';
  const BACKDROP_ATTR = 'data-brave-media-backdrop';
  const ICON_ATTR = 'data-brave-media-icon-button';
  const CHECK_ATTR = 'data-brave-media-check-indicator';
  const COMPACT_ATTR = 'data-brave-media-compact-button';
  const POPUP_ATTR = 'data-brave-media-popup-panel';
  const GLYPH_ATTR = 'data-brave-media-control-glyph';
  const CONTAINED_FIELD_ATTR = 'data-brave-media-contained-field';
  const LABEL_FILL_ATTR = 'data-brave-media-label-fill';
  const BOUNDARY_ATTR = 'data-brave-media-control-boundary';
  const SURFACE_ATTR = 'data-brave-media-surface';
  const theme = { mode: 1, brightness: 100, contrast: 100, grayscale: 0, sepia: 0,
    darkSchemeBackgroundColor: '#101010', darkSchemeTextColor: '#eeeeee',
    // Our palette owns selection CSS; the engine's layered automatic selection
    // rule otherwise outranks even an important unlayered palette override.
    selectionColor: '', styleSystemControls: true, useFont: false, textStroke: 0 };
  let fixes = { invert: [], css: '', ignoreImageAnalysis: ['*'],
    ignoreInlineStyle: ['img','video','canvas','object','embed','iframe','svg','svg *'],
    disableStyleSheetsProxy: true, disableCustomElementRegistryProxy: true };
  let paletteKey = null;
  let enabled = false, scheduled = false, frame = null, nextId = 0, disposed = false;
  // Independent extension worlds can retire after a replacement has published
  // locks. IDs must identify the controller, not just its local sequence.
  const ownerId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const previousAttribute = (node, attribute) => {
    const value=node.getAttribute(attribute);
    // Preserve authored provenance across isolated-world takeovers. The old
    // controller's cleanup cannot remove the replacement marker, and OFF must
    // restore the source value rather than resurrect an obsolete owner ID.
    if(typeof value==='string' && /^bm-[a-z0-9-]+~/.test(value)) {
      try {const source=JSON.parse(decodeURIComponent(value.slice(value.indexOf('~')+1)));if(source===null || typeof source==='string')return source;} catch { /* An authored lookalike stays authored. */ }
    }
    return value;
  };
  const nextLockId = previous => `bm-${ownerId}-${++nextId}~${encodeURIComponent(JSON.stringify(previous ?? null))}`;
  const locks = new Map(), backdrops = new Map(), icons = new Map(), indicators = new Map(), compactButtons = new Map(), popupPanels = new Map(), glyphs = new Map(), pendingGlyphs = new Map(), containedFields = new Map(), labelFills = new Map(), labelFillCache = new Map(), boundaries = new Map(), surfaces = new Map(), roots = new Map(), authoredStyles = new WeakMap();
  const markerMaps = new Map([[ATTR,locks],[BACKDROP_ATTR,backdrops],[ICON_ATTR,icons],[CHECK_ATTR,indicators],
    [COMPACT_ATTR,compactButtons],[POPUP_ATTR,popupPanels],[GLYPH_ATTR,glyphs],
    [CONTAINED_FIELD_ATTR,containedFields],[LABEL_FILL_ATTR,labelFills],[BOUNDARY_ATTR,boundaries],[SURFACE_ATTR,surfaces]]);
  const markerSources = new WeakMap(), ownershipWatchers = new Map(), disposalListeners = new Set();
  const STYLE_ATTR = 'data-brave-media-theme-style', STYLE_OWNER_ATTR = 'data-brave-media-theme-owner';
  const CLAIM_SELECTOR = 'meta[name="brave-media-controller"]';
  const claim = typeof document.querySelector==='function' ? document.createElement('meta') : null;
  if(claim) {claim.setAttribute('name','brave-media-controller');claim.setAttribute('content',ownerId);}
  let claimPublished=false,claimDocumentRoot=null;
  function publishClaim() {
    const parent=document.head || document.documentElement;
    if(!claim || !parent) return;
    document.querySelector(CLAIM_SELECTOR)?.remove();parent.appendChild(claim);claimPublished=true;claimDocumentRoot=document.documentElement;
  }
  function ownsDocument() {
    // document.open() removes DOM event listeners without retiring the JS
    // world. A shared marker also fences that document replacement and any
    // modern owner whose synchronous retirement listener disappeared.
    if(!claimPublished) return true;
    const current=document.querySelector(CLAIM_SELECTOR);
    return current ? current===claim : document.documentElement===claimDocumentRoot;
  }
  const markerSelector = [...markerMaps.keys()].map(attribute=>`[${attribute}]`).join(',');
  function generatedMarker(attribute,value) {
    if(typeof value!=='string') return false;
    if(/^bm-[a-z0-9-]+~/.test(value)) return previousAttribute({getAttribute:()=>value},attribute)!==value;
    return [ICON_ATTR,COMPACT_ATTR,POPUP_ATTR,CONTAINED_FIELD_ATTR,LABEL_FILL_ATTR].includes(attribute) && value==='true' ||
      attribute===CHECK_ATTR && /^(before|after)-(checkbox|radio)-(checked|unchecked)$/.test(value);
  }
  function reconcileMarker(node,attribute,oldValue=null) {
    const lock=markerMaps.get(attribute).get(node),value=node.getAttribute(attribute);
    let source=markerSources.get(node);
    if(!source) {source=new Map();markerSources.set(node,source);}
    // Pre-claim controllers cannot hear the retirement event. Their generated
    // IDs carry source provenance; legacy presence/state flags are reserved UI
    // markers. Keep authored values observed before a stale writer replaces them.
    if(!source.has(attribute)) {
      const generated=generatedMarker(attribute,value)?value:generatedMarker(attribute,oldValue)?oldValue:null;
      source.set(attribute,generated===null?value:/^bm-/.test(generated)?previousAttribute({getAttribute:()=>generated},attribute):null);
    }
    if(!lock && !generatedMarker(attribute,value) && !generatedMarker(attribute,oldValue)) source.set(attribute,value);
    const expected=enabled && lock ? lock.id : source.get(attribute);
    if(value===expected || !lock && !generatedMarker(attribute,value) && !generatedMarker(attribute,oldValue)) return;
    if(expected===null) node.removeAttribute(attribute);else node.setAttribute(attribute,expected);
  }
  function reconcileNode(node) {
    if(node?.nodeType!==1) return;
    if(node.hasAttribute?.(STYLE_ATTR) && node.getAttribute(STYLE_OWNER_ATTR)!==ownerId) {node.remove();return;}
    for(const attribute of markerMaps.keys()) if(node.hasAttribute?.(attribute) || markerMaps.get(attribute).has(node)) reconcileMarker(node,attribute);
  }
  function reconcileTree(root) {
    reconcileNode(root);
    for(const node of root.querySelectorAll(`${markerSelector},style[${STYLE_ATTR}]`)) reconcileNode(node);
    for(const node of root.querySelectorAll('*')) if(node.shadowRoot) watchOwnership(node.shadowRoot);
  }
  function watchOwnership(root) {
    if(ownershipWatchers.has(root)) return;
    reconcileTree(root);
    const observer=new MutationObserver(records=>{
      if(disposed) return;
      if(!ownsDocument()) {dispose();return;}
      if(!claimPublished || claim && !claim.isConnected) publishClaim();
      for(const [observed,watcher] of ownershipWatchers) if(observed!==document && observed.isConnected===false) {watcher.disconnect();ownershipWatchers.delete(observed);}
      let stylesChanged=false;
      const changedMarkers=new Map();
      for(const record of records) {
        if(record.type==='attributes') {
          const {target,attributeName,oldValue}=record;
          let changed=changedMarkers.get(target);if(!changed) {changed=new Map();changedMarkers.set(target,changed);}changed.set(attributeName,oldValue);
          // Mutations share the final DOM value. Capture the last authored
          // source in a batch before repairing a subsequent legacy overwrite.
          if(!markerMaps.get(attributeName).has(target) && !generatedMarker(attributeName,oldValue)) {
            let source=markerSources.get(target);if(!source) {source=new Map();markerSources.set(target,source);}source.set(attributeName,oldValue);
          }
        }
        else {
          const target=record.target?.nodeType===1?record.target:record.target?.parentElement;
          reconcileNode(target);
          for(const node of record.addedNodes) if(node.nodeType===1) reconcileTree(node);
          if(target?.hasAttribute?.(STYLE_ATTR) || [...record.addedNodes,...record.removedNodes].some(node=>node.hasAttribute?.(STYLE_ATTR))) stylesChanged=true;
        }
      }
      for(const [node,attributes] of changedMarkers) for(const [attribute,oldValue] of attributes) reconcileMarker(node,attribute,oldValue);
      // Old engine teardown may also detach a current sheet. Reattach its
      // existing rules without rescanning artwork or changing form state.
      if(stylesChanged) writeOwnedStyles();
    });
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:[...markerMaps.keys()]});
    ownershipWatchers.set(root,observer);
  }
  let fetchMethod = null, backdropChanged = null, beforeRefresh = null;
  let engineRoots = new WeakSet();
  let labelFillRevision = 0, lastRefreshDuration = 0;
  let lastRefreshPhases = Object.freeze({});
  function nodesOf(root) {
    const state=roots.get(root);
    // Element identity survives paint/layout changes. Only source tree changes
    // replace this inventory; bounds and authored styles remain live reads.
    // Owned sheets are ignored by our observer and must not be retained here.
    if(!state.nodes) state.nodes=[...root.querySelectorAll('*')].filter(node=>!ownedNode(node));
    return state.nodes;
  }
  const signature = value => (value || '').split(';').filter(part => !/^\s*--darkreader-/i.test(part)).join(';');
  const ownedNode = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!element && (!!element.closest?.('.darkreader, [data-brave-media-theme-style], meta[name="darkreader"], meta[name="brave-media-controller"]'));
  };
  function isOwnMutation(record) {
    if (ownedNode(record.target)) return true;
    if (record.type === 'attributes') {
      if (record.attributeName === ATTR || record.attributeName === BACKDROP_ATTR || record.attributeName === ICON_ATTR || record.attributeName === CHECK_ATTR || record.attributeName === COMPACT_ATTR || record.attributeName === POPUP_ATTR || record.attributeName === GLYPH_ATTR || record.attributeName === CONTAINED_FIELD_ATTR || record.attributeName === LABEL_FILL_ATTR || record.attributeName === BOUNDARY_ATTR || record.attributeName === SURFACE_ATTR || record.attributeName?.startsWith('data-darkreader-')) return true;
      if (record.attributeName === 'style') return signature(record.target.getAttribute('style')) === authoredStyles.get(record.target);
    }
    return record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].length > 0 &&
      [...record.addedNodes, ...record.removedNodes].every(ownedNode);
  }
  function labelSourceChanged(record) {
    const target=record.target?.nodeType===1?record.target:record.target?.parentElement;
    if(['style','link'].includes(target?.localName)) return true;
    if(record.type==='childList' && [...record.addedNodes,...record.removedNodes].some(node=>['style','link'].includes(node.localName) || node.querySelector?.('style,link[rel="stylesheet"]'))) return true;
    return record.type==='attributes' && [...labelFillCache.values()].some(({owner})=>
      owner===target || owner.contains?.(target) || target?.contains?.(owner));
  }
  function observe(root) {
    if (roots.has(root)) return;
    watchOwnership(root);
    const observer = new MutationObserver(records => {
      if(!enabled) return;
      const external=records.filter(record=>!isOwnMutation(record));
      if(!external.length) return;
      if(external.some(record=>record.type==='childList')) roots.get(root).nodes=null;
      if(external.some(labelSourceChanged)) labelFillRevision++;
      schedule();
    });
    observer.observe(root, {subtree:true,childList:true,attributes:true,characterData:true});
    roots.set(root, {observer, nodes:null,style:null,glyphStyle:null,nativeStyle:null});
  }
  function discoverRoot(root, refresh = true) {
    if(!enabled || disposed || !root || root!==document && root.isConnected===false) return;
    const newlyObserved = !roots.has(root);
    observe(root);
    let initialized=false;
    if(root!==document && !engineRoots.has(root) && pageEngine.isEnabled() && pageEngine.registerShadowRoot) {
      pageEngine.registerShadowRoot(root);
      engineRoots.add(root);
      initialized=true;
    }
    // A late attachShadow does not mutate the host's light DOM. Discovering
    // a new root must also capture artwork after its theme managers initialize.
    if(newlyObserved && refresh && root!==document) schedule();
    return initialized;
  }
  function allRoots() {
    const result=[];
    function walk(root) {
      if(root!==document && root.isConnected===false) return;
      result.push(root); discoverRoot(root, false);
      const nodes=nodesOf(root);
      for (const element of nodes) {
        authoredStyles.set(element, signature(element.getAttribute('style')));
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    }
    walk(document);
    return result;
  }
  function isCompactAnchor(element) {
    if(element.localName!=='a' || !element.getAttribute('href')) return false;
    const text=(element.textContent || '').trim().replace(/\s+/g,' ');
    if(!text || text.length>64 || element.querySelector?.('img,video,canvas,object,embed,iframe,picture,figure,article,section,h1,h2,h3,p')) return false;
    for(const svg of element.querySelectorAll('svg')) {
      const rect=svg.getBoundingClientRect();
      if(Math.max(rect.width,rect.height)>=96 || Math.min(rect.width,rect.height)>=48) return false;
    }
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    if(![rect.width,rect.height,Number.parseFloat(style.paddingLeft),Number.parseFloat(style.paddingRight),Number.parseFloat(style.borderTopLeftRadius || style.borderRadius)].every(Number.isFinite)) return false;
    if(!['inline-flex','inline-grid','inline-block'].includes(style.display) || rect.width<40 || rect.width>320 || rect.height<28 || rect.height>64 ||
        Number.parseFloat(style.paddingLeft)<8 || Number.parseFloat(style.paddingRight)<8 || Number.parseFloat(style.borderTopLeftRadius || style.borderRadius)<Math.max(8,rect.height*.2)) return false;
    const match=style.backgroundColor?.match(/^rgba?\(([^)]+)\)$/);
    if(!match || globalThis.MediaGeometry?.hasMediaBackground(style.backgroundImage)) return false;
    const channels=match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return channels.every(Number.isFinite) && (channels.length===3 || (channels.length===4 && channels[3]>.5));
  }
  function isElevatedPopup(element) {
    // Unlabelled popup implementations still expose an elevated, compact
    // action panel. Do not infer this from classes or ordinary page containers.
    if(!['div','section'].includes(element.localName) && !element.localName?.includes('-')) return false;
    if(['main','navigation','banner','contentinfo','complementary','tooltip','img'].includes(element.getAttribute('role')) || element.getAttribute('aria-hidden')==='true') return false;
    const style=getComputedStyle(element);
    if(!['fixed','absolute'].includes(style.position) || !(Number(style.zIndex)>0) ||
       style.display==='none' || ['hidden','collapse'].includes(style.visibility) || Number(style.opacity)===0 || style.pointerEvents==='none') return false;
    const rect=element.getBoundingClientRect();
    if(![rect.width,rect.height,innerWidth,innerHeight].every(Number.isFinite) || rect.width<48 || rect.height<40 ||
       rect.width>640 || rect.height>600 || rect.width*rect.height>innerWidth*innerHeight*.45) return false;
    if(element.querySelector?.('figure,article,[role="img"],main,nav,header,footer,aside')) return false;
    for(const media of element.querySelectorAll('img,video,canvas,object,embed,iframe')) {
      const bounds=media.getBoundingClientRect();
      if(!(bounds.width>0 && bounds.height>0)) continue;
      if(media.localName==='img' && !media.currentSrc && !media.getAttribute('src') && !media.getAttribute('srcset')) continue;
      const painted=globalThis.MediaGeometry?.isPaintVisible?.(media,getComputedStyle) ??
        !['hidden','collapse'].includes(getComputedStyle(media).visibility);
      if(painted) return false;
    }
    for(const svg of element.querySelectorAll('svg')) {
      const bounds=svg.getBoundingClientRect();
      if(Math.max(bounds.width,bounds.height)>=96 || Math.min(bounds.width,bounds.height)>=48) return false;
    }
    let actions=0;
    for(const action of element.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])')) {
      if(action.disabled || action.getAttribute('aria-disabled')==='true' || action.getAttribute('aria-hidden')==='true') continue;
      const bounds=action.getBoundingClientRect();
      if(bounds.width>0 && bounds.height>0 && ++actions>=2) return true;
    }
    return false;
  }
  function glyphCandidate(element,root) {
    const helper=globalThis.MediaGlyphs;if(!helper || element.textContent?.trim()) return null;
    if(element.localName!=='svg' && (element.childElementCount>0 ||
        (element.getAttribute('aria-hidden')!=='true' && !['presentation','none'].includes(element.getAttribute('role'))))) return null;
    if(element.getAttribute('aria-label')?.trim() || element.getAttribute('aria-labelledby') || element.getAttribute('alt')?.trim()) return null;
    const rect=element.getBoundingClientRect();
    if(!helper.isControlGlyph(element,rect)) return null;
    const style=getComputedStyle(element);
    if(style.display==='none' || ['hidden','collapse'].includes(style.visibility) || Number(style.opacity)===0 ||
       (style.filter && style.filter!=='none') || (style.maskImage && style.maskImage!=='none')) return null;
    if(element.localName==='svg') {
      if(style.backgroundImage && style.backgroundImage!=='none') return null;
      if(style.backgroundColor && style.backgroundColor!=='transparent' && !/rgba\([^)]*,\s*0\s*\)$/.test(style.backgroundColor)) return null;
      return helper.isDarkSvgGlyph(element,rect,getComputedStyle)?{kind:'svg',key:'svg',root}:null;
    }
    if(element.querySelector?.('svg,img,video,canvas,iframe,object,embed')) return null;
    const match=/^url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^'"()\s\\]+))\s*\)$/i.exec(style.backgroundImage || '');
    if(!match) return null;
    let url;try { url=new URL(match[1]||match[2]||match[3],document.baseURI).href; } catch { return null; }
    if(!/^https?:/.test(url)) return null;
    const safe=value=>typeof value==='string' && !/[;{}]/.test(value)?value:null;
    return {kind:'css',key:url,url,root,size:safe(style.backgroundSize)||'auto',position:safe(style.backgroundPosition)||'0% 0%',repeat:safe(style.backgroundRepeat)||'repeat'};
  }
  function withGlyphStylesDisabled(callback) {
    const sheets=[];
    if(glyphs.size) for(const state of roots.values()) if(state.glyphStyle?.sheet) {
      sheets.push([state.glyphStyle.sheet,state.glyphStyle.sheet.disabled]);state.glyphStyle.sheet.disabled=true;
    }
    try { return callback(); } finally { for(const [sheet,disabled] of sheets) sheet.disabled=disabled; }
  }
  function withAuthoredSvgStyles(currentRoots,callback) {
    // currentColor can inherit an engine-adapted color from outside the SVG,
    // including across a shadow host. Prove SVG glyphs and capture artwork in
    // one authored styling scope; generated ink would alternate glyph/artwork
    // ownership on successive refreshes. This synchronous scope cannot paint.
    const sheets=[];
    for(const root of currentRoots) for(const style of root.querySelectorAll('style.darkreader,style[data-brave-media-theme-style]')) {
      if(style.sheet) {sheets.push([style.sheet,style.sheet.disabled]);style.sheet.disabled=true;}
    }
    try {return callback();} finally {for(const [sheet,disabled] of sheets) sheet.disabled=disabled;}
  }
  function ownGlyph(element,candidate) {
    let lock=glyphs.get(element);
    if(!lock) {lock={previous:previousAttribute(element,GLYPH_ATTR)};lock.id=nextLockId(lock.previous);}
    Object.assign(lock,candidate);glyphs.set(element,lock);
    if(element.getAttribute(GLYPH_ATTR)!==lock.id) element.setAttribute(GLYPH_ATTR,lock.id);
  }
  function refreshBitmapGlyphs(currentRoots) {
    if(!globalThis.MediaGlyphs) return false;
    let changed=false;const current=new Set();
    const inspect=(element,root)=>{
      const candidate=glyphCandidate(element,root);if(!candidate) return;
      const existing=glyphs.get(element);
      if(existing?.key===candidate.key) {
        ownGlyph(element,candidate);current.add(element);return;
      }
      if(pendingGlyphs.get(element)?.key===candidate.key) return;
      const token={key:candidate.key};pendingGlyphs.set(element,token);
      globalThis.MediaGlyphs.loadDarkGlyph(candidate.url).then(proven=>{
        if(!proven || disposed || !enabled || element.isConnected===false || pendingGlyphs.get(element)!==token || !roots.has(root)) return;
        const latest=withGlyphStylesDisabled(()=>glyphCandidate(element,root));
        if(!latest || latest.key!==candidate.key) return;
        ownGlyph(element,latest);writeOwnedStyles();backdropChanged?.();
      }).catch(()=>{}).finally(()=>{if(pendingGlyphs.get(element)===token) pendingGlyphs.delete(element);});
    };
    withGlyphStylesDisabled(()=>{
      for(const root of currentRoots) for(const element of nodesOf(root)) {
        if(element.localName!=='svg') inspect(element,root);
      }
    });
    for(const [element,lock] of glyphs) if(lock.kind!=='svg' && !current.has(element)) {restoreAttribute(element,lock,GLYPH_ATTR);glyphs.delete(element);changed=true;}
    return changed;
  }
  function refreshSvgGlyphs(candidates) {
    if(!globalThis.MediaGlyphs) return false;
    let changed=false;const current=new Set();
    for(const [element,root] of candidates) {
      const candidate=glyphCandidate(element,root);if(!candidate) continue;
      if(!glyphs.has(element)) changed=true;
      ownGlyph(element,candidate);current.add(element);
    }
    for(const [element,lock] of glyphs) if(lock.kind==='svg' && !current.has(element)) {restoreAttribute(element,lock,GLYPH_ATTR);glyphs.delete(element);changed=true;}
    return changed;
  }
  function hasRoundedFieldShell(element) {
    const isField=['input','textarea','select'].includes(element.localName) || ['textbox','combobox'].includes(element.getAttribute('role'));
    if(!isField || (element.localName==='input' && ['hidden','checkbox','radio','range','color','image','button','submit','reset'].includes(element.type))) return false;
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    const sides=['Top','Right','Bottom','Left'];
    if(!(rect.width>0 && rect.height>0) || sides.some(side=>Number.parseFloat(style[`border${side}Width`])>0)) return false;
    let shell=element.parentElement || element.getRootNode?.()?.host;
    for(let depth=0;shell&&depth<4;depth++,shell=shell.parentElement || shell.getRootNode?.()?.host) {
      const bounds=shell.getBoundingClientRect(),paint=getComputedStyle(shell);
      if(![bounds.left,bounds.top,bounds.right,bounds.bottom,bounds.width,bounds.height,rect.left,rect.top,rect.right,rect.bottom].every(Number.isFinite)) continue;
      if(bounds.width>Math.max(rect.width*2,rect.width+128) || bounds.height>rect.height*2+12 ||
         rect.left<bounds.left-2 || rect.right>bounds.right+2 || rect.top<bounds.top-2 || rect.bottom>bounds.bottom+2) continue;
      const radii=['TopLeft','TopRight','BottomLeft','BottomRight'].map(corner=>Number.parseFloat(paint[`border${corner}Radius`] || paint.borderRadius));
      if(radii.filter(radius=>radius>=6).length<2) continue;
      const visibleBorder=sides.some(side=>{
        if(!(Number.parseFloat(paint[`border${side}Width`])>=.4) || !['solid','double','groove','ridge','inset','outset'].includes(paint[`border${side}Style`])) return false;
        const match=/^rgba?\(([^)]+)\)$/.exec(paint[`border${side}Color`] || '');
        const color=match?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return color?.length>=3 && color.every(Number.isFinite) && Math.max(...color.slice(0,3))>=96 && (color.length===3 || color[3]>.3);
      });
      if(!visibleBorder || paint.display==='none' || ['hidden','collapse'].includes(paint.visibility) || Number(paint.opacity)===0) continue;
      const peers=[...shell.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,select,[role="textbox"],[role="combobox"]')];
      if(peers.some(peer=>peer!==element && !peer.contains?.(element) && !element.contains?.(peer))) continue;
      return true;
    }
    return false;
  }
  function hasVisibleControlBorder(element) {
    // Read borders, never our own generated outline. A visible authored
    // underline is also a valid field boundary; do not surround it with a box.
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    if(!(rect.width>0 && rect.height>0) || style.display==='none' || ['hidden','collapse'].includes(style.visibility) || Number(style.opacity)===0) return false;
    const rgba=value=>{
      const match=/^rgba?\(([^)]+)\)$/.exec(value || '');
      const channels=match?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if(!channels || !channels.every(Number.isFinite) || ![3,4].includes(channels.length)) return null;
      return [...channels.slice(0,3),channels[3] ?? 1];
    };
    const canvas=theme.darkSchemeBackgroundColor.slice(1).match(/../g).map(channel=>parseInt(channel,16));
    const fill=rgba(style.backgroundColor),background=fill ? fill.slice(0,3).map((channel,i)=>channel*fill[3]+canvas[i]*(1-fill[3])) : canvas;
    return ['Top','Right','Bottom','Left'].some(side=>{
      if(!(Number.parseFloat(style[`border${side}Width`])>=.4) || !['solid','dotted','dashed','double','groove','ridge','inset','outset'].includes(style[`border${side}Style`])) return false;
      const color=rgba(style[`border${side}Color`]);
      return color && color[3]>0 && Math.max(...color.slice(0,3).map((channel,i)=>Math.abs(channel-background[i])*color[3]))>=24;
    });
  }
  function hasDefaultNativeBevel(element) {
    if(!['input','button','textarea','select'].includes(element.localName) ||
       element.localName==='input' && ['hidden','range','color','image','checkbox','radio','file'].includes(element.type)) return false;
    // This fingerprint belongs to Chromium's default native bevel. Explicit
    // styled borders, colored edges and appearance:none remain authored.
    if(/(?:^|;)\s*(?:border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?|(?:-webkit-)?appearance)\s*:/i.test(element.getAttribute('style') || '')) return false;
    const paint=getComputedStyle(element);
    if(!['auto','button','textfield','textarea','menulist','menulist-button'].includes(paint.appearance)) return false;
    const sides=['Top','Right','Bottom','Left'],kind=paint.borderTopStyle;
    if(!['inset','outset'].includes(kind)) return false;
    // At fractional browser/output scale the default 2px bevel is reported
    // after physical-pixel rounding: 3 / 1.85546875 = 1.61684 CSS pixels.
    // Recognize that same native border without changing its layout width.
    const dpr=Number(globalThis.devicePixelRatio),scale=Number.isFinite(dpr)&&dpr>0?dpr:1;
    const snappedWidth=Math.floor(2*scale)/scale;
    return sides.every(side=>{
      const width=Number.parseFloat(paint[`border${side}Width`]);
      if(paint[`border${side}Style`]!==kind || ![2,snappedWidth].some(expected=>Math.abs(width-expected)<=.01)) return false;
      const match=/^rgba?\(([^)]+)\)$/.exec(paint[`border${side}Color`] || '');
      const color=match?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return color && [3,4].includes(color.length) && color.every(Number.isFinite) && (color[3] ?? 1)===1 &&
        Math.max(...color.slice(0,3))-Math.min(...color.slice(0,3))<=12;
    });
  }
  function isStructuralSurface(element,style,viewport) {
    const roles=node=>(node.getAttribute('role') || '').split(/\s+/);
    if(!['block','flex','inline-flex','grid','inline-grid','flow-root','list-item'].includes(style.display) ||
       ['hidden','collapse'].includes(style.visibility) || Number(style.opacity)===0 ||
       style.backgroundImage && style.backgroundImage!=='none' || style.mixBlendMode && style.mixBlendMode!=='normal' ||
       ['maskImage','filter','backdropFilter'].some(key=>style[key] && style[key]!=='none')) return false;
    const fill=/^rgba?\(([^)]+)\)$/.exec(style.backgroundColor || '')?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if(!fill || ![3,4].includes(fill.length) || !fill.every(Number.isFinite) || fill[3]===0) return false;
    const rect=element.getBoundingClientRect();
    if(![rect.width,rect.height,viewport.innerWidth].every(Number.isFinite) || rect.width<=0 || rect.height<=0) return false;
    const ownRoles=roles(element);
    const structural=['html','body','main','header','nav','footer','aside','section','article'].includes(element.localName) ||
      ownRoles.some(role=>['main','banner','navigation','contentinfo','complementary','tablist'].includes(role));
    const tabs=element.localName==='li' && ownRoles.includes('presentation') &&
      !!element.querySelector?.('[role~="tab"]');
    const actions=!!element.querySelector?.('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[role="textbox"],[role="combobox"]');
    const wide=element.localName==='div' && rect.width>=viewport.innerWidth*.8 &&
      (rect.height>=64 || rect.height>=32 && (['fixed','sticky'].includes(style.position) || actions));
    if(!(structural || tabs || wide) || !(element.textContent?.trim() || actions)) return false;
    // These are background owners, not guesses about arbitrary colored pixels.
    // State/actions, status paint and meaningful artwork retain their colors.
    for(let node=element;node;node=node.assignedSlot || node.parentElement || node.getRootNode?.()?.host) {
      if(['a','button','input','textarea','select','option','meter','progress','img','video','canvas','svg','object','embed','iframe','picture','figure'].includes(node.localName) ||
         roles(node).some(role=>['button','link','tab','option','checkbox','radio','switch','textbox','combobox','status','alert','alertdialog','progressbar','meter','img','figure'].includes(role)) ||
         ['aria-selected','aria-pressed','aria-checked'].some(name=>node.getAttribute(name)==='true')) return false;
    }
    return true;
  }
  function matchingLabelFills(currentRoots,owners) {
    const candidates=new Map(),fresh=[];
    const attrs=node=>['id','class','aria-selected','aria-pressed','aria-checked'].map(name=>node.getAttribute(name)).concat(signature(node.getAttribute('style')));
    for(const {owner,root} of owners) {
      if(root.adoptedStyleSheets?.length) continue; // Authored/owned adopted CSS cannot be separated here.
      let bounded=0;
      for(const label of owner.querySelectorAll('span,div')) {
        const text=(label.textContent || '').trim();
        if(!text || text.length>128 || ++bounded>16 ||
           (label.getAttribute('role') || '').split(/\s+/).some(role=>['img','figure','button','textbox','combobox','checkbox','radio','switch'].includes(role)) ||
           label.querySelector?.('svg,img,video,canvas,object,embed,iframe,figure,picture,input,textarea,select,button,a,[role="img"],[role="button"],[role="textbox"],[role="combobox"]')) continue;
        let ancestor=label.parentElement,depth=0,nested=false;
        while(ancestor&&ancestor!==owner&&depth++<4) {
          if(ancestor.localName==='button' || ['button','tab','checkbox','radio','switch','option'].includes(ancestor.getAttribute('role'))) nested=true;
          ancestor=ancestor.parentElement;
        }
        if(ancestor!==owner || nested) continue;
        const key=JSON.stringify([labelFillRevision,attrs(owner),attrs(label),!!owner.matches?.(':hover'),!!owner.matches?.(':focus-visible')]),cache=labelFillCache.get(label);
        const entry=cache?.key===key?cache:{key,owner,root,matched:false};
        candidates.set(label,entry);if(entry!==cache)fresh.push([label,entry]);
      }
    }
    if(fresh.length) {
      const sheets=[];
      // Capture only newly selected/source-changed plain labels. No generated
      // sheet is toggled on unrelated typing or an unchanged refresh.
      for(const root of currentRoots)for(const style of root.querySelectorAll('style.darkreader,style[data-brave-media-theme-style]'))if(style.sheet){sheets.push([style.sheet,style.sheet.disabled]);style.sheet.disabled=true;}
      const rgba=value=>{const match=/^rgba?\(([^)]+)\)$/.exec(value || '');if(!match)return null;const channels=match[1].split(/[,\s/]+/).filter(Boolean).map(Number);if(channels.length===3)channels.push(1);return channels.length===4&&channels.every(Number.isFinite)?channels:null;};
      try {
        for(const [label,entry] of fresh) {
          const child=getComputedStyle(label),parent=getComputedStyle(entry.owner);
          if((child.backgroundImage && child.backgroundImage!=='none') || (parent.backgroundImage && parent.backgroundImage!=='none')) continue;
          const a=rgba(child.backgroundColor),b=rgba(parent.backgroundColor);
          entry.matched=!!a&&!!b&&a[3]>.3&&Math.max(...a.slice(0,3))-Math.min(...a.slice(0,3))<=12&&a.every((value,i)=>Math.abs(value-b[i])<.001);
        }
      } finally {for(const [sheet,disabled] of sheets)sheet.disabled=disabled;}
    }
    labelFillCache.clear();for(const [label,entry]of candidates)labelFillCache.set(label,entry);
    for(const [label,lock]of labelFills)if(!candidates.get(label)?.matched){restoreAttribute(label,lock,LABEL_FILL_ATTR);labelFills.delete(label);}
    for(const [label,entry]of candidates)if(entry.matched){
      if(!labelFills.has(label))labelFills.set(label,{id:'true',previous:label.getAttribute(LABEL_FILL_ATTR)});
      if(label.getAttribute(LABEL_FILL_ATTR)!=='true')label.setAttribute(LABEL_FILL_ATTR,'true');
    }
  }
  function refreshControls(currentRoots) {
    // Read native border source independently of its adaptation. Keeping this
    // small sheet separate avoids toggling unrelated page/theme declarations
    // and prevents a normalized solid edge from alternating with its bevel.
    const sheets=[];
    for(const state of roots.values()) if(state.nativeStyle?.sheet) {sheets.push([state.nativeStyle.sheet,state.nativeStyle.sheet.disabled]);state.nativeStyle.sheet.disabled=true;}
    try { classifyControls(currentRoots); } finally {for(const [sheet,disabled] of sheets)sheet.disabled=disabled;}
  }
  function classifyControls(currentRoots) {
    const currentIcons = new Set(), currentIndicators = new Map(), currentCompact = new Set(), currentPopups = new Set(), currentContained = new Set(), currentBoundaries = new Map(), selectedOwners=[];
    for(const root of currentRoots) for(const element of nodesOf(root)) {
      if((element.localName==='button' || ['button','tab','checkbox','radio','switch','option'].includes(element.getAttribute('role'))) &&
        ['aria-selected','aria-pressed','aria-checked'].some(name=>element.getAttribute(name)==='true'))selectedOwners.push({owner:element,root});
      if(hasRoundedFieldShell(element)) currentContained.add(element);
      if(isCompactAnchor(element)) currentCompact.add(element);
      if(isElevatedPopup(element)) currentPopups.add(element);
      const boundaryControl=['input','textarea','select','button','dialog'].includes(element.localName) ||
        ['button','tab','checkbox','radio','switch','textbox','combobox','dialog','alertdialog','menu','listbox'].includes(element.getAttribute('role')) || currentCompact.has(element);
      if(boundaryControl && hasVisibleControlBorder(element)) currentBoundaries.set(element,{root,nativeBorder:hasDefaultNativeBevel(element)});
      if(element.getAttribute?.('aria-expanded')==='true' && ['true','menu','listbox','tree','grid','dialog'].includes(element.getAttribute('aria-haspopup'))) {
        for(const id of (element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)) {
          const target=root.getElementById?.(id);
          if(!target || target.isConnected===false || target.getAttribute('aria-hidden')==='true') continue;
          const role=target.getAttribute('role');
          if(!['menu','listbox','tree','grid','dialog'].includes(role) && !target.querySelector?.('[role="menu"],[role="listbox"],[role="tree"],[role="grid"],[role="dialog"]') && !target.hasAttribute?.('popover')) continue;
          const style=getComputedStyle(target),rect=target.getBoundingClientRect();
          if(style.display!=='none' && style.visibility!=='hidden' && rect.width>0 && rect.height>0) currentPopups.add(target);
        }
      }
      const isButton=element.localName==='button' || element.getAttribute?.('role')==='button';
      if(isButton && element.localName!=='input' && !(element.textContent || '').trim() &&
          (element.getAttribute?.('aria-label')?.trim() || element.getAttribute?.('title')?.trim() || element.querySelector?.('svg,img'))) currentIcons.add(element);
      if(element.localName!=='label') continue;
      const control=element.control || root.getElementById?.(element.getAttribute('for'));
      if(!control || control.localName!=='input' || !['checkbox','radio'].includes(control.type)) continue;
      const rect=control.getBoundingClientRect();
      const style=getComputedStyle(control);
      const hidden=(rect.width<=2 && rect.height<=2) || style.display==='none' || style.visibility==='hidden' || Number(style.opacity)===0 ||
        rect.right<=0 || rect.bottom<=0 || rect.left>=globalThis.innerWidth || rect.top>=globalThis.innerHeight;
      if(!hidden) continue;
      for(const pseudo of ['before','after']) {
        const paint=getComputedStyle(element,`::${pseudo}`);
        const width=Number.parseFloat(paint.width),height=Number.parseFloat(paint.height);
        if(!['""',"''"].includes(paint.content) || !/(?:url|image-set)\s*\(/i.test(paint.backgroundImage || '') ||
            !Number.isFinite(width) || !Number.isFinite(height) || Math.min(width,height)<8 || Math.max(width,height)>32 || Math.abs(width-height)>2) continue;
        currentIndicators.set(element,`${pseudo}-${control.type}-${control.checked?'checked':'unchecked'}`);
        break;
      }
    }
    matchingLabelFills(currentRoots,selectedOwners);
    for(const element of currentPopups) {
      let ancestor=element.parentElement;
      while(ancestor) {
        if(currentPopups.has(ancestor)) {currentPopups.delete(element);break;}
        ancestor=ancestor.parentElement;
      }
      if(currentPopups.has(element) && hasVisibleControlBorder(element)) currentBoundaries.set(element,{root:element.getRootNode?.() || document,nativeBorder:false});
    }
    for(const [element,lock] of boundaries) if(!currentBoundaries.has(element)) {restoreAttribute(element,lock,BOUNDARY_ATTR);boundaries.delete(element);}
    for(const [element,paint] of currentBoundaries) {
      if(!boundaries.has(element)) {const previous=previousAttribute(element,BOUNDARY_ATTR);boundaries.set(element,{id:nextLockId(previous),previous});}
      const lock=boundaries.get(element);
      Object.assign(lock,paint);
      if(element.getAttribute(BOUNDARY_ATTR)!==lock.id) element.setAttribute(BOUNDARY_ATTR,lock.id);
    }
    for(const [element,lock] of containedFields) if(!currentContained.has(element)) {restoreAttribute(element,lock,CONTAINED_FIELD_ATTR);containedFields.delete(element);}
    for(const element of currentContained) {
      if(!containedFields.has(element)) containedFields.set(element,{id:'true',previous:element.getAttribute(CONTAINED_FIELD_ATTR)});
      if(element.getAttribute(CONTAINED_FIELD_ATTR)!=='true') element.setAttribute(CONTAINED_FIELD_ATTR,'true');
    }
    for(const [element,lock] of icons) if(!currentIcons.has(element)) {restoreAttribute(element,lock,ICON_ATTR);icons.delete(element);}
    for(const element of currentIcons) {
      if(!icons.has(element)) icons.set(element,{id:'true',previous:element.getAttribute(ICON_ATTR)});
      if(element.getAttribute(ICON_ATTR)!=='true') element.setAttribute(ICON_ATTR,'true');
    }
    for(const [element,lock] of indicators) if(!currentIndicators.has(element)) {restoreAttribute(element,lock,CHECK_ATTR);indicators.delete(element);}
    for(const [element,id] of currentIndicators) {
      let lock=indicators.get(element);
      if(!lock) {lock={id,previous:element.getAttribute(CHECK_ATTR)};indicators.set(element,lock);}else lock.id=id;
      if(element.getAttribute(CHECK_ATTR)!==id) element.setAttribute(CHECK_ATTR,id);
    }
    for(const [element,lock] of compactButtons) if(!currentCompact.has(element)) {restoreAttribute(element,lock,COMPACT_ATTR);compactButtons.delete(element);}
    for(const element of currentCompact) {
      if(!compactButtons.has(element)) compactButtons.set(element,{id:'true',previous:element.getAttribute(COMPACT_ATTR)});
      if(element.getAttribute(COMPACT_ATTR)!=='true') element.setAttribute(COMPACT_ATTR,'true');
    }
    for(const [element,lock] of popupPanels) if(!currentPopups.has(element)) {restoreAttribute(element,lock,POPUP_ATTR);popupPanels.delete(element);}
    for(const element of currentPopups) {
      if(!popupPanels.has(element)) popupPanels.set(element,{id:'true',previous:element.getAttribute(POPUP_ATTR)});
      if(element.getAttribute(POPUP_ATTR)!=='true') element.setAttribute(POPUP_ATTR,'true');
    }
  }
  function refreshArtwork() {
    if (!enabled || disposed) return;
    // Publish current media geometry before the semantic pass can spend a frame
    // reading authored styles. Its native protection must not await this work.
    beforeRefresh?.();
    if (!enabled || disposed) return;
    const startedAt=Date.now();let phaseAt=startedAt;const phases={};
    const phase=name=>{const now=Date.now();phases[name]=now-phaseAt;phaseAt=now;};
    const currentRoots = allRoots(), artwork = new Map(), backdropCandidates = new Map(), currentBackdrops = new Map(), surfaceCandidates = new Map(), currentSurfaces = new Map(), liveNodes = new Set();
    phase('roots');refreshControls(currentRoots);phase('controls');
    let glyphChanged=refreshBitmapGlyphs(currentRoots);phase('glyphs');
    let newlyPending = false;
    const geometry = globalThis.MediaGeometry;
    const viewport = { innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
      elementsFromPoint: document.elementsFromPoint?.bind(document) };
    for (const root of currentRoots) for (const node of nodesOf(root)) {
      liveNodes.add(node);
      const paint=getComputedStyle(node);
      const cssImage = geometry?.hasMediaBackground(paint.backgroundImage) ?? false;
      if((['html','body','main','header','nav','footer','aside','section','article','div','li'].includes(node.localName) ||
          /(?:^|\s)(?:main|banner|navigation|contentinfo|complementary|tablist)(?:\s|$)/.test(node.getAttribute('role') || '')) &&
         (surfaces.has(node) || paint.backgroundColor && paint.backgroundColor!=='transparent' && !/^rgba\([^)]*,\s*0\s*\)$/.test(paint.backgroundColor))) surfaceCandidates.set(node,root);
      if (geometry && (cssImage || backdrops.has(node) || node.localName === 'img')) {
        const rect = node.getBoundingClientRect();
        const fullPage = [viewport.innerWidth, viewport.innerHeight, rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
          rect.left <= 2 && rect.top <= 2 && rect.right >= viewport.innerWidth - 2 && rect.bottom >= viewport.innerHeight - 2;
        if (fullPage || node.localName === 'html' || node.localName === 'body' || node.localName === 'img' || backdrops.has(node)) backdropCandidates.set(node,{root,rect});
      }
    }
    phase('backgrounds');
    const svgCandidates=[];
    for(const root of currentRoots) for(const svg of root.querySelectorAll('svg')) svgCandidates.push([svg,root]);
    phase('artworkDiscovery');
    const captureBackgrounds=()=>{
      // Classification sees authored background images and actual layer order,
      // even after our previous pass hid a wallpaper. No paint occurs between
      // disabling owned styles and restoring them in this synchronous scope.
      for (const [node,{root,rect}] of backdropCandidates) {
        const image = geometry.isDecorativeWallpaperImage(node,rect,getComputedStyle,viewport);
        if (!image && !geometry.isDecorativePageBackground(node,rect,getComputedStyle,viewport)) continue;
        let lock=backdrops.get(node);
        if (!lock) {const previous=previousAttribute(node,BACKDROP_ATTR);lock={id:nextLockId(previous),previous,root};}
        lock.root=root;lock.kind=image?'image':'css';lock.pending=false;lock.releaseToken=null;
        currentBackdrops.set(node,lock);
      }
      for(const [node,root] of surfaceCandidates) {
        if(!isStructuralSurface(node,getComputedStyle(node),viewport)) continue;
        let lock=surfaces.get(node);
        if(!lock) {const previous=previousAttribute(node,SURFACE_ATTR);lock={id:nextLockId(previous),previous,root};}
        lock.root=root;currentSurfaces.set(node,lock);
      }
    };
    if(svgCandidates.length) withAuthoredSvgStyles(currentRoots,()=>{
      // Glyph proof and remaining artwork's inherited currentColor share the
      // same authored paint. Restore generated sheets once after both reads.
      const svgChanged=refreshSvgGlyphs(svgCandidates);glyphChanged ||= svgChanged;
      for(const [svg,root] of svgCandidates) {
        // Only positive authored proof can remove an SVG from media protection.
        if(glyphs.has(svg) && svg.getAttribute(GLYPH_ATTR)===glyphs.get(svg).id) continue;
        for(const node of [svg,...svg.querySelectorAll('*')]) artwork.set(node,root);
      }
      if(artwork.size) captureBackgrounds();
      for(const [node,root] of artwork) {
        let lock=locks.get(node);
        if (!lock) {
          const previous=previousAttribute(node,ATTR);lock={id:nextLockId(previous),previous,root,color:null};
          locks.set(node,lock);
        }
        const color=getComputedStyle(node).color;
        lock.color=/[;{}]/.test(color) ? null : color;
        lock.root=root;
        authoredStyles.set(node,signature(node.getAttribute('style')));
      }
    });
    else {const svgChanged=refreshSvgGlyphs(svgCandidates);glyphChanged ||= svgChanged;}
    if(!artwork.size) {
      // With no remaining SVG artwork, backgrounds retain the existing narrow
      // source scope: engine paint stays on, only our prior canvas/hiding is off.
      const sheets=[];
      if((backdrops.size && backdropCandidates.size) || surfaces.size) {
        for(const state of roots.values()) if(state.style?.sheet) {
          sheets.push([state.style.sheet,state.style.sheet.disabled]);state.style.sheet.disabled=true;
        }
      }
      try {captureBackgrounds();} finally {for(const [sheet,disabled] of sheets) sheet.disabled=disabled;}
    }
    phase('sourceCapture');
    let surfaceChanged=false;
    for(const [node,lock] of surfaces) if(!currentSurfaces.has(node)) {restoreAttribute(node,lock,SURFACE_ATTR);surfaceChanged=true;}
    for(const [node,lock] of currentSurfaces) if(!surfaces.has(node) || node.getAttribute(SURFACE_ATTR)!==lock.id) surfaceChanged=true;
    surfaces.clear();for(const [node,lock] of currentSurfaces) surfaces.set(node,lock);
    for (const [node,lock] of backdrops) if(!currentBackdrops.has(node)) {
      if (!liveNodes.has(node)) { restoreAttribute(node,lock,BACKDROP_ATTR); continue; }
      // Keep the original hiding/canvas rule until native media geometry has
      // explicitly accepted a snapshot protecting this newly meaningful artwork.
      if (!lock.pending) { lock.pending=true;lock.releaseToken=nextLockId();newlyPending=true; }
      currentBackdrops.set(node,lock);
    }
    backdrops.clear();
    for (const [node,lock] of currentBackdrops) backdrops.set(node,lock);
    for (const [node,lock] of locks) if(!artwork.has(node)) { restoreAttribute(node,lock); locks.delete(node); }
    // Reconcile after updating lock ownership: artwork moved to a live root
    // keeps its lock, while detached roots release their strong references.
    const liveRoots = new Set(currentRoots);
    for (const [root,state] of roots) if(!liveRoots.has(root)) {
      state.observer.disconnect();
      state.style?.remove();state.glyphStyle?.remove();state.nativeStyle?.remove();
      roots.delete(root);
      engineRoots.delete(root);
      ownershipWatchers.get(root)?.disconnect();ownershipWatchers.delete(root);
    }
    for (const [node,lock] of locks) if(node.getAttribute(ATTR)!==lock.id) node.setAttribute(ATTR,lock.id);
    for (const [node,lock] of backdrops) if(node.getAttribute(BACKDROP_ATTR)!==lock.id) node.setAttribute(BACKDROP_ATTR,lock.id);
    for(const [node,lock] of surfaces) if(node.getAttribute(SURFACE_ATTR)!==lock.id) node.setAttribute(SURFACE_ATTR,lock.id);
    writeOwnedStyles();
    phase('publication');lastRefreshPhases=Object.freeze(phases);
    lastRefreshDuration=Date.now()-startedAt;
    if (newlyPending || glyphChanged || surfaceChanged) backdropChanged?.();
  }
  function writeOwnedStyles() {
    if(!enabled || disposed) return;
    for (const [root,state] of roots) {
      const parent=root===document ? document.head || document.documentElement : root;
      if(!parent || root!==document && root.isConnected===false) continue;
      const artworkCSS=[...locks.values()].filter(lock=>lock.root===root && lock.color)
        .map(lock=>`[${ATTR}="${lock.id}"]{color:${lock.color}!important}`).join('\n');
      const backdropCSS=[...backdrops.values()].filter(lock=>lock.root===root)
        .map(lock=>`[${BACKDROP_ATTR}="${lock.id}"]{${lock.kind==='image'?'visibility:hidden!important':`background-image:none!important;background-color:${theme.darkSchemeBackgroundColor}!important`}}`).join('\n');
      const surfaceCSS=[...surfaces.values()].filter(lock=>lock.root===root)
        .map(lock=>`[${SURFACE_ATTR}="${lock.id}"]{background-color:${theme.darkSchemeBackgroundColor}!important}`).join('\n');
      const nativeBorderCSS=[...boundaries.values()].filter(lock=>lock.root===root && lock.nativeBorder)
        .map(lock=>`[${BOUNDARY_ATTR}="${lock.id}"]{border-style:solid!important;border-color:rgba(160,160,160,.35)!important}`).join('\n');
      const glyphCSS=[...glyphs.values()].filter(lock=>lock.root===root).map(lock=>{
        const selector=`[${GLYPH_ATTR}="${lock.id}"]`;
        if(lock.kind==='svg') return `${selector}{filter:brightness(0) invert(1)!important}`;
        const url=lock.url.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
        return `${selector}{background-image:none!important;background-color:${theme.darkSchemeTextColor}!important;mask-image:url("${url}")!important;mask-mode:alpha!important;mask-size:${lock.size}!important;mask-position:${lock.position}!important;mask-repeat:${lock.repeat}!important}`;
      }).join('\n');
      // Glyph source reads must not toggle unrelated wallpaper/artwork rules.
      // Separate sheets keep those ownership declarations stable during proof.
      for(const [key,css] of [['style',[artworkCSS,backdropCSS,surfaceCSS].filter(Boolean).join('\n')],['glyphStyle',glyphCSS],['nativeStyle',nativeBorderCSS]]) {
        if(!state[key] && css) {
          state[key]=document.createElement('style');state[key].classList.add('darkreader');state[key].setAttribute(STYLE_ATTR,key);state[key].setAttribute(STYLE_OWNER_ATTR,ownerId);
        }
        if(state[key] && state[key].textContent!==css) state[key].textContent=css;
        // An older isolated engine can remove another controller's generated
        // sheets during takeover. Ownership includes attachment to this live
        // root, even when the retained sheet's CSS text is already current.
        if(state[key] && state[key].parentNode!==parent) parent.appendChild(state[key]);
      }
    }
  }
  function pendingBackdropMedia() {
    return [...backdrops].filter(([,lock])=>lock.pending).map(([element,lock])=>({element,token:lock.releaseToken}));
  }
  function acceptBackdropMedia(entries) {
    let changed=false;
    for (const {element,token,rect} of entries || []) {
      const lock=backdrops.get(element);
      if (!lock?.pending || lock.releaseToken!==token) continue;
      const current=element.getBoundingClientRect();
      if (!['left','top','right','bottom'].every(key=>current[key]===rect[key])) continue;
      restoreAttribute(element,lock,BACKDROP_ATTR);backdrops.delete(element);changed=true;
    }
    if (changed) { writeOwnedStyles();backdropChanged?.(); }
    return changed;
  }

  function restoreAttribute(node,lock,attribute=ATTR) {
    if(node.getAttribute(attribute)!==lock.id) return;
    if(lock.previous===null) node.removeAttribute(attribute);else node.setAttribute(attribute,lock.previous);
  }
  function schedule() {
    if(!enabled || disposed || scheduled) return;
    scheduled=true;
    frame=requestAnimationFrame(()=>{scheduled=false;frame=null;refreshArtwork();});
  }
  function controlCSS(accent,foreground) {
    // Shape/layout stay authored. Outlines paint above authored child fills and distinguish interactive
    // fields and controls without adding borders to every layout container.
    const field=':where(input:not([type="hidden"]):not([type="range"]):not([type="color"]):not([type="image"]),textarea,select,[role="textbox"],[role="combobox"])';
    const button=`:where(button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[${COMPACT_ATTR}])`;
    const popup=`:is(:where(dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[popover]:popover-open):not(:where([${POPUP_ATTR}] *)),:where([${POPUP_ATTR}]))`;
    const safe=':not(svg):not(svg *)';
    const selected=':where([aria-selected="true"],[aria-pressed="true"],[aria-checked="true"],option:checked)';
    const boundary='rgba(160,160,160,.35)',hoverBoundary='rgba(160,160,160,.45)';
    return `${field}:not(:where([${CONTAINED_FIELD_ATTR}])):not(:where([${BOUNDARY_ATTR}]))${safe}{outline:1px solid ${boundary}!important;outline-offset:0!important}
${field}${safe}{caret-color:${foreground}!important}
:where([${CONTAINED_FIELD_ATTR}])${safe}{outline:none!important}
${button}:not(:where([${ICON_ATTR}])):not(:where([${BOUNDARY_ATTR}]))${safe}{outline:1px solid ${boundary}!important;outline-offset:0!important}
:where([${ICON_ATTR}])${safe}{outline:none!important}
:where([${BOUNDARY_ATTR}])${safe}{outline:none!important}
:where(input[type="checkbox"],input[type="radio"],input[type="range"]){accent-color:${accent}!important}
${button}${safe}:where(:hover:not(:disabled):not([aria-disabled="true"])){background-color:${theme.darkSchemeBackgroundColor}!important}
${button}${safe}:where(:hover:not(:disabled):not([aria-disabled="true"])):not(:where([${BOUNDARY_ATTR}])){outline:1px solid ${hoverBoundary}!important;outline-offset:0!important}
:where([${LABEL_FILL_ATTR}])${safe}{background-color:transparent!important}
${selected}${safe}{background-color:${theme.darkSchemeBackgroundColor}!important;color:${foreground}!important;outline:1px solid ${accent}!important;outline-offset:0!important}
${button}${safe}:focus-visible:not(:disabled):not([aria-disabled="true"]),${field}${safe}:focus-visible{outline:2px solid ${accent}!important;outline-offset:1px!important}
${popup}${safe}{background-color:${theme.darkSchemeBackgroundColor}!important;box-shadow:0 12px 28px rgba(0,0,0,.45)!important}
${popup}:not(:where([${BOUNDARY_ATTR}]))${safe}{outline:1px solid ${boundary}!important;outline-offset:0!important}
${field}${safe}::placeholder{color:#b8b8b8!important}
:where([${CHECK_ATTR}^="before-"])::before,:where([${CHECK_ATTR}^="after-"])::after{box-shadow:inset 0 0 0 1px #b8b8b8!important;opacity:1!important}
:where([${CHECK_ATTR}="before-checkbox-checked"],[${CHECK_ATTR}="before-radio-checked"])::before,:where([${CHECK_ATTR}="after-checkbox-checked"],[${CHECK_ATTR}="after-radio-checked"])::after{background-color:${accent}!important;box-shadow:inset 0 0 0 1px ${accent}!important}
:where([${CHECK_ATTR}^="before-radio-"])::before,:where([${CHECK_ATTR}^="after-radio-"])::after{border-radius:50%!important}
${button}${safe}:where(:disabled,[aria-disabled="true"]){color:#b8b8b8!important}`;
  }
  function setPalette(palette = {}) {
    if(disposed) return;
    const color = value => {
      if(typeof value !== 'string' || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)) return null;
      const hex=value.slice(1).toLowerCase();
      return `#${hex.length===3 ? [...hex].map(channel=>channel+channel).join('') : hex}`;
    };
    const background = color(palette?.background) || theme.darkSchemeBackgroundColor;
    const foreground = color(palette?.foreground) || theme.darkSchemeTextColor;
    const selection = color(palette?.selection) || '#333333';
    const selectedText = color(palette?.selectionForeground) || foreground;
    const accent = color(palette?.accent) || '#bbbbbb';
    const nextKey = [background,foreground,selection,selectedText,accent].join('|');
    const changed = nextKey!==paletteKey;
    if(changed) {
      theme.darkSchemeBackgroundColor=background;
      theme.darkSchemeTextColor=foreground;
      const focus = `:focus-visible{outline-color:${accent}!important}`;
      // The engine retains its previous fixes by reference. Publishing a fresh
      // snapshot lets it detect changed control/selection CSS correctly.
      fixes={...fixes,css:`::selection{background-color:${selection}!important;color:${selectedText}!important}\n${focus}\n${controlCSS(accent,foreground)}`};
      paletteKey=nextKey;
    }
    if(enabled) {
      if (isPdfDocument()) disable();
      else if(changed) { pageEngine.enable(theme,fixes);schedule(); }
    }
  }
  function isPdfDocument() {
    return String(document.contentType || '').split(';',1)[0].trim().toLowerCase() === 'application/pdf';
  }
  function enable(palette) {
    if(disposed) return false;
    if(!ownsDocument()) {dispose();return false;}
    // Chromium's native PDF viewer is a closed guest, not authored page UI.
    if (isPdfDocument()) { disable();return false; }
    if(palette || !fixes.css) setPalette(palette);
    if(enabled || disposed) {
      // A page enabled while hidden can become visible before its event is
      // delivered. Complete that deferred startup without republishing palette.
      if(enabled) pageEngine.completeInitialization?.();
      return enabled;
    }
    if(!pageEngine) throw new Error('Bundled page theme engine unavailable');
    enabled=true;
    try {
      refreshArtwork();
      if(!enabled || disposed) return false;
      // Image analysis is disabled; this fetch hook serves stylesheet text only.
      pageEngine.setFetchMethod(fetchMethod || (url=>fetch(url,{credentials:'same-origin'})));
      pageEngine.enable(theme,fixes);
      schedule();
      return true;
    } catch(error) { disable();throw error; }
  }
  function disable() {
    if(disposed) return;
    enabled=false;
    if(frame!==null) cancelAnimationFrame(frame);
    frame=null;scheduled=false;
    for(const state of roots.values()) state.observer.disconnect();
    if(pageEngine?.isEnabled()) pageEngine.disable();
    for(const [attribute,map] of markerMaps) for(const [node,lock] of map) {
      let source=markerSources.get(node);if(!source) {source=new Map();markerSources.set(node,source);}source.set(attribute,lock.previous);
    }
    for(const [node,lock] of locks) restoreAttribute(node,lock);
    for(const [node,lock] of backdrops) restoreAttribute(node,lock,BACKDROP_ATTR);
    for(const [node,lock] of icons) restoreAttribute(node,lock,ICON_ATTR);
    for(const [node,lock] of indicators) restoreAttribute(node,lock,CHECK_ATTR);
    for(const [node,lock] of compactButtons) restoreAttribute(node,lock,COMPACT_ATTR);
    for(const [node,lock] of popupPanels) restoreAttribute(node,lock,POPUP_ATTR);
    for(const [node,lock] of glyphs) restoreAttribute(node,lock,GLYPH_ATTR);
    for(const [node,lock] of containedFields) restoreAttribute(node,lock,CONTAINED_FIELD_ATTR);
    for(const [node,lock] of labelFills) restoreAttribute(node,lock,LABEL_FILL_ATTR);
    for(const [node,lock] of boundaries) restoreAttribute(node,lock,BOUNDARY_ATTR);
    for(const [node,lock] of surfaces) restoreAttribute(node,lock,SURFACE_ATTR);
    for(const state of roots.values()) {state.style?.remove();state.glyphStyle?.remove();state.nativeStyle?.remove();}
    locks.clear();backdrops.clear();icons.clear();indicators.clear();compactButtons.clear();popupPanels.clear();glyphs.clear();pendingGlyphs.clear();containedFields.clear();labelFills.clear();labelFillCache.clear();boundaries.clear();surfaces.clear();roots.clear();engineRoots=new WeakSet();
  }
  const stopSourceChanges=pageEngine?.onSourceChange?.(()=>{labelFillRevision++;schedule();});
  function dispose() {
    if(disposed) return;
    disable();disposed=true;stopSourceChanges?.();backdropChanged=null;beforeRefresh=null;
    for(const watcher of ownershipWatchers.values()) watcher.disconnect();ownershipWatchers.clear();
    document.removeEventListener?.(CLAIM_EVENT,dispose);
    if(claimPublished && ownsDocument()) claim.remove();
    for(const event of ['load','resize','change','transitionrun','animationstart','pointerover','pointerout','focusin']) globalThis.removeEventListener(event,onState,true);
    for(const callback of disposalListeners) callback();disposalListeners.clear();
  }
  const onState = event => {
    if(event.type==='load' && (event.target===document || ['link','style'].includes(event.target?.localName)))labelFillRevision++;
    if(event.type==='change' && !['checkbox','radio'].includes(event.target?.type)) return;
    // Native CSS theming follows ordinary hover/focus itself. Only artwork
    // interactions require recapturing its authored currentColor.
    const path=event.composedPath?.() || [event.target];
    const labelInteraction=[...labelFillCache.values()].some(({owner})=>path.includes(owner));
    if(event.type==='pointerout' && !labelInteraction) return;
    if (['pointerover','pointerout','focusin','transitionrun','animationstart'].includes(event.type) &&
        !labelInteraction && !path.some(node => locks.has(node))) return;
    schedule();
  };
  for(const event of ['load','resize','change','transitionrun','animationstart','pointerover','pointerout','focusin']) globalThis.addEventListener(event,onState,true);
  globalThis.BraveMediaTheme=Object.freeze({version:VERSION,enable,disable,setPalette,discoverRoot,refresh:schedule,isOwnMutation,ownsMutation:isOwnMutation,isDisposed:()=>disposed,
    setFetchMethod(method) { fetchMethod=method; if(enabled) pageEngine.setFetchMethod(method); },
    lastRefreshDurationMs:()=>lastRefreshDuration,lastRefreshPhaseTimings:()=>lastRefreshPhases,isEnabled:()=>enabled,isBackdrop:node=>{const lock=backdrops.get(node);return enabled&&!!lock&&lock.id===node?.getAttribute(BACKDROP_ATTR);},isSurface:node=>{const lock=surfaces.get(node);return enabled&&!!lock&&node?.isConnected!==false&&lock.id===node.getAttribute(SURFACE_ATTR);},isControlGlyph:node=>{const lock=glyphs.get(node);return enabled&&!!lock&&lock.id===node?.getAttribute(GLYPH_ATTR);},pendingBackdropMedia,acceptBackdropMedia,
    setBackdropChanged(callback) { backdropChanged=typeof callback==='function'?callback:null; },
    setBeforeRefresh(callback) { beforeRefresh=typeof callback==='function'?callback:null; },
    onDispose(callback) {if(disposed) {callback();return ()=>{};}disposalListeners.add(callback);return ()=>disposalListeners.delete(callback);},dispose
  });
  globalThis.SemanticTheme=globalThis.BraveMediaTheme;
  document.addEventListener?.(CLAIM_EVENT,dispose);
  // Existing open roots also need legacy cleanup while global transparency is
  // OFF. Newly discovered roots join this ownership boundary when enabled.
  publishClaim();
  watchOwnership(document);
})();
