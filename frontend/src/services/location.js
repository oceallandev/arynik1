const toFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const codeMessage = (code) => {
    const c = Number(code || 0);
    if (c === 1) return 'Location permission denied';
    if (c === 2) return 'Location unavailable';
    if (c === 3) return 'Location request timed out. Move to open sky and retry.';
    return '';
};

export const DEFAULT_GEO_WATCH_OPTIONS = {
    enableHighAccuracy: false,
    timeout: 20000,
    maximumAge: 15000,
};

const DEFAULT_POSITION_ATTEMPTS = [
    { enableHighAccuracy: true, timeout: 14000, maximumAge: 0 },
    { enableHighAccuracy: false, timeout: 18000, maximumAge: 30000 },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
];

export const normalizeGeoErrorMessage = (error) => {
    const raw = String(error?.message || '').trim();
    const codeMsg = codeMessage(error?.code);
    if (raw && raw.toLowerCase() !== 'gps error') return raw;
    if (codeMsg) return codeMsg;
    return 'Failed to detect location';
};

const readCurrentPosition = (options) => new Promise((resolve, reject) => {
    if (!navigator?.geolocation) {
        const e = new Error('Geolocation is not supported');
        e.code = 0;
        reject(e);
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        (e) => {
            const out = new Error(normalizeGeoErrorMessage(e));
            out.code = Number(e?.code || 0);
            reject(out);
        },
        options
    );
});

export const getCurrentPositionRobust = async ({ attempts } = {}) => {
    const trialList = Array.isArray(attempts) && attempts.length > 0 ? attempts : DEFAULT_POSITION_ATTEMPTS;
    let lastError = null;

    for (const attempt of trialList) {
        try {
            const pos = await readCurrentPosition(attempt);
            const lat = toFinite(pos?.coords?.latitude);
            const lon = toFinite(pos?.coords?.longitude);
            if (lat === null || lon === null) {
                const bad = new Error('Invalid GPS coordinates');
                bad.code = 2;
                throw bad;
            }
            return {
                latitude: lat,
                longitude: lon,
                accuracy_m: toFinite(pos?.coords?.accuracy),
                heading: toFinite(pos?.coords?.heading),
                speed: toFinite(pos?.coords?.speed),
                timestamp: new Date(pos?.timestamp || Date.now()).toISOString(),
            };
        } catch (e) {
            lastError = e;
            if (Number(e?.code || 0) === 1) break;
        }
    }

    const msg = normalizeGeoErrorMessage(lastError);
    const out = new Error(msg);
    out.code = Number(lastError?.code || 0);
    throw out;
};
