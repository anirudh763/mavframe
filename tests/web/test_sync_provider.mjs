import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSyncProvider } from '../../docs/js/sync-provider.js';

const users = {
  'a@example.test': { id: '11111111-1111-4111-8111-111111111111', token: 'access-A' },
  'b@example.test': { id: '22222222-2222-4222-8222-222222222222', token: 'access-B' },
};
let server, origin, records;
test.beforeEach(async () => {
  records = new Map();
  server = http.createServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100_000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    const user = Object.values(users).find(item => item.token === auth);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/auth/v1/token')) {
      if (req.headers.apikey !== 'public-anon-key') { res.writeHead(401).end('{}'); return; }
      const match = users[body.email];
      if (!match || body.password !== 'cloud password') { res.writeHead(400).end('{}'); return; }
      res.end(JSON.stringify({ access_token: match.token, expires_in: 3600, user: { id: match.id } })); return;
    }
    if (!user) { res.writeHead(401).end('{}'); return; }
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/mavframe_sync?')) {
      const query = new URL(req.url, 'http://localhost');
      if (query.searchParams.get('owner_id') !== `eq.${user.id}`) { res.end('[]'); return; }
      const row = records.get(`${user.id}:saved_views`) || records.get(`${user.id}:preferences`);
      const collection = query.searchParams.get('collection')?.slice(3);
      const found = records.get(`${user.id}:${collection}`);
      res.end(JSON.stringify(found ? [found] : [])); return;
    }
    if (req.method === 'POST' && req.url === '/rest/v1/rpc/mavframe_sync_put') {
      const key = `${user.id}:${body.p_collection}`; const previous = records.get(key);
      if ((previous?.revision ?? 0) !== body.p_expected_revision) { res.writeHead(409).end('{}'); return; }
      const row = { owner_id: user.id, collection: body.p_collection, revision: (previous?.revision ?? 0) + 1, payload: body.p_payload };
      records.set(key, row); res.end(JSON.stringify(row)); return;
    }
    if (req.method === 'POST' && req.url === '/rest/v1/rpc/mavframe_sync_delete') {
      const key = `${user.id}:${body.p_collection}`; const previous = records.get(key);
      const deleted = previous?.revision === body.p_expected_revision; if (deleted) records.delete(key);
      res.end(JSON.stringify(deleted)); return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
test.afterEach(async () => { await new Promise(resolve => server.close(resolve)); });
const provider = () => createSyncProvider({ projectUrl: origin, anonKey: 'public-anon-key', isOnline: () => true });

test('authenticated sync requires explicit upload, exposes conflicts and revision-checks deletes', async () => {
  const client = provider();
  await client.connect('a@example.test', 'cloud password');
  const local = [{ name: 'Review', savedAt: '2026-01-01T00:00:00.000Z', context: { screen: 'frames' }, theme: 'dark' }];
  assert.deepEqual(await client.syncCollection('saved_views', local), { status: 'pending-upload', revision: 0 });
  assert.deepEqual(await client.syncCollection('saved_views', local, 'upload-local'), { status: 'synced', revision: 1 });
  assert.deepEqual(await client.syncCollection('saved_views', local), { status: 'current', revision: 1 });
  const remote = [{ name: 'Cloud copy', savedAt: '2026-01-02T00:00:00.000Z', context: { screen: 'capture' }, theme: 'light' }];
  records.set(`${users['a@example.test'].id}:saved_views`, { owner_id: users['a@example.test'].id, collection: 'saved_views', revision: 2, payload: remote });
  const conflict = await client.syncCollection('saved_views', local);
  assert.equal(conflict.status, 'conflict'); assert.deepEqual(conflict.payload, remote);
  assert.deepEqual(await client.syncCollection('saved_views', local, 'use-remote'), { status: 'use-remote', revision: 2, payload: remote });
  assert.deepEqual(await client.syncCollection('saved_views', local, 'upload-local'), { status: 'synced', revision: 3 });
  await client.deleteCollection('saved_views', 3);
  assert.equal(records.has(`${users['a@example.test'].id}:saved_views`), false);
});

test('separate provider identity cannot read another user collection', async () => {
  const idA = users['a@example.test'].id;
  records.set(`${idA}:saved_views`, { owner_id: idA, collection: 'saved_views', revision: 1, payload: [{ name: 'A only' }] });
  const clientB = provider(); await clientB.connect('b@example.test', 'cloud password');
  assert.deepEqual(await clientB.syncCollection('saved_views', []), { status: 'pending-upload', revision: 0 });
  assert.equal(records.get(`${idA}:saved_views`).payload[0].name, 'A only');
});

test('logout aborts pending sync, validates collections/payload sizes and reports offline edits pending', async () => {
  const client = provider(); await client.connect('a@example.test', 'cloud password');
  await assert.rejects(client.syncCollection('captures', []), /allowlist/);
  await assert.rejects(client.syncCollection('saved_views', 'x'.repeat(50_000)), /48 KiB/);
  await assert.rejects(client.syncCollection('saved_views', [{ name: 'Private', savedAt: '2026', theme: 'light', context: { screen: 'frames', captureBytes: 'secret' } }]), /unsupported or malformed/);
  client.logout(); await assert.rejects(client.syncCollection('saved_views', []), /Connect/);
  const offline = createSyncProvider({ projectUrl: origin, anonKey: 'public-anon-key', isOnline: () => false });
  await assert.rejects(offline.connect('a@example.test', 'cloud password'), /Offline edits remain/);
  const secretKey = createSyncProvider({ projectUrl: origin, anonKey: 'sb_secret_do_not_use', isOnline: () => true });
  await assert.rejects(secretKey.connect('a@example.test', 'cloud password'), /secret keys are never accepted/);
});

test('logout aborts an in-flight read and ignores its delayed result', async () => {
  const delayedFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (!String(url).includes('/rest/v1/')) return response;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted by logout', 'AbortError')), { once: true });
    });
  };
  const client = createSyncProvider({ projectUrl: origin, anonKey: 'public-anon-key', fetchImpl: delayedFetch, isOnline: () => true });
  await client.connect('a@example.test', 'cloud password');
  const pending = client.syncCollection('saved_views', []);
  await new Promise(resolve => setTimeout(resolve, 20)); client.logout();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(records.size, 0);
});
