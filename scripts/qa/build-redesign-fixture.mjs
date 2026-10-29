import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'outputs/design/redesign-production-qa');
await mkdir(out,{recursive:true});
const sources={
 'next/link':`import React from 'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
 'next/navigation':`export const usePathname=()=>'/';export const useSearchParams=()=>new URLSearchParams();export const useRouter=()=>({push:(href)=>window.dispatchEvent(new CustomEvent('fixture:navigate',{detail:href})),replace:()=>{},refresh:()=>{}});`,
 'next/dynamic':`import React from 'react';export default function dynamic(loader){const Component=React.lazy(async()=>{const m=await loader();return {default:m.default??m}});return p=><React.Suspense fallback={null}><Component {...p}/></React.Suspense>}`,
 'next-auth/react':`export const useSession=()=>({status:'authenticated',data:{user:{id:'synthetic-actor',name:'Тестовый сотрудник',email:'fixture@example.invalid'}}});`,
 '@/hooks/useUnreadCounts':`export const useUnreadCounts=()=>({byProject:{support:2},total:2});`,
 '@/hooks/useProjectBoard':`export const useProjectBoard=()=>({socket:null,isJoined:false});`,
 '@/lib/telemetry/client':`export const getBrowserTelemetryClient=()=>null;`,
 '@/lib/prisma':`export const prisma={};`,
 '@/lib/logger':`export const dbLogger={error:()=>{},info:()=>{}};`,
 // Replace the transport boundary, never the discussion UI. Emit a canonical
 // synthetic DTO so the actual chat reconciles its optimistic send normally.
 '@/hooks/useTaskChat':`const listeners=new Map();const socket={connected:true,on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return socket;},off(event,fn){listeners.get(event)?.delete(fn);return socket;},emit(event,payload,ack){ack?.({ok:true});if(event==='message:send'){window.__fixtureSends=(window.__fixtureSends??0)+1;queueMicrotask(()=>{const message={...payload,id:'confirmed-'+payload.clientId,authorId:'synthetic-actor',author:{id:'synthetic-actor',name:'Тестовый сотрудник',email:'fixture@example.invalid'},createdAt:new Date().toISOString(),mentions:[],reactions:{}};for(const fn of listeners.get('message:new')??[])fn(message);});}return socket;}};export const useTaskChat=()=>({socket,isConnected:true,isJoined:true,lastError:null});`,
};
await build({entryPoints:['scripts/qa/redesign-fixture.tsx'],outfile:path.join(out,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"','process.env':'{}'},plugins:[{name:'isolated-boundaries',setup(b){b.onResolve({filter:/.*/},args=>sources[args.path]?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:sources[args.path],loader:'tsx',resolveDir:root}));}}]});
// Scope Tailwind discovery to actual source and this fixture. Automatically
// scanning work/ or previous generated bundles makes this isolated check slow.
const fixtureCss=(await readFile('src/app/globals.css','utf8')).replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "../";\n@source "../../scripts/qa";');
const css=await postcss([tailwind()]).process(fixtureCss,{from:path.join(root,'src/app/globals.css'),to:path.join(out,'fixture.css')});await writeFile(path.join(out,'fixture.css'),css.css);
await writeFile(path.join(out,'index.html'),'<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Реальные компоненты — изолированная проверка</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');

