import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('./nginx/taskboard.conf.template', import.meta.url), 'utf8');
const directives = source.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
const block = name => directives.match(new RegExp(`map \\$${name} \\$[a-z_]+ \\{([\\s\\S]*?)\\n\\}`))?.[1];
const format = directives.match(/log_format taskboard_observation escape=json\s+([\s\S]*?);/)?.[1];

test('both taskboard vhosts explicitly select safe JSON format declared in http include context', () => {
  assert.ok(format);
  assert.ok(directives.indexOf('log_format ') < directives.indexOf('server {'));
  assert.equal((directives.match(/access_log \/var\/log\/nginx\/taskboard\.access\.log taskboard_observation;/g) || []).length, 2);
  assert.equal((directives.match(/access_log /g) || []).length, 2);
  assert.match(source, /внутри http \{\}/);
});

test('access fields contain only reviewed server IDs/static categories/timings, never raw input', () => {
  const variables = [...format.matchAll(/\$([a-z0-9_]+)/g)].map(match => match[1]);
  assert.deepEqual(variables, ['time_iso8601','request_id','taskboard_app_request_id','taskboard_log_method','status',
    'request_time','taskboard_upstream_response_seconds','taskboard_upstream_connect_seconds','taskboard_upstream_header_seconds','taskboard_upstream_state']);
  for (const field of ['requestTimeSeconds','upstreamResponseTimeSeconds','upstreamConnectTimeSeconds','upstreamHeaderTimeSeconds']) assert.ok(format.includes(`"${field}"`));
  assert.doesNotMatch(format, /\$(?:request_method|request_uri|uri|args|query_string|http_|remote_|proxy_|request_body|upstream_addr)/);
});

test('missing upstream timings normalize to dash without accepting header-derived timing values', () => {
  for (const name of ['upstream_response_time','upstream_connect_time','upstream_header_time']) {
    const map = block(name); assert.ok(map); assert.match(map, /"" "-";/);
    assert.deepEqual([...map.matchAll(/\$([a-z_]+)/g)].map(match=>match[1]), [name]);
    assert.match(map, new RegExp(`default \\$${name};`));
  }
});

test('arbitrary methods normalize to static OTHER rather than reflecting attacker bytes', () => {
  const map = block('request_method'); assert.ok(map);
  const entries = [...map.matchAll(/^\s*(\w+)\s+(\w+);/gm)].map(match => [match[1], match[2]]);
  assert.deepEqual(entries, [['default','OTHER'], ...['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].map(method => [method,method])]);
  assert.doesNotMatch(map, /\$/);
  const normalize = method => entries.find(([key]) => key.toLowerCase() === method.toLowerCase())?.[1] ?? 'OTHER';
  for (const method of ['SECRET_METHOD','GET_SYNTHETIC_TOKEN','CUSTOM"SECRET','CONNECT','TRACE']) assert.equal(normalize(method), 'OTHER');
});

test('app ID accepts only upstream response UUID and never substitutes edge/client IDs', () => {
  const map = block('upstream_http_x_request_id'); assert.ok(map);
  assert.match(map, /default "-";/);
  const pattern = map.match(/"~\*([^"\n]+)" \$upstream_http_x_request_id;/)?.[1]; assert.ok(pattern);
  const uuid = new RegExp(pattern, 'i');
  for (const value of ['30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93','30DC9A4D-3FDC-4F04-B5DB-604B4D4C6B93']) assert.ok(uuid.test(value));
  for (const value of ['', 'a'.repeat(32), 'synthetic-secret', '30dc9a4d-3fdc-0f04-b5db-604b4d4c6b93',
    '30dc9a4d-3fdc-4f04-75db-604b4d4c6b93','x30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93']) assert.equal(uuid.test(value), false);
  assert.doesNotMatch(map, /\$(?:request_id|http_x_request_id)/);
  const state = block('upstream_addr'); assert.match(state, /"" none;/); assert.match(state, /default attempted;/);
});

test('HTTPS forwarding/trusted client IP and genuine error diagnostics remain intact', () => {
  assert.equal((directives.match(/error_log\s+\/var\/log\/nginx\/taskboard\.error\.log warn;/g) || []).length, 2);
  assert.match(source, /error_log[\s\S]*raw request\/URI\/query\/IP/);
  assert.match(directives, /return 301 https:\/\/\$host\$request_uri;/);
  assert.equal((directives.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g) || []).length, 2);
  assert.doesNotMatch(directives, /proxy_set_header X-Request-Id/);
  assert.match(directives, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
});
