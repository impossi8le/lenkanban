const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
// Parse actual fixture functions without evaluating its DB/auth fixture setup.
const ts=require(require.resolve('typescript',{paths:[process.env.POINTER_GESTURE_DEPENDENCIES||path.resolve(__dirname,'../..')]}));
const file=process.env.POINTER_GESTURE_FIXTURE||path.join(__dirname,'isolated-project.cjs');const text=fs.readFileSync(file,'utf8');const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const names=new Set(['visibleBox','assertViewportPoint','startPointerDrag','dragTask','cancelDrag','dropOutside']);const functions=[];
function visit(node){const name=node.name?.getText(source);if(names.has(name)&&(ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))){let body=node.getText(source);if(ts.isMethodDeclaration(node))body=body.replace(/^async /,'async function ');functions.push(body);}ts.forEachChild(node,visit);}visit(source);assert.equal(functions.length,6);
async function gesture(modern=true){
 const points=[];let active=false;const handle={count:async()=>modern?1:0,scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:492,y:655,width:44,height:44})};
 const original={x:273,y:640,width:278,height:213};const card={getByRole:()=>handle,scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>active?{...original,height:100}:original};
 const target={scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:273,y:205,width:278,height:213})};
 const page={viewportSize:()=>({width:1280,height:900}),mouse:{move:async(x,y,options)=>{points.push({x,y,steps:options?.steps});if(options?.steps===4)active=true;},down:async()=>{},up:async()=>{}}};
 const context={dndV2Enabled:modern,cardByTitle:(_page,title)=>title==='C'?card:target,columnByTitle:()=>target,expect:()=>({toBeEnabled:async()=>{},toBeVisible:async()=>{}})};
 vm.createContext(context);vm.runInContext(functions.join('\n')+'\nthis.dragTask=dragTask;',context);await context.dragTask(page,'C',{column:'todo',before:'A'});return {points,original};
}
test('historical handle pickup places the actual dragged center above A beyond existing six-pixel hysteresis',async()=>{
 const {points,original}=await gesture();const pickup=points[0],drop=points.at(-1);const offset={x:original.x+original.width/2-pickup.x,y:original.y+original.height/2-pickup.y};
 assert.deepEqual(offset,{x:-102,y:69.5});
 const actualCenter={x:drop.x+offset.x,y:drop.y+offset.y};assert.equal(actualCenter.y,217);assert.equal(actualCenter.x,412);
 // Actual second diagnostic: scroll rect top205/scrollTop22, cached A center106.5.
 assert.ok(actualCenter.y-205+22 < 106.5-6);
 assert.equal(drop.steps,14);assert.equal(points[1].steps,4);
});
test('whole-card legacy pickup keeps the same center-based destination with zero grab offset',async()=>{
 const {points,original}=await gesture(false);const pickup=points[0],drop=points.at(-1);assert.equal(pickup.x,original.x+original.width/2);assert.equal(pickup.y,original.y+original.height/2);assert.equal(drop.x,412);assert.equal(drop.y,217);
});

function scrollProbe(errors,box={x:20,y:30,width:100,height:80}){
 const context={Error};vm.createContext(context);vm.runInContext(functions.join('\n')+'\nthis.visibleBox=visibleBox;',context);
 let calls=0,boxes=0;const locator={scrollIntoViewIfNeeded:async(...args)=>{assert.equal(args.length,0,'Keep original ordinary timeout/options');const error=errors[calls++];if(error)throw error;},boundingBox:async()=>{boxes++;return box;}};
 return {run:()=>context.visibleBox({viewportSize:()=>({width:1280,height:900})},locator,'Synthetic geometry'),counts:()=>({calls,boxes})};
}
const detached=()=>new Error('locator.scrollIntoViewIfNeeded: Element is not attached to the DOM\nCall log:\n  - waiting for element to be stable');
test('re-resolves once after the exact detached-scroll failure and then measures the fresh node',async()=>{
 const probe=scrollProbe([detached()]);const box=await probe.run();assert.equal(box.visible.left,20);assert.equal(box.visible.top,30);assert.deepEqual(probe.counts(),{calls:2,boxes:1});
});
test('a second detached-scroll failure propagates unchanged without further retry or bounding box',async()=>{
 const final=detached(),probe=scrollProbe([detached(),final]);await assert.rejects(probe.run(),error=>error===final);assert.deepEqual(probe.counts(),{calls:2,boxes:0});
});
for(const [name,error] of [
 ['ordinary timeout',Object.assign(new Error('locator.scrollIntoViewIfNeeded: Timeout exceeded'),{name:'TimeoutError'})],
 ['strict locator ambiguity',new Error('locator.scrollIntoViewIfNeeded: strict mode violation')],
 ['unrelated detached action',new Error('locator.click: Element is not attached to the DOM')],
 ['plain thrown object',{message:'locator.scrollIntoViewIfNeeded: Element is not attached to the DOM'}],
])test(`${name} is never retried or replaced`,async()=>{const probe=scrollProbe([error]);await assert.rejects(probe.run(),actual=>actual===error);assert.deepEqual(probe.counts(),{calls:1,boxes:0});});
test('missing geometry after successful scrolling still fails the existing guard',async()=>{
 const probe=scrollProbe([],null);await assert.rejects(probe.run(),/has no viewport bounding box/);assert.deepEqual(probe.counts(),{calls:1,boxes:1});
});

async function transientHandleGesture(method,fail=false){
 let handlePresent=false;const events=[];const sentinel=Object.assign(new Error('Synthetic ordinary handle timeout'),{name:'TimeoutError'});
 const handle={count:async()=>{events.push('handle-count');return handlePresent?1:0;},scrollIntoViewIfNeeded:async()=>{assert(handlePresent);events.push('scroll-handle');},boundingBox:async()=>({x:100,y:120,width:44,height:44})};
 const card={getByRole:()=>handle,scrollIntoViewIfNeeded:async()=>events.push('scroll-card'),boundingBox:async()=>({x:50,y:100,width:200,height:200})};
 const target={scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:300,y:100,width:200,height:200})};
 const page={viewportSize:()=>({width:1280,height:900}),keyboard:{press:async()=>{}},mouse:{move:async()=>{},down:async()=>events.push('pointer-down'),up:async()=>{}}};
 const context={Error,dndV2Enabled:true,cardByTitle:(_page,title)=>title==='C'?card:target,columnByTitle:()=>target,expect:value=>({toBeEnabled:async()=>{assert.equal(value,handle);events.push('wait-real-handle');if(fail)throw sentinel;handlePresent=true;},toBeVisible:async()=>events.push('visible-card')})};
 vm.createContext(context);vm.runInContext(functions.join('\n')+'\nthis.run='+method+';',context);
 let error;try{await context.run(page,'C',{column:'todo',before:'A'});}catch(caught){error=caught;}return {events,error,sentinel,handlePresent};
}
for(const method of ['dragTask','cancelDrag','dropOutside'])test(`V2 ${method} waits for the actual initially absent handle instead of using the card`,async()=>{
 const result=await transientHandleGesture(method);assert.equal(result.error,undefined);assert.equal(result.handlePresent,true);assert.equal(result.events[0],'wait-real-handle');assert.ok(result.events.includes('scroll-handle'));assert.ok(result.events.includes('pointer-down'));assert.ok(!result.events.includes('scroll-card'));assert.ok(!result.events.includes('visible-card'));
});
test('a V2 handle that never becomes enabled propagates the ordinary timeout without fallback or pointer down',async()=>{
 const result=await transientHandleGesture('dragTask',true);assert.equal(result.error,result.sentinel);assert.deepEqual(result.events,['wait-real-handle']);assert.equal(result.handlePresent,false);
});
