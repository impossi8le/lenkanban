import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const state = vi.hoisted(() => {
 const handlers = new Map<string, (payload: unknown) => void>();
 const socket = {on:(name:string,callback:(payload:unknown)=>void)=>handlers.set(name,callback),off:(name:string)=>handlers.delete(name)};
 return {handlers,socket,joined:false};
});
vi.mock('@/hooks/useProjectBoard',()=>({useProjectBoard:()=>({isJoined:state.joined,socket:state.socket})}));
import { useTaskDetailRealtime } from './useTaskDetailRealtime';
let client: QueryClient;
afterEach(()=>{cleanup();client?.clear();state.handlers.clear();state.joined=false;vi.useRealTimers();});
function wrapper({children}:{children:ReactNode}){return <QueryClientProvider client={client}>{children}</QueryClientProvider>;}
function deferred(){let resolve!:()=>void;let reject!:(error:Error)=>void;const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject};}
it('bounds overlap while the current detail read remains pending',async()=>{
 const hook=useTaskDetailRealtime,expected=1;
 vi.useFakeTimers(); client=new QueryClient(); const pending=deferred(); const read=vi.fn(()=>pending.promise);
 renderHook(()=>hook('project','task',read),{wrapper});
 for(let index=0;index<20;index++){
  act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));
  await act(()=>vi.advanceTimersByTimeAsync(150));
 }
 expect(read).toHaveBeenCalledTimes(expected);
 await act(async()=>{pending.resolve();await pending.promise;});
 await act(()=>vi.advanceTimersByTimeAsync(100));
 expect(read).toHaveBeenCalledTimes(expected===1?2:20);
});
it('close cancels the queued catch-up without repeating the pending read',async()=>{
 vi.useFakeTimers(); client=new QueryClient(); const pending=deferred(); const read=vi.fn(()=>pending.promise);
 const view=renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 view.unmount();await act(async()=>pending.resolve());await act(()=>vi.advanceTimersByTimeAsync(100));
 expect(read).toHaveBeenCalledTimes(1);expect(state.handlers.size).toBe(0);
});

it('history invalidates at actual read start, even while detail never settles',async()=>{
 vi.useFakeTimers();client=new QueryClient();const invalidate=vi.spyOn(client,'invalidateQueries');const pending=deferred();const read=vi.fn(()=>pending.promise);
 client.setQueryData(['activities','task','actor'],[]);client.setQueryData(['activities','other-task','actor'],[]);
 client.setQueryData(['task-related','actor','task',1],[]);client.setQueryData(['task-related','actor','other-task',1],[]);
 const view=renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));expect(invalidate).not.toHaveBeenCalled();
 await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).toHaveBeenCalledOnce();
 expect(invalidate).toHaveBeenCalledWith({queryKey:['activities','task']});
 expect(client.getQueryState(['activities','task','actor'])?.isInvalidated).toBe(true);
 expect(client.getQueryState(['activities','other-task','actor'])?.isInvalidated).toBe(false);
 expect(client.getQueryState(['task-related','actor','task',1])?.isInvalidated).toBe(true);
 expect(client.getQueryState(['task-related','actor','other-task',1])?.isInvalidated).toBe(false);
 view.unmount();await act(async()=>pending.resolve());
});
it('same-card reconnect preserves the active read and one catch-up',async()=>{
 vi.useFakeTimers();client=new QueryClient();const pending=deferred();const read=vi.fn(()=>pending.promise);
 const view=renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 state.joined=true;view.rerender();await act(()=>vi.advanceTimersByTimeAsync(500));expect(read).toHaveBeenCalledOnce();
 state.socket={...state.socket};view.rerender();await act(()=>vi.advanceTimersByTimeAsync(500));expect(read).toHaveBeenCalledOnce();
 await act(async()=>pending.resolve());await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).toHaveBeenCalledTimes(2);
});
it('B starts while A is pending; A completion never schedules another B read',async()=>{
 vi.useFakeTimers();client=new QueryClient();const a=deferred(),b=deferred();const readA=vi.fn(()=>a.promise),readB=vi.fn(()=>b.promise);
 const view=renderHook(({task,read})=>useTaskDetailRealtime('project',task,read),{wrapper,initialProps:{task:'A',read:readA}});
 act(()=>state.handlers.get('task:updated')?.({id:'A',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 act(()=>state.handlers.get('task:updated')?.({id:'A',projectId:'project'}));
 view.rerender({task:'B',read:readB});act(()=>state.handlers.get('task:updated')?.({id:'B',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 expect(readA).toHaveBeenCalledOnce();expect(readB).toHaveBeenCalledOnce();
 await act(async()=>a.resolve());await act(()=>vi.advanceTimersByTimeAsync(500));expect(readA).toHaveBeenCalledOnce();expect(readB).toHaveBeenCalledOnce();
 view.unmount();await act(async()=>b.resolve());
});
it('latest callback for the same card is used for its queued catch-up',async()=>{
 vi.useFakeTimers();client=new QueryClient();const pending=deferred();const original=vi.fn(()=>pending.promise),latest=vi.fn();
 const view=renderHook(({read})=>useTaskDetailRealtime('project','task',read),{wrapper,initialProps:{read:original as ()=>void|Promise<void>}});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));view.rerender({read:latest});
 await act(async()=>pending.resolve());await act(()=>vi.advanceTimersByTimeAsync(100));expect(original).toHaveBeenCalledOnce();expect(latest).toHaveBeenCalledOnce();
});
it('rejection after unmount is handled and cannot schedule queued reads',async()=>{
 vi.useFakeTimers();client=new QueryClient();const pending=deferred();const read=vi.fn(()=>pending.promise);
 const view=renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 act(()=>state.handlers.get('task:deleted')?.({taskId:'task',projectId:'project'}));view.unmount();
 await act(async()=>{pending.reject(new Error('synthetic read rejection'));await Promise.resolve();});await act(()=>vi.advanceTimersByTimeAsync(500));
 expect(read).toHaveBeenCalledOnce();expect(state.handlers.size).toBe(0);
});
it('cleanup before debounce prevents callback invocation for either target',async()=>{
 vi.useFakeTimers();client=new QueryClient();const readA=vi.fn(),readB=vi.fn();
 const view=renderHook(({task,read})=>useTaskDetailRealtime('project',task,read),{wrapper,initialProps:{task:'A',read:readA}});
 act(()=>state.handlers.get('task:updated')?.({id:'A',projectId:'project'}));
 view.rerender({task:'B',read:readB});view.unmount();await act(()=>vi.advanceTimersByTimeAsync(500));expect(readA).not.toHaveBeenCalled();expect(readB).not.toHaveBeenCalled();
});
it('preserves foreign-event filters and the original moved/deleted matching rules',async()=>{
 vi.useFakeTimers();client=new QueryClient();const read=vi.fn();renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>{
  state.handlers.get('task:updated')?.({id:'task',projectId:'foreign'});
  state.handlers.get('task:updated')?.({id:'foreign',projectId:'project'});
  state.handlers.get('task:deleted')?.({taskId:'task',projectId:'foreign'});
  state.handlers.get('task:moved')?.({task:{id:'foreign'}});
 });await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).not.toHaveBeenCalled();
 act(()=>state.handlers.get('task:moved')?.({task:{id:'task'}}));await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).toHaveBeenCalledOnce();
 act(()=>state.handlers.get('task:deleted')?.({taskId:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).toHaveBeenCalledTimes(2);
});
it('rejection while mounted still drains one queued catch-up with latest callback',async()=>{
 vi.useFakeTimers();client=new QueryClient();const pending=deferred();const read=vi.fn().mockImplementationOnce(()=>pending.promise).mockResolvedValue(undefined);
 renderHook(()=>useTaskDetailRealtime('project','task',read),{wrapper});
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));await act(()=>vi.advanceTimersByTimeAsync(100));
 act(()=>state.handlers.get('task:updated')?.({id:'task',projectId:'project'}));
 await act(async()=>{pending.reject(new Error('synthetic read rejection'));await Promise.resolve();});await act(()=>vi.advanceTimersByTimeAsync(100));expect(read).toHaveBeenCalledTimes(2);
});
