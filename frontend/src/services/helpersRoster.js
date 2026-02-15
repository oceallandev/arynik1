const HELPERS_KEY = 'arynik_helpers_v1';

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

const normalizeName = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    // Collapse whitespace to keep the roster tidy.
    return raw.replace(/\s+/g, ' ');
};

const keyOf = (name) => normalizeName(name).toLowerCase();

export const listHelpers = () => {
    const raw = safeGet(HELPERS_KEY);
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeName)
            .filter(Boolean)
            .filter((name, idx, arr) => arr.findIndex((x) => keyOf(x) === keyOf(name)) === idx)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch {
        return [];
    }
};

export const addHelper = (name) => {
    const normalized = normalizeName(name);
    if (!normalized) return listHelpers();

    const current = listHelpers();
    const exists = current.some((n) => keyOf(n) === keyOf(normalized));
    if (exists) return current;

    const next = [...current, normalized].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    safeSet(HELPERS_KEY, JSON.stringify(next));
    return next;
};

export const removeHelper = (name) => {
    const normalized = normalizeName(name);
    if (!normalized) return listHelpers();

    const current = listHelpers();
    const targetKey = keyOf(normalized);
    const next = current.filter((n) => keyOf(n) !== targetKey);
    safeSet(HELPERS_KEY, JSON.stringify(next));
    return next;
};

