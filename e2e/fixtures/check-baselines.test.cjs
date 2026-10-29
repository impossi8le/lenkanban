const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const {checkBaselines}=require('./check-baselines.cjs');
const {requiredBaselinePaths}=require('./visual-manifest.cjs');
const {FIXED_TIME}=require('./design-data.cjs');

async function fixture(run) {
 const tempRoot=fs.realpathSync(os.tmpdir());
 const root=fs.mkdtempSync(path.join(tempRoot,'lenkanban-baseline-test-'));
 try {
  const pngs=new Map();
  for(const width of [360,768,1440]) pngs.set(width,await sharp({create:{width,height:width===360?844:width===768?1024:900,channels:4,background:'#ffffff'}}).png().toBuffer());
  for(const relative of requiredBaselinePaths()) {
   const target=path.join(root,relative),project=relative.split('/')[0],width=Number(project.split('-')[1]),png=pngs.get(width);
   fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,png);
   fs.writeFileSync(target+'.json',JSON.stringify({schemaVersion:2,pngSha256:createHash('sha256').update(png).digest('hex'),source:{digest:'a'.repeat(64)},environment:{browser:'synthetic-browser',playwright:'synthetic-version',os:{platform:'linux',arch:'x64'}},project,viewport:{width,height:width===360?844:width===768?1024:900},locale:'ru-RU',timezone:'Europe/Moscow',fixedTime:FIXED_TIME}));
  }
  await run(root);
 } finally {
  const resolved=fs.realpathSync(root);
  assert.equal(path.dirname(resolved),tempRoot); assert.ok(path.basename(resolved).startsWith('lenkanban-baseline-test-')); assert.ok(!fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(resolved,{recursive:true});
 }
}
test('complete canonical matrix accepts exactly300 PNG/provenance pairs',()=>fixture(root=>assert.equal(checkBaselines(root),300)));
test('one missing pair fails before launching any browser',()=>fixture(root=>{const file=path.join(root,requiredBaselinePaths()[0]);fs.unlinkSync(file);fs.unlinkSync(file+'.json');assert.throws(()=>checkBaselines(root),/incomplete reviewed matrix; missing 2 of 600/);}));
test('one missing rendering profile is rejected',()=>fixture(root=>{for(const file of requiredBaselinePaths().filter(x=>x.startsWith('visual-1440-system-dark/'))){fs.unlinkSync(path.join(root,file));fs.unlinkSync(path.join(root,file+'.json'));}assert.throws(()=>checkBaselines(root),/missing 50 of 600/);}));
test('Windows provenance cannot pass a Linux CI preflight',()=>fixture(root=>{const file=path.join(root,requiredBaselinePaths()[0]+'.json'),data=JSON.parse(fs.readFileSync(file));data.environment.os.platform='win32';fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>checkBaselines(root),/canonical Linux x64/);}));
test('profile metadata cannot be moved under a different path',()=>fixture(root=>{const file=path.join(root,requiredBaselinePaths()[0]+'.json'),data=JSON.parse(fs.readFileSync(file));data.project='visual-360-dark';fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>checkBaselines(root),/profile\/path mismatch/);}));
test('unreviewed extra baselines are rejected',()=>fixture(root=>{fs.writeFileSync(path.join(root,'extra.png'),'synthetic');assert.throws(()=>checkBaselines(root),/Unexpected baseline input/);}));
