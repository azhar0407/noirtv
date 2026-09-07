// Cloudflare Pages Function: /api/proxy?url=... (updated robust version)
// Rate-limit state lives at module scope (per-instance, resets on cold start — intentional trade-off)
// ---- RATE LIMIT: 60 req/min per IP ----
const rateMap = new Map(); // ip -> [ts]
const RATE_LIMIT = 60;
const RATE_WINDOW = 60_000; // ms
const RATE_MAP_MAX = 5000; // ponytail: per-instance cap; use Workers KV for multi-instance
function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateMap.get(ip) || [];
  const active = bucket.filter(ts => now - ts < RATE_WINDOW);
  if (active.length >= RATE_LIMIT) { rateMap.set(ip, active); return true; }
  active.push(now);
  rateMap.set(ip, active);
  // GC: evict oldest entries when map grows too large
  if (rateMap.size > RATE_MAP_MAX) {
    const oldest = [...rateMap.entries()]
      .sort((a, b) => (a[1][0] || 0) - (b[1][0] || 0))
      .slice(0, 500);
    for (const [k] of oldest) rateMap.delete(k);
  }
  return false;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const clientIp = request.headers.get("cf-connecting-ip") ||
                   request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                   "unknown";

  // OPTIONS exempt from rate limit (browser preflight must not consume quota)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*" }
    });
  }

  // Rate limit
  if (isRateLimited(clientIp)) {
    console.log(JSON.stringify({ event: "rate_limited", ip: clientIp, ts: Date.now() }));
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
                 "Retry-After": "60" }
    });
  }

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    let normalizedTarget;
    try { normalizedTarget = new URL(targetUrl); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid target URL" }), {
        status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    if (normalizedTarget.protocol !== "http:" && normalizedTarget.protocol !== "https:") {
      return new Response(JSON.stringify({ error: "Unsupported URL scheme" }), {
        status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ---- SSRF DEFENSE ----
    const hostname = normalizedTarget.hostname.toLowerCase(); // already strip port
    const privateIPPattern = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
    // ponytail: no DNS rebinding check — add if serving sensitive internal networks
    if (privateIPPattern.test(hostname)) {
      return new Response(JSON.stringify({ error: "Private / internal IP blocked" }), {
        status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const customReferrer = url.searchParams.get("referrer");
    const reqHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    if (customReferrer) reqHeaders.set("Referer", customReferrer);

    let upstream;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 7000);
      try {
        upstream = await fetch(normalizedTarget.href, { headers: reqHeaders, signal: ctrl.signal });
        clearTimeout(to);
        if (upstream.ok) break;
        upstream = null;
      } catch (e) { clearTimeout(to); upstream = null; if (e.name === 'AbortError') break; }
    }
    if (!upstream) {
      return new Response(JSON.stringify({ error: "Upstream fetch failed after retries" }), {
        status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const contentType = upstream.headers.get("content-type") || "";
    const likelyPlaylist = contentType.includes("mpegurl")
      || /\.m3u8?($|[?#])/i.test(normalizedTarget.pathname);

    let bodyText, isPlaylist;
    if (likelyPlaylist) {
      bodyText = await upstream.text();
      isPlaylist = true;
    } else {
      const buf = await upstream.arrayBuffer();
      const sniff = new TextDecoder().decode(buf.slice(0, 512));
      if (/^\s*#EXTM3U|#EXT-X-|#EXTINF/.test(sniff)) {
        bodyText = new TextDecoder().decode(buf);
        isPlaylist = true;
      } else {
        // Binary pass-through — do not text-decode (would corrupt binary)
        console.log(JSON.stringify({ event: "proxy_request", host: hostname, status: upstream.status,
          ip: clientIp, target: normalizedTarget.href, ts: Date.now() }));
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
      }
    }

    if (isPlaylist) {
      const text = bodyText;
      const base = new URL(normalizedTarget.href);

      // ---- ADULT CONTENT FILTER (two-pass) ----
      const adultKeywords = ['adult','xxx','porn','sex','18+','nsfw','erotic','hentai','playboy','hustler','redtube','pornhub'];
      const lines = text.split("\n");
      let dropNext = false; // true when previous line was adult #EXTINF → drop following URL
      const filtered = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("#EXTINF")) {
          const namePart = (line.match(/,(.+)$/) || ['', ''])[1] || '';
          const groupPart = (line.match(/group-title="([^"]*)"/i) || ['', ''])[1] || '';
          const combined = (namePart + ' ' + groupPart).toLowerCase();
          if (adultKeywords.some(k => combined.includes(k))) {
            console.log(JSON.stringify({ event: "adult_content_blocked", name: namePart, group: groupPart, ts: Date.now() }));
            dropNext = true; // next non-comment line (the URL) should be dropped
            continue; // drop #EXTINF line
          }
          dropNext = false;
        }
        if (dropNext && trimmed && !trimmed.startsWith("#")) {
          dropNext = false; // drop the URL line of adult channel
          continue;
        }
        if (!trimmed || trimmed.startsWith("#")) {
          filtered.push(line);
          continue;
        }
        // Rewrite relative segment/chunklist through proxy
        let absolute;
        try { absolute = new URL(trimmed, base).href; }
        catch { filtered.push(line); continue; }
        let proxyUrl = `${url.origin}/api/proxy?url=${encodeURIComponent(absolute)}`;
        if (customReferrer) proxyUrl += `&referrer=${encodeURIComponent(customReferrer)}`;
        filtered.push(proxyUrl);
      }
      const rewritten = filtered.join("\n");

      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          "Content-Type": contentType || "application/x-mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Cache-Control": "no-cache"
        }
      });
    }

    // Should not reach here — binary already returned above, playlist returned above
    return new Response(JSON.stringify({ error: "Unhandled content type" }), {
      status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    console.log(JSON.stringify({ event: "proxy_error", error: err.message, ip: clientIp, target: targetUrl, ts: Date.now() }));
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};
