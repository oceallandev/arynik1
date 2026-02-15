const ORIGIN_KEY = 'arynik_warehouse_origin_v1';

const envCoord = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) < 0.0001) return null;
    return n;
};

// Default: Bacau, Romania (city). Replace with the exact warehouse coordinates as needed.
const DEFAULT_ORIGIN = {
    lat: envCoord(import.meta.env.VITE_WAREHOUSE_LAT) ?? 46.5667,
    lon: envCoord(import.meta.env.VITE_WAREHOUSE_LON) ?? 26.9167,
    label: String(import.meta.env.VITE_WAREHOUSE_LABEL || 'Warehouse (Bacau)'),
};

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
        return true;
    } catch {
        return false;
    }
};

const isValidCoord = (lat, lon) => (
    Number.isFinite(Number(lat))
    && Number.isFinite(Number(lon))
    && Math.abs(Number(lat)) > 0.0001
    && Math.abs(Number(lon)) > 0.0001
);

export const getWarehouseOrigin = () => {
    if (typeof window === 'undefined') return DEFAULT_ORIGIN;

    const raw = safeGet(ORIGIN_KEY);
    if (!raw) return DEFAULT_ORIGIN;

    try {
        const parsed = JSON.parse(raw);
        const lat = Number(parsed?.lat);
        const lon = Number(parsed?.lon);
        if (!isValidCoord(lat, lon)) return DEFAULT_ORIGIN;

        return {
            lat,
            lon,
            label: String(parsed?.label || DEFAULT_ORIGIN.label || 'Warehouse'),
        };
    } catch {
        return DEFAULT_ORIGIN;
    }
};

export const setWarehouseOrigin = ({ lat, lon, label } = {}) => {
    const nextLat = Number(lat);
    const nextLon = Number(lon);
    if (!isValidCoord(nextLat, nextLon)) return false;

    return safeSet(
        ORIGIN_KEY,
        JSON.stringify({
            lat: nextLat,
            lon: nextLon,
            label: String(label || DEFAULT_ORIGIN.label || 'Warehouse'),
            ts: Date.now(),
        })
    );
};
