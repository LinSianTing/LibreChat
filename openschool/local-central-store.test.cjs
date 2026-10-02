const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(env, central = true) {
  let options;
  let registrations = 0;
  const store = {};
  const module = { exports: {} };
  const supplied = {
    passport: { session: () => () => {}, use() {} },
    '~/server/services/LocalCentralSSO': { enabled: () => central, assertConfig() {} },
    'express-session': (value) => {
      options = value;
      return () => {};
    },
    'librechat-data-provider': { CacheKeys: { OPENID_SESSION: 'openid' } },
    '@librechat/api': {
      math: (value, fallback) => Number(value ?? fallback),
      isEnabled: (value) => value === 'true',
      shouldUseSecureCookie: () => false,
      registerOpenIdWithRetry: async () => {
        registrations++;
      },
    },
    '@librechat/data-schemas': { logger: { info() {} }, DEFAULT_SESSION_EXPIRY: 300000 },
    '~/strategies': {},
    '~/cache': { getLogStores: () => store },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../api/server/socialLogins.js'), 'utf8'),
    {
      module,
      exports: module.exports,
      process: { env },
      require: (name) => supplied[name],
    },
  );
  return {
    run: () => module.exports({ use() {} }),
    store,
    options: () => options,
    registrations: () => registrations,
  };
}

test('central startup refuses absent Redis configuration instead of memory fallback', async () => {
  for (const env of [
    {},
    { USE_REDIS: 'false', REDIS_URI: 'redis://localhost' },
    { USE_REDIS: 'true' },
  ]) {
    const f = fixture(env);
    await assert.rejects(f.run(), /persistent Redis/);
    assert.equal(f.options(), undefined);
    assert.equal(f.registrations(), 0);
  }
});

test('central startup uses configured store and does not extend authentication lifetime', async () => {
  const f = fixture({ USE_REDIS: 'true', REDIS_URI: 'redis://localhost' });
  await f.run();
  assert.equal(f.options().store, f.store);
  assert.equal(f.options().resave, false);
  assert.equal(f.options().saveUninitialized, false);
  assert.equal(f.options().cookie.maxAge, 300000);
  assert.equal(f.options().cookie.httpOnly, true);
  assert.equal(f.options().cookie.sameSite, 'lax');
  assert.equal(f.registrations(), 1);
});

test('non-central startup retains its existing configuration path', async () => {
  const f = fixture({}, false);
  await f.run();
  assert.equal(f.options(), undefined);
});
