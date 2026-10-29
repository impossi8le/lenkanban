const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { controlsFit } = require('./design.cjs');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function scenario(html, run) {
  const page = await browser.newPage({ viewport: { width: 360, height: 844 } });
  await page.route('**/*', route => route.abort());
  try {
    await page.setContent(`<style>body{margin:0}button{box-sizing:border-box;width:36px;height:36px;padding:0;border:0}</style>${html}`);
    await run(page, page.locator('button'));
  } finally { await page.close(); }
}
async function centerHits(control) {
  return control.evaluate(el => { const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(hit && (el===hit || el.contains(hit))); });
}
async function rejectsFit(page,control) { await assert.rejects(controlsFit(page,control), error => error.matcherResult?.actual === false && error.matcherResult?.expected === true); }
test('viewport-fixed panel escapes ordinary main overflow above its y56 clip', async () => {
  await scenario('<main style="position:absolute;top:56px;width:360px;height:788px;overflow-x:hidden;overflow-y:auto"><aside style="position:fixed;inset:0;overflow:hidden"><button style="position:absolute;right:12px;top:9.5px" aria-label="Close">×</button></aside></main>', async (page, control) => {
    assert.equal(await centerHits(control), true);
    assert.deepEqual(await control.boundingBox(), { x:312,y:9.5,width:36,height:36 });
    await controlsFit(page,control);
  });
});
test('overflow between a fixed element and its transformed containing block does not clip it', async () => {
  await scenario('<section style="transform:translateZ(0);width:360px;height:844px"><main style="position:absolute;top:56px;width:360px;height:300px;overflow:clip"><button style="position:fixed;left:312px;top:9.5px">×</button></main></section>', async (page, control) => {
    assert.equal(await centerHits(control),true); await controlsFit(page,control);
  });
});
for(const [name,style] of [
  ['transform','transform:translateZ(0);overflow:clip'],
  ['paint containment','contain:paint;overflow:visible'],
  ['layout containment with overflow','contain:layout;overflow:clip'],
  ['will-change transform','will-change:transform;overflow:clip'],
]) test(`fixed control remains subject to ${name} containing-block clipping even when center hits`, async () => {
  await scenario(`<main style="position:absolute;left:20px;top:56px;width:100px;height:100px;${style}"><button style="position:fixed;left:80px;top:10px">×</button></main>`, async (page, control) => {
    assert.equal(await centerHits(control),true);
    assert.equal(await control.evaluate(el => {const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.right-1,r.top+r.height/2));}),false);
    await rejectsFit(page,control);
  });
});
test('ordinary partially clipped control is rejected although its center hits', async () => {
  await scenario('<main style="position:absolute;left:20px;top:56px;width:100px;height:100px;overflow:clip"><button style="position:absolute;left:80px;top:10px">×</button></main>',async(page,control)=>{
    assert.equal(await centerHits(control),true);await rejectsFit(page,control);
  });
});
test('clipping inside a viewport-fixed panel still applies', async () => {
  await scenario('<main style="overflow:clip;position:absolute;top:56px;width:360px;height:300px"><aside style="position:fixed;left:20px;top:56px;width:100px;height:100px;overflow:clip"><button style="position:absolute;left:80px;top:10px">×</button></aside></main>',async(page,control)=>{
    assert.equal(await centerHits(control),true);await rejectsFit(page,control);
  });
});
test('covered enabled control still fails hit testing', async () => {
  await scenario('<button style="position:absolute;left:10px;top:10px">×</button><div style="position:absolute;left:0;top:0;width:100px;height:100px;background:white"></div>',async(page,control)=>{
    assert.equal(await centerHits(control),false);await rejectsFit(page,control);
  });
});
test('disabled pointer-transparent control still fails real overflow clipping', async () => {
  await scenario('<main style="position:absolute;left:20px;top:56px;width:100px;height:100px;overflow:clip"><button disabled style="pointer-events:none;position:absolute;left:80px;top:10px">×</button></main>',async(page,control)=>{
    await rejectsFit(page,control);
  });
});
