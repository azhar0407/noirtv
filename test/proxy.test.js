// Test regresi rewrite proxy noir-tv. Jalankan: node --test test/proxy.test.js
// Load worker source via data: URL (pola skill: stub fetch per-URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../functions/api/proxy.js', import.meta.url)), 'utf8');

// Lock: tidak ada kode vendor lama / secret material
assert.equal(src.includes('firebaseremoteconfig'), false, 'vendor Firebase harus dihapus');
assert.equal(src.includes('randomFid'), false, 'randomFid harus dihapus');

function makeCtx(target, upstreamBody, upstreamCT, method = 'GET') {
  globalThis.fetch = async () =>
    new Response(upstreamBody, { status: 200, headers: { 'Content-Type': upstreamCT } });
  return {
    request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent(target)}`, { method }),
    env: {},
  };
}

async function run(target, body, ct, method = 'GET') {
  const mod = await import(`../functions/api/proxy.js?bust=${Math.random()}`);
  const res = await mod.onRequest(makeCtx(target, body, ct, method));
  return res;
}

test('chunklist .m3u8 dengan content-type text/html ikut direwrite', async () => {
  const res = await run('https://up.example/live/chunklist.m3u8',
    'https://up.example/live/seg-1.ts\n', 'text/html');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/, 'segment harus direwrite ke proxy');
});

test('master playlist application/vnd.apple.mpegurl direwrite', async () => {
  const res = await run('https://up.example/master.m3u8',
    'https://up.example/720p/chunklist.m3u8\n', 'application/vnd.apple.mpegurl');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/);
});

test('skip?next=1 tetap direwrite (ekstensi file tak reliable)', async () => {
  const res = await run('https://up.example/live.m3u8?token=x',
    '#EXTM3U\nhttps://up.example/seg.ts\n', 'audio/x-mpegurl');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/);
});

test('non-playlist (logo png) pass-through tanpa rewrite', async () => {
  const res = await run('https://up.example/logo.png', 'PNGDATA', 'image/png');
  const t = await res.text();
  assert.equal(t, 'PNGDATA');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('scheme selain http/https ditolak 400', async () => {
  const res = await run('ftp://up.example/file.ts', '', 'application/octet-stream');
  assert.equal(res.status, 400);
});

test('OPTIONS preflight -> 204 + CORS', async () => {
  const mod = await import('../functions/api/proxy.js');
  const res = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/proxy?url=https://a.example/x.ts', { method: 'OPTIONS' }),
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('POST tanpa url param -> 400 (semantik saat ini dipertahankan)', async () => {
  const res = await run('', '', '', 'POST');
  assert.equal(res.status, 400);
});

test('cache-control tidak dinonaktifkan untuk playlist live', async () => {
  const res = await run('https://up.example/live.m3u8', '#EXTM3U\nhttps://up.example/seg.ts\n', 'application/vnd.apple.mpegurl');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});
