import { Capacitor, registerPlugin } from '@capacitor/core';

const LAST_DEVICE_PHONE_KEY = 'arynik_last_device_phone_v1';
const MAX_RECURSION_DEPTH = 4;
const PHONE_KEYS = [
    'phone',
    'phone_number',
    'phoneNumber',
    'number',
    'msisdn',
    'line1Number',
    'line_number',
    'subscriberNumber',
    'displayNumber',
];

const pluginCandidates = [
    { name: 'DevicePhoneNumber', methods: ['getPhoneNumber', 'getInfo', 'getPhoneInfo'] },
    { name: 'PhoneNumber', methods: ['getPhoneNumber', 'getInfo'] },
    { name: 'Sim', methods: ['getPhoneNumber', 'getSimInfo', 'getSimCards'] },
    { name: 'CapacitorSim', methods: ['getPhoneNumber', 'getSimInfo', 'getSimCards'] },
];

const asString = (value) => String(value || '').trim();

export const phoneDigitsFingerprint = (value) => {
    const txt = asString(value);
    if (!txt) return '';
    let digits = txt.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00') && digits.length > 2) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith('0')) digits = `40${digits.slice(1)}`;
    else if (digits.length === 9 && digits.startsWith('7')) digits = `40${digits}`;
    return digits;
};

const toE164 = (value) => {
    const fp = phoneDigitsFingerprint(value);
    if (!fp || fp.length < 8) return '';
    return `+${fp}`;
};

const extractPhoneCandidate = (value, depth = 0) => {
    if (depth > MAX_RECURSION_DEPTH || value == null) return '';

    if (typeof value === 'string' || typeof value === 'number') {
        return toE164(String(value));
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = extractPhoneCandidate(item, depth + 1);
            if (found) return found;
        }
        return '';
    }

    if (typeof value === 'object') {
        for (const key of PHONE_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const found = extractPhoneCandidate(value[key], depth + 1);
            if (found) return found;
        }
        for (const v of Object.values(value)) {
            const found = extractPhoneCandidate(v, depth + 1);
            if (found) return found;
        }
    }

    return '';
};

const persistLastPhone = (phone) => {
    const normalized = toE164(phone);
    if (!normalized) return;
    try {
        localStorage.setItem(LAST_DEVICE_PHONE_KEY, normalized);
    } catch { }
};

const readLastPhone = () => {
    try {
        return toE164(localStorage.getItem(LAST_DEVICE_PHONE_KEY) || '');
    } catch {
        return '';
    }
};

const tryWindowBridge = async () => {
    if (typeof window === 'undefined') return '';
    try {
        const bridge = window.Android || window.ArynikBridge || window.ReactNativeWebView;
        if (!bridge) return '';
        if (typeof bridge.getPhoneNumber === 'function') {
            const raw = await bridge.getPhoneNumber();
            return toE164(raw);
        }
    } catch { }
    return '';
};

const tryPlugin = async (candidate) => {
    const pluginName = asString(candidate?.name);
    if (!pluginName) return '';
    const methods = Array.isArray(candidate?.methods) ? candidate.methods : [];

    let plugin = null;
    try {
        plugin = registerPlugin(pluginName);
    } catch {
        plugin = null;
    }
    if (!plugin) return '';

    for (const method of methods) {
        const fn = plugin?.[method];
        if (typeof fn !== 'function') continue;
        try {
            const result = await fn.call(plugin);
            const found = extractPhoneCandidate(result);
            if (found) return found;
        } catch {
            // Plugin/method may not be implemented on this platform.
            continue;
        }
    }
    return '';
};

export const readDevicePhoneNumber = async () => {
    const isNative = Boolean(Capacitor?.isNativePlatform?.());
    const platform = String(Capacitor?.getPlatform?.() || '').trim().toLowerCase();
    if (!isNative || platform !== 'android') {
        return null;
    }

    const fromBridge = await tryWindowBridge();
    if (fromBridge) {
        persistLastPhone(fromBridge);
        return { phone: fromBridge, source: 'android_bridge' };
    }

    for (const candidate of pluginCandidates) {
        const found = await tryPlugin(candidate);
        if (found) {
            persistLastPhone(found);
            return { phone: found, source: `plugin:${String(candidate.name || '').trim()}` };
        }
    }

    const cached = readLastPhone();
    if (cached) {
        return { phone: cached, source: 'local_cache' };
    }

    return null;
};

