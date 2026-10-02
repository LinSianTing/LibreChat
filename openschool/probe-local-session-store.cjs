/** Local synthetic Redis persistence evidence only; never print session keys or token values. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Redis = require('ioredis');
const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
const checkpoint = path.join(__dirname, '../.local/session-store-checkpoint.json');

async function main() {
  assert.equal(env.MONGO_URI, 'mongodb://127.0.0.1:15484/openschool_sso_local');
  const uri = new URL(env.REDIS_URI);
  assert.equal(uri.hostname, '127.0.0.1');
  assert.equal(uri.port, '15485');
  const client = new Redis(env.REDIS_URI, { lazyConnect: true, maxRetriesPerRequest: 0 });
  client.on('error', () => {});
  try {
    await client.connect();
    const records = [];
    let cursor = '0';
    do {
      const result = await client.scan(cursor, 'MATCH', '*', 'COUNT', 100);
      cursor = result[0];
      for (const key of result[1]) {
        if ((await client.type(key)) !== 'string') continue;
        let item;
        try {
          item = JSON.parse(await client.get(key));
        } catch {
          continue;
        }
        const record = item?.centralLogout;
        if (record?.central?.subject !== '11111111-1111-7111-8111-111111111111') continue;
        assert.ok(record.retainUntil > Date.now());
        assert.ok(typeof record.idToken === 'string');
        const digest = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
        records.push({ digest, expiresAtUtc: record.central.expiresAtUtc });
      }
    } while (cursor !== '0');
    assert.ok(records.length > 0, 'No synthetic logout record');
    records.sort((a, b) => a.digest.localeCompare(b.digest));
    if (process.argv.includes('--record')) {
      fs.writeFileSync(checkpoint, JSON.stringify(records));
    } else {
      assert.deepEqual(records, JSON.parse(fs.readFileSync(checkpoint, 'utf8')));
    }
    if (process.argv.includes('--expired')) {
      assert.ok(records.every((r) => Date.parse(r.expiresAtUtc) <= Date.now()));
    }
    const persistence = await client.info('persistence');
    assert.match(persistence, /aof_enabled:1/);
    assert.match(persistence, /aof_last_write_status:ok/);
    console.log(
      JSON.stringify({
        records: records.length,
        unchanged_after_restart: !process.argv.includes('--record'),
        expired_auth_retained_for_logout: process.argv.includes('--expired'),
        aof_write_status: 'ok',
      }),
    );
  } finally {
    client.disconnect();
  }
}
main().catch(() => {
  console.error('Local persistence check failed; no credentials printed.');
  process.exitCode = 1;
});
