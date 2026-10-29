import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ session:vi.fn(), token:vi.fn(), handler:vi.fn(), info:vi.fn(),warn:vi.fn(),error:vi.fn() }));
vi.mock('./prisma',()=>({prisma:{apiToken:{findUnique:mocks.token}}}));
vi.mock('./require-user',()=>({requireDbUser:mocks.session}));
vi.mock('./logger',()=>({apiLogger:{info:mocks.info,warn:mocks.warn,error:mocks.error}}));
import { organizationApi } from './organization-api';

beforeEach(()=>{
  for (const name of ['NEXT_PUBLIC_APP_URL','APP_URL','NEXTAUTH_URL']) vi.stubEnv(name,undefined);
  vi.resetAllMocks();vi.stubEnv('TELEMETRY_ENABLED','false');
  mocks.session.mockResolvedValue({id:'actor',globalRole:'ADMIN'});
  mocks.handler.mockResolvedValue(new Response('{}',{status:200}));
});
afterEach(()=>vi.unstubAllEnvs());

it.each(['Bearer\tinvalid','Bearer\vunsupported','Basic synthetic-value'])('cookie fallback cannot obtain bearer Origin waiver: %s',async authorization=>{
  const input=new Request('https://app.test/api/admin/organization/groups',{method:'POST',headers:{authorization,cookie:'synthetic-cookie'}});
  const response=await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true);
  expect(mocks.session).toHaveBeenCalledOnce(); // Actual getApiUser cookie fallback.
  expect(mocks.token).not.toHaveBeenCalled();
  expect(response.status).toBe(403);expect(mocks.handler).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('rejects missing-Origin cross-site before the bearer waiver even when outer identity is valid',async()=>{
  const input=new Request('https://app.test/api/admin/organization/groups',{method:'POST',headers:{authorization:'Bearer\tinvalid','sec-fetch-site':'cross-site'}});
  expect((await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true)).status).toBe(403);
  expect(mocks.handler).not.toHaveBeenCalled();
});
it('keeps authenticated same-origin cookie mutation usable with a non-bearer header',async()=>{
  const input=new Request('https://app.test/api/admin/organization/groups',{method:'POST',headers:{authorization:'Bearer\tinvalid',origin:'https://app.test','sec-fetch-site':'same-origin'}});
  expect((await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true)).status).toBe(200);
  expect(mocks.session).toHaveBeenCalledOnce();expect(mocks.handler).toHaveBeenCalledOnce();
});
it('accepts the configured public origin when a proxy derived an internal request origin',async()=>{
  vi.stubEnv('NEXTAUTH_URL','https://public.test');
  const input=new Request('http://localhost:3000/api/admin/organization/groups',{method:'POST',headers:{origin:'https://public.test','sec-fetch-site':'same-origin'}});
  expect((await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true)).status).toBe(200);
  expect(mocks.handler).toHaveBeenCalledOnce();
});
it('still rejects a foreign origin once a public origin is configured',async()=>{
  vi.stubEnv('NEXTAUTH_URL','https://public.test');
  const input=new Request('http://localhost:3000/api/admin/organization/groups',{method:'POST',headers:{origin:'https://evil.test','sec-fetch-site':'same-origin'}});
  expect((await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true)).status).toBe(403);
  expect(mocks.handler).not.toHaveBeenCalled();
});
it('still rejects a cookie mutation without Origin when a public origin is configured',async()=>{
  vi.stubEnv('NEXTAUTH_URL','https://public.test');
  const input=new Request('http://localhost:3000/api/admin/organization/groups',{method:'POST',headers:{cookie:'synthetic-cookie'}});
  expect((await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true)).status).toBe(403);
  expect(mocks.handler).not.toHaveBeenCalled();
});
it('rejects a revoked bearer before body and never falls back to an ADMIN cookie',async()=>{
  mocks.token.mockResolvedValue({id:'credential',revokedAt:new Date(),user:{id:'actor',globalRole:'ADMIN'}});
  const input=new Request('https://app.test/api/admin/organization/groups',{
    method:'POST',headers:{authorization:`Bearer kb2_123456789abc_${'s'.repeat(43)}`,
      cookie:'synthetic-cookie',origin:'https://app.test','content-type':'application/json'},
    body:JSON.stringify({secret:'synthetic-secret'}),
  });
  const reader=vi.spyOn(input.body!,'getReader');
  const response=await organizationApi(input,'/api/admin/organization/groups',mocks.handler,true);
  expect(response.status).toBe(401);expect(mocks.token).toHaveBeenCalledOnce();
  expect(mocks.session).not.toHaveBeenCalled();expect(reader).not.toHaveBeenCalled();
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(JSON.stringify([...mocks.info.mock.calls,...mocks.warn.mock.calls,...mocks.error.mock.calls])).not.toContain('synthetic-secret');
});
