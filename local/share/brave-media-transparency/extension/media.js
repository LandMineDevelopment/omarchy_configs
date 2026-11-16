/* Positive identification of authored dark monochrome control glyphs. */
(() => {
  const REVISION='1';
  if(globalThis.MediaGlyphs?.revision===REVISION) return;
  const CONTROL_ROLES=new Set(['button','link','listbox','combobox','menuitem','menuitemcheckbox','menuitemradio','checkbox','radio','switch','tab','option']);
  const MAX_SIDE=64;
  function isControlGlyph(el,rect) {
    if(!el || !rect || ![rect.width,rect.height].every(value=>Number.isFinite(value)&&value>0&&value<=48)) return false;
    if(el.textContent?.trim() || el.getAttribute?.('aria-label')?.trim() || el.getAttribute?.('aria-labelledby') || el.getAttribute?.('alt')?.trim() || el.querySelector?.('title,desc')) return false;
    if(['img','figure'].includes(el.getAttribute?.('role'))) return false;
    // Bitmap UI needs affirmative decorative ownership; an unlabeled logo is
    // still artwork. SVG action icons also receive full authored paint proof.
    if(el.localName!=='svg' && el.getAttribute?.('aria-hidden')!=='true' && !['presentation','none'].includes(el.getAttribute?.('role'))) return false;
    let node=el;
    for(let depth=0;node&&depth<12;depth++,node=node.parentElement||node.getRootNode?.()?.host) {
      if(['figure','picture','canvas','video','iframe','object','embed'].includes(node.localName) || ['img','figure'].includes(node.getAttribute?.('role'))) return false;
      if(node.localName==='button' || node.localName==='select' || (node.localName==='a'&&node.getAttribute?.('href')) || CONTROL_ROLES.has(node.getAttribute?.('role'))) return true;
      if(node.localName==='input'&&['checkbox','radio','button','submit','reset'].includes(node.type)) return true;
    }
    return false;
  }
  function analyzeGlyphPixels(data,width,height) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_SIDE||height>MAX_SIDE||!data||data.length!==width*height*4) return false;
    let ink=0,clear=0;
    for(let i=0;i<data.length;i+=4) {
      const [r,g,b,a]=[data[i],data[i+1],data[i+2],data[i+3]];
      if(![r,g,b,a].every(value=>Number.isInteger(value)&&value>=0&&value<=255)) return false;
      if(a<16) { clear++;continue; }
      if(Math.max(r,g,b)-Math.min(r,g,b)>16 || Math.max(r,g,b)>96) return false;
      ink++;
    }
    return ink>0&&ink<=width*height*.65&&clear>=width*height*.2;
  }
  function darkPaint(value) {
    if(!value||value==='none'||value==='transparent') return true;
    const match=/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,?\s*(\d+(?:\.\d+)?)\s*,?\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(value);
    if(!match) return false;
    const rgb=match.slice(1,4).map(Number),alpha=match[4]===undefined?1:Number(match[4]);
    return alpha===0 || (alpha>0&&alpha<=1&&Math.max(...rgb)<=96&&Math.min(...rgb)>=0&&Math.max(...rgb)-Math.min(...rgb)<=16);
  }
  function isDarkSvgGlyph(el,rect,readStyle) {
    if(el?.localName!=='svg'||!isControlGlyph(el,rect)||el.querySelector?.('image,foreignObject,text,use,linearGradient,radialGradient,pattern,filter,mask')) return false;
    let painted=false;
    for(const node of [el,...el.querySelectorAll('*')]) {
      const style=readStyle(node);
      if(!style || (style.filter&&style.filter!=='none') || (style.maskImage&&style.maskImage!=='none')) return false;
      if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0) continue;
      for(const paint of [style.fill,style.stroke]) {
        if(!darkPaint(paint)) return false;
        if(paint&&paint!=='none'&&paint!=='transparent'&&!/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(paint)&&!/^rgba?\([^)]*\/\s*0(?:\.0+)?\s*\)$/i.test(paint)) painted=true;
      }
    }
    return painted;
  }
  const imageResults=new Map();
  function isStaticPng(bytes) {
    if(bytes.length<33 || ![137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)) return false;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let offset=8,ended=false;
    while(offset+12<=bytes.length) {
      const length=view.getUint32(offset),type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
      if(length>bytes.length-offset-12 || type==='acTL') return false;
      offset+=12+length;
      if(type==='IEND') { ended=true;break; }
    }
    return ended&&offset===bytes.length;
  }
  async function inspectDarkGlyph(url,signal) {
    let bitmap;
    try {
      const response=await fetch(url,{credentials:'same-origin',signal});
      if(!response.ok || response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='image/png') return false;
      const reader=response.body?.getReader();if(!reader) return false;
      let size=0;const chunks=[];
      for(;;) {
        const {done,value}=await reader.read();if(done) break;
        size+=value.length;if(size>262144) { await reader.cancel();return false; }chunks.push(value);
      }
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.length; }
      if(!isStaticPng(bytes)) return false;
      bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const width=bitmap.width,height=bitmap.height;
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_SIDE||height>MAX_SIDE) return false;
      const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d',{willReadFrequently:true});if(!context) return false;
      context.drawImage(bitmap,0,0);return analyzeGlyphPixels(context.getImageData(0,0,width,height).data,width,height);
    } catch { return false; }
    finally { bitmap?.close?.(); }
  }
  function loadDarkGlyph(url) {
    try {
      if(typeof url!=='string' || url.length>8192) return Promise.resolve(false);
      const parsed=new URL(url,document.baseURI);
      if(!['http:','https:','data:'].includes(parsed.protocol) || (parsed.protocol==='data:'&&!parsed.href.startsWith('data:image/png'))) return Promise.resolve(false);
      if(!imageResults.has(parsed.href)) {
        // A bounded per-document cache avoids retries and repeated decoding.
        if(imageResults.size>=128) return Promise.resolve(false);
        const controller=new AbortController();let timer;
        const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false);},3000);});
        imageResults.set(parsed.href,Promise.race([inspectDarkGlyph(parsed.href,controller.signal),deadline]).finally(()=>clearTimeout(timer)));
      }
      return imageResults.get(parsed.href);
    } catch { return Promise.resolve(false); }
  }
  globalThis.MediaGlyphs=Object.freeze({revision:REVISION,isControlGlyph,analyzeGlyphPixels,isDarkSvgGlyph,loadDarkGlyph,isStaticPng});
})();
