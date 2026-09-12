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
  assert.ok(ch.channel_id, 'channel must have channel_id');
  assert.ok(ch.name, 'channel must have name');
});

test('Vidio API: GET /api/vidio?stream_id=204 resolves direct HLS stream', async () => {
  const mod = await import('../functions/api/vidio.js');
  const res = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/vidio?stream_id=204', { method: 'GET' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.channel_id, '204');
  assert.equal(data.is_drm, false);
  assert.ok(data.hls_url && data.hls_url.includes('.m3u8'), 'hls_url must be a valid .m3u8 link');
});
