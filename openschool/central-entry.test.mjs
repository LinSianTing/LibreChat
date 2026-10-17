import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

async function load(path) {
  const source = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { createCentralEntry } = await load('../packages/api/src/openschool/entry.ts');
const { attemptCentralEntry, isCentralEntryTarget } = await load('../client/src/components/Auth/centralEntry.ts');
function browser(id = 'A') {
  return { sessionID: id, headers: {}, session: {
    save(done) { done(); }, reload(done) { done(); },
  } };
}
async function call(handler, req) {
  let code, body;
  const headers = {};
  await handler(req, { setHeader(k, v) { headers[k] = v; },
    status(value) { code = value; return this; }, json(value) { body = value; } });
  return { code, body, headers };
}
test('new browser: persist before allowing once; second request denied', async () => {
  const handler = createCentralEntry({ enabled: () => true });
  const req = browser(); req.headers.cookie = 'connect.sid=A'; const original = req.session;
  const first = await call(handler, req);
  assert.equal(first.code, 200);
  assert.equal(original.centralEntryAttempted, true);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal((await call(handler, req)).code, 409);
});
test('disabled mode and missing session fail closed', async () => {
  assert.equal((await call(createCentralEntry({ enabled: () => false }), browser())).code, 404);
  assert.equal((await call(createCentralEntry({ enabled: () => true }), { headers: {} })).code, 409);
});
test('recovery (including malformed state), stale auth cookie and Bearer never auto-enter', async () => {
  const handler = createCentralEntry({ enabled: () => true });
  for (const state of [{}, null, { pending: true }, { expired: true }]) {
    const req = browser(); const original = req.session; req.session.centralLogout = state;
    assert.equal((await call(handler, req)).code, 409);
    assert.equal(original.centralEntryAttempted, undefined);
  }
  for (const headers of [{ cookie: 'refreshToken=expired' }, { cookie: 'x=1; token_provider=openid' }, { authorization: 'Bearer A', cookie: 'refreshToken=B' }]) {
    const req = browser(); req.headers = headers;
    assert.equal((await call(handler, req)).code, 409);
  }
});
test('save failure does not authorize; same request remains consumed', async () => {
  const handler = createCentralEntry({ enabled: () => true });
  const req = browser(); req.headers.cookie = 'connect.sid=A'; req.session.save = (done) => done(new Error('store down'));
  assert.equal((await call(handler, req)).code, 503);
  assert.equal((await call(handler, req)).code, 409);
});
test('existing cookie reloads authoritative state; missing store cannot become fresh login', async () => {
  const handler = createCentralEntry({ enabled: () => true });
  const req = browser(); req.headers.cookie = 'connect.sid=opaque';
  req.session.reload = (done) => { req.session.centralLogout = { pending: true }; done(); };
  assert.equal((await call(handler, req)).code, 409);
  const lost = browser(); lost.headers.cookie = 'connect.sid=old';
  lost.session.reload = (done) => done(new Error('not found'));
  assert.equal((await call(handler, lost)).code, 503);
});
test('concurrent same browser rejected while saving; different browser independent', async () => {
  const handler = createCentralEntry({ enabled: () => true });
  let saved;
  const a = browser(); a.headers.cookie = 'connect.sid=A'; a.session.save = (done) => { saved = done; };
  const first = call(handler, a);
  await Promise.resolve();
  assert.equal((await call(handler, browser())).code, 409);
  assert.equal((await call(handler, browser('B'))).code, 200);
  saved(); assert.equal((await first).code, 200);
});
function client() {
  const values = new Map(); const events = [];
  return { events, options: {
    blocked: false, target: '/c/new?model=circle',
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    persist: (target) => events.push(['persist', target]),
    request: async () => { events.push(['request']); return true; },
    isCurrent: () => true,
    navigate: () => events.push(['navigate']),
  } };
}
test('first entry preserves return before request; rerender/back/refresh does not retry', async () => {
  const { options, events } = client();
  await attemptCentralEntry(options); await attemptCentralEntry(options);
  assert.deepEqual(events, [['persist', '/c/new?model=circle'], ['request'], ['navigate']]);
});
test('error or redirect=false consumes attempt even after query cleanup', async () => {
  const { options, events } = client();
  await attemptCentralEntry({ ...options, blocked: true });
  await attemptCentralEntry(options);
  assert.deepEqual(events, []);
});
test('network failure/denial retain manual UI and never retry automatically', async () => {
  for (const request of [async () => false, async () => { throw new Error('offline'); }]) {
    const { options, events } = client();
    await attemptCentralEntry({ ...options, request });
    await attemptCentralEntry(options);
    assert.deepEqual(events, [['persist', '/c/new?model=circle']]);
  }
});
test('separate tabs use separate navigation state; blocked tab cannot change another', async () => {
  const a = client(), b = client();
  await attemptCentralEntry({ ...a.options, blocked: true });
  await attemptCentralEntry(b.options);
  assert.deepEqual(a.events, []);
  assert.equal(b.events.at(-1)[0], 'navigate');
});
test('unsafe return destinations rejected, normal conversation and circle target retained', async () => {
  for (const target of ['https://evil.test/c/new', '//evil.test/c/new', '/chat/login', '/login', '/c/new\\evil', '/c/%2f%2fevil', '/c/new\n', '/oauth/openid', '/c/new/../login', '/c/new#login']) {
    assert.equal(isCentralEntryTarget(target), false, target);
    const state = client(); await attemptCentralEntry({ ...state.options, target });
    assert.deepEqual(state.events, []);
  }
  assert.equal(isCentralEntryTarget('/c/12345678-1234-1234-1234-123456789abc'), true);
  assert.equal(isCentralEntryTarget('/c/new?model=circle'), true);
});
test('unavailable browser storage never starts SSO', async () => {
  const { options, events } = client();
  await attemptCentralEntry({ ...options, storage: {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
  } });
  assert.deepEqual(events, []);
});
test('late allowed response after navigation/manual action/error does not initiate OIDC', async () => {
  const { options, events } = client();
  let allowed, current = true;
  const operation = attemptCentralEntry({ ...options,
    request: () => new Promise((resolve) => { allowed = resolve; }),
    isCurrent: () => current,
  });
  current = false; allowed(true); await operation;
  assert.deepEqual(events, [['persist', '/c/new?model=circle']]);
});
