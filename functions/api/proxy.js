// Cloudflare Pages Function: /api/proxy?url=...
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

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
    const customReferrer = url.searchParams.get("referrer");
    const reqHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    if (customReferrer) {
      reqHeaders.set("Referer", customReferrer);
    }

    const upstream = await fetch(targetUrl, { headers: reqHeaders });
    const contentType = upstream.headers.get("content-type") || "";

    // If playlist m3u8 / m3u, rewrite relative URLs so chunks pass through proxy
    if (contentType.includes("mpegurl") || contentType.includes("m3u") || targetUrl.includes(".m3u")) {
      let text = await upstream.text();
      const baseUrl = new URL(targetUrl);

      const rewritten = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        
        let absoluteUrl;
        try {
          absoluteUrl = new URL(trimmed, baseUrl).href;
        } catch {
          return line;
        }

        let proxyUrl = `${url.origin}/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
        if (customReferrer) {
          proxyUrl += `&referrer=${encodeURIComponent(customReferrer)}`;
        }
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

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

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
