import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const scope = vm.createContext({});
vm.runInContext(readFileSync(new URL('./extension/geometry.js',import.meta.url),'utf8'),scope);
const contentRect = scope.MediaGeometry.videoContentRect;
const plain = value => JSON.parse(JSON.stringify(value));
const box = (left,top,right,bottom) => ({left,top,right,bottom,width:right-left,height:bottom-top});
function video(intrinsic = [640,480], styles = {}) {
  return {videoWidth:intrinsic[0],videoHeight:intrinsic[1],style:{width:'800px',height:'450px',boxSizing:'content-box',objectFit:'contain',objectPosition:'50% 50%',transform:'none',...styles}};
}
const read = el => el.style;
const bounds = box(100,50,900,500);
const result = (el,rect=bounds) => plain(contentRect(el,rect,read));
test('contain removes browser pillarboxes while protecting all intrinsic video pixels', () => {
  assert.deepEqual(result(video()),box(200,50,800,500));
  assert.deepEqual(result(video([1920,1080])),bounds);
});
test('wide video in a square player excludes only browser-generated letterboxes', () => {
  const el = video([1920,1080],{width:'400px',height:'400px'});
  assert.deepEqual(result(el,box(0,0,400,400)),box(0,87.5,400,312.5));
});
test('fill stretches video across content box while cover crops without adding margins', () => {
  assert.deepEqual(result(video([640,480],{objectFit:'fill'})),bounds);
  assert.deepEqual(result(video([640,480],{objectFit:'cover'})),bounds);
});
test('none keeps intrinsic dimensions and clips oversized pixels to content box', () => {
  assert.deepEqual(result(video([200,100],{objectFit:'none'})),box(400,225,600,325));
  assert.deepEqual(result(video([1600,900],{objectFit:'none'})),bounds);
});
test('scale-down fits larger content but never stretches a smaller intrinsic video', () => {
  assert.deepEqual(result(video([1600,1200],{objectFit:'scale-down'})),box(200,50,800,500));
  assert.deepEqual(result(video([200,100],{objectFit:'scale-down'})),box(400,225,600,325));
});
test('object-position resolves percentages against free space and accepts reordered keywords', () => {
  assert.deepEqual(result(video([640,480],{objectPosition:'25% 50%'})),box(150,50,750,500));
  assert.deepEqual(result(video([640,480],{objectPosition:'top left'})),box(100,50,700,500));
  assert.deepEqual(result(video([640,480],{objectPosition:'center right'})),box(300,50,900,500));
});
test('pixel positions and right/bottom edge offsets move the object without exposing pixels outside content', () => {
  assert.deepEqual(result(video([200,100],{objectFit:'none',objectPosition:'10px 20px'})),box(110,70,310,170));
  assert.deepEqual(result(video([200,100],{objectFit:'none',objectPosition:'right 10px bottom 20px'})),box(690,380,890,480));
  assert.deepEqual(result(video([200,100],{objectFit:'none',objectPosition:'right 10% bottom 20%'})),box(640,330,840,430));
});
test('common computed calc percentages plus pixel offsets are supported', () => {
  const el = video([200,100],{objectFit:'none',objectPosition:'calc(100% - 10px) calc(50% + 20px)'});
  assert.deepEqual(result(el),box(690,245,890,345));
});
test('border and padding do not enlarge the protected intrinsic video bounds', () => {
  const style = {borderLeftWidth:'2px',borderRightWidth:'3px',borderTopWidth:'4px',borderBottomWidth:'6px',paddingLeft:'10px',paddingRight:'15px',paddingTop:'20px',paddingBottom:'10px'};
  const el = video([640,480],style);
  const rect = box(100,50,930,540);
  assert.deepEqual(result(el,rect),box(212,74,812,524));
  el.style = {...el.style,width:'830px',height:'490px',boxSizing:'border-box'};
  assert.deepEqual(result(el,rect),box(212,74,812,524));
});
test('fractional CSS dimensions and positive scale retain subpixel media geometry', () => {
  const el = video([100,100],{width:'200.5px',height:'100.25px',borderLeftWidth:'2px',borderRightWidth:'2px',borderTopWidth:'2px',borderBottomWidth:'2px',paddingLeft:'2px',paddingRight:'2px',paddingTop:'2px',paddingBottom:'2px',transform:'matrix(1.5, 0, 0, 1.5, 10, 20)'});
  assert.deepEqual(result(el,box(10,20,322.75,182.375)),box(91.1875,26,241.5625,176.375));
});
test('unknown metadata, object-position and non-axis-aligned transforms conservatively preserve full box', () => {
  assert.deepEqual(result(video([0,0])),bounds);
  assert.deepEqual(result(video([640,480],{objectPosition:'calc(50% + 20px + 10px) center'})),bounds);
  assert.deepEqual(result(video([640,480],{transform:'matrix(0, 1, -1, 0, 0, 0)'})),bounds);
  assert.deepEqual(result(video([640,480],{transform:'matrix(-1, 0, 0, 1, 0, 0)'})),bounds);
  const el = video();el.parentElement={style:{perspective:'1000px'}};
  assert.deepEqual(result(el),bounds);
});
test('an object positioned completely outside its content box has no visible intrinsic video', () => {
  assert.equal(result(video([200,100],{objectFit:'none',objectPosition:'1000px 1000px'})),null);
});
