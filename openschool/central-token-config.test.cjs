const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
function appFor(central, failure) {
  const module = { exports: {} };
  const deps = {
    '@librechat/data-schemas': { logger: { error() {} } },
    '@librechat/api': {
      resolveTokenConfigMap: async () => ({ synthetic: { model: { context: 1024 } } }),
    },
    '~/server/controllers/ModelController': {
      getModelsConfig: async () => {
        if (failure) throw Object.assign(new Error('private upstream detail'), { status: failure });
        return { synthetic: ['model'] };
      },
    },
    '~/models': {},
    '~/server/services/LocalCentralSSO': { enabled: () => central },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../api/server/controllers/TokenConfigController.js'),
      'utf8',
    ),
    { module, require: (name) => deps[name] },
  );
  const app = express();
  app.get('/', (req, res) => {
    req.user = { id: 'synthetic' };
    return module.exports(req, res);
  });
  return app;
}
for (const [failure, status] of [
  [null, 200],
  [401, 401],
  [403, 403],
  [503, 503],
  [500, 503],
]) {
  test(`central token config ${failure ?? 'success'} has correct status and private no-store`, async () => {
    const result = await request(appFor(true, failure)).get('/');
    assert.equal(result.status, status);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.ok(!result.text.includes('private upstream detail'));
  });
}
test('legacy token config retains existing failure response', async () => {
  const result = await request(appFor(false, 401)).get('/');
  assert.equal(result.status, 500);
  assert.equal(result.headers['cache-control'], undefined);
});
