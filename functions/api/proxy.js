// Cloudflare Pages Function: /api/proxy?url=... (updated robust version)
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    // validate and normalize target URL (reject malformed)
    let normalizedTarget;
    try { normalizedTarget = new URL(targetUrl); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid target URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // optional referrer passed from frontend (not currently used but preserved for extensibility)
    const customReferrer = url.searchParams.get("referrer");

    const reqHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    if (customReferrer) reqHeaders.set("Referer", customReferrer);

    // simple retry for transient network issues (max 2 attempts)
    let upstream;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await fetch(normalizedTarget.href, { headers: reqHeaders });
        if (upstream.ok) break;
        upstream = null;
      } catch (e) { upstream = null; }
    }
    if (!upstream) {
      return new Response(JSON.stringify({ error: "Upstream fetch failed after retries" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const contentType = upstream.headers.get("content-type") || "";

    // REWRITE: for M3U/M3U8 playlists, rewrite any relative paths (chunklist, segments) through proxy
    // This prevents CORS errors when browser tries to load HLS segments
    if (contentType.includes("mpegurl") || contentType.includes("m3u") || normalizedTarget.href.endsWith(".m3u")) {
      const text = await upstream.text();
      const base = new URL(normalizedTarget.href);

      const rewritten = text.split("\n").map(line => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;

        let absolute;
        try { absolute = new URL(t, base).href; }
        catch { return line; }

        // Proxy each segment/chunklist so that the browser can load them without CORS
        let proxyUrl = `${url.origin}/api/proxy?url=${encodeURIComponent(absolute)}`;
        if (customReferrer) proxyUrl += `&referrer=${encodeURIComponent(customReferrer)}`;
        return proxyUrl;
      }).join("\n");

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

    // NON-PLAYLIST assets (e.g., channel logos, thumbnails) pass-through with CORS headers
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

    // Return stream preserving full asset (e.g., image) without extra copy
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}