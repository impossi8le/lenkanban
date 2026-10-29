import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, isConfirmedAuthorDateCorrection } from '../../scripts/mail/iab-store.mjs';
const base='https://mail.example.test/basemail.php?folder=all';
const url=`${base}&topicid=1`;
const old={source_instance:'https://mail.example.test',source_message_id:'post_1',source_url:url,topic_id:'1',title:'Synthetic',body_text:'Synthetic body',sent_at:'20.10.2026 18:30',author_text:'Synthetic author',content_status:'complete',attachments:[],attachments_status:'unverified'};
const corrected={...old,sent_at:'20.10.2026 09:40',source_header_dates:{author_header:'20.10.2026 09:40',secondary_header:'20.10.2026 18:30'},source_date_observation:{primary_field:'author_header',secondary_semantics:'unverified',parser_version:'basemail-author-date-v2'}};
test('date correction requires exact observed dual-date parser evidence and unchanged message content',()=>{
 assert.equal(isConfirmedAuthorDateCorrection(old,corrected),true);
 for(const changed of [{...corrected,body_text:'Different body'},{...corrected,author_text:'Other'},{...corrected,source_date_observation:undefined},{...corrected,sent_at:'21.10.2026 09:40'},{...corrected,source_header_dates:{...corrected.source_header_dates,secondary_header:'Other'}}])assert.equal(isConfirmedAuthorDateCorrection(old,changed),false);
});
test('date replay preserves originals in audit and enriches unchanged records with durable provenance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'date-repair-'));const s=await openStore({dir,scope:base});
 try{
 s.ingestListPage({url:base,topics:[{topic_id:'1',title:old.title,source_url:url}],page_links:[],filter_confirmed:true,pagination_verified:true});
 const ingest=messages=>s.ingestTopicPage({url,topic_id:'1',title:old.title,messages,page_links:[],content_verified:true,pagination_verified:true});
 ingest([old,{...old,source_message_id:'post_2',sent_at:corrected.sent_at}]);
 ingest([corrected,{...corrected,source_message_id:'post_2'}]);
 assert.equal(s.progress().date_audit.observed_messages,1);
 assert.equal(s.progress().date_audit.legacy_messages,1);
 assert.equal(s.resolveDateParsingCorrections().resolved,1);
 assert.equal(s.progress().date_audit.status,'observed_author_header');
 assert.equal(s.progress().conflict_versions,0);
 assert.equal(s.progress().resolved_date_parsing_variants,1);
 assert.equal(s.resolveDateParsingCorrections().resolved,0);
 await s.exportNdjson();const audit=JSON.parse((await readFile(join(dir,'conflict-resolutions.ndjson'),'utf8')).trim());
 assert.equal(audit.original.sent_at,old.sent_at);assert.equal(audit.canonical.sent_at,corrected.sent_at);assert.deepEqual(audit.source_header_dates,corrected.source_header_dates);
 const unchangedAudit=JSON.parse((await readFile(join(dir,'date-observations.ndjson'),'utf8')).trim());
 assert.equal(unchangedAudit.original.source_message_id,'post_2');assert.equal(unchangedAudit.original.source_date_observation,undefined);assert.deepEqual(unchangedAudit.source_header_dates,corrected.source_header_dates);
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
