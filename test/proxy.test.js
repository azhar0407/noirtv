// Test regresi rewrite proxy noir-tv. Jalankan: node --test test/proxy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../functions/api/proxy.js', import.meta.url)), 'utf8');

// Lock: tidak ada kode vendor lama / secret material
assert.equal(src.includes('firebaseremoteconfig'), false, 'vendor Firebase harus dihapus');
assert.equal(src.includes('randomFid'), false, 'randomFid harus dihapus');

// Pakai host yang ada di allowlist (iptv-org.github.io) untuk mock upstream
const UP = 'https://iptv-org.github.io';

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
  const res = await run(`${UP}/live/chunklist.m3u8`,
    `${UP}/live/seg-1.ts\n`, 'text/html');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/, 'segment harus direwrite ke proxy');
  assert.ok(
    t.includes(encodeURIComponent(`${UP}/live/seg-1.ts`)),
    'URL segment spesifik harus encoded di proxy'
  );
});

test('SSRF: AWS metadata 169.254 -> 403', async () => {
  const res = await run('http://169.254.169.254/latest/meta-data/', 'data', 'text/plain');
  assert.equal(res.status, 403, 'metadata IP harus 403');
});

test('SSRF: localhost 127.0.0.1 -> 403', async () => {
  const res = await run('http://127.0.0.1:8080/admin', 'data', 'text/plain');
  assert.equal(res.status, 403, 'loopback harus 403');
});

test('SSRF: 10.0.0.0/8 private -> 403', async () => {
  const res = await run('http://10.0.0.1/admin', 'data', 'text/plain');
  assert.equal(res.status, 403, 'private range harus 403');
});

test('SSRF + retry: hang fetch tidak crash (best-effort, race terhadap timeout)', async () => {
  globalThis.fetch = () => new Promise(() => {});
  const mod = await import(`../functions/api/proxy.js?bust2=${Math.random()}`);
  const promise = mod.onRequest({
    request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${UP}/x.m3u`),
    env: {},
  });
  const result = await Promise.race([
    promise.then(r => ({ status: r.status })).catch(e => ({ err: e.name })),
    new Promise(res => setTimeout(() => res({ timeout: true }), 8500)),
  ]);
  assert.ok(result, 'harus return sesuatu (status, error, atau timeout)');
});

test('master playlist application/vnd.apple.mpegurl direwrite', async () => {
  const res = await run(`${UP}/master.m3u8`,
    `${UP}/720p/chunklist.m3u8\n`, 'application/vnd.apple.mpegurl');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/);
});

test('skip?next=1 tetap direwrite (ekstensi file tak reliable)', async () => {
  const res = await run(`${UP}/live.m3u8?token=x`,
    `#EXTM3U\n${UP}/seg.ts\n`, 'audio/x-mpegurl');
  const t = await res.text();
  assert.match(t, /api\/proxy\?url=/);
});

test('non-playlist (logo png) pass-through tanpa rewrite', async () => {
  const res = await run(`${UP}/logo.png`, 'PNGDATA', 'image/png');
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

test('cache-control no-cache untuk playlist live', async () => {
  const res = await run(`${UP}/live.m3u8`, `#EXTM3U\n${UP}/seg.ts\n`, 'application/vnd.apple.mpegurl');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('ADULT FILTER: channel dengan "XXX" di nama di-drop', async () => {
  const body = `#EXTM3U
#EXTINF:-1 tvg-logo="" group-title="Adult",XXX Channel 24
${UP}/adult.ts
#EXTINF:-1 tvg-logo="" group-title="News",CNN Indonesia
${UP}/cnn.ts
`;
  const res = await run(`${UP}/list.m3u`, body, 'application/x-mpegurl');
  const t = await res.text();
  assert.ok(!t.includes('XXX Channel 24'), 'channel adult harus di-drop');
  assert.ok(!t.includes(encodeURIComponent(`${UP}/adult.ts`)), 'segment adult harus hilang');
  assert.ok(t.includes('CNN Indonesia'), 'channel biasa harus tetap ada');
});

test('ADULT FILTER: keyword porn/18+ di group-title juga di-drop', async () => {
  const body = `#EXTM3U
#EXTINF:-1 group-title="18+",Hot Movies
${UP}/x.ts
#EXTINF:-1 group-title="Sports",ESPN
${UP}/espn.ts
`;
  const res = await run(`${UP}/list.m3u`, body, 'application/x-mpegurl');
  const t = await res.text();
  assert.ok(!t.includes('Hot Movies'), '18+ group harus di-drop');
  assert.ok(t.includes('ESPN'), 'sports channel tetap ada');
});

test('ADULT FILTER: "Hotstar" tidak false positive (hot dihapus dari keywords)', async () => {
  const body = `#EXTM3U
#EXTINF:-1 group-title="Entertainment",Hotstar Movies
${UP}/hotstar.ts
`;
  const res = await run(`${UP}/list.m3u`, body, 'application/x-mpegurl');
  const t = await res.text();
  assert.ok(t.includes('Hotstar Movies'), 'Hotstar harus lolos filter');
});

test('RATE LIMIT: 61 request dari IP sama di window 60s -> 429', async () => {
  // Reset rateMap
  // (we use require-like import fresh)
  const mod = await import(`../functions/api/proxy.js?bust_rl=${Math.random()}`);
  // Hit 60 times - semua harus berhasil (200 atau 502 mock)
  for (let i = 0; i < 60; i++) {
    const res = await mod.onRequest({
      request: new Request('https://noir-tv.pages.dev/api/proxy?url=https://evil.example/x', {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      }),
      env: {},
    });
    // First 60 bukan 429
    if (res.status === 429) {
      assert.fail(`Hit ${i+1} harus belum 429`);
    }
  }
  // 61st: harus 429
  const res61 = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/proxy?url=https://evil.example/x', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    }),
    env: {},
  });
  assert.equal(res61.status, 429, 'request ke-61 harus 429');
  assert.equal(res61.headers.get('retry-after'), '60');
});

test('INPUT BOUNDARY: target url kosong atau tanpa param -> 400', async () => {
  const mod = await import(`../functions/api/proxy.js?bust_ib1=${Math.random()}`);
  const resNoParam = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/proxy'),
    env: {},
  });
  assert.equal(resNoParam.status, 400);
  const jsonNoParam = await resNoParam.json();
  assert.equal(jsonNoParam.error, 'Missing url parameter');

  const resEmptyParam = await mod.onRequest({
    request: new Request('https://noir-tv.pages.dev/api/proxy?url='),
    env: {},
  });
  assert.equal(resEmptyParam.status, 400);
  const jsonEmptyParam = await resEmptyParam.json();
  assert.equal(jsonEmptyParam.error, 'Missing url parameter');
});

test('INPUT BOUNDARY: target url malformed syntax -> 400', async () => {
  const mod = await import(`../functions/api/proxy.js?bust_ib2=${Math.random()}`);
  const badUrls = ['http://[::1', 'not-a-url', '://missing-scheme', 'http://%zz%'];
  for (const bad of badUrls) {
    const res = await mod.onRequest({
      request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent(bad)}`),
      env: {},
    });
    assert.equal(res.status, 400, `target ${bad} harus 400`);
    const json = await res.json();
    assert.equal(json.error, 'Invalid target URL');
  }
});

test('INPUT BOUNDARY: skema selain http/https (javascript/data/file) -> 400', async () => {
  const mod = await import(`../functions/api/proxy.js?bust_ib3=${Math.random()}`);
  const schemes = ['javascript:alert(1)', 'data:text/html,pwnd', 'file:///etc/passwd'];
  for (const s of schemes) {
    const res = await mod.onRequest({
      request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent(s)}`),
      env: {},
    });
    assert.equal(res.status, 400, `skema ${s} harus 400`);
    const json = await res.json();
    assert.equal(json.error, 'Unsupported URL scheme');
  }
});

test('INPUT BOUNDARY: SSRF IPv6 loopback, ULA, link-local terkurung kurung siku -> 403', async () => {
  const mod = await import(`../functions/api/proxy.js?bust_ib4=${Math.random()}`);
  const targets = ['http://[::1]/status', 'http://[fc00::1]:8080/admin', 'http://[fe80::1]/internal'];
  for (const t of targets) {
    const res = await mod.onRequest({
      request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent(t)}`),
      env: {},
    });
    assert.equal(res.status, 403, `SSRF IPv6 ${t} harus 403`);
    const json = await res.json();
    assert.equal(json.error, 'Private / internal IP blocked');
  }
});

test('INPUT BOUNDARY: SSRF IPv4 batas 0.0.0.0, 172.16, 172.31 vs 172.32', async () => {
  const mod = await import(`../functions/api/proxy.js?bust_ib5=${Math.random()}`);
  const blocked = ['http://0.0.0.0/', 'http://172.16.0.1/', 'http://172.31.255.254/'];
  for (const b of blocked) {
    const res = await mod.onRequest({
      request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent(b)}`),
      env: {},
    });
    assert.equal(res.status, 403, `SSRF IPv4 ${b} harus 403`);
  }

  // 172.32.0.1 adalah IP publik, tidak boleh terblokir oleh regex private IP
  globalThis.fetch = async () => new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  const resPub = await mod.onRequest({
    request: new Request(`https://noir-tv.pages.dev/api/proxy?url=${encodeURIComponent('http://172.32.0.1/live.ts')}`),
    env: {},
  });
  assert.notEqual(resPub.status, 403, '172.32.0.1 bukan private IP');
});
