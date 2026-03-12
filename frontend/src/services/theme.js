const THEME_KEY = 'arynik_theme_mode_v1';
const THEME_EVENT = 'arynik:theme-mode';
const MODES = ['auto', 'dark', 'light'];

let mediaListenerBound = false;
let mediaQuery = null;
let mediaQueryHandler = null;

const canUseDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

export const normalizeThemeMode = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    return MODES.includes(raw) ? raw : 'dark';
};

export const getThemeMode = () => {
    if (!canUseDom()) return 'dark';
    try {
        return normalizeThemeMode(localStorage.getItem(THEME_KEY));
    } catch {
        return 'dark';
    }
};

export const resolveTheme = (mode) => {
    const normalized = normalizeThemeMode(mode);
    if (normalized === 'dark' || normalized === 'light') return normalized;
    if (!canUseDom() || typeof window.matchMedia !== 'function') return 'dark';
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

export const applyThemeMode = (mode) => {
    if (!canUseDom()) return;
    const finalTheme = resolveTheme(mode);
    document.documentElement.setAttribute('data-theme', finalTheme);
    document.documentElement.style.colorScheme = finalTheme;
};

const notifyThemeMode = (mode) => {
    if (!canUseDom()) return;
    try {
        window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { mode: normalizeThemeMode(mode) } }));
    } catch {
        // ignore
    }
};

export const setThemeMode = (mode) => {
    const normalized = normalizeThemeMode(mode);
    if (canUseDom()) {
        try {
            localStorage.setItem(THEME_KEY, normalized);
        } catch {
            // ignore
        }
    }
    applyThemeMode(normalized);
    notifyThemeMode(normalized);
    return normalized;
};

const bindAutoThemeListener = () => {
    if (!canUseDom() || mediaListenerBound || typeof window.matchMedia !== 'function') return;
    mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    mediaQueryHandler = () => {
        if (getThemeMode() === 'auto') {
            applyThemeMode('auto');
        }
    };
    if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', mediaQueryHandler);
    } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(mediaQueryHandler);
    }
    mediaListenerBound = true;
};

export const initTheme = () => {
    const mode = getThemeMode();
    applyThemeMode(mode);
    bindAutoThemeListener();
    return mode;
};

export const subscribeThemeMode = (callback) => {
    if (!canUseDom() || typeof callback !== 'function') return () => { };
    const handler = (event) => {
        const mode = normalizeThemeMode(event?.detail?.mode);
        callback(mode);
    };
    window.addEventListener(THEME_EVENT, handler);
    return () => window.removeEventListener(THEME_EVENT, handler);
};
