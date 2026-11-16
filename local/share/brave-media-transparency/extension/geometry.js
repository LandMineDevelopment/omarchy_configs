/* Shared pure geometry; no page content or URLs leave the browser. */
(() => {
  const MAX_RECTS = 128;
  function normalize(boxes, viewport, guard = 2) {
    const { outerWidth: ow, outerHeight: oh, dpr, zoom = 1 } = viewport;
    const iw = viewport.innerWidth * zoom;
    const ih = viewport.innerHeight * zoom;
    if (![iw, ih, ow, oh, dpr, zoom].every(Number.isFinite) || iw <= 0 || ih <= 0 || ow + 2 < iw || oh + 2 < ih || dpr <= 0 || dpr > 8 || zoom <= 0 || zoom > 5) {
      return { valid: false, reason: 'viewport-unknown', rects: [] };
    }
    const widthGap = ow - iw;
    const side = 0;
    const top = Math.max(0, oh - ih);
    if (widthGap > 12 || top < 0 || top > 400) return { valid: false, reason: 'viewport-unknown', rects: [] };
    if (boxes.length > MAX_RECTS) return { valid: false, reason: 'media-overflow', rects: [] };
    const rects = [];
    for (const box of boxes) {
      if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite) || box.right < box.left || box.bottom < box.top) {
        return { valid: false, reason: 'geometry-unknown', rects: [] };
      }
      if (box.right <= 0 || box.bottom <= 0 || box.left * zoom >= iw || box.top * zoom >= ih) continue;
      const left = Math.max(0, box.left * zoom + side - guard);
      const right = Math.min(ow, box.right * zoom + side + guard);
      // Page media is clipped by the content viewport. A partly scrolled-out
      // image must never protect unrelated browser chrome above that viewport.
      const y = Math.max(top, box.top * zoom + top - guard);
      const bottom = Math.min(oh, box.bottom * zoom + top + guard);
      if (right > left && bottom > y) rects.push([left / ow, y / oh, (right - left) / ow, (bottom - y) / oh]);
    }
    return { valid: true, reason: 'settled', rects };
  }
  function videoContentRect(video, rect, readStyle) {
    const fallback = () => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.right - rect.left, height: rect.bottom - rect.top });
    if (![video.videoWidth, video.videoHeight].every(value => Number.isFinite(value) && value > 0)) return fallback();
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode?.()?.host;
    // Bounding boxes cannot map a rotated, skewed, reflected or perspective
    // content rectangle accurately. Preserve the whole video in those cases.
    for (let node = video; node; node = parentOf(node)) {
      const style = readStyle(node);
      if (style.perspective && style.perspective !== 'none') return fallback();
      if (style.rotate && !['none', '0', '0deg'].includes(style.rotate)) return fallback();
      if (style.scale && style.scale !== 'none' && !style.scale.split(/\s+/).every(value => Number.parseFloat(value) > 0)) return fallback();
      if (style.transform && style.transform !== 'none') {
        const matrix = style.transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number);
        if (!matrix || matrix.length !== 6 || !matrix.every(Number.isFinite) || Math.abs(matrix[1]) > 1e-9 || Math.abs(matrix[2]) > 1e-9 || matrix[0] <= 0 || matrix[3] <= 0) return fallback();
      }
    }
    const style = readStyle(video);
    const px = value => value === undefined || value === '' ? 0 : /^[-+]?(?:\d*\.)?\d+(?:px)?$/.test(value) ? Number.parseFloat(value) : NaN;
    const bl = px(style.borderLeftWidth), br = px(style.borderRightWidth), bt = px(style.borderTopWidth), bb = px(style.borderBottomWidth);
    const pl = px(style.paddingLeft), pr = px(style.paddingRight), pt = px(style.paddingTop), pb = px(style.paddingBottom);
    const extraX = bl + br + pl + pr, extraY = bt + bb + pt + pb;
    let borderWidth = px(style.width), borderHeight = px(style.height);
    if (!Number.isFinite(borderWidth) || borderWidth <= 0) borderWidth = video.offsetWidth;
    else if (style.boxSizing !== 'border-box') borderWidth += extraX;
    if (!Number.isFinite(borderHeight) || borderHeight <= 0) borderHeight = video.offsetHeight;
    else if (style.boxSizing !== 'border-box') borderHeight += extraY;
    const cw = borderWidth - extraX, ch = borderHeight - extraY;
    const sx = (rect.right - rect.left) / borderWidth, sy = (rect.bottom - rect.top) / borderHeight;
    if (![cw, ch, sx, sy].every(value => Number.isFinite(value) && value > 0)) return fallback();
    let ow = video.videoWidth, oh = video.videoHeight;
    const fit = style.objectFit || 'fill';
    const contain = Math.min(cw / ow, ch / oh);
    if (fit === 'fill') { ow = cw; oh = ch; }
    else if (fit === 'contain' || fit === 'cover' || fit === 'scale-down') {
      const scale = fit === 'cover' ? Math.max(cw / ow, ch / oh) : fit === 'scale-down' ? Math.min(1, contain) : contain;
      ow *= scale; oh *= scale;
    } else if (fit !== 'none') return fallback();
    function amount(token) {
      let m = token.match(/^([-+]?(?:\d*\.)?\d+)(%|px)$/);
      if (m) return m[2] === '%' ? { p: Number(m[1]) / 100, px: 0 } : { p: 0, px: Number(m[1]) };
      if (token === '0') return { p: 0, px: 0 };
      m = token.match(/^calc\(\s*([-+]?(?:\d*\.)?\d+)%\s*([+-])\s*((?:\d*\.)?\d+)px\s*\)$/);
      return m ? { p: Number(m[1]) / 100, px: Number(m[3]) * (m[2] === '-' ? -1 : 1) } : null;
    }
    function axis(token, vertical) {
      if (token === 'center') return { p: .5, px: 0 };
      if (token === (vertical ? 'top' : 'left')) return { p: 0, px: 0 };
      if (token === (vertical ? 'bottom' : 'right')) return { p: 1, px: 0 };
      return amount(token);
    }
    const tokens = (style.objectPosition || '50% 50%').match(/calc\([^)]*\)|[^\s]+/g) || [];
    let x, y;
    if (tokens.length === 1) {
      if (['top', 'bottom'].includes(tokens[0])) { x = axis('center', false); y = axis(tokens[0], true); }
      else { x = axis(tokens[0], false); y = axis('center', true); }
    } else if (tokens.length === 2) {
      if (['top', 'bottom'].includes(tokens[0]) || ['left', 'right'].includes(tokens[1])) [tokens[0], tokens[1]] = [tokens[1], tokens[0]];
      x = axis(tokens[0], false); y = axis(tokens[1], true);
    } else if (tokens.length === 4) {
      for (let i = 0; i < 4; i += 2) {
        const edge = tokens[i], offset = amount(tokens[i + 1]);
        if (!offset || !['left', 'right', 'top', 'bottom'].includes(edge)) return fallback();
        const value = ['right', 'bottom'].includes(edge) ? { p: 1 - offset.p, px: -offset.px } : offset;
        if (['left', 'right'].includes(edge)) { if (x) return fallback(); x = value; }
        else { if (y) return fallback(); y = value; }
      }
    }
    if (!x || !y) return fallback();
    const originX = rect.left + (bl + pl) * sx, originY = rect.top + (bt + pt) * sy;
    const ox = (cw - ow) * x.p + x.px, oy = (ch - oh) * y.p + y.px;
    const left = Math.max(originX, originX + ox * sx), top = Math.max(originY, originY + oy * sy);
    const right = Math.min(originX + cw * sx, originX + (ox + ow) * sx), bottom = Math.min(originY + ch * sy, originY + (oy + oh) * sy);
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  }
  function clipMediaRect(el, rect, readStyle, paintRoot = null, readGeometry = null) {
    if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return null;
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    const clips = value => ['auto', 'scroll', 'hidden', 'clip'].includes(value);
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode?.()?.host;
    const positioned = style => style.position === 'absolute' ? 'absolute' : style.position === 'fixed' ? 'fixed' : null;
    function establishes(style, kind) {
      const transformed = [style.transform, style.perspective, style.filter, style.backdropFilter].some(value => value && value !== 'none');
      const contained = /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(style.contain || '');
      const anticipated = /(?:^|[,\s])(?:transform|perspective|filter)(?:[,\s]|$)/.test(style.willChange || '');
      return transformed || contained || anticipated || (kind === 'absolute' && style.position && style.position !== 'static');
    }
    let escape = positioned(readStyle(el));
    for (let ancestor = el === paintRoot ? null : parentOf(el); ancestor; ancestor = ancestor === paintRoot ? null : parentOf(ancestor)) {
      const style = readStyle(ancestor);
      // CSS overflow does not clip an absolute/fixed descendant between it
      // and its containing block. Once that block is reached, clipping resumes.
      if (escape && establishes(style, escape)) escape = null;
      const paintClip = /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain || '');
      const xValue = style.overflowX || style.overflow;
      const yValue = style.overflowY || style.overflow;
      const x = paintClip && !clips(xValue) ? 'clip' : xValue;
      const y = paintClip && !clips(yValue) ? 'clip' : yValue;
      if (!escape && style.display !== 'inline' && style.display !== 'contents' && (clips(x) || clips(y))) {
        const bounds = readGeometry ? readGeometry.bounds(ancestor) : ancestor.getBoundingClientRect();
        if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)) return null;
        const metrics = readGeometry ? readGeometry.metrics(ancestor) : ancestor;
        const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
        const sx = metrics.offsetWidth > 0 ? width / metrics.offsetWidth : 1;
        const sy = metrics.offsetHeight > 0 ? height / metrics.offsetHeight : 1;
        const pixels = value => Number.parseFloat(value) || 0;
        const insetX = Number.isFinite(metrics.clientLeft) ? metrics.clientLeft : pixels(style.borderLeftWidth);
        const insetY = Number.isFinite(metrics.clientTop) ? metrics.clientTop : pixels(style.borderTopWidth);
        const clientWidth = Number.isFinite(metrics.clientWidth) ? metrics.clientWidth : width / sx - insetX - pixels(style.borderRightWidth);
        const clientHeight = Number.isFinite(metrics.clientHeight) ? metrics.clientHeight : height / sy - insetY - pixels(style.borderBottomWidth);
        let clipLeft = bounds.left + insetX * sx, clipTop = bounds.top + insetY * sy;
        let clipRight = clipLeft + clientWidth * sx, clipBottom = clipTop + clientHeight * sy;
        let marginLeft = clipLeft, marginTop = clipTop, marginRight = clipRight, marginBottom = clipBottom;
        const margin = style.overflowClipMargin || '0px';
        const expansion = pixels(margin.match(/([\d.]+)px(?:\s|$)/)?.[1]);
        if (margin.includes('border-box')) { marginLeft = bounds.left; marginTop = bounds.top; marginRight = bounds.right; marginBottom = bounds.bottom; }
        else if (margin.includes('content-box')) {
          marginLeft += pixels(style.paddingLeft) * sx; marginTop += pixels(style.paddingTop) * sy;
          marginRight -= pixels(style.paddingRight) * sx; marginBottom -= pixels(style.paddingBottom) * sy;
        }
        if (clips(x)) { left = Math.max(left, x === 'clip' ? marginLeft - expansion * sx : clipLeft); right = Math.min(right, x === 'clip' ? marginRight + expansion * sx : clipRight); }
        if (clips(y)) { top = Math.max(top, y === 'clip' ? marginTop - expansion * sy : clipTop); bottom = Math.min(bottom, y === 'clip' ? marginBottom + expansion * sy : clipBottom); }
        if (right <= left || bottom <= top) return null;
      }
      // A positioned wrapper can itself escape the next outer scrollbox.
      if (!escape) escape = positioned(style);
    }
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  }
  function isPaintVisible(el, readStyle, opacityCache = new WeakMap(), paintRoot = null) {
    const style = readStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    // Closed details can retain a measurable light-DOM media box in Blink.
    // Only their first summary branch is painted; body media is not visible.
    for (let child = el, parent; (parent = child === paintRoot ? null : child.parentElement || child.getRootNode?.()?.host); child = parent) {
      if (parent.localName === 'details' && !parent.open) {
        const summary = Array.from(parent.children || []).find(node => node.localName === 'summary');
        if (child !== summary) return false;
      }
    }
    function opacityVisible(node) {
      if (!node) return true;
      if (opacityCache.has(node)) return opacityCache.get(node);
      const own = readStyle(node);
      const parent = node === paintRoot ? null : node.parentElement || node.getRootNode?.()?.host;
      const visible = own.display !== 'none' && Number(own.opacity) !== 0 && opacityVisible(parent);
      opacityCache.set(node, visible);
      return visible;
    }
    return opacityVisible(el);
  }
  function hasMediaBackground(backgroundImage) {
    // Gradients describe UI fills; URL and image-set layers carry actual images.
    return typeof backgroundImage === 'string' && /(?:url|(?:-webkit-)?image-set)\s*\(/i.test(backgroundImage);
  }
  function isOpaqueNeutralBackground(style, ownedSurface = false) {
    if(!style || style.backgroundImage && style.backgroundImage!=='none') return false;
    const match=/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/.exec(style.backgroundColor||'');
    if(!match || match[4]!==undefined&&Number(match[4])!==1) return false;
    const rgb=match.slice(1,4).map(Number);
    // A live theme-owned structural surface is known UI even when the active
    // Omarchy canvas is chromatic. Still require real opaque color paint above;
    // ownership never makes an image or translucent fill safe to subtract.
    return ownedSurface ? rgb.every(channel=>channel>=0&&channel<=255) :
      Math.max(...rgb)<=120&&Math.min(...rgb)>=0&&Math.max(...rgb)-Math.min(...rgb)<=16;
  }
  function rectangularAppearance(element,style) {
    if(!style.appearance||style.appearance==='none') return true;
    // Button appearance on ordinary action markup still paints its authored
    // CSS fill. Native form widgets have internal shapes we cannot prove.
    const roles=(element.getAttribute?.('role')||'').split(/\s+/);
    return style.appearance==='button' && !['input','button','select','textarea','option','meter','progress'].includes(element.localName) &&
      (roles.some(role=>['button','tab','link','menuitem','menuitemcheckbox','menuitemradio'].includes(role)) || element.localName==='a'&&!!element.getAttribute?.('href'));
  }
  function opaqueUiRegions(elements,readStyle,paintRoot=null,paints=null,isOwnedSurface=()=>false,readGeometry=null) {
    const result=[],parentOf=node=>node.assignedSlot||node.parentElement||node.getRootNode?.()?.host;
    const intersection=(a,b)=>{const r={left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)};return r.right>r.left&&r.bottom>r.top?r:null;};
    function interiors(node,bounds) {
      const style=readStyle(node),width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;
      const radius=value=> {
        const tokens=(value||'0px').trim().split(/\s+/);if(tokens.length>2) return null;
        const parse=(text,dimension)=>/^\d+(?:\.\d+)?(?:px|%)?$/.test(text)?Number.parseFloat(text)*(text.endsWith('%')?dimension/100:1):NaN;
        const x=parse(tokens[0],width),y=parse(tokens[1]||tokens[0],height);
        return Number.isFinite(x)&&Number.isFinite(y)?[x,y]:null;
      };
      const corners=['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].map(key=>radius(style[key]));
      if(corners.some(value=>!value)) return [];
      const [tl,tr,bl,br]=corners;
      const factor=Math.min(1,width/Math.max(1,tl[0]+tr[0]),width/Math.max(1,bl[0]+br[0]),height/Math.max(1,tl[1]+bl[1]),height/Math.max(1,tr[1]+br[1]));
      const left=Math.max(tl[0],bl[0])*factor,right=Math.max(tr[0],br[0])*factor,top=Math.max(tl[1],tr[1])*factor,bottom=Math.max(bl[1],br[1])*factor;
      // Keep the antialiased boundary and rounded corners under media protection.
      return [{left:bounds.left+left+1,top:bounds.top+1,right:bounds.right-right-1,bottom:bounds.bottom-1},
        {left:bounds.left+1,top:bounds.top+top+1,right:bounds.right-1,bottom:bounds.bottom-bottom-1}].filter(rect=>rect.right>rect.left&&rect.bottom>rect.top);
    }
    for(const element of elements) {
      if(result.length>=256) break;
      try {
        // Layout-only overlap rejection precedes pseudo styles and ancestry.
        // A remote UI fill cannot change any submitted media pixels.
        const bounds=readGeometry?readGeometry.bounds(element):element.getBoundingClientRect();
        if(!['left','top','right','bottom'].every(key=>Number.isFinite(bounds[key]))) continue;
        if(paints&&!paints.some(({rect})=>bounds.left<rect.right&&bounds.right>rect.left&&bounds.top<rect.bottom&&bounds.bottom>rect.top)) continue;
        const style=readStyle(element);
        if(!isOpaqueNeutralBackground(style,isOwnedSurface(element))||!['block','inline-block','flex','inline-flex','grid','inline-grid','flow-root','list-item'].includes(style.display)||style.backgroundClip&&style.backgroundClip!=='border-box') continue;
        if(!rectangularAppearance(element,style)) continue;
        if(['::before','::after'].some(pseudo=>{const paint=readStyle(element,pseudo);return !paint||hasMediaBackground(paint.backgroundImage)||/(?:url|image-set)\s*\(/i.test(paint.content||'')||paint.maskImage&&paint.maskImage!=='none';})) continue;
        let safe=true;
        for(let node=element;node;node=node===paintRoot?null:parentOf(node)) {
          const current=readStyle(node),roles=(node.getAttribute?.('role')||'').split(/\s+/);
          if(['svg','img','video','canvas','object','embed','iframe','picture','figure'].includes(node.localName)||roles.some(role=>['img','figure'].includes(role))||
            Number(current.opacity)!==1||current.visibility==='hidden'||current.visibility==='collapse'||current.display==='none'||current.mixBlendMode&&current.mixBlendMode!=='normal'||current.zoom&& !['1','normal'].includes(String(current.zoom))||
            ['transform','translate','rotate','scale','filter','backdropFilter','perspective','clipPath','maskImage','mask','clip'].some(key=>current[key]&&!['none','auto'].includes(current[key]))) {safe=false;break;}
        }
        if(!safe) continue;
        let regions=interiors(element,bounds);
        for(let node=parentOf(element);node&&regions.length;node=node===paintRoot?null:parentOf(node)) {
          const ancestor=readStyle(node);
          const clips=['hidden','clip','auto','scroll'].some(value=>[ancestor.overflow,ancestor.overflowX,ancestor.overflowY].includes(value))||/(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(ancestor.contain||'');
          if(!clips) continue;
          // Conservative rounded clipping: stay in one guaranteed interior strip
          // of each ancestor rather than treating its bounding box as painted.
          const ancestorInteriors=interiors(node,readGeometry?readGeometry.bounds(node):node.getBoundingClientRect());
          if(!ancestorInteriors.length) {regions=[];break;}
          const center=ancestorInteriors.reduce((a,b)=>intersection(a,b));
          regions=center?regions.map(rect=>intersection(rect,center)).filter(Boolean):[];
        }
        for(const region of regions) {
          const clipped=clipMediaRect(element,region,readStyle,paintRoot,readGeometry);
          if(result.length<256 && clipped && !result.some(entry=>entry.element===element&&['left','top','right','bottom'].every(key=>entry.rect[key]===clipped[key]))) result.push({element,rect:clipped});
        }
      } catch { /* Unknown paint ownership keeps its media mask. */ }
    }
    return result;
  }
  function subtractOpaqueUi(paints,regions,readStyle,viewport,reserved=0) {
    const original=paints.map(entry=>entry.rect);
    if(typeof viewport.elementsFromPoint!=='function'||original.length+reserved>MAX_RECTS) return original;
    let spare=MAX_RECTS-original.length-reserved,proofs=0;const result=[];
    const clock=viewport.now || (()=>globalThis.performance?.now?.() ?? Date.now());
    const deadline=clock()+50;
    const intersect=(a,b)=>({left:Math.max(a.left,b.left,0),top:Math.max(a.top,b.top,0),right:Math.min(a.right,b.right,viewport.innerWidth),bottom:Math.min(a.bottom,b.bottom,viewport.innerHeight)});
    const nonempty=rect=>rect.right>rect.left&&rect.bottom>rect.top;
    function above(media,candidate,cut) {
      if(++proofs>64) return false;
      const dx=Math.min(.5,(cut.right-cut.left)/4),dy=Math.min(.5,(cut.bottom-cut.top)/4);
      try {
        for(const x of [cut.left+dx,(cut.left+cut.right)/2,cut.right-dx]) for(const y of [cut.top+dy,(cut.top+cut.bottom)/2,cut.bottom-dy]) {
          // UI cutouts are optional refinement. Slow page hit testing must not
          // delay publishing the fresh media mask; unfinished proofs keep it.
          if(clock()>=deadline) {proofs=64;return false;}
          const stack=viewport.elementsFromPoint(x,y);if(!Array.isArray(stack)) return false;
          const first=stack.indexOf(candidate),last=stack.indexOf(media);
          if(first<0||last<0||first>=last) return false;
          // A separate image above the fill is independently protected; a
          // descendant of this media owner is allowed to own foreground UI.
        }
        return true;
      } catch {return false;}
    }
    for(const paint of paints) {
      // A media owner's ancestor fill is normally behind it. Conservatively
      // retain protection even in unusual negative-z stacking instead of
      // querying paint order for every enclosing body/control background.
      const ancestors=new Set();
      for(let node=paint.element.assignedSlot||paint.element.parentElement||paint.element.getRootNode?.()?.host;node;node=node.assignedSlot||node.parentElement||node.getRootNode?.()?.host) ancestors.add(node);
      let pieces=[paint.rect];
      for(const region of regions) {
        if(region.element===paint.element||ancestors.has(region.element)||proofs>=64) continue;
        const cut=intersect(paint.rect,region.rect);
        // Already removed pixels need no repeated hit-test proof (rounded
        // interiors overlap and nested panels commonly cover the same area).
        if(!nonempty(cut)||!pieces.some(piece=>nonempty(intersect(piece,cut)))||!above(paint.element,region.element,cut)) continue;
        const split=[];
        for(const piece of pieces) {
          const overlap=intersect(piece,cut);if(!nonempty(overlap)) {split.push(piece);continue;}
          split.push({left:piece.left,top:piece.top,right:piece.right,bottom:overlap.top},
            {left:piece.left,top:overlap.bottom,right:piece.right,bottom:piece.bottom},
            {left:piece.left,top:overlap.top,right:overlap.left,bottom:overlap.bottom},
            {left:overlap.right,top:overlap.top,right:piece.right,bottom:overlap.bottom});
        }
        const next=split.filter(nonempty);
        if(next.length>1+spare) continue;
        pieces=next;
      }
      spare-=pieces.length-1;result.push(...pieces);
    }
    return result;
  }
  function isFullyOccludedMedia(el,rect,readStyle,viewport,paintRoot=null) {
    if(typeof viewport.elementsFromPoint!=='function') return false;
    const clipped={left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(viewport.innerWidth,rect.right),bottom:Math.min(viewport.innerHeight,rect.bottom)};
    if(!Object.values(clipped).every(Number.isFinite)||clipped.right<=clipped.left||clipped.bottom<=clipped.top) return false;
    const parentOf=node=>node.assignedSlot||node.parentElement||node.getRootNode?.()?.host;
    const contains=(owner,node)=>owner===node||!!owner.contains?.(node);
    const covers=box=>box&&['left','top','right','bottom'].every(key=>Number.isFinite(box[key]))&&box.left<=clipped.left&&box.top<=clipped.top&&box.right>=clipped.right&&box.bottom>=clipped.bottom;
    function opaqueRectangle(node) {
      const style=readStyle(node),color=style.backgroundColor||'';
      if(!/^rgb\(\s*\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?\s*\)$/.test(color)&&!/^rgba\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*1(?:\.0+)?\s*\)$/.test(color)) return false;
      if(!['block','inline-block','flex','inline-flex','grid','inline-grid','flow-root','list-item'].includes(style.display)||style.backgroundClip&&style.backgroundClip!=='border-box') return false;
      if(!rectangularAppearance(node,style)) return false;
      if(['::before','::after'].some(pseudo=>{const paint=readStyle(node,pseudo);return !paint||hasMediaBackground(paint.backgroundImage)||/(?:url|image-set)\s*\(/i.test(paint.content||'')||paint.maskImage&&paint.maskImage!=='none';})) return false;
      for(let ancestor=node;ancestor;ancestor=ancestor===paintRoot?null:parentOf(ancestor)) {
        const current=readStyle(ancestor),roles=(ancestor.getAttribute?.('role')||'').split(/\s+/);
        if(['svg','img','video','canvas','object','embed','iframe','picture','figure'].includes(ancestor.localName)||roles.some(role=>['img','figure'].includes(role))) return false;
        if(Number(current.opacity)!==1||current.visibility==='hidden'||current.visibility==='collapse'||current.display==='none') return false;
        if(['transform','translate','rotate','scale','filter','backdropFilter','perspective','clipPath','maskImage','mask','clip'].some(key=>current[key]&&!['none','auto'].includes(current[key]))) return false;
        if(current.mixBlendMode&&current.mixBlendMode!=='normal') return false;
        if(['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].some(key=>current[key]&&!/^0(?:px|%)?(?:\s+0(?:px|%)?)?$/.test(current[key]))) return false;
      }
      const bounds=node.getBoundingClientRect();
      return covers(clipMediaRect(node,bounds,readStyle,paintRoot));
    }
    try {
      const dx=Math.min(.5,(clipped.right-clipped.left)/4),dy=Math.min(.5,(clipped.bottom-clipped.top)/4);
      // Prepared neutral UI interiors already prove rectangular paint safety.
      // Reject impossible whole covers before any compositor hit testing.
      let prepared=null;
      if(Array.isArray(viewport.opaqueRegions)) {
        prepared=viewport.opaqueRegions.filter(entry=>covers(entry.rect)&&entry.element!==el&&!contains(entry.element,el)&&!contains(el,entry.element)).map(entry=>entry.element);
        if(!prepared.length) return false;
      }
      let candidates=prepared;
      for(const x of [clipped.left+dx,(clipped.left+clipped.right)/2,clipped.right-dx]) for(const y of [clipped.top+dy,(clipped.top+clipped.bottom)/2,clipped.bottom-dy]) {
        const stack=viewport.elementsFromPoint(x,y);if(!Array.isArray(stack)) return false;
        const index=stack.indexOf(el);if(index<1) return false;
        if(prepared!==null) {
          // Relationships and paint safety were checked once before sampling.
          candidates=candidates.filter(node=>{const position=stack.indexOf(node);return position>=0&&position<index;});
        } else {
          const above=stack.slice(0,index).filter(node=>!contains(node,el)&&!contains(el,node));
          candidates=candidates===null?above.filter(opaqueRectangle):candidates.filter(node=>above.includes(node));
        }
        if(!candidates.length) return false;
      }
      return candidates.length>0;
    } catch { return false; }
  }
  function isDecorativePageBackground(el, rect, readStyle, viewport) {
    // CSS URLs can be either content artwork or the page canvas. Only positive
    // root/backdrop semantics authorize changing them; size alone does not.
    if (['img', 'video', 'canvas', 'svg', 'object', 'embed', 'iframe', 'picture', 'figure'].includes(el.localName)) return false;
    for (let node = el; node; node = node.parentElement || node.getRootNode?.()?.host) {
      const roles = (node.getAttribute?.('role') || '').split(/\s+/);
      if (roles.includes('img') || roles.includes('figure') || ['figure', 'picture'].includes(node.localName)) return false;
    }
    const style = readStyle(el);
    if (!hasMediaBackground(style.backgroundImage)) return false;
    if (el.localName === 'html' || el.localName === 'body') return true;
    const { innerWidth: width, innerHeight: height } = viewport;
    if (![width, height, rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) || width <= 0 || height <= 0 ||
        rect.left > 2 || rect.top > 2 || rect.right < width - 2 || rect.bottom < height - 2) return false;
    const roles = (el.getAttribute?.('role') || '').split(/\s+/);
    const decorative = roles.includes('presentation') || roles.includes('none') || el.getAttribute?.('aria-hidden') === 'true';
    const behind = Number.isFinite(Number(style.zIndex)) && Number(style.zIndex) < 0;
    return ['fixed', 'absolute'].includes(style.position) && style.pointerEvents === 'none' && (decorative || behind);
  }
  function isDecorativeWallpaperImage(el, rect, readStyle, viewport) {
    if (el.localName !== 'img' || typeof viewport.elementsFromPoint !== 'function') return false;
    const { innerWidth: width, innerHeight: height } = viewport;
    const covers = box => [width, height, box.left, box.top, box.right, box.bottom].every(Number.isFinite) && width > 0 && height > 0 &&
      box.left <= 2 && box.top <= 2 && box.right >= width - 2 && box.bottom >= height - 2;
    const visible={left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(width,rect.right),bottom:Math.min(height,rect.bottom)};
    if(!Object.values(visible).every(Number.isFinite)||visible.right<=visible.left||visible.bottom<=visible.top) return false;
    const labeled = node => ['alt', 'aria-label', 'aria-labelledby'].some(attribute => !!node.getAttribute?.(attribute)?.trim());
    const roles = node => (node.getAttribute?.('role') || '').split(/\s+/).filter(Boolean);
    if (labeled(el) || roles(el).some(role => !['none', 'presentation'].includes(role))) return false;
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode?.()?.host;
    let layer = null;
    for (let node = parentOf(el), depth = 0; node && depth++ < 32; node = parentOf(node)) {
      if (['picture', 'figure'].includes(node.localName) || roles(node).some(role => ['img', 'figure'].includes(role))) return false;
      if (readStyle(node).position === 'fixed') { layer = node; break; }
    }
    if (!layer || !covers(layer.getBoundingClientRect()) || labeled(layer) || roles(layer).some(role => !['none', 'presentation'].includes(role))) return false;
    // A dedicated wallpaper layer contains no article, control or other media.
    // A full-screen photo viewer or image inside a figure keeps its protection.
    const blockers = 'a,button,input,textarea,select,video,canvas,svg,iframe,object,embed,picture,figure,[contenteditable="true"],[role="button"],[role="link"],[role="img"],[role="figure"],[aria-label],[aria-labelledby]';
    if (layer.querySelector?.(blockers) || layer.textContent?.trim()) return false;
    const images = layer.querySelectorAll?.('img');
    if (!images || images.length !== 1 || images[0] !== el) return false;
    const contains = (owner, node) => owner === node || !!owner.contains?.(node);
    function branchAt(node, scope) {
      for (let depth = 0; node && depth++ < 32; node = parentOf(node))
        if (parentOf(node) === scope) return node;
      return null;
    }
    let foreground = [];
    for (let scope = parentOf(layer), depth = 0; scope && depth++ < 32; scope = parentOf(scope)) {
      const background = branchAt(layer, scope);
      const branches = new Set();
      for (const main of scope.querySelectorAll?.('main,[role="main"],[role="application"]') || []) {
        if (contains(layer, main) || contains(main, layer)) continue;
        const branch = branchAt(main, scope);
        if (branch && branch !== background) branches.add(branch);
      }
      if (branches.size) { foreground = [...branches]; break; }
    }
    if (!foreground.length) return false;
    // Verify actual stacking at interior points: independent application
    // content must sit above this image across the page, not only in a toolbar.
    try {
      for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) {
        const stack = viewport.elementsFromPoint(visible.left+(visible.right-visible.left)*x,visible.top+(visible.bottom-visible.top)*y);
        if (!Array.isArray(stack)) return false;
        const imageIndex = stack.indexOf(el);
        if (imageIndex <= 0 || !stack.slice(0, imageIndex).some(node => foreground.some(branch => contains(branch, node)))) return false;
      }
    } catch { return false; }
    return true;
  }
  const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;
  let canvasProbe = null, canvasProbeContext = null;
  function isCanvasPaintEmpty(el, budget = { remainingPixels: MAX_CANVAS_PIXELS }) {
    if (el.localName !== 'canvas' || el.getAttribute?.('data-brave-media-canvas-context') !== '2d') return false;
    const { width, height } = el;
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return false;
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > MAX_CANVAS_PIXELS ||
        !budget || !Number.isSafeInteger(budget.remainingPixels) || pixels > budget.remainingPixels) return false;
    // Only confirmed 2D canvases are readable media evidence. A WebGL canvas
    // can clear its drawing buffer after presenting a still-visible frame.
    // Full alpha verification is bounded across every canvas in one snapshot.
    // Never cache a blank result: canvas drawing does not emit DOM mutations.
    budget.remainingPixels -= pixels;
    try {
      if (!canvasProbe) {
        canvasProbe = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height)
          : globalThis.document?.createElement?.('canvas');
        canvasProbeContext = canvasProbe?.getContext('2d', { willReadFrequently: true });
      }
      if (!canvasProbeContext) return false;
      if (canvasProbe.width !== width) canvasProbe.width = width;
      if (canvasProbe.height !== height) canvasProbe.height = height;
      // Read a detached copy. Calling getContext on a page-owned canvas could
      // initialize it as 2D and prevent its later WebGL initialization.
      canvasProbeContext.clearRect(0, 0, width, height);
      canvasProbeContext.drawImage(el, 0, 0, width, height);
      const image = canvasProbeContext.getImageData(0, 0, width, height);
      if (image.width !== width || image.height !== height || image.data.length !== pixels * 4) return false;
      for (let alpha = 3; alpha < image.data.length; alpha += 4)
        if (image.data[alpha] !== 0) return false;
      return true;
    } catch {
      // A tainted source taints the probe too. Discard it so the next readable
      // canvas is independently checked instead of inheriting that failure.
      canvasProbe = null;
      canvasProbeContext = null;
      return false;
    }
  }
  function isExplicitCustomMedia(el) {
    return unknownCustomElement(el) && el.getAttribute?.('role') === 'img';
  }
  function unknownCustomElement(el) {
    return el.localName.includes('-') && !el.shadowRoot && !el.childNodes.length;
  }
  // An explicit disconnect always revokes a previously valid snapshot.
  function disconnectedState(previous) {
    return { ...previous, enabled: false, valid: false, reason: 'disconnected', rects: [] };
  }
  globalThis.MediaGeometry = Object.freeze({ normalize, disconnectedState, unknownCustomElement, videoContentRect, clipMediaRect, isPaintVisible, hasMediaBackground, isOpaqueNeutralBackground, opaqueUiRegions, subtractOpaqueUi, isFullyOccludedMedia, isDecorativePageBackground, isDecorativeWallpaperImage, isExplicitCustomMedia, isCanvasPaintEmpty, MAX_CANVAS_PIXELS, MAX_RECTS });
})();
