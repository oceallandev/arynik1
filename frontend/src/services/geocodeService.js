const CACHE_KEY = 'arynik_geocode_cache_v1';
const MIN_DELAY_MS = 1100; // Respect Nominatim's usage policy (roughly 1 req/sec).

let lastRequestAt = 0;
let requestChain = Promise.resolve();

// Avoid JSON.parse(localStorage) on every geocode call.
let memoryCache = null;
let cacheDirty = false;
let cacheSaveTimer = null;
const inflight = new Map();

const MAX_CACHE_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 250;

const safeGet = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const safeSet = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch { }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadCacheOnce = () => {
    if (memoryCache) return memoryCache;

    const raw = safeGet(CACHE_KEY);
    if (!raw) {
        memoryCache = {};
        return memoryCache;
    }

    try {
        const parsed = JSON.parse(raw);
        memoryCache = parsed && typeof parsed === 'object' ? parsed : {};
        return memoryCache;
    } catch {
        memoryCache = {};
        return memoryCache;
    }
};

const evictOldEntries = (cache) => {
    const entries = Object.entries(cache || {});
    if (entries.length <= MAX_CACHE_ENTRIES) return;

    entries.sort((a, b) => Number(a?.[1]?.ts || 0) - Number(b?.[1]?.ts || 0));
    const removeCount = entries.length - MAX_CACHE_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) {
        delete cache[entries[i][0]];
    }
};

const scheduleSave = () => {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => {
        cacheSaveTimer = null;
        if (!cacheDirty) return;
        cacheDirty = false;

        const cache = loadCacheOnce();
        try {
            evictOldEntries(cache);
            safeSet(CACHE_KEY, JSON.stringify(cache || {}));
        } catch {
            // Ignore storage quota / serialization issues.
        }
    }, SAVE_DEBOUNCE_MS);
};

const setCacheEntry = (key, value) => {
    const cache = loadCacheOnce();
    cache[key] = value;
    cacheDirty = true;
    scheduleSave();
};

const getCacheEntry = (key) => {
    const cache = loadCacheOnce();
    const entry = cache ? cache[key] : null;
    return entry && typeof entry === 'object' ? entry : null;
};

export const getCachedGeocode = (query) => {
    const q = String(query || '').trim();
    if (!q) return null;

    const entry = getCacheEntry(q);
    if (!entry) return null;

    if (entry.lat === null && entry.lon === null) {
        return { lat: null, lon: null, display_name: entry.display_name || q, ts: entry.ts || 0 };
    }

    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return {
        ...entry,
        lat,
        lon,
    };
};

const jsonp = (url, { timeoutMs = 15000 } = {}) => new Promise((resolve, reject) => {
    const cbName = `__arynik_jsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement('script');
    const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Geocode timeout'));
    }, timeoutMs);

    const cleanup = () => {
        clearTimeout(timeoutId);
        try { delete window[cbName]; } catch { window[cbName] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
    };

    window[cbName] = (data) => {
        cleanup();
        resolve(data);
    };

    script.onerror = () => {
        cleanup();
        reject(new Error('Geocode network error'));
    };

    script.async = true;
    script.src = `${url}${url.includes('?') ? '&' : '?'}json_callback=${encodeURIComponent(cbName)}`;
    document.body.appendChild(script);
});

const rateLimited = (fn) => {
    const run = async () => {
        const wait = MIN_DELAY_MS - (Date.now() - lastRequestAt);
        if (wait > 0) {
            await sleep(wait);
        }
        lastRequestAt = Date.now();
        return fn();
    };

    const p = requestChain.then(run, run);
    // Keep the chain alive even if a request fails.
    requestChain = p.catch(() => { });
    return p;
};

export const geocodeAddress = async (query) => {
    const q = String(query || '').trim();
    if (!q) return null;

    const cached = getCachedGeocode(q);
    if (cached) {
        if (Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) return cached;
        // Negative cache: don't retry unless the query changes.
        if (cached.lat === null && cached.lon === null) return null;
    }

    if (inflight.has(q)) return inflight.get(q);

    const task = (async () => {
        const baseUrl = 'https://nominatim.openstreetmap.org/search';
        const url = `${baseUrl}?format=json&limit=1&q=${encodeURIComponent(q)}`;

        try {
            const data = await rateLimited(() => jsonp(url));
            const first = Array.isArray(data) ? data[0] : null;
            const lat = first ? Number(first.lat) : NaN;
            const lon = first ? Number(first.lon) : NaN;

            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                setCacheEntry(q, { lat: null, lon: null, display_name: q, ts: Date.now() });
                return null;
            }

            const result = {
                lat,
                lon,
                display_name: first.display_name || q,
                ts: Date.now()
            };
            setCacheEntry(q, result);
            return result;
        } catch (error) {
            console.warn('Geocode failed', error);
            return null;
        }
    })();

    inflight.set(q, task);
    try {
        return await task;
    } finally {
        inflight.delete(q);
    }
};
