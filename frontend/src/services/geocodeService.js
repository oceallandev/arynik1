const CACHE_KEY = 'arynik_geocode_cache_v1';
const MIN_DELAY_MS = 1100; // Respect Nominatim's usage policy (roughly 1 req/sec).

let lastRequestAt = 0;

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

const loadCache = () => {
    const raw = safeGet(CACHE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const saveCache = (cache) => {
    safeSet(CACHE_KEY, JSON.stringify(cache || {}));
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

export const geocodeAddress = async (query) => {
    const q = String(query || '').trim();
    if (!q) return null;

    const cache = loadCache();
    if (cache[q] && cache[q].lat && cache[q].lon) {
        return cache[q];
    }

    const wait = MIN_DELAY_MS - (Date.now() - lastRequestAt);
    if (wait > 0) {
        await sleep(wait);
    }
    lastRequestAt = Date.now();

    const baseUrl = 'https://nominatim.openstreetmap.org/search';
    const url = `${baseUrl}?format=json&limit=1&q=${encodeURIComponent(q)}`;

    try {
        const data = await jsonp(url);
        const first = Array.isArray(data) ? data[0] : null;
        const lat = first ? Number(first.lat) : NaN;
        const lon = first ? Number(first.lon) : NaN;

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            cache[q] = { lat: null, lon: null, ts: Date.now() };
            saveCache(cache);
            return null;
        }

        const result = {
            lat,
            lon,
            display_name: first.display_name || q,
            ts: Date.now()
        };
        cache[q] = result;
        saveCache(cache);
        return result;
    } catch (error) {
        console.warn('Geocode failed', error);
        return null;
    }
};

