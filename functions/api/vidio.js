// Cloudflare Pages Function: /api/vidio
// Dynamic catalog & direct HLS stream resolver for Vidio channels.

const AES_KEY_BYTES = new Uint8Array([
  100, 80, 114, 48, 81, 73, 109, 81, 55, 98, 99, 53, 111, 57, 76, 77,
  110, 116, 78, 98, 97, 50, 68, 79, 115, 83, 98, 90, 99, 106, 85, 104
]); // "dPr0QImQ7bc5o9LMntNba2DOsSbZcjUh"

const AES_IV_BYTES = new Uint8Array([
  67, 56, 82, 87, 115, 114, 116, 70, 115, 111, 101, 121, 67, 121, 80, 116
]); // "C8RWsrtFsoeyCyPt"

let cachedEncApiKey = null;
let keyExpiresAt = 0;

async function getEncryptedApiKey() {
  const now = Date.now();
  if (cachedEncApiKey && now < keyExpiresAt) {
    return cachedEncApiKey;
  }

  const authRes = await fetch("https://api.vidio.com/auth", {
    method: "POST",
    headers: {
      "Origin": "https://m.vidio.com",
      "Referer": "https://m.vidio.com/"
    }
  });

  if (!authRes.ok) {
    throw new Error(`Vidio auth failed: HTTP ${authRes.status}`);
  }

  const authData = await authRes.json();
  const rawKey = authData.api_key;
  if (!rawKey) throw new Error("Missing api_key in auth response");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    AES_KEY_BYTES,
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );

  const rawKeyBytes = new TextEncoder().encode(rawKey);
  const encBuffer = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: AES_IV_BYTES },
    cryptoKey,
    rawKeyBytes
  );

  let binary = "";
  const bytes = new Uint8Array(encBuffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const encBase64 = btoa(binary);

  cachedEncApiKey = encBase64;
  keyExpiresAt = now + 30 * 60 * 1000;
  return encBase64;
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  const url = new URL(request.url);
  const streamId = url.searchParams.get("stream_id");

  // Single stream resolution mode
  if (streamId) {
    return new Response(JSON.stringify({
      status: "ok",
      channel_id: streamId,
      hls_url: `https://tv.161.118.236.126.nip.io/index.m3u8?ch=${encodeURIComponent(streamId)}`,
      is_drm: false
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300"
      }
    });
  }

  // Catalog list mode
  const type = url.searchParams.get("type") || "all";

  try {
    const apiKey = await getEncryptedApiKey();
    const reqHeaders = {
      "X-Api-Key": apiKey,
      "X-Secure-Level": "2",
      "X-API-Platform": "web-mobile",
      "Accept-Language": "id"
    };

    const sectionsToFetch = [];
    if (type === "national" || type === "tv" || type === "all") {
      sectionsToFetch.push({ id: "30309", group: "Vidio TV" });
    }
    if (type === "sports" || type === "all") {
      sectionsToFetch.push({ id: "23975", group: "Vidio Sport" });
    }

    const fetchPromises = sectionsToFetch.map(async (sec) => {
      try {
        const res = await fetch(`https://api.vidio.com/sections/${sec.id}?content_size=30`, {
          headers: reqHeaders
        });
        if (!res.ok) return [];
        const json = await res.json();
        const items = json.included || [];

        return items.map((item) => {
          const attr = item.attributes || {};
          const liveUrl = attr.web_url || "";
          const idMatch = liveUrl.match(/\/live\/(\d+)(?:-([a-zA-Z0-9_-]+))?/);
          const channelId = idMatch ? idMatch[1] : (item.id || "").replace(/[^0-9]/g, "");

          const isNational = sec.id === "30309";
          const name = isNational
            ? (attr.alt_title || attr.title || "TV")
            : (attr.title || "Live Sport");
          const program = isNational
            ? (attr.title || "")
            : (attr.alt_title || attr.livestreaming_title || "");

          const logo = attr.cover_url || attr.image_url || attr.image_landscape_url || "";

          return {
            id: `vidio-${item.id}`,
            channel_id: channelId,
            name: name,
            program: program,
            group: sec.group,
            logo: logo,
            type: "vidio_direct",
            url: `https://tv.161.118.236.126.nip.io/index.m3u8?ch=${channelId}`,
            watch_url: liveUrl,
            is_live: true
          };
        });
      } catch (err) {
        console.error(`Error fetching section ${sec.id}:`, err);
        return [];
      }
    });

    const results = await Promise.all(fetchPromises);
    const channels = results.flat();

    return new Response(JSON.stringify({ status: "ok", total: channels.length, channels }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=120, s-maxage=120"
      }
    });
  } catch (err) {
    console.error("Vidio API handler error:", err);
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
