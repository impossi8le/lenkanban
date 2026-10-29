import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createOrganizationService } from '../src/lib/organization';
import { decodeOrganizationResult, decodePrivilegeProfileSettings, type OrganizationCommandActor, type OrganizationResult } from '../src/lib/organization-command';
import type { OrganizationMutation } from '../src/lib/organization-contract';
import { normalizeLogin } from '../src/lib/login-identity';
import { logAuthEvent } from '../src/lib/logger';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const legacyId = z.string().regex(/^[0-9]{1,10}$/);
const planSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  groups: z.array(z.object({ legacyId, name: z.string().trim().min(1).max(120) }).strict()).length(52),
  users: z.array(z.object({ id: identifier, legacyId, legacyIds: z.array(legacyId).min(1).max(2),
    name: z.string().min(1).max(100), login: z.string().regex(/^[а-яёa-z0-9]+$/u),
    email: z.string().min(1).max(254), groupIds: z.array(legacyId).min(1).max(52),
  }).strict()).length(391),
  mergedIdentities: z.array(z.object({ name: z.string(), legacyIds: z.array(legacyId) }).strict()).length(3),
}).strict();
const inputSchema = z.object({
  phase: z.enum(['dry-run', 'preserve', 'apply', 'activate']), importId: identifier,
  plan: planSchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedExistingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  password: z.string().min(1).max(128).optional(),
  actorId: identifier,
  departmentIds: z.object({ support: identifier, quality: identifier }).strict(),
}).strict();
type Input = z.infer<typeof inputSchema>;
const preservedSelection = { id: true, email: true, name: true, passwordHash: true, globalRole: true,
  primaryDepartmentId: true, isBlocked: true, blockedAt: true, authSource: true, externalId: true,
  emailVerified: true } as const;
/** Stable across JSON key order, Zod projection, and Python sort_keys manifests. */
export function peopleImportDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const digest = peopleImportDigest;
function need(value: unknown, token: string): asserts value { if (!value) throw new Error(token); }
function operationUuid(importId: string, label: string): string {
  const hex = digest([importId, label]);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function departmentFor(input: Input, groupIds: readonly string[]): string | null {
  const names = groupIds.map(id => input.plan.groups.find(group => group.legacyId === id)!.name);
  const support = names.includes('IT отдел - Техподдержка');
  const quality = names.includes('ОКК') || names.includes('ОЗОК');
  need(!(support && quality), 'AMBIGUOUS_DEPARTMENT');
  return support ? input.departmentIds.support : quality ? input.departmentIds.quality : null;
}
function validatePlan(input: Input) {
  need(digest(input.plan) === input.manifestSha256, 'MANIFEST_DIGEST_MISMATCH');
  const users = input.plan.users, groups = input.plan.groups;
  need(new Set(groups.map(g => g.legacyId)).size === 52 && new Set(groups.map(g => g.name)).size === 52, 'DUPLICATE_GROUP');
  need(new Set(users.map(u => u.id)).size === 391 && new Set(users.map(u => u.email)).size === 391, 'DUPLICATE_ACCOUNT');
  need(new Set(users.flatMap(u => u.legacyIds)).size === 394 && users.reduce((n,u)=>n+u.legacyIds.length,0) === 394, 'LEGACY_IDENTITIES_MISMATCH');
  for (const user of users) {
    need(user.id === `people-legacy-user-${user.legacyId}` && user.legacyIds.includes(user.legacyId), 'USER_ID_MISMATCH');
    need(normalizeLogin(user.login) === user.email && user.email === `${user.login}@taskboard.lenremontn8n.ru`, 'LOGIN_IDENTITY_MISMATCH');
    need(new Set(user.groupIds).size === user.groupIds.length && user.groupIds.every(id => groups.some(g=>g.legacyId===id)), 'GROUP_REFERENCE_MISMATCH');
    departmentFor(input, user.groupIds);
  }
  need(groups.filter(g=>['IT отдел - Техподдержка','ОКК','ОЗОК'].includes(g.name)).length === 3, 'EXECUTOR_GROUPS_MISSING');
}

/** Administrative provisioning only. No credentials/PII in the returned receipt. */
export async function provisionPeopleRoles(db: PrismaClient, untrusted: unknown) {
  const input = inputSchema.parse(untrusted); validatePlan(input);
  const ids = input.plan.users.map(u=>u.id), idsSet = new Set(ids);
  const preserved = async (client: Pick<Prisma.TransactionClient,'user'> = db) => {
    const rows = await client.user.findMany({ where: { id: { notIn: ids } }, select: preservedSelection, orderBy: { id: 'asc' } });
    return { rows, digest: digest(rows) };
  };
  const checkAdminAndDepartments = async (client: Prisma.TransactionClient | PrismaClient = db) => {
    const actor = await client.user.findUnique({ where: { id: input.actorId }, select: { globalRole: true, isBlocked: true, blockedAt: true } });
    need(actor?.globalRole === 'ADMIN' && !actor.isBlocked && actor.blockedAt === null && !idsSet.has(input.actorId), 'ACTIVE_EXISTING_ADMIN_REQUIRED');
    for (const [key,name] of [['support','Поддержка'],['quality','Отдел качества']] as const) {
      const row = await client.department.findUnique({ where: { id: input.departmentIds[key] } });
      need(row?.name === name && row.archivedAt === null, 'DEPARTMENT_IDENTITY_CHANGED');
    }
  };
  async function ownedReceipt(client: Prisma.TransactionClient | PrismaClient, key: string, method: 'createPrivilegeProfile' | 'createGroup', required = false): Promise<string | null> {
    const row = await client.organizationOperation.findUnique({ where: { actorId_operationId: { actorId: input.actorId, operationId: operationUuid(input.importId, key) } } });
    if (!row) { need(!required, 'IMPORT_RESOURCE_RECEIPT_MISSING'); return null; }
    need(row.operation === method && row.targetKind === (method === 'createGroup' ? 'group' : 'profile'), 'IMPORT_RESOURCE_RECEIPT_DRIFT');
    const decoded = decodeOrganizationResult(method, row.result);
    need('id' in decoded && decoded.id === row.targetId, 'IMPORT_RESOURCE_RECEIPT_DRIFT');
    return decoded.id;
  }
  async function checkNameConflicts(client: Prisma.TransactionClient | PrismaClient, key?: string) {
    for (const [roleKey, name] of [['employee', 'Сотрудник'], ['executor', 'Исполнитель']] as const) {
      if (key && key !== `profile:${roleKey}`) continue;
      const owned = await ownedReceipt(client, `profile:${roleKey}`, 'createPrivilegeProfile');
      const matches = await client.privilegeProfile.findMany({ where: { name }, select: { id: true } });
      need(matches.every(row => row.id === owned), 'PROFILE_NAME_CONFLICT');
    }
    for (const group of input.plan.groups) {
      const groupKey = `group:${group.legacyId}`;
      if (key && key !== groupKey) continue;
      const owned = await ownedReceipt(client, groupKey, 'createGroup');
      const matches = await client.responsibleGroup.findMany({ where: { name: group.name }, select: { id: true } });
      need(matches.every(row => row.id === owned), 'GROUP_NAME_CONFLICT');
    }
  }
  await checkAdminAndDepartments();
  await checkNameConflicts(db, input.phase === 'preserve' ? 'profile:executor' : undefined);
  const before = await preserved();
  if (input.phase !== 'dry-run') need(input.expectedExistingDigest === before.digest, 'EXISTING_ACCOUNT_SET_CHANGED');
  const existingTargets = await db.user.findMany({ where: { OR: [{ id: { in: ids } }, { email: { in: input.plan.users.map(u=>u.email) } }] }, select: preservedSelection });
  for (const row of existingTargets) {
    const expected = input.plan.users.find(u=>u.id===row.id);
    need(expected && expected.email === row.email && expected.name === row.name && row.globalRole === 'USER'
      && row.authSource === 'local' && row.externalId === null, 'ACCOUNT_COLLISION_OR_DRIFT');
  }
  if (input.phase === 'dry-run') return { passed: true, phase: input.phase, importId: input.importId,
    manifestSha256: input.manifestSha256, expectedExistingDigest: before.digest, existingUsers: before.rows.length,
    intendedUsers: ids.length, newUsers: ids.length-existingTargets.length, existingImportedUsers: existingTargets.length,
    intendedGroups: input.plan.groups.length, executorUsers: input.plan.users.filter(u=>departmentFor(input,u.groupIds)).length };

  let currentOrgKey: string | null = null;
  const guardedDatabase = { $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'},0))::text AS locked`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.importId},0))::text AS locked`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.actorId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ANY(${Object.values(input.departmentIds)}::text[]) ORDER BY "id" FOR SHARE`;
    await checkAdminAndDepartments(tx);
    need((await preserved(tx)).digest === input.expectedExistingDigest, 'EXISTING_ACCOUNT_PRESERVATION_FAILED');
    if (currentOrgKey?.startsWith('profile:') || currentOrgKey?.startsWith('group:')) await checkNameConflicts(tx, currentOrgKey);
    return run(tx);
  }, options) } as unknown as Pick<PrismaClient, '$transaction'>;
  const service = createOrganizationService(guardedDatabase);
  async function org<T extends OrganizationResult>(key: string, action: (meta: OrganizationCommandActor) => Promise<OrganizationMutation<T>>): Promise<T> {
    await checkAdminAndDepartments();
    const operationId = operationUuid(input.importId, key);
    const receipt = await db.organizationOperation.findUnique({ where: { actorId_operationId: { actorId: input.actorId, operationId } } });
    const version = receipt?.expectedVersion ?? (await db.organizationState.findUnique({ where: { id: 'organization' } }))?.version ?? 0;
    currentOrgKey = key;
    try { return (await action({ actorId: input.actorId, operationId, expectedVersion: version })).result; }
    finally { currentOrgKey = null; }
  }
  const role = async (key: string, name: string, permissions: ('request.execute')[], visibility: 'own'|'board') => {
    const result = await org(`profile:${key}`,meta=>service.createPrivilegeProfile({ ...meta, name, permissions, visibility }));
    const row = await db.privilegeProfile.findUnique({ where: { id: result.id } });
    need(row && row.name===name && row.archivedAt===null, 'PROFILE_IDENTITY_DRIFT');
    const settings = decodePrivilegeProfileSettings(row.permissions);
    need(JSON.stringify(settings.permissions)===JSON.stringify(permissions) && settings.visibility===visibility, 'PROFILE_PERMISSION_DRIFT');
    return result.id;
  };
  const existingProfileIds = (key: string) => ownedReceipt(db, `profile:${key}`, 'createPrivilegeProfile', true) as Promise<string>;
  const createdIds = new Set<string>();
  const initialHashes = new Map<string, string>();
  let createdCount=0;
  if (input.phase === 'preserve') {
    const executor = await role('executor', 'Исполнитель', ['request.execute'], 'board');
    const staff = before.rows.filter(old => !old.isBlocked && old.blockedAt === null
      && [input.departmentIds.support, input.departmentIds.quality].includes(old.primaryDepartmentId ?? ''));
    for (const old of staff) await org(`preserve-execution:${old.id}:${old.primaryDepartmentId}`, meta => service.setPrivilegeAssignment({
      ...meta, userId: old.id, profileId: executor, scopeKind: 'department', departmentId: old.primaryDepartmentId, projectId: null, assigned: true,
    }));
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'},0))::text AS locked`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.importId},0))::text AS locked`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${before.rows.map(row => row.id).sort()}::text[]) ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ANY(${Object.values(input.departmentIds)}::text[]) ORDER BY "id" FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "PrivilegeProfile" WHERE "id" = ${executor} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "ScopedPrivilegeAssignment" WHERE "userId" = ANY(${staff.map(row => row.id).sort()}::text[]) ORDER BY "id" FOR SHARE`;
      await checkAdminAndDepartments(tx);
      need(await ownedReceipt(tx, 'profile:executor', 'createPrivilegeProfile', true) === executor, 'IMPORT_PROFILE_RECEIPT_DRIFT');
      const profile = await tx.privilegeProfile.findUnique({ where: { id: executor } });
      need(profile?.name === 'Исполнитель' && profile.archivedAt === null, 'PROFILE_IDENTITY_DRIFT');
      const settings = decodePrivilegeProfileSettings(profile.permissions);
      need(settings.visibility === 'board' && JSON.stringify(settings.permissions) === JSON.stringify(['request.execute']), 'PROFILE_PERMISSION_DRIFT');
      const grants = await tx.scopedPrivilegeAssignment.findMany({ where: { userId: { in: staff.map(row => row.id) }, profileId: executor } });
      for (const old of staff) need(grants.some(grant => grant.userId === old.id && grant.scopeKind === 'department'
        && grant.departmentId === old.primaryDepartmentId && grant.projectId === null), 'EXISTING_EXECUTION_GRANT_MISSING');
      need((await preserved(tx)).digest === input.expectedExistingDigest, 'EXISTING_ACCOUNT_PRESERVATION_FAILED');
    }, { maxWait: 10000, timeout: 30000 });
    return { passed: true, phase: input.phase, importId: input.importId, manifestSha256: input.manifestSha256,
      existingUsers: before.rows.length, preservedExecutors: staff.length, existingAccountsPreserved: true,
      importedUsers: 0, importedGroups: 0, createdCount: 0, activatedCount: 0, newGlobalAdmins: 0 };
  }
  if (input.phase === 'apply') {
    const hashes = initialHashes;
    for (const target of input.plan.users) if (!existingTargets.some(u=>u.id===target.id)) { need(input.password, 'INITIAL_PASSWORD_REQUIRED'); try { hashes.set(target.id,await bcrypt.hash(input.password,12)); } catch { throw new Error('PASSWORD_HASH_FAILED'); } }
    await db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'},0))::text AS locked`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.importId},0))::text AS locked`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${[...ids, ...before.rows.map(row => row.id)].sort()}::text[]) ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ANY(${Object.values(input.departmentIds)}::text[]) ORDER BY "id" FOR SHARE`;
      await checkAdminAndDepartments(tx);
      need((await preserved(tx)).digest === input.expectedExistingDigest,'EXISTING_ACCOUNT_SET_CHANGED');
      const actor=await tx.user.findUnique({where:{id:input.actorId},select:{globalRole:true,isBlocked:true,blockedAt:true}});
      need(actor?.globalRole==='ADMIN'&&!actor.isBlocked&&actor.blockedAt===null,'ACTIVE_EXISTING_ADMIN_REQUIRED');
      for(const user of input.plan.users){
        const row=await tx.user.findUnique({where:{id:user.id},select:preservedSelection});
        if(row){need(row.email===user.email&&row.name===user.name&&row.globalRole==='USER'&&row.authSource==='local'&&row.externalId===null,'IMPORTED_ACCOUNT_DRIFT');continue;}
        need(hashes.has(user.id),'IMPORT_SET_CHANGED_DURING_HASHING');
        try { await tx.user.create({data:{id:user.id,email:user.email,name:user.name,passwordHash:hashes.get(user.id)!,globalRole:'USER',
          authSource:'local',externalId:null,isBlocked:true,blockedAt:new Date(),emailVerified:new Date()}}); } catch { throw new Error('IMPORTED_ACCOUNT_CREATE_FAILED'); }
        createdCount++; createdIds.add(user.id);
      }
    },{maxWait:10000,timeout:60000});
    for(const id of createdIds)logAuthEvent('register',id,undefined,true);
  }
  const employee = input.phase==='apply' ? await role('employee','Сотрудник',[],'board') : await existingProfileIds('employee');
  const executor = input.phase==='apply' ? await role('executor','Исполнитель',['request.execute'],'board') : await existingProfileIds('executor');
  const groupMap = new Map<string,string>();
  for(const group of input.plan.groups){
    const key=`group:${group.legacyId}`;
    let groupId: string;
    if(input.phase==='apply'){
      const row=await org(key,meta=>service.createGroup({...meta,name:group.name}));groupId=row.id;
    }else{
      groupId = (await ownedReceipt(db, key, 'createGroup', true))!;
    }
    const current=await db.responsibleGroup.findUnique({where:{id:groupId}});
    need(current?.name===group.name&&current.archivedAt===null,'GROUP_IDENTITY_DRIFT');groupMap.set(group.legacyId,groupId);
    if(input.phase==='apply'){
      await org(`group-employee:${group.legacyId}`,meta=>service.setGroupPrivilegeAssignment({...meta,groupId,profileId:employee,scopeKind:'organization',departmentId:null,projectId:null,assigned:true}));
      const departmentId=departmentFor(input,[group.legacyId]);
      if(departmentId)await org(`group-executor:${group.legacyId}`,meta=>service.setGroupPrivilegeAssignment({...meta,groupId,profileId:executor,scopeKind:'department',departmentId,projectId:null,assigned:true}));
    }
  }
  if(input.phase==='apply'){
    for(const user of input.plan.users){
      const departmentId=departmentFor(input,user.groupIds);
      await org(`department:${user.id}`,meta=>service.assignUserDepartment({...meta,userId:user.id,departmentId}));
      for(const legacy of user.groupIds)await org(`member:${legacy}:${user.id}`,meta=>service.setGroupMember({...meta,groupId:groupMap.get(legacy)!,userId:user.id,member:true}));
    }
    for(const old of before.rows){
      if(old.isBlocked||old.blockedAt!==null||![input.departmentIds.support,input.departmentIds.quality].includes(old.primaryDepartmentId??''))continue;
      await org(`preserve-execution:${old.id}:${old.primaryDepartmentId}`,meta=>service.setPrivilegeAssignment({...meta,userId:old.id,profileId:executor,scopeKind:'department',departmentId:old.primaryDepartmentId,projectId:null,assigned:true}));
    }
  }
  async function verifyConfiguration(client: Prisma.TransactionClient){
    await checkAdminAndDepartments(client);
    const rows=await client.user.findMany({where:{id:{in:ids}},select:{...preservedSelection,responsibleGroupMemberships:{select:{groupId:true}}}});
    need(rows.length===391,'IMPORTED_ACCOUNT_COUNT_MISMATCH');
    for(const user of input.plan.users){
      const row=rows.find(r=>r.id===user.id)!;
      need(row.email===user.email&&row.name===user.name&&row.globalRole==='USER'&&row.authSource==='local'&&row.externalId===null
        &&row.primaryDepartmentId===departmentFor(input,user.groupIds)&&row.passwordHash&&row.emailVerified,'IMPORTED_ACCOUNT_VERIFICATION_FAILED');
      need(JSON.stringify(row.responsibleGroupMemberships.map(x=>x.groupId).sort())===JSON.stringify(user.groupIds.map(id=>groupMap.get(id)!).sort()),'GROUP_MEMBERSHIP_DRIFT');
      if(createdIds.has(user.id)) { need(row.isBlocked && row.blockedAt !== null, 'NEW_ACCOUNT_MUST_BE_BLOCKED'); need(row.passwordHash === initialHashes.get(user.id), 'INITIAL_PASSWORD_VERIFICATION_FAILED'); }
    }
    for (const [key, id, name, permissions] of [ ['employee', employee, 'Сотрудник', []], ['executor', executor, 'Исполнитель', ['request.execute']] ] as const) {
      need(await ownedReceipt(client, `profile:${key}`, 'createPrivilegeProfile', true) === id, 'IMPORT_PROFILE_RECEIPT_DRIFT');
      const profile = await client.privilegeProfile.findUnique({ where: { id } });
      need(profile?.name === name && profile.archivedAt === null, 'PROFILE_IDENTITY_DRIFT');
      const settings = decodePrivilegeProfileSettings(profile.permissions);
      need(settings.visibility === 'board' && JSON.stringify(settings.permissions) === JSON.stringify(permissions), 'PROFILE_PERMISSION_DRIFT');
    }
    need(await client.scopedPrivilegeAssignment.count({ where: { userId: { in: ids } } }) === 0, 'UNEXPECTED_PERSONAL_IMPORT_ROLE');
    for(const group of input.plan.groups){
      const groupId=groupMap.get(group.legacyId)!;
      need(await ownedReceipt(client, `group:${group.legacyId}`, 'createGroup', true) === groupId, 'IMPORT_GROUP_RECEIPT_DRIFT');
      const current = await client.responsibleGroup.findUnique({ where: { id: groupId } });
      need(current?.name === group.name && current.archivedAt === null && current.leaderId === null, 'GROUP_IDENTITY_DRIFT');
      const members = await client.responsibleGroupMember.findMany({ where: { groupId }, select: { userId: true } });
      const expectedMembers = input.plan.users.filter(user => user.groupIds.includes(group.legacyId)).map(user => user.id).sort();
      need(JSON.stringify(members.map(member => member.userId).sort()) === JSON.stringify(expectedMembers), 'GROUP_MEMBERSHIP_DRIFT');
      const saved=await client.groupPrivilegeAssignment.findMany({where:{groupId}});
      const departmentId=departmentFor(input,[group.legacyId]);
      need(saved.length===(departmentId?2:1)&&saved.some(g=>g.profileId===employee&&g.scopeKind==='organization'&&g.departmentId===null&&g.projectId===null)
        &&(!departmentId||saved.some(g=>g.profileId===executor&&g.scopeKind==='department'&&g.departmentId===departmentId&&g.projectId===null)),'GROUP_ROLE_DRIFT');
    }
    const expectedStaff = before.rows.filter(old => !old.isBlocked && old.blockedAt === null
      && [input.departmentIds.support, input.departmentIds.quality].includes(old.primaryDepartmentId ?? ''));
    const existingGrants = await client.scopedPrivilegeAssignment.findMany({ where: { userId: { in: expectedStaff.map(row => row.id) }, profileId: executor } });
    for (const staff of expectedStaff) need(existingGrants.some(grant => grant.userId === staff.id && grant.scopeKind === 'department'
      && grant.departmentId === staff.primaryDepartmentId && grant.projectId === null), 'EXISTING_EXECUTION_GRANT_MISSING');
    need((await preserved(client)).digest===input.expectedExistingDigest,'EXISTING_ACCOUNT_PRESERVATION_FAILED');
    return rows;
  }
  let activatedCount=0;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'},0))::text AS locked`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.importId},0))::text AS locked`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${[...ids, ...before.rows.map(row => row.id)].sort()}::text[]) ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ANY(${Object.values(input.departmentIds)}::text[]) ORDER BY "id" FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "PrivilegeProfile" WHERE "id" = ANY(${[employee, executor]}::text[]) ORDER BY "id" FOR SHARE`;
    const groups = [...groupMap.values()].sort();
    await tx.$queryRaw`SELECT "id" FROM "ResponsibleGroup" WHERE "id" = ANY(${groups}::text[]) ORDER BY "id" FOR SHARE`;
    await tx.$queryRaw`SELECT "groupId", "userId" FROM "ResponsibleGroupMember" WHERE "groupId" = ANY(${groups}::text[]) ORDER BY "groupId", "userId" FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "GroupPrivilegeAssignment" WHERE "groupId" = ANY(${groups}::text[]) ORDER BY "id" FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "ScopedPrivilegeAssignment" WHERE "userId" = ANY(${[...ids, ...before.rows.map(row => row.id)].sort()}::text[]) ORDER BY "id" FOR SHARE`;
    await verifyConfiguration(tx);
    if(input.phase==='activate') {
      const updated = await tx.user.updateMany({ where: { id: { in: ids }, globalRole: 'USER', authSource: 'local', OR: [{ isBlocked: true }, { blockedAt: { not: null } }] }, data: { isBlocked: false, blockedAt: null } });
      activatedCount=updated.count;
      const rows = await tx.user.findMany({ where: { id: { in: ids } }, select: { isBlocked: true, blockedAt: true } });
      need(rows.length === ids.length && rows.every(user => user.isBlocked === false && user.blockedAt === null), 'ACTIVATION_VERIFICATION_FAILED');
    }
  }, { maxWait: 10000, timeout: 120000 });

  return {passed:true,phase:input.phase,importId:input.importId,manifestSha256:input.manifestSha256,
    importedUsers:391,importedGroups:52,createdCount,activatedCount,existingUsers:before.rows.length,
    existingAccountsPreserved:true,newGlobalAdmins:0,executorUsers:input.plan.users.filter(u=>departmentFor(input,u.groupIds)).length};
}
