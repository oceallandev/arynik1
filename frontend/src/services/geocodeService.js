import axios from 'axios';
import { autoDetectApiUrl, getApiUrl } from './api';

const CACHE_KEY = 'arynik_geocode_cache_v1';
const MIN_DELAY_MS = 1100; // Respect Nominatim's usage policy (roughly 1 req/sec).
const BACKEND_TIMEOUT_MS = 12000;
const TOKEN_KEY = 'token';

let backendApiUrlCache = '';

let lastRequestAt = 0;
let requestChain = Promise.resolve();

// Avoid JSON.parse(localStorage) on every geocode call.
let memoryCache = null;
let cacheDirty = false;
let cacheSaveTimer = null;
const inflight = new Map();

const MAX_CACHE_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 250;
const NEGATIVE_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

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

const readTokenFromStorage = () => {
    try {
        return String(localStorage.getItem(TOKEN_KEY) || '').trim();
    } catch {
        return '';
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeHint = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const cacheKeyFor = (query, hints = {}) => {
    const q = String(query || '').trim();
    const locality = normalizeHint(hints?.expectedLocality);
    const county = normalizeHint(hints?.expectedCounty);
    if (!locality && !county) return q;
    return `${q}||loc=${locality || '-'}||county=${county || '-'}`;
};

const includesToken = (text, token) => {
    const src = normalizeHint(text);
    const t = normalizeHint(token);
    if (!src || !t) return false;
    if (t.length <= 2) {
        const words = src.split(/[^a-z0-9]+/).filter(Boolean);
        return words.includes(t);
    }
    return src.includes(t);
};

const candidateScore = (candidate, hints = {}) => {
    const expectedLocality = normalizeHint(hints?.expectedLocality);
    const expectedCounty = normalizeHint(hints?.expectedCounty);

    const address = candidate?.address && typeof candidate.address === 'object' ? candidate.address : {};
    const localityValues = [
        address.city,
        address.town,
        address.village,
        address.municipality,
        address.suburb,
        address.city_district,
        address.hamlet,
        candidate?.display_name,
    ];
    const countyValues = [
        address.county,
        address.state_district,
        address.state,
        candidate?.display_name,
    ];

    let score = 0;
    let localityMatch = false;
    let countyMatch = false;

    if (expectedLocality) {
        localityMatch = localityValues.some((v) => includesToken(v, expectedLocality));
        score += localityMatch ? 120 : -100;
    }
    if (expectedCounty) {
        countyMatch = countyValues.some((v) => includesToken(v, expectedCounty));
        score += countyMatch ? 80 : -60;
    }

    if (candidate?.type === 'house' || candidate?.type === 'building') score += 15;
    if (candidate?.type === 'residential' || candidate?.type === 'road') score += 8;

    return { score, localityMatch, countyMatch };
};

const pickBestCandidate = (list, hints = {}) => {
    const candidates = Array.isArray(list) ? list : [];
    if (candidates.length === 0) return null;

    const expectedLocality = normalizeHint(hints?.expectedLocality);
    const expectedCounty = normalizeHint(hints?.expectedCounty);
    if (!expectedLocality && !expectedCounty) return candidates[0];

    let best = null;
    for (const c of candidates) {
        const info = candidateScore(c, hints);
        if (!best || info.score > best.info.score) {
            best = { c, info };
        }
    }
    if (!best) return null;

    // Strong verification: if we know expected locality/county, avoid caching obviously wrong places.
    if (expectedLocality && !best.info.localityMatch) return null;
    if (expectedCounty && !best.info.countyMatch) return null;
    return best.c;
};

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

export const getCachedGeocode = (query, hints = {}) => {
    const q = String(query || '').trim();
    if (!q) return null;

    const specificKey = cacheKeyFor(q, hints);
    const entry = getCacheEntry(specificKey);
    if (!entry) return null;

    if (entry.lat === null && entry.lon === null) {
        const ts = Number(entry.ts || 0);
        if (Number.isFinite(ts) && ts > 0 && (Date.now() - ts) > NEGATIVE_CACHE_TTL_MS) {
            try {
                const cache = loadCacheOnce();
                delete cache[specificKey];
                cacheDirty = true;
                scheduleSave();
            } catch { }
            return null;
        }
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

const resolveBackendApiUrl = async () => {
    const cached = String(backendApiUrlCache || '').trim();
    const current = String(getApiUrl() || '').trim();
    if (current) {
        if (current !== cached) backendApiUrlCache = current;
        return current;
    }

    if (cached) {
        return cached;
    }

    try {
        const detected = await autoDetectApiUrl({ persist: true, timeout: 9000 });
        const found = String(detected?.apiUrl || '').trim();
        if (detected?.ok && found) {
            backendApiUrlCache = found;
            return found;
        }
    } catch {
        // Fallback to Nominatim.
    }

    return '';
};

const geocodeViaBackend = async (query, hints = {}, tokenOverride = '') => {
    const apiUrl = await resolveBackendApiUrl();
    if (!apiUrl) return null;

    const payload = {
        query,
        expected_locality: hints?.expectedLocality || undefined,
        expected_county: hints?.expectedCounty || undefined,
    };
    const token = String(tokenOverride || readTokenFromStorage() || '').trim();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    try {
        const response = await axios.post(`${apiUrl}/maps/geocode`, payload, {
            headers,
            timeout: BACKEND_TIMEOUT_MS,
        });
        const data = response?.data || {};
        if (data?.found) {
            const lat = Number(data?.lat);
            const lon = Number(data?.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                return {
                    ok: true,
                    result: {
                        lat,
                        lon,
                        display_name: String(data?.formatted_address || query || '').trim() || String(query || ''),
                        provider: String(data?.provider || 'backend_geocoder').trim() || 'backend_geocoder',
                        accuracy: data?.accuracy ? String(data.accuracy) : null,
                        partial_match: typeof data?.partial_match === 'boolean' ? data.partial_match : null,
                        matched_locality: typeof data?.matched_locality === 'boolean' ? data.matched_locality : null,
                        matched_county: typeof data?.matched_county === 'boolean' ? data.matched_county : null,
                        ts: Date.now(),
                    }
                };
            }
        }

        if (Object.prototype.hasOwnProperty.call(data, 'found') && data?.found === false) {
            return { ok: true, result: null };
        }
    } catch (error) {
        const status = Number(error?.response?.status || 0);
        // 401/403 means session issue; avoid repeated backend retries in this tab.
        if (status === 401 || status === 403) return null;

        const fallbackApi = await autoDetectApiUrl({ persist: true, timeout: 9000 }).catch(() => null);
        const fallbackUrl = String(fallbackApi?.apiUrl || '').trim();
        if (!fallbackApi?.ok || !fallbackUrl || fallbackUrl === apiUrl) {
            return null;
        }

        try {
            backendApiUrlCache = fallbackUrl;
            const retry = await axios.post(`${fallbackUrl}/maps/geocode`, payload, {
                headers,
                timeout: BACKEND_TIMEOUT_MS,
            });
            const data = retry?.data || {};
            if (!data?.found) return { ok: true, result: null };
            const lat = Number(data?.lat);
            const lon = Number(data?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: true, result: null };
            return {
                ok: true,
                result: {
                    lat,
                    lon,
                    display_name: String(data?.formatted_address || query || '').trim() || String(query || ''),
                    provider: String(data?.provider || 'backend_geocoder').trim() || 'backend_geocoder',
                    accuracy: data?.accuracy ? String(data.accuracy) : null,
                    partial_match: typeof data?.partial_match === 'boolean' ? data.partial_match : null,
                    matched_locality: typeof data?.matched_locality === 'boolean' ? data.matched_locality : null,
                    matched_county: typeof data?.matched_county === 'boolean' ? data.matched_county : null,
                    ts: Date.now(),
                }
            };
        } catch {
            return null;
        }
    }

    return null;
};

export const geocodeAddress = async (query, hints = {}, tokenOverride = '') => {
    const q = String(query || '').trim();
    if (!q) return null;
    const key = cacheKeyFor(q, hints);

    const cached = getCachedGeocode(q, hints);
    if (cached) {
        if (Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) return cached;
        // Negative cache: don't retry unless the query changes.
        if (cached.lat === null && cached.lon === null) return null;
    }

    if (inflight.has(key)) return inflight.get(key);

    const task = (async () => {
        const backend = await geocodeViaBackend(q, hints, tokenOverride);
        if (backend?.ok && backend?.result) {
            setCacheEntry(key, backend.result);
            return backend.result;
        }

        const baseUrl = 'https://nominatim.openstreetmap.org/search';
        const url = `${baseUrl}?format=json&addressdetails=1&countrycodes=ro&limit=5&q=${encodeURIComponent(q)}`;

        try {
            const data = await rateLimited(() => jsonp(url));
            const first = pickBestCandidate(Array.isArray(data) ? data : [], hints);
            const lat = first ? Number(first.lat) : NaN;
            const lon = first ? Number(first.lon) : NaN;

            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                setCacheEntry(key, { lat: null, lon: null, display_name: q, ts: Date.now() });
                return null;
            }

            const result = {
                lat,
                lon,
                display_name: first.display_name || q,
                provider: 'nominatim',
                ts: Date.now()
            };
            setCacheEntry(key, result);
            return result;
        } catch (error) {
            console.warn('Geocode failed', error);
            return null;
        }
    })();

    inflight.set(key, task);
    try {
        return await task;
    } finally {
        inflight.delete(key);
    }
};
