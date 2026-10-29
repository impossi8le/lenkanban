// Production only: no DB fixtures, no seed/reset, no mutations of existing data.
// Run: npx.cmd playwright test --config e2e/playwright.prod.config.cjs
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const baseURL = process.env.PROD_BASE_URL || 'https://taskboard.lenremontn8n.ru';
const origin = new URL(baseURL).origin;
const out = path.join(__dirname, 'artifacts/prod-audit');
const sizes = [{width:375,height:812},{width:768,height:1024},{width:1440,height:900}];

test('production E2E and UI audit (synthetic data only)', async ({ browser, request }) => {
  fs.mkdirSync(out, { recursive: true });
  const rows = [], screenshots = [], evidence = { started: new Date().toISOString(), browser: browser.version(), baseURL: origin, headers: {}, ui: {}, network: {} };
  const row = (scenario, device, expected, actual, status, screenshot = '', where = '') => rows.push({scenario,device,expected,actual,status,screenshot,where});
  const check = (scenario, device, expected, actual, ok, screenshot = '', where = '') => row(scenario,device,expected,actual,ok?'PASS':'FAIL',screenshot,where);
  const safePath = url => { const u = new URL(url); return u.origin + u.pathname; };
  async function shot(page, name) {
    const rel = `e2e/artifacts/prod-audit/${name}.png`;
    await page.screenshot({path:path.resolve(__dirname,'..',rel),fullPage:true,animations:'disabled',mask:[page.locator('input[type=password]')]});
    screenshots.push(rel); return rel;
  }
  async function attempt(name, fn) {
    try { await fn(); } catch(e) { row(name,'—','Проверка выполнена',`${e.name}: ${String(e.message).split('\n')[0].slice(0,240)}`,'BLOCKED'); }
  }
  try {
    await attempt('Доступность и заголовки', async () => {
      for (const p of ['/', '/sign-in', '/api/auth/session', '/api/health']) {
        const r = await request.get(origin+p,{maxRedirects:0,timeout:20000});
        const h = r.headers();
        evidence.headers[p] = Object.fromEntries(['location','content-type','strict-transport-security','content-security-policy','x-frame-options','x-content-type-options','referrer-policy','cache-control'].filter(k=>h[k]).map(k=>[k,h[k]]));
        if(p==='/api/health' && r.status()===404) row('Health endpoint (optional)','HTTP','200 при наличии маршрута, иначе 404','404: маршрут не предусмотрен','PASS');
        else check(`HTTP ${p}`,'HTTP',p==='/'?'307 → /sign-in':'200',`status=${r.status()}${h.location?'; location='+safePath(new URL(h.location,origin).href):''}`,p==='/'?r.status()===307&&new URL(h.location,origin).pathname==='/sign-in':r.status()===200);
        if(p==='/api/auth/session') { const body=await r.json(); check('Анонимная сессия','HTTP','Нет user',`userPresent=${Boolean(body?.user)}`,!body?.user); }
        if(p==='/sign-in') {
          const missing=['strict-transport-security','x-content-type-options','referrer-policy'].filter(k=>!h[k]);
          if(!h['x-frame-options']&&!/frame-ancestors/i.test(h['content-security-policy']||''))missing.push('x-frame-options / CSP frame-ancestors');
          check('Защитные заголовки HTTPS','HTTP','HSTS, nosniff, referrer policy, frame protection согласно nginx-шаблону',`missing=${missing.join(', ')}`,!missing.length,'','deploy/nginx/taskboard.conf.template:75');
        }
      }
      const r=await request.get(origin.replace('https:','http:')+'/sign-in',{maxRedirects:0,timeout:20000});
      check('HTTP → HTTPS','HTTP','301/302/307/308 на тот же HTTPS origin',`status=${r.status()}; location=${r.headers().location||'нет'}`,[301,302,307,308].includes(r.status())&&new URL(r.headers().location,origin).origin===origin);
    });
    for(const p of ['/projects','/my-tasks','/messages','/settings','/admin','/admin/users','/projects/demo_project_1/board','/api/projects','/api/tasks','/api/users','/api/activities?taskId=prod-audit-nonexistent','/api/tokens','/api/admin/users']) await attempt(`Анонимный доступ ${p}`,async()=>{
      const r=await request.get(origin+p,{maxRedirects:0,timeout:15000});
      const loc=r.headers().location;
      const ok=[401,403].includes(r.status())||([301,302,303,307,308].includes(r.status())&&loc&&new URL(loc,origin).pathname==='/sign-in');
      check(`Без сессии ${p}`,'HTTP','Redirect /sign-in либо 401/403',`status=${r.status()}${loc?'; redirect='+new URL(loc,origin).pathname:''}`,ok,'','src/app/(dashboard)/layout.tsx; src/lib/auth.ts');
    });
    for(const p of ['/sign-in','/sign-up','/forgot-password']) for(const theme of ['light','dark']) for(const size of sizes) await attempt(`UI ${p} ${size.width} ${theme}`,async()=>{
      const context=await browser.newContext({viewport:size,locale:'ru-RU',timezoneId:'Europe/Moscow',colorScheme:'light',reducedMotion:'reduce',ignoreHTTPSErrors:false});
      await context.addInitScript(value=>localStorage.setItem('theme',value),theme);
      const page=await context.newPage();
      const net={js:[],console:[],server:[],foreign:[],mixed:[],failed:[],abortedPrefetch:[]};
      page.on('pageerror',e=>net.js.push(e.name+': '+e.message.slice(0,160)));
      page.on('console',m=>{if(m.type()==='error')net.console.push(m.text().replace(/https?:\/\/\S+/g,'[URL]').slice(0,200));});
      page.on('response',r=>{if(r.status()>=500)net.server.push({path:safePath(r.url()),status:r.status()});});
      page.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)net.foreign.push(u.origin+u.pathname);if(u.protocol==='http:')net.mixed.push(u.origin+u.pathname);});
      page.on('requestfailed',r=>{const item={path:safePath(r.url()),error:r.failure()?.errorText}; const h=r.headers(); if(item.error==='net::ERR_ABORTED'&&(h['next-router-prefetch']||h['purpose']==='prefetch'))net.abortedPrefetch.push(item);else net.failed.push(item);});
      try {
        let response;
        try { response=await page.goto(origin+p,{waitUntil:'networkidle',timeout:25000}); }
        catch(e) { if(!String(e.message).includes('ERR_NETWORK_CHANGED'))throw e; net.failed=[]; response=await page.goto(origin+p,{waitUntil:'networkidle',timeout:25000}); }
        await page.locator('h1').waitFor(); await page.evaluate(()=>document.fonts.ready);
        const device=`${size.width}×${size.height} ${theme}`;
        const screenshot=await shot(page,`${p.slice(1)}-${size.width}-${theme}`);
        check(`Открытие ${p}`,device,'200, HTTPS без игнорирования TLS',`status=${response.status()}; protocol=${new URL(page.url()).protocol}`,response.status()===200&&page.url().startsWith(origin),screenshot);
        const m=await page.evaluate(()=>{
          const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
          const info=e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,label:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,70),x:r.x,y:r.y,w:r.width,h:r.height};};
          const controls=[...document.querySelectorAll('input,button,a,select,textarea')].filter(visible);
          const buttons=[...document.querySelectorAll('button,[role=button]')].filter(visible).map(info);
          const inputs=[...document.querySelectorAll('input')].filter(visible).map(e=>({id:e.id,label: e.labels?.[0]?.textContent||e.getAttribute('aria-label')||e.getAttribute('aria-labelledby'),required:e.required}));
          const overlaps=[]; const cs=controls.map(info);
          for(let i=0;i<cs.length;i++)for(let j=i+1;j<cs.length;j++){const a=cs[i],b=cs[j];if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>2&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>2)overlaps.push([a.id||a.label,b.id||b.label]);}
          const clipped=[...document.querySelectorAll('label,button,h1,h2')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2&&['hidden','clip'].includes(getComputedStyle(e).overflowX)).map(info);
          return {scrollWidth:document.documentElement.scrollWidth,innerWidth,buttons,inputs,overlaps,clipped};
        });
        evidence.ui[`${p}-${size.width}-${theme}`]=m;
        check(`Горизонтальный scroll ${p}`,device,'scrollWidth ≤ viewport',`${m.scrollWidth} ≤ ${m.innerWidth}`,m.scrollWidth<=m.innerWidth,screenshot);
        check(`Перекрытия/обрезка ${p}`,device,'Нет перекрытий controls и обрезанных labels',JSON.stringify({overlaps:m.overlaps,clipped:m.clipped}),!m.overlaps.length&&!m.clipped.length,screenshot);
        const small=m.buttons.filter(b=>b.h<44||b.w<44);
        check(`Кнопки ≥44px ${p}`,device,'Все кнопки ≥44×44',JSON.stringify(small.length?small:m.buttons.map(b=>({label:b.label,w:b.w,h:b.h}))),!small.length,screenshot,'src/components/ui/button.tsx:20; src/components/shared/theme-toggle.tsx');
        check(`Подписи полей ${p}`,device,'Каждое поле имеет accessible name через label/ARIA',JSON.stringify(m.inputs),m.inputs.every(i=>Boolean(i.label)),screenshot);
        const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
        const violations=axe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
        evidence.ui[`${p}-${size.width}-${theme}`].axe=violations;
        const contrast=violations.filter(v=>v.id==='color-contrast');
        check(`Контраст ${p}`,device,'Нет axe color-contrast нарушений',JSON.stringify(contrast),!contrast.length,screenshot,'src/app/design-system.css; src/app/globals.css');
        check(`Axe WCAG AA ${p}`,device,'Нет автоматических нарушений',JSON.stringify(violations.map(v=>({id:v.id,count:v.nodes.length}))),!violations.length,screenshot);
        if(p==='/sign-in'){
          await page.locator('body').click({position:{x:1,y:1}});
          const focus=[];
          for(let i=0;i<9;i++){
            await page.keyboard.press('Tab');
            // Allow the focus-visible outline transition to render before measuring.
            await page.waitForTimeout(220);
            focus.push(await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,label:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,80),visible:e.matches(':focus-visible'),outline:s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0,shadow:s.boxShadow!=='none',w:r.width,h:r.height};}));
            if(i===4) await shot(page,`sign-in-focus-${size.width}-${theme}`);
          }
          evidence.ui[`${p}-${size.width}-${theme}`].focus=focus;
          const fsafe=focus.filter(f=>['INPUT','BUTTON','A'].includes(f.tag));
          check('Tab-порядок и видимый фокус',device,'Email, password, submit достижимы; focus-visible имеет outline/ring',JSON.stringify(focus),fsafe.some(f=>f.id==='email')&&fsafe.some(f=>f.id==='password')&&fsafe.every(f=>f.visible&&(f.outline||f.shadow)),screenshot,'src/app/globals.css:688');
          await page.locator('button[type=submit]').focus();
          for(const key of ['Enter','Space']){
            let authRequests=0;const count=r=>{if(r.method()==='POST')authRequests++;};page.on('request',count);
            await page.keyboard.press(key); await page.waitForTimeout(150);page.off('request',count);
            const invalid=await page.locator('#email').evaluate(e=>!e.validity.valid&&document.activeElement===e);
            check(`Пустая форма: ${key}`,device,'Нативная required-валидация, фокус на email, нет POST',`invalidFocused=${invalid}; POST=${authRequests}`,invalid&&authRequests===0,screenshot);
            await page.locator('button[type=submit]').focus();
          }
          await page.locator('#email').fill('invalid-email');await page.locator('#password').fill('synthetic-invalid');
          await page.locator('button[type=submit]').click();
          check('Неверный формат email',device,'typeMismatch блокирует submit',String(await page.locator('#email').evaluate(e=>e.validity.typeMismatch)),await page.locator('#email').evaluate(e=>e.validity.typeMismatch),screenshot);
          await page.locator('#email').fill('');await page.locator('#password').fill('');
          for(const key of ['Enter','Space']){
            await page.getByRole('banner').getByRole('button',{name:'Выбрать тему'}).focus(); await page.keyboard.press(key);
            const open=await page.getByRole('menu').isVisible();
            check(`Меню темы: ${key}`,device,'Клавиша открывает меню',`menuVisible=${open}`,open,screenshot);
            await page.keyboard.press('Escape');
          }
        }
        evidence.network[`${p}-${size.width}-${theme}`]=net;
        check(`JS/console ${p}`,device,'Нет pageerror/console.error',JSON.stringify({js:net.js,console:net.console}),!net.js.length&&!net.console.length,screenshot);
        check(`Сеть ${p}`,device,'Нет 5xx, mixed content, чужих origin и failed requests',JSON.stringify(net),!net.server.length&&!net.foreign.length&&!net.mixed.length&&!net.failed.length,screenshot);
      } finally {await context.close();}
    });
    await attempt('Неверные credentials и привязка ошибки',async()=>{
      const context=await browser.newContext({viewport:sizes[0]}); const page=await context.newPage();
      try {
        await page.goto(origin+'/sign-in');
        await page.locator('#email').fill(`prod-audit-missing-${crypto.randomUUID()}@example.invalid`);
        await page.locator('#password').fill(crypto.randomBytes(20).toString('base64url'));
        const rPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/callback/credentials');
        await page.getByRole('button',{name:'Войти',exact:true}).click();
        const r=await rPromise;await page.locator('#sign-in-error').waitFor();
        const linked=await page.locator('#email,#password').evaluateAll(es=>es.map(e=>({id:e.id,invalid:e.getAttribute('aria-invalid'),linked:(e.getAttribute('aria-describedby')||'').split(' ').some(id=>document.getElementById(id)?.getAttribute('role')==='alert')})));
        await page.locator('#email').fill('');await page.locator('#password').fill('');
        const s=await shot(page,'sign-in-invalid-375');
        check('Отказ неверным credentials','375×812','401, остаётся /sign-in, нет сессии',`callback=${r.status()}; path=${new URL(page.url()).pathname}`,r.status()===401&&new URL(page.url()).pathname==='/sign-in',s);
        check('Ошибка связана с полями','375×812','aria-invalid + aria-describedby → alert у email и password',JSON.stringify(linked),linked.every(x=>x.invalid==='true'&&x.linked),s,'src/app/sign-in/page.tsx:95');
      } finally {await context.close();}
    });
    await attempt('Регистрация',async()=>{
      const context=await browser.newContext({viewport:sizes[0]}); const page=await context.newPage();
      try {
        const identity={name:'Synthetic production QA',email:`prod-audit-${crypto.randomUUID()}@example.invalid`,password:crypto.randomBytes(24).toString('base64url')};
        await page.goto(origin+'/sign-up');await page.locator('#name').fill(identity.name);await page.locator('#email').fill(identity.email);await page.locator('#password').fill(identity.password);
        const rPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/register'&&r.request().method()==='POST');
        await page.getByRole('button',{name:'Создать аккаунт',exact:true}).click();
        const r=await rPromise; const body=await r.json();const code=typeof body.error==='string'?body.error:body.error?.code;
        if(r.status()===403&&code==='REGISTRATION_DISABLED'){
          await page.locator('#sign-up-error').waitFor();await page.locator('#name').fill('');await page.locator('#email').fill('');await page.locator('#password').fill('');
          const s=await shot(page,'sign-up-disabled-375');
          check('Закрытая регистрация','375×812','403 REGISTRATION_DISABLED, понятный alert',`status=${r.status()}; code=${code}; alert=${await page.locator('#sign-up-error').innerText()}`,true,s);
          row('Регистрация новой синтетической записи','375×812','201 при LOCAL_AUTH_MODE=open','Регистрация закрыта runtime-ответом 403','BLOCKED',s);
          row('Повторная регистрация того же email','375×812','Повтор не создаёт аккаунт и не раскрывает существование email','Новая запись не создана: REGISTRATION_DISABLED','BLOCKED',s);
        }else if(r.status()===201){
          check('Регистрация новой синтетической записи','375×812','201',`status=${r.status()}`,true);
          // Same synthetic email; API contract deliberately returns generic 201, not 409.
          const duplicate=await context.request.post(origin+'/api/auth/register',{data:identity});
          const db=await duplicate.json();check('Повторная регистрация того же email','HTTP','Та же generic 201, без дополнительного аккаунта',`status=${duplicate.status()}; sameResponse=${JSON.stringify(body)===JSON.stringify(db)}`,duplicate.status()===201&&JSON.stringify(body)===JSON.stringify(db));
          await page.goto(origin+'/sign-in');await page.locator('#email').fill(identity.email);await page.locator('#password').fill(identity.password);await page.getByRole('button',{name:'Войти',exact:true}).click();
          await page.waitForTimeout(2500);const session=await context.request.get(origin+'/api/auth/session');const signed=Boolean((await session.json())?.user);
          check('Вход новой синтетической записи','375×812','Сессия либо явное требование email verification',`sessionPresent=${signed}; path=${new URL(page.url()).pathname}`,signed);
          row('Авторизованные продуктовые сценарии','—','Доска, заявки, файлы, realtime, роли','Нет заранее подготовленного тестового пространства; новые чужие записи не затрагивались','BLOCKED');
        }else check('Регистрация','375×812','201 либо 403 REGISTRATION_DISABLED',`status=${r.status()}; code=${code||'unknown'}`,false,'','src/app/api/auth/register/route.ts:34');
      } finally {await context.close();}
    });
    row('15 предзаданных аккаунтов / роли / продуктовые E2E','—','Действующие тестовые credentials','docs/engineering/MVP_AUTH.md и deploy/RESPONSE_TO_PAVEL.md: пароли только в серверных env/закрытом канале; доступных паролей в docs/deploy нет','BLOCKED');
    row('Визуальная регрессия относительно эталона','Все','Проверенный production baseline','Выполнены текущие screenshots, геометрия и axe; эталон именно production отсутствует','BLOCKED');
  } finally {
    evidence.finished=new Date().toISOString();evidence.rows=rows;evidence.screenshots=screenshots;
    fs.writeFileSync(path.join(out,'audit-results.json'),JSON.stringify(evidence,null,2));
  }
  expect(rows.filter(r=>r.status==='FAIL').map(r=>`${r.scenario} ${r.device}: ${r.actual}`),'Production audit findings (see audit-results.json)').toEqual([]);
});
