import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=path.resolve('outputs/design/redesign-production-qa');
const server=createServer(async(req,res)=>{try{const file=path.join(out,req.url==='/'?'index.html':req.url.slice(1));const body=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
const report={surface:'Actual Sidebar, QuickStart -> CreateTaskDialog -> RequestDialogProvider -> MyTaskCommandLoader -> TaskCommandPanel -> centered TaskDetailPanel -> actual TaskChatPanel and ActivityTimeline; actual RequestDialogLink and RequestBoardPresentation; synthetic session, HTTP and socket transport only; source CSS via PostCSS/Tailwind',browser:'Microsoft Edge headless',cases:[],consoleErrors:[],requests:[],axe:[]};
let taskCounter=0;
async function audit(page,width,theme,surface){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();report.axe.push({width,theme,surface,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});}
async function detailBounds(dialog,width){const r=await dialog.boundingBox();assert(r.x>=0&&r.x+r.width<=width+1);assert(r.width<=741);assert(Math.abs((r.x+r.width/2)-width/2)<2);assert(r.y>=0&&r.y+r.height<=1001);assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);}
async function createAlignment(dialog){const spacing=await dialog.evaluate(el=>{const header=getComputedStyle(el.querySelector('.request-create-header')),form=getComputedStyle(el.querySelector('form'));return {headerLeft:header.paddingLeft,headerRight:header.paddingRight,formLeft:form.paddingLeft,formRight:form.paddingRight};});assert.equal(spacing.headerLeft,spacing.formLeft);assert.equal(spacing.headerRight,spacing.formRight);assert(parseFloat(spacing.headerLeft)>=18);}
try{
for(const width of [1440,375])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,reducedMotion:'reduce'});
 const createdTasks=new Map();let denyNextRead=false;
 await context.addInitScript(t=>localStorage.setItem('theme',t),theme);
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.origin!==base){await route.abort();return;}
  if(!url.pathname.startsWith('/api/')){await route.continue();return;}
  const body=req.postData()?req.postDataJSON():undefined;
  report.requests.push({path:url.pathname,query:url.search,method:req.method(),body});
  if(denyNextRead&&req.method()==='GET'&&/^\/api\/tasks\/[^/]+$/.test(url.pathname)){denyNextRead=false;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'FORBIDDEN',message:'Access denied'}})});return;}
  let data={};
  if(url.pathname==='/api/admin/me')data={globalRole:'USER'};
  else if(url.pathname==='/api/request-directions')data={support:{projectId:'support',projectName:'Техподдержка и ИТ'},claim:{projectId:'claim',projectName:'Претензии клиентов'}};
  else if(url.pathname==='/api/projects')data=[{id:'support',name:'Техподдержка и ИТ'},{id:'claim',name:'Претензии клиентов'}];
  else if(url.pathname==='/api/activities')data=[{id:'synthetic-activity',action:'created',oldValue:null,newValue:null,createdAt:new Date().toISOString(),user:{id:'synthetic-author',name:'Анна Примерова',email:'author@example.invalid',avatarUrl:null}}];
  else if(url.pathname.endsWith('/messages')&&req.method()==='GET')data={items:[],nextCursor:null,canReadInternal:false};
  else if(url.pathname.endsWith('/task-permissions'))data={canChangeStatus:false,canAssign:false};
  else if(url.pathname.endsWith('/members'))data={members:[],owner:null};
  else if(url.pathname==='/api/tasks'&&req.method()==='POST'){
   const id=`created-${++taskCounter}`;
   const fields=body.requestDetails;const description=['Сведения об обращении (v1)',`Направление: ${fields.kind}`,`Категория: ${fields.category}`,...(fields.order?[`Номер заказа: ${fields.order}`]:[]),...(fields.phone?[`Телефон клиента: ${fields.phone}`]:[]),...(fields.client?[`Клиент: ${fields.client}`]:[]),...(fields.want?[`Пожелание: ${fields.want}`]:[]),'Конец сведений','',body.description??''].join('\n');
   // The endpoint adapter returns the same scalar fields. Metadata is encoded
   // by the production create API, covered separately by its server tests.
   createdTasks.set(id,{id,...body,description,position:0,version:1,createdAt:new Date().toISOString(),createdBy:{id:'synthetic-actor',name:'Тестовый сотрудник',primaryDepartment:{name:'Контактный центр'}},request:{state:'SUBMITTED',executorId:null},assignees:[]});
   data={taskId:id};
  }
  else if(url.pathname.endsWith('/lifecycle')){const id=url.pathname.split('/')[3];data={taskId:id,projectId:id==='claim-task'?'claim':'support',version:0,marked:true,deleted:false,state:createdTasks.has(id)?'DRAFT':'SUBMITTED',authorId:'synthetic-author',executorId:null,executorName:null,permissions:{isAuthor:false,isExecutor:false,isLeader:false,isGroupMember:true,canParticipate:true,canExecute:true,canAssign:false},assignees:[],attachments:[]};}
  else if(url.pathname.startsWith('/api/tasks/')&&req.method()==='GET'){const id=url.pathname.split('/')[3];data=createdTasks.get(id)??await req.frame().evaluate(taskId=>window.__fixtureTasks.find(task=>task.id===taskId),id)??{};}
  else if(url.pathname.startsWith('/api/tasks/'))data={version:1,state:'SUBMITTED'};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data})});
 });
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.consoleErrors.push({width,theme,error:e.message}));
 await page.goto(base);await page.getByRole('heading',{name:'Куда вам нужно обратиться?'}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(out,`${width}-${theme}-home.png`),fullPage:true});
 const checks=['home-no-document-overflow','theme-applied'];
 if(width===1440){const buttons=await page.locator('.quick-start-grid .quick-start-action').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().bottom));assert.equal(buttons.length,2);assert(Math.abs(buttons[0]-buttons[1])<1);checks.push('quick-start-actions-align-at-card-bottom');}
 if(width===1440){await page.getByRole('button',{name:'Свернуть боковую панель'}).click();await page.getByRole('button',{name:'Развернуть боковую панель'}).waitFor();await page.screenshot({path:path.join(out,`${width}-${theme}-collapsed.png`),fullPage:true});await page.getByRole('button',{name:'Развернуть боковую панель'}).click();checks.push('sidebar-collapse-expand');}
 if(width===1440){
  const globalTrigger=page.getByRole('button',{name:'Добавить обращение',exact:true});await globalTrigger.click();
  const chooser=page.getByRole('dialog',{name:'Куда вам нужно обратиться?',exact:true});await chooser.waitFor();await chooser.getByRole('button',{name:/Написать в Техподдержку/}).click();
  const form=page.getByRole('dialog',{name:'Обращение в Техподдержку',exact:true});await form.waitFor();await chooser.waitFor({state:'hidden'});
  const title=form.getByRole('textbox',{name:'Кратко о проблеме',exact:true});assert.equal(await title.evaluate(el=>document.activeElement===el),true,'Direction chooser must not steal focus from the newly opened form');
  await page.keyboard.type('Проверка фокуса после выбора отдела');assert.equal(await title.inputValue(),'Проверка фокуса после выбора отдела');await page.screenshot({path:path.join(out,`${width}-${theme}-global-create.png`),fullPage:true});
  await form.getByRole('button',{name:'Отмена',exact:true}).click();await form.waitFor({state:'hidden'});assert.equal(await globalTrigger.evaluate(el=>document.activeElement===el),true);checks.push('global-sidebar-create-opens-chooser-and-form','chooser-handoff-preserves-textbox-focus','global-create-cancel-restores-sidebar-trigger');
 }
 const board=page.getByRole('region',{name:'Проверка доски'});
 const hint=board.locator('.request-board-column-head p').first(),originalHint=await hint.textContent();await hint.evaluate(el=>{el.textContent='Длинная подсказка для проверки переноса строки в заголовке колонки обращения';});const heads=await board.locator('.request-board-column-head').evaluateAll(nodes=>nodes.map(el=>el.getBoundingClientRect().height));assert(heads.every(height=>Math.abs(height-heads[0])<1),'Column headers must share height when text wraps');await hint.evaluate((el,text)=>{el.textContent=text;},originalHint);checks.push('board-headers-share-wrapped-row-height');
 assert.equal(await board.locator('[data-request-stage]').count(),4);
 await board.getByRole('button',{name:'Срочные',exact:true}).click();assert.equal(await board.locator('[data-task-id]').count(),1);
 await board.getByRole('button',{name:'Все',exact:true}).click();await board.getByRole('textbox',{name:'Поиск обращений'}).fill('5305316');assert.equal(await board.locator('[data-task-id]').count(),1);
 await board.getByRole('textbox',{name:'Поиск обращений'}).fill('');await board.getByRole('combobox',{name:'Категория',exact:true}).selectOption('Качество');assert.equal(await board.locator('[data-task-id]').count(),1);
 await board.getByRole('combobox',{name:'Категория',exact:true}).selectOption('');await board.getByRole('button',{name:/Архив/}).click();assert.equal(await board.locator('[data-task-id]').count(),1);await board.getByText('Закрытое синтетическое обращение',{exact:true}).waitFor();await board.getByRole('button',{name:/К доске/}).click();
 await board.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`${width}-${theme}-board.png`),fullPage:true});checks.push('four-active-lifecycle-columns','urgency-filter-two-values','board-search-order','board-category-filter','archive-separate-from-active');
 const cards=page.locator('main > section').first().locator('[data-task-id]');
 const requestLink=page.getByRole('link',{name:'Открыть обращение из списка',exact:true});assert.equal(await requestLink.getAttribute('href'),'/projects/support/tasks/synthetic-task');await requestLink.click();let linked=page.getByRole('dialog',{name:'Детали задачи'});await linked.waitFor();assert.equal(page.url(),base+'/');await linked.getByRole('button',{name:'Закрыть',exact:true}).click();await linked.waitFor({state:'hidden'});checks.push('actual-request-link-preserves-background','provider-authorized-loader-command-panel');
 denyNextRead=true;await requestLink.click();await page.getByText('Карточка недоступна или права изменились.',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog',{name:'Детали задачи'}).count(),0);await page.getByRole('button',{name:'Закрыть загрузку карточки',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});checks.push('denied-fresh-read-does-not-reuse-cached-task');
 const opener=cards.first().getByRole('button',{name:/Открыть задачу/});await opener.focus();await opener.click();
 let detail=page.getByRole('dialog',{name:'Детали задачи'});await detail.waitFor();await detail.getByRole('region',{name:'Данные обращения'}).waitFor();
 await detailBounds(detail,width);
 const longTitle=detail.getByRole('textbox',{name:'Название обращения',exact:true});assert.equal((await longTitle.inputValue()).length,200);const titleBox=await longTitle.evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));assert(titleBox.height>=titleBox.scrollHeight-1,'Full long title must remain visible without textarea scrolling');assert(titleBox.scrollWidth<=titleBox.width+1);if(width===375)assert(titleBox.height>titleBox.lineHeight*2);checks.push('200-character-title-wraps-without-clipping');
 assert.equal(await detail.locator('[contenteditable="true"]').count(),0);assert.equal(await detail.getByText('Перетащите файлы сюда или',{exact:false}).count(),0);
 await detail.getByRole('button',{name:'Изменить описание',exact:true}).click();await detail.locator('[contenteditable="true"]').waitFor();checks.push('description-readonly-until-edit','empty-attachments-collapsed');
 const metadata=detail.getByRole('region',{name:'Данные обращения'});await metadata.getByText('Анна Примерова',{exact:true}).waitFor();await metadata.getByText('Контактный центр',{exact:true}).waitFor();await metadata.getByText('Ждёт специалиста',{exact:true}).waitFor();
 await detail.getByRole('region',{name:'Обсуждение'}).waitFor();assert.equal(await detail.getByRole('tab').count(),0);
 await detail.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Синтетическое уточнение в обсуждении');await detail.getByRole('button',{name:'Отправить сообщение',exact:true}).click();await detail.getByText('Синтетическое уточнение в обсуждении',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__fixtureSends),1);
 const history=detail.locator('summary').filter({hasText:'История обращения'});await history.focus();await page.keyboard.press('Tab');assert.equal(await detail.getByRole('button',{name:'Удалить',exact:true}).first().evaluate(el=>document.activeElement===el),true);await page.keyboard.press('Shift+Tab');assert.equal(await history.evaluate(el=>document.activeElement===el),true);await history.click();await detail.getByText('Анна Примерова создал задачу',{exact:true}).waitFor();checks.push('keyboard-trap-includes-history-summary');
 await detail.getByRole('region',{name:'Обсуждение'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`${width}-${theme}-detail-discussion.png`),fullPage:true});
 await audit(page,width,theme,'detail-discussion');
 await page.keyboard.press('Escape');await detail.waitFor({state:'hidden'});assert.equal(await opener.evaluate(el=>document.activeElement===el),true);
 checks.push('card-opens-centered-max740-dialog','detail-within-viewport-no-overflow','detail-author-department-unassigned','discussion-inline-no-tabs','actual-chat-sends-canonical-confirmation','history-inline-loads-on-open','escape-closes-focus-restored');
 await cards.nth(1).getByRole('button',{name:/Открыть задачу/}).focus();await cards.nth(1).getByRole('button',{name:/Открыть задачу/}).click();detail=page.getByRole('dialog',{name:'Детали задачи'});await detail.waitFor();await detail.getByRole('region',{name:'Данные обращения'}).getByRole('link',{name:/Заказ № 5305316/}).waitFor();await detail.getByText('+7 000 000-00-00',{exact:true}).waitFor();await detailBounds(detail,width);await detail.getByRole('region',{name:'Данные обращения'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`${width}-${theme}-claim-detail.png`),fullPage:true});
 await page.mouse.click(2,2);await detail.waitFor({state:'hidden'});checks.push('claim-detail-crm-phone','backdrop-closes');
 await page.getByRole('button',{name:/Написать в Техподдержку/}).click();let dialog=page.getByRole('dialog');await dialog.waitFor();
 await createAlignment(dialog);checks.push('create-header-body-equal-horizontal-padding');
 await dialog.getByRole('button',{name:'Компьютер',exact:true}).click();assert.equal(await dialog.getByRole('button',{name:'Компьютер',exact:true}).getAttribute('aria-pressed'),'true');
 await dialog.getByLabel('Кратко о проблеме').fill('Синтетическая проверка ИТ');await dialog.getByLabel('Подробности').fill('Синтетическое описание без персональных данных');await dialog.getByRole('radio',{name:'Срочно',exact:true}).check();await page.screenshot({path:path.join(out,`${width}-${theme}-it-form.png`),fullPage:true});await audit(page,width,theme,'it-form');
 await dialog.getByRole('button',{name:'Отправить обращение',exact:true}).click();
 detail=page.getByRole('dialog',{name:'Детали задачи'});await detail.waitFor();await detail.getByRole('textbox',{name:'Название обращения',exact:true}).waitFor();assert.equal(await detail.getByRole('textbox',{name:'Название обращения',exact:true}).inputValue(),'Синтетическая проверка ИТ');await detail.getByRole('button',{name:'Закрыть',exact:true}).click();await detail.waitFor({state:'hidden'});checks.push('it-category-urgency-create-submit','created-task-opens-automatically');
 await page.getByRole('button',{name:/Передать недовольного клиента/}).click();dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'Качество',exact:true}).click();await dialog.getByLabel('Номер заказа').fill('5305316');await dialog.getByLabel('Телефон клиента').fill('+7 000 000-00-00');await dialog.getByLabel('Как зовут клиента').fill('Синтетический клиент');await dialog.getByLabel('Кратко о проблеме').fill('Синтетическая претензия');assert.equal(await dialog.getByLabel('Номер заказа').getAttribute('required'),'');assert.equal(await dialog.getByLabel('Телефон клиента').getAttribute('required'),'');await page.screenshot({path:path.join(out,`${width}-${theme}-claim-form.png`),fullPage:true});await audit(page,width,theme,'claim-form');const rect=await dialog.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width+1);checks.push('claim-required-order-phone-category','create-dialog-within-viewport');
 await dialog.getByRole('button',{name:'Отправить обращение',exact:true}).click();detail=page.getByRole('dialog',{name:'Детали задачи'});await detail.waitFor();await detail.getByRole('button',{name:'Закрыть',exact:true}).click();await detail.waitFor({state:'hidden'});
 await cards.first().hover();const take=cards.first().getByRole('button',{name:'Взять в работу →'});await take.waitFor({state:'visible'});assert.equal(await take.evaluate(el=>getComputedStyle(el.closest('.request-quick-take')).pointerEvents),'auto');await take.click();await page.getByRole('button',{name:'Роль: исполнитель'}).click();assert.equal(await page.getByRole('button',{name:'Взять в работу →'}).count(),0);checks.push('executor-take-command','applicant-no-take');assert.equal(await cards.nth(1).locator('a[href="https://basav2.lenremont.com/requests/5305316"]').count(),1);checks.push('claim-card-crm-link');await audit(page,width,theme,'home-cards');report.cases.push({width,theme,checks});await context.close();
}
 const creates=report.requests.filter(r=>r.path==='/api/tasks'&&r.method==='POST');assert.equal(creates.length,8);for(const request of creates){assert(request.body.operationId);if(request.body.projectId==='claim'){assert.equal(request.body.requestDetails.order,'5305316');assert.equal(request.body.requestDetails.phone,'+7 000 000-00-00');assert.equal(request.body.requestDetails.category,'Качество');}else{assert.equal(request.body.requestDetails.category,'Компьютер');assert.equal(request.body.priority,'URGENT');}}
 assert.equal(report.requests.filter(r=>r.body?.action==='take').length,4);assert.equal(report.requests.filter(r=>r.body?.action==='submit').length,8);const detailReads=report.requests.filter(r=>r.method==='GET'&&/^\/api\/tasks\/[^/]+$/.test(r.path));assert.equal(detailReads.length,24);assert(detailReads.every(r=>r.query==='?view=details'));assert.equal(report.consoleErrors.length,0);assert.equal(report.axe.flatMap(s=>s.violations).length,0);
 await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({cases:report.cases.length,checks:report.cases.reduce((n,c)=>n+c.checks.length,0),consoleErrors:report.consoleErrors.length,axeViolations:report.axe.map(x=>({width:x.width,theme:x.theme,surface:x.surface,count:x.violations.length})),output:out}));
}catch(error){await writeFile(path.join(out,'report.json'),JSON.stringify({...report,failure:String(error)},null,2));throw error;}finally{await browser.close();server.close();}




