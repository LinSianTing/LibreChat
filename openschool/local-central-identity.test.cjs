const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalCentralIdentity, LOCAL_ISSUER } = require('../api/strategies/localCentralIdentity');
const binding = {
  issuer: LOCAL_ISSUER, subject: 'central-a', googleSubject: 'synthetic-google-a',
  memberId: '11111111-1111-7111-8111-111111111111', chatUserId: '111111111111111111111111',
};
const config = () => ({ enabled: true, environment: 'development', issuer: LOCAL_ISSUER, bindings: [{ ...binding }] });
const claims = () => ({ iss: LOCAL_ISSUER, sub: binding.subject, sid: 'browser-a', email: 'same@example.test' });
const fixture = () => {
  const user = Object.freeze({ _id: binding.chatUserId, googleId: binding.googleSubject, provider: 'google', role: 'USER', email: 'same@example.test' });
  const queries = [];
  return { user, queries, dependencies: { findUser: async (q) => { queries.push(q); return user; }, isActive: async () => true } };
};

test('disabled does not activate a resolver', () => assert.equal(createLocalCentralIdentity({ enabled: false }), null));
for (const environment of ['production', 'test', 'Development', 'demo']) {
  test(`reject enabled environment ${environment}`, () => assert.throws(() => createLocalCentralIdentity({ ...config(), environment })));
}
test('reject alternate issuer and malformed bindings', () => {
  assert.throws(() => createLocalCentralIdentity({ ...config(), issuer: `${LOCAL_ISSUER}/` }));
  assert.throws(() => createLocalCentralIdentity({ ...config(), bindings: null }));
  for (const change of [{ subject: ' ' }, { subject: 'a\nb' }, { googleSubject: 'deleted:a' }, { chatUserId: 'not-an-object-id' }, { memberId: '00000000-0000-0000-0000-000000000000' }]) {
    assert.throws(() => createLocalCentralIdentity({ ...config(), bindings: [{ ...binding, ...change }] }));
  }
});
for (const field of ['subject', 'googleSubject', 'memberId', 'chatUserId']) {
  test(`reject ambiguous ${field}`, () => {
    const other = { issuer: LOCAL_ISSUER, subject: 'central-b', googleSubject: 'google-b', memberId: '22222222-2222-7222-8222-222222222222', chatUserId: '222222222222222222222222' };
    other[field] = binding[field];
    assert.throws(() => createLocalCentralIdentity({ ...config(), bindings: [binding, other] }));
  });
}
test('preserves exact owner and stored identity; claims cannot promote or overwrite', async () => {
  const f = fixture();
  const before = JSON.stringify(f.user);
  const result = await createLocalCentralIdentity(config()).resolveVerifiedClaims({ ...claims(), role: 'ADMIN', email: 'new@example.test' }, f.dependencies);
  assert.equal(result.user, f.user);
  assert.equal(result.user.role, 'USER');
  assert.equal(result.identity.sessionId, 'browser-a');
  assert.deepEqual(f.queries, [{ _id: binding.chatUserId }]);
  assert.equal(JSON.stringify(f.user), before);
});
test('unknown subject cannot claim an existing account through identical email', async () => {
  const f = fixture();
  const resolver = createLocalCentralIdentity(config());
  for (const change of [{ sub: 'unknown' }, { iss: `${LOCAL_ISSUER}/` }, { sid: '' }, { sid: 'x\ny' }]) {
    assert.equal(await resolver.resolveVerifiedClaims({ ...claims(), ...change }, f.dependencies), null);
  }
  assert.equal(f.queries.length, 0);
});
test('configuration mutation cannot change the resolved owner', async () => {
  const c = config();
  const resolver = createLocalCentralIdentity(c);
  c.bindings[0].chatUserId = '222222222222222222222222';
  assert.equal((await resolver.resolveVerifiedClaims(claims(), fixture().dependencies)).identity.chatUserId, binding.chatUserId);
});
test('reject missing, mismatched, migrated or tenant-scoped owner without fallback', async () => {
  const f = fixture();
  for (const user of [null, { ...f.user, _id: '222222222222222222222222' }, { ...f.user, googleId: 'other' }, { ...f.user, provider: 'openid' }, { ...f.user, tenantId: 'other' }, { ...f.user, role: null }, { ...f.user, openidId: 'other' }, { ...f.user, openidIssuer: LOCAL_ISSUER }]) {
    assert.equal(await createLocalCentralIdentity(config()).resolveVerifiedClaims(claims(), { findUser: async () => user, isActive: async () => true }), null);
  }
});
test('account deletion and database failure fail closed on subsequent resolutions', async () => {
  const f = fixture();
  const resolver = createLocalCentralIdentity(config());
  assert.ok(await resolver.resolveVerifiedClaims(claims(), f.dependencies));
  assert.equal(await resolver.resolveVerifiedClaims(claims(), { ...f.dependencies, isActive: async () => false }), null);
  await assert.rejects(resolver.resolveVerifiedClaims(claims(), { ...f.dependencies, findUser: async () => { throw new Error('offline'); } }));
});
test('same account in different browser sessions retains separate session identities', async () => {
  const resolver = createLocalCentralIdentity(config());
  const a = await resolver.resolveVerifiedClaims(claims(), fixture().dependencies);
  const b = await resolver.resolveVerifiedClaims({ ...claims(), sid: 'browser-b' }, fixture().dependencies);
  assert.notEqual(a.identity.sessionId, b.identity.sessionId);
  assert.equal(a.identity.chatUserId, b.identity.chatUserId);
});
