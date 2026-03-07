const PREMIUM_ENABLED_KEY = 'arynik_premium_enabled_v1';
const PREMIUM_UPDATED_AT_KEY = 'arynik_premium_updated_at_v1';
const PREMIUM_EVENT_NAME = 'arynik:premium-changed';

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

const safeRemove = (key) => {
    try {
        localStorage.removeItem(key);
    } catch { }
};

const emitPremiumChanged = (enabled) => {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(PREMIUM_EVENT_NAME, {
            detail: {
                enabled: Boolean(enabled),
                updated_at: safeGet(PREMIUM_UPDATED_AT_KEY) || null,
            }
        }));
    } catch { }
};

export const isPremiumEnabled = () => String(safeGet(PREMIUM_ENABLED_KEY) || '') === '1';

export const getPremiumState = () => ({
    enabled: isPremiumEnabled(),
    updated_at: safeGet(PREMIUM_UPDATED_AT_KEY) || null,
});

export const setPremiumEnabled = (enabled) => {
    const on = Boolean(enabled);
    if (on) {
        safeSet(PREMIUM_ENABLED_KEY, '1');
    } else {
        safeRemove(PREMIUM_ENABLED_KEY);
    }
    safeSet(PREMIUM_UPDATED_AT_KEY, new Date().toISOString());
    emitPremiumChanged(on);
    return getPremiumState();
};

export const subscribePremiumChanges = (listener) => {
    if (typeof window === 'undefined' || typeof listener !== 'function') {
        return () => { };
    }
    const handler = () => {
        try {
            listener(getPremiumState());
        } catch { }
    };
    window.addEventListener(PREMIUM_EVENT_NAME, handler);
    window.addEventListener('storage', handler);
    return () => {
        window.removeEventListener(PREMIUM_EVENT_NAME, handler);
        window.removeEventListener('storage', handler);
    };
};

