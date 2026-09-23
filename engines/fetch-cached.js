// engines/fetch-cached.js -- classic script, importScripts()'d by both
// engine workers. Downloads a cross-origin engine asset once, keeps it in
// the Cache API for later visits, and hands back a same-origin Blob.
//
// Loading the engines from blob: URLs instead of their Hugging Face URLs is
// required, not an optimization: the page runs under
// Cross-Origin-Embedder-Policy (needed for SharedArrayBuffer), which blocks
// cross-origin scripts that don't send a Cross-Origin-Resource-Policy header.
// A CORS fetch() of the bytes is allowed, and a blob: URL is same-origin.
var transcribrFetchCached = (function () {
  // Keep in sync with ENGINE_CACHE_PREFIX in app.js, which prunes old versions.
  const CACHE_PREFIX = "transcribr-web-engines-";

  // onProgress(loadedBytes, totalBytes) fires while downloading; totalBytes
  // is 0 when the server sends no Content-Length.
  async function fetchCachedBlob(url, cacheVersion, onProgress) {
    let cache = null;
    try {
      cache = await caches.open(CACHE_PREFIX + cacheVersion);
      const hit = await cache.match(url);
      if (hit) return await hit.blob();
    } catch (e) {
      cache = null; // Cache API unavailable (private mode etc.) -- just download.
    }

    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`download failed (network error): ${url}`);
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`);

    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (onProgress) onProgress(loaded, total);
      }
    } catch (e) {
      throw new Error(`download failed (connection dropped): ${url}`);
    }
    const blob = new Blob(chunks);

    if (cache) {
      try {
        await cache.put(url, new Response(blob));
      } catch (e) {
        // Storage quota exceeded: still usable this session, just not cached.
      }
    }
    return blob;
  }

  return { fetchCachedBlob };
})();
