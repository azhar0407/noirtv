import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Vidio API: OPTIONS preflight returns 204 + CORS', async () => {
  const mod = await import('../functions/api/vidio.js');
  const res = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/vidio', { method: 'OPTIONS' })
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('Vidio API: GET /api/vidio returns valid channel structure', async () => {
  const mod = await import('../functions/api/vidio.js');
  const res = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/vidio?type=all', { method: 'GET' })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');

  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.ok(Array.isArray(data.channels));
  assert.ok(data.channels.length > 0, 'Katalog tidak boleh kosong');

  const ch = data.channels[0];
  assert.ok(ch.id, 'channel must have id');
  assert.ok(ch.name, 'channel must have name');
  assert.ok(ch.embed_url, 'channel must have embed_url');
  assert.ok(ch.embed_url.includes('vidio.com/live/'), 'embed_url must point to vidio live');
});
