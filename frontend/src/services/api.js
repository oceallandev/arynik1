import axios from 'axios';
import {
    demoGetAnalytics,
    demoGetLogs,
    demoGetMe,
    demoGetRoles,
    demoListUsers,
    demoCreateUser,
    demoUpdateUser,
    demoSyncDrivers,
    demoTriggerPostisSync,
    demoGetPostisSyncStatus,
    demoGetShipments,
    demoGetShipment,
    demoGetStats,
    demoGetStatusOptions,
    demoGetHealth,
    demoLogin,
    demoUpdateAwb,
    demoRecipientSignup,
    demoGetNotifications,
    demoMarkNotificationRead,
    demoListAdminNotes,
    demoCreateAdminNote,
    demoAllocateShipment,
    demoUpdateLocation,
    demoCreateTrackingRequest,
    demoListTrackingInbox,
    demoListTrackingActive,
    demoAcceptTrackingRequest,
    demoDenyTrackingRequest,
    demoStopTrackingRequest,
    demoGetTrackingRequest,
    demoGetTrackingLatest,
    demoListChatThreads,
    demoEnsureChatThread,
    demoGetChatThread,
    demoListChatMessages,
    demoSendChatMessage,
    demoMarkChatRead,
    demoCreateContactAttempt,
    demoGetNdrReasons,
    demoCreateManifest,
    demoListManifests,
    demoGetManifest,
    demoScanManifest,
    demoCloseManifest,
    demoStartRouteRun,
    demoListActiveRouteRuns,
    demoGetRouteRun,
    demoRouteRunArrive,
    demoRouteRunComplete,
    demoRouteRunSkip,
    demoFinishRouteRun,
    demoGetLiveDrivers,
    demoGetCodReport,
    demoUpdateShipmentInstructions,
    demoRequestReschedule,
    demoGetPaymentLink,
    demoGetShipmentPod
} from './demoApi';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const EXTRA_API_CANDIDATES = import.meta.env.VITE_API_CANDIDATES || '';
const API_URL_KEY = 'arynik_api_url_v1';
const WORKING_API_URL_KEY = 'arynik_api_url_working_v1';
const DATA_SOURCE_KEY = 'arynik_data_source_v1'; // 'api' | 'snapshot'
const DATA_SOURCE_REASON_KEY = 'arynik_data_source_reason_v1';

const sanitizeBaseUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    // API base URLs should never include hash-router fragments.
    const withoutHash = raw.split('#')[0].trim();
    if (!withoutHash) return '';

    let normalized = withoutHash;
    try {
        const parsed = new URL(withoutHash);
        normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname || ''}`;
    } catch {
        // Keep non-URL inputs (for example localhost:8000) as entered.
    }

    return normalized.replace(/\/+$/, '');
};

export const isLikelyFrontendUrl = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return false;
    if (raw.includes('/#/')) return true;

    try {
        const parsed = new URL(raw);
        const host = String(parsed.hostname || '').toLowerCase();
        const path = String(parsed.pathname || '').toLowerCase();

        if (host.includes('github.io')) return true;
        if (path.endsWith('/index.html')) return true;
        if (path === '/arynik1' || path === '/arynik1/') return true;
    } catch {
        // Non-URL input; no additional checks.
    }

    return false;
};

export const getApiUrlIssue = (value) => {
    const api = sanitizeBaseUrl(value);
    if (!api) return '';

    if (isLikelyFrontendUrl(api)) {
        return 'API URL points to the frontend app, not FastAPI. Set it to your backend base URL where /docs opens.';
    }

    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && /^http:\/\//i.test(api)) {
        return 'This app is opened over HTTPS, so Backend API URL must also be HTTPS.';
    }

    return '';
};

const safeLocalStorageGet = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const safeLocalStorageSet = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch { }
};

const safeLocalStorageRemove = (key) => {
    try {
        localStorage.removeItem(key);
    } catch { }
};

const isLocalHost = (host) => {
    const h = String(host || '').trim().toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
};

const canUseHttpApi = () => {
    if (typeof window === 'undefined') return true;
    if (window.location.protocol !== 'https:') return true;
    return isLocalHost(window.location.hostname);
};

const isRecoverableApiError = (error) => {
    if (!error) return true;
    if (!error.response) return true;
    const status = Number(error?.response?.status || 0);
    return status === 404 || status === 405 || status >= 500;
};

const isAuthApiError = (error) => {
    const status = Number(error?.response?.status || 0);
    return status === 401 || status === 403;
};

const isRenderApiUrl = (apiUrl) => {
    try {
        const parsed = new URL(String(apiUrl || ''));
        return String(parsed.hostname || '').toLowerCase().endsWith('.onrender.com');
    } catch {
        return false;
    }
};

const apiTimeoutMs = (apiUrl, { forHealth = false } = {}) => {
    if (isRenderApiUrl(apiUrl)) {
        // Render can take longer after cold start / fresh deploy.
        return forHealth ? 15000 : 20000;
    }
    return forHealth ? 6000 : 7000;
};

const splitApiCandidates = (raw) => String(raw || '')
    .split(/[,\s]+/)
    .map((v) => sanitizeBaseUrl(v))
    .filter(Boolean);

const pushUnique = (arr, value) => {
    const v = sanitizeBaseUrl(value);
    if (!v) return;
    if (/^http:\/\//i.test(v) && !canUseHttpApi()) return;
    if (!arr.includes(v)) arr.push(v);
};

const buildApiCandidates = () => {
    const out = [];
    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        pushUnique(out, params.get('api'));
        pushUnique(out, safeLocalStorageGet(API_URL_KEY));
        pushUnique(out, safeLocalStorageGet(WORKING_API_URL_KEY));
    }
    pushUnique(out, DEFAULT_API_URL);
    for (const c of splitApiCandidates(EXTRA_API_CANDIDATES)) pushUnique(out, c);

    if (typeof window !== 'undefined') {
        const origin = sanitizeBaseUrl(window.location.origin);
        pushUnique(out, `${origin}/api`);
        pushUnique(out, origin);
        if (isLocalHost(window.location.hostname)) {
            pushUnique(out, 'http://localhost:8000');
        }
    }

    return out;
};

const notifyDataSource = (source, reason) => {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent('arynik:data-source', { detail: { source, reason } }));
    } catch { }
};

const setDataSource = (source, reason = '') => {
    if (typeof window === 'undefined') return;
    const s = String(source || '').trim() || 'api';
    safeLocalStorageSet(DATA_SOURCE_KEY, s);
    safeLocalStorageSet(DATA_SOURCE_REASON_KEY, String(reason || '').trim());
    notifyDataSource(s, String(reason || '').trim());
};

export const getDataSource = () => safeLocalStorageGet(DATA_SOURCE_KEY) || 'api';
export const getDataSourceReason = () => safeLocalStorageGet(DATA_SOURCE_REASON_KEY) || '';

export const getApiUrl = () => {
    if (typeof window === 'undefined') {
        return sanitizeBaseUrl(DEFAULT_API_URL);
    }

    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('api');
    const fromStorage = safeLocalStorageGet(API_URL_KEY);
    const fromWorking = safeLocalStorageGet(WORKING_API_URL_KEY);

    if (fromQuery) return sanitizeBaseUrl(fromQuery);
    if (fromStorage) return sanitizeBaseUrl(fromStorage);
    if (fromWorking) return sanitizeBaseUrl(fromWorking);

    const envDefault = sanitizeBaseUrl(DEFAULT_API_URL);
    if (envDefault) {
        const isLocalDefault = /(^https?:\/\/localhost)|(^https?:\/\/127\.0\.0\.1)|(^https?:\/\/\[?::1\]?)/i.test(envDefault);
        if (!(isLocalDefault && !isLocalHost(window.location.hostname))) {
            if (!/^http:\/\//i.test(envDefault) || canUseHttpApi()) {
                return envDefault;
            }
        }
    }

    if (isLocalHost(window.location.hostname)) return 'http://localhost:8000';
    return '';
};

export const setApiUrl = (value) => {
    const v = sanitizeBaseUrl(value);
    const issue = getApiUrlIssue(v);
    if (issue) {
        return { ok: false, apiUrl: v, issue };
    }

    if (v) {
        safeLocalStorageSet(API_URL_KEY, v);
        safeLocalStorageSet(WORKING_API_URL_KEY, v);
        return { ok: true, apiUrl: v, issue: '' };
    }

    safeLocalStorageRemove(API_URL_KEY);
    safeLocalStorageRemove(WORKING_API_URL_KEY);
    return { ok: true, apiUrl: '', issue: '' };
};

export async function autoDetectApiUrl({ persist = true, timeout = 6000 } = {}) {
    if (isDemoMode) {
        return { ok: true, apiUrl: '', issue: '' };
    }

    const candidates = buildApiCandidates();
    for (const baseUrl of candidates) {
        if (!baseUrl) continue;
        const issue = getApiUrlIssue(baseUrl);
        if (issue) continue;
        const timeoutMs = Math.max(Number(timeout) || 0, apiTimeoutMs(baseUrl, { forHealth: true }));
        try {
            const response = await axios.get(`${baseUrl}/health`, {
                timeout: timeoutMs,
                validateStatus: () => true,
            });
            if (Number(response?.status) !== 200) continue;
            const payload = response?.data;
            const looksLikeApi = payload && typeof payload === 'object'
                && (Object.prototype.hasOwnProperty.call(payload, 'ok')
                    || Object.prototype.hasOwnProperty.call(payload, 'postis_configured'));
            if (!looksLikeApi) continue;
            if (persist) {
                safeLocalStorageSet(API_URL_KEY, baseUrl);
                safeLocalStorageSet(WORKING_API_URL_KEY, baseUrl);
            }
            return { ok: true, apiUrl: baseUrl, issue: '' };
        } catch {
            continue;
        }
    }
    return {
        ok: false,
        apiUrl: '',
        issue: 'No reachable backend API detected. Open Settings and set a valid HTTPS FastAPI URL.',
    };
}

const resolveApiUrlOrThrow = async ({ timeout = 12000 } = {}) => {
    let apiUrl = getApiUrl();
    if (apiUrl) return apiUrl;

    const detected = await autoDetectApiUrl({ persist: true, timeout });
    if (detected?.ok && detected?.apiUrl) return sanitizeBaseUrl(detected.apiUrl);

    throw new Error(detected?.issue || 'No reachable backend API detected. Open Settings and set a valid HTTPS FastAPI URL.');
};

const apiRequestWithFallback = async (requestFactory, { timeout = 12000 } = {}) => {
    const primaryApiUrl = await resolveApiUrlOrThrow({ timeout });
    try {
        return await requestFactory(primaryApiUrl);
    } catch (error) {
        if (!isRecoverableApiError(error)) throw error;
        const detected = await autoDetectApiUrl({ persist: true, timeout });
        const fallbackApiUrl = sanitizeBaseUrl(detected?.apiUrl);
        if (!detected?.ok || !fallbackApiUrl || fallbackApiUrl === primaryApiUrl) throw error;
        return await requestFactory(fallbackApiUrl);
    }
};

const authHeaders = (token) => (
    token
        ? { Authorization: `Bearer ${token}` }
        : {}
);

const filenameFromDisposition = (contentDisposition, fallback = 'document.pdf') => {
    const raw = String(contentDisposition || '').trim();
    if (!raw) return fallback;

    // RFC 5987 style: filename*=UTF-8''...
    const extMatch = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (extMatch?.[1]) {
        try {
            return decodeURIComponent(extMatch[1].replace(/["']/g, '')).trim() || fallback;
        } catch {
            // continue with basic match
        }
    }

    const basicMatch = raw.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (basicMatch?.[1]) {
        return String(basicMatch[1]).trim() || fallback;
    }

    return fallback;
};

const normalizeAwbList = (awbs) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(awbs) ? awbs : []) {
        const key = String(raw || '').trim().toUpperCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
};

const toBase64Url = (value) => {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';

    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });

    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
};

const buildOfflineToken = (payload) => {
    const header = { alg: 'none', typ: 'JWT' };
    return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.offline`;
};

const offlineRoleForUsername = (username) => {
    const normalized = String(username || '').trim().toLowerCase();

    if (normalized.includes('admin')) {
        return 'Admin';
    }

    if (normalized.includes('manager')) {
        return 'Manager';
    }

    const digits = normalized.replace(/\\D/g, '');
    if (digits.length >= 9) {
        return 'Recipient';
    }

    return 'Driver';
};

const offlineDriverIdForRole = (role, username) => {
    if (role === 'Driver') {
        const normalized = String(username || '').trim().toUpperCase();
        if (/^D\\d{3,}$/i.test(normalized)) {
            return normalized;
        }
        // Snapshot data currently uses D002 for imported shipments.
        return 'D002';
    }

    if (role === 'Recipient') {
        const digits = String(username || '').replace(/\\D/g, '');
        return digits ? `R${digits.slice(-15)}` : 'R000';
    }

    return 'D001';
};

export async function login(username, password) {
    if (isDemoMode) {
        return demoLogin(username, password);
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);
    const doLogin = async (baseUrl) => {
        const response = await axios.post(`${baseUrl}/login`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 3000
        });
        safeLocalStorageSet(WORKING_API_URL_KEY, baseUrl);
        setDataSource('api', 'login');
        return response.data;
    };

    try {
        const API_URL = getApiUrl();
        if (API_URL) {
            return await doLogin(API_URL);
        }
    } catch (error) {
        // If we got an HTTP response (e.g. 401), it's a real auth failure: do not bypass.
        if (!isRecoverableApiError(error)) {
            throw error;
        }
    }

    try {
        const detected = await autoDetectApiUrl({ persist: true });
        if (detected?.ok && detected?.apiUrl) {
            return await doLogin(detected.apiUrl);
        }
    } catch (error) {
        if (!isRecoverableApiError(error)) throw error;
    }

    console.warn('Login API unavailable; using snapshot/offline token.');
    setDataSource('snapshot', 'login');

    const resolvedUsername = String(username || '').trim() || 'offline';
    const role = offlineRoleForUsername(resolvedUsername);
    const payload = {
        sub: resolvedUsername,
        driver_id: offlineDriverIdForRole(role, resolvedUsername),
        role,
        offline: true,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    };

    return {
        access_token: buildOfflineToken(payload),
        token_type: 'bearer',
        role
    };
}

export async function recipientSignup(payload) {
    if (isDemoMode) {
        return demoRecipientSignup(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/recipient/signup`, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function getStats(token) {
    if (isDemoMode) {
        return demoGetStats();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/stats`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function getDashboardOverview(token, { period = 'today', scope = 'auto', anchor_date = null, awb_limit = 500 } = {}) {
    if (isDemoMode) {
        // Reuse demo analytics fallback for local preview environments.
        const a = await demoGetAnalytics({ scope: scope === 'all' ? 'all' : 'self', awb_limit: 200 });
        const delivered = Array.isArray(a?.awbs) ? a.awbs.filter((x) => String(x?.status || '').toLowerCase().includes('deliver')) : [];
        return {
            generated_at: new Date().toISOString(),
            timezone: 'Europe/Bucharest',
            scope: scope === 'all' ? 'all' : 'self',
            period: String(period || 'today'),
            ranges: {},
            counts: {
                today: 0,
                week: 0,
                month: delivered.length,
                total: delivered.length,
            },
            selected: {
                period: String(period || 'today'),
                delivered_count: delivered.length,
                cod_total: 0,
                shipping_total: 0,
                estimated_shipping_total: 0,
                payment_total: 0,
                km_total: 0,
                drivers: [],
                daily: [],
                awbs: delivered.slice(0, 300),
            },
        };
    }

    const periodNorm = String(period || 'today').trim().toLowerCase();
    const scopeNorm = String(scope || 'auto').trim().toLowerCase();

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/dashboard/overview`, {
            params: {
                period: periodNorm,
                scope: scopeNorm,
                anchor_date: anchor_date || undefined,
                awb_limit,
            },
            headers: authHeaders(token),
            timeout: 20000,
        }),
        { timeout: 20000 }
    );

    return response.data;
}

export async function getMe(token) {
    if (isDemoMode) {
        return demoGetMe(token);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/me`, {
            headers: authHeaders(token),
            timeout: 12000,
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function getHealth() {
    if (isDemoMode) {
        return demoGetHealth();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/health`, {
            timeout: apiTimeoutMs(API_URL, { forHealth: true }),
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function getAnalytics(token, { scope = 'self', awb_limit = 200 } = {}) {
    if (isDemoMode) {
        return demoGetAnalytics({ scope, awb_limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/analytics`, {
            params: { scope, awb_limit },
            headers: authHeaders(token),
            timeout: 15000,
        }),
        { timeout: 15000 }
    );

    return response.data;
}

export async function getRoles(token) {
    if (isDemoMode) {
        return demoGetRoles();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/roles`, {
            headers: authHeaders(token),
            timeout: 10000,
        }),
        { timeout: 10000 }
    );

    return response.data;
}

export async function getVehicleTypes(token) {
    if (isDemoMode) {
        return [
            { code: 'VAN_35T', label: '3.5t Van', supports_liftgate: true, max_volume_m3: 18, target_volume_m3: 16.5, max_weight_kg: 1400, target_weight_kg: 1200 },
            { code: 'TIR_40T', label: 'TIR 40t', supports_liftgate: false, max_volume_m3: 90, target_volume_m3: 82, max_weight_kg: 24000, target_weight_kg: 22000 },
        ];
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/vehicle-types`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function listUsers(token) {
    if (isDemoMode) {
        return demoListUsers();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/users`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function seedFleetAccounts(token, { reset_passwords = true } = {}) {
    if (isDemoMode) {
        return [];
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/users/seed-fleet-accounts`, null, {
            params: { reset_passwords: reset_passwords ? 1 : 0 },
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );

    return response.data;
}

export async function createUser(token, payload) {
    if (isDemoMode) {
        return demoCreateUser(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/users`, payload, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function updateUser(token, driverId, patch) {
    if (isDemoMode) {
        return demoUpdateUser(driverId, patch);
    }

    const identifier = String(driverId || '').trim();
    if (!identifier) throw new Error('driver_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/users/${encodeURIComponent(identifier)}`, patch, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function getFleetOverview(token, { days = 30, include_inactive = false } = {}) {
    if (isDemoMode) {
        return {
            vehicles_total: 0,
            vehicles_with_lift: 0,
            target_volume_m3_total: 0,
            target_weight_kg_total: 0,
            by_vehicle_type: {},
            reminders_total: 0,
            reminders_due_soon: 0,
            reminders_overdue: 0,
            reminders: []
        };
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/overview`, {
            params: { days, include_inactive: include_inactive ? 1 : undefined },
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function listFleetVehicles(token, { include_inactive = false, sync_from_drivers = true } = {}) {
    if (isDemoMode) {
        return [];
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/vehicles`, {
            params: {
                include_inactive: include_inactive ? 1 : undefined,
                sync_from_drivers: sync_from_drivers ? 1 : 0,
            },
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetVehicle(token, payload) {
    if (isDemoMode) {
        return { id: `demo-${Date.now()}`, ...(payload || {}) };
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/vehicles`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function updateFleetVehicle(token, vehicleId, patch) {
    if (isDemoMode) {
        return { id: vehicleId, ...(patch || {}) };
    }
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}`, patch || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function listFleetDocuments(token, vehicleId) {
    if (isDemoMode) return [];
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/documents`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetDocument(token, vehicleId, payload) {
    if (isDemoMode) return { id: `demo-doc-${Date.now()}`, vehicle_id: vehicleId, ...(payload || {}) };
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/documents`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function updateFleetDocument(token, vehicleId, docId, patch) {
    if (isDemoMode) return { id: docId, vehicle_id: vehicleId, ...(patch || {}) };
    const vId = Number(vehicleId);
    const dId = Number(docId);
    if (!Number.isFinite(vId) || vId <= 0) throw new Error('vehicle_id is required');
    if (!Number.isFinite(dId) || dId <= 0) throw new Error('doc_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(vId))}/documents/${encodeURIComponent(String(dId))}`, patch || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function listFleetServices(token, vehicleId) {
    if (isDemoMode) return [];
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/services`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetService(token, vehicleId, payload) {
    if (isDemoMode) return { id: `demo-svc-${Date.now()}`, vehicle_id: vehicleId, ...(payload || {}) };
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/services`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function updateFleetService(token, vehicleId, serviceId, patch) {
    if (isDemoMode) return { id: serviceId, vehicle_id: vehicleId, ...(patch || {}) };
    const vId = Number(vehicleId);
    const sId = Number(serviceId);
    if (!Number.isFinite(vId) || vId <= 0) throw new Error('vehicle_id is required');
    if (!Number.isFinite(sId) || sId <= 0) throw new Error('service_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(vId))}/services/${encodeURIComponent(String(sId))}`, patch || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function listFleetInsurances(token, vehicleId) {
    if (isDemoMode) return [];
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/insurances`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetInsurance(token, vehicleId, payload) {
    if (isDemoMode) return { id: `demo-ins-${Date.now()}`, vehicle_id: vehicleId, ...(payload || {}) };
    const identifier = Number(vehicleId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('vehicle_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(identifier))}/insurances`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function updateFleetInsurance(token, vehicleId, insuranceId, patch) {
    if (isDemoMode) return { id: insuranceId, vehicle_id: vehicleId, ...(patch || {}) };
    const vId = Number(vehicleId);
    const iId = Number(insuranceId);
    if (!Number.isFinite(vId) || vId <= 0) throw new Error('vehicle_id is required');
    if (!Number.isFinite(iId) || iId <= 0) throw new Error('insurance_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/fleet/vehicles/${encodeURIComponent(String(vId))}/insurances/${encodeURIComponent(String(iId))}`, patch || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function syncDrivers(token) {
    if (isDemoMode) {
        return demoSyncDrivers();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/sync-drivers`, null, {
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );

    return response.data;
}

export async function getPostisSyncStatus(token) {
    if (isDemoMode) {
        return demoGetPostisSyncStatus();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/postis/sync/status`, {
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function triggerPostisSync(token, { wait = false, mode = undefined, missing_fields_limit = undefined } = {}) {
    if (isDemoMode) {
        return demoTriggerPostisSync({ wait, mode, missing_fields_limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/postis/sync`, null, {
            params: {
                wait: wait ? 1 : undefined,
                mode: mode ? String(mode) : undefined,
                missing_fields_limit: Number.isFinite(Number(missing_fields_limit)) ? Number(missing_fields_limit) : undefined,
            },
            headers: authHeaders(token),
            timeout: wait ? 10 * 60 * 1000 : 15000
        }),
        { timeout: wait ? 10 * 60 * 1000 : 20000 }
    );
    return response.data;
}

export async function listRoutePlans(token, { plan_date = undefined } = {}) {
    if (isDemoMode) return [];
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/routes/plans`, {
            params: { plan_date: plan_date ? String(plan_date) : undefined },
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function getRoutePlan(token, planId) {
    if (isDemoMode) return null;
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}`, {
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function generateRoutePlans(token, { plan_date = undefined, sync_postis = true } = {}) {
    if (isDemoMode) {
        return {
            date: String(plan_date || new Date().toISOString().slice(0, 10)),
            created_routes: 0,
            updated_routes: 0,
            allocated_awbs: 0,
            deliverable_in_moldova: 0,
            plans: []
        };
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/generate`, {
            plan_date: plan_date ? String(plan_date) : null,
            sync_postis: Boolean(sync_postis),
        }, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 10 * 60 * 1000
        }),
        { timeout: 10 * 60 * 1000 }
    );
    return response.data;
}

export async function approveRoutePlan(token, planId) {
    if (isDemoMode) return null;
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}/approve`, null, {
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function assignRoutePlan(token, planId, vehiclePlate) {
    if (isDemoMode) return null;
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const plate = String(vehiclePlate || '').trim().toUpperCase();
    if (!plate) throw new Error('vehicle_plate is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}/assign`, {
            vehicle_plate: plate,
        }, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function getStatusOptions(token) {
    if (isDemoMode) {
        return demoGetStatusOptions();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/status-options`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function updateAwb(token, payload) {
    if (isDemoMode) {
        return demoUpdateAwb(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/update-awb`, payload, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function getLogs(token, params = {}) {
    if (isDemoMode) {
        return demoGetLogs(params);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/logs`, {
            params,
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );

    return response.data;
}

export async function getShipments(token) {
    if (isDemoMode) {
        return demoGetShipments();
    }

    const fetchFromApi = async (apiUrl) => {
        const baseTimeout = apiTimeoutMs(apiUrl);
        let response;
        try {
            response = await axios.get(`${apiUrl}/shipments`, {
                headers: authHeaders(token),
                timeout: baseTimeout
            });
        } catch (error) {
            if (isAuthApiError(error)) {
                // Backend is reachable, but token/permissions are invalid.
                setDataSource('api', 'shipments');
                throw error;
            }
            if (!isRecoverableApiError(error)) throw error;

            // One more attempt with a longer timeout for cold starts/redeploys.
            response = await axios.get(`${apiUrl}/shipments`, {
                headers: authHeaders(token),
                timeout: Math.max(baseTimeout + 10000, 30000)
            });
        }
        safeLocalStorageSet(WORKING_API_URL_KEY, apiUrl);
        setDataSource('api', 'shipments');
        return response.data;
    };

    const API_URL = getApiUrl();
    try {
        if (API_URL) {
            return await fetchFromApi(API_URL);
        }
    } catch (error) {
        // If the server responded, don't silently fall back (auth/permission errors must be visible).
        if (isAuthApiError(error)) {
            setDataSource('api', 'shipments');
            throw error;
        }
        if (!isRecoverableApiError(error)) throw error;
    }

    try {
        const detected = await autoDetectApiUrl({ persist: true });
        if (detected?.ok && detected?.apiUrl) {
            return await fetchFromApi(detected.apiUrl);
        }
    } catch (error) {
        if (isAuthApiError(error)) {
            setDataSource('api', 'shipments');
            throw error;
        }
        if (!isRecoverableApiError(error)) throw error;
    }

    try {
        console.warn("Backend API unavailable, attempting to load static snapshot...");
        setDataSource('snapshot', 'shipments');
        // Fallback to static JSON
        const snapshotUrl = `${import.meta.env.BASE_URL}data/shipments.json`.replace('//', '/');
        const response = await axios.get(snapshotUrl);
        console.info("Loaded shipments from static snapshot.");

        let data = response.data;

        // Client-side RBAC for Offline Mode
        if (token) {
            try {
                // Manual JWT Decode (Payload is 2nd part)
                const base64Url = token.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function (c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));

                const payload = JSON.parse(jsonPayload);
                const role = payload.role;
                const driverId = payload.driver_id;
                const normalizeStatus = (value) => String(value || '')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .trim()
                    .toLowerCase();
                const isDriverPoolStatus = (status, processingStatus) => {
                    const folded = normalizeStatus(status || processingStatus);
                    if (!folded) return false;
                    return (
                        folded.includes('finalizare pregatire depozit')
                        || folded.includes('initial')
                        || folded.includes('pending')
                        || folded.includes('in asteptare')
                        || folded.includes('expediere preluata de curier')
                        || folded.includes('expedierea a fost preluata de curier')
                        || folded.includes('incarcat la curier')
                        || folded.includes('intrare in depozit')
                        || folded.includes('in depozitul curierului')
                        || folded.includes('courier warehouse')
                        || folded.includes('in depot')
                        || folded.includes('livrare reprogramata')
                        || folded.includes('reprogramat')
                        || folded.includes('reschedule')
                        || folded.includes('refuz')
                    );
                };

                // Filter for Drivers
                if (role === 'Driver') {
                    console.info(`Offline RBAC: Filtering for Driver ${driverId}`);
                    const me = String(driverId || '').trim().toUpperCase();
                    data = data.filter((s) => {
                        const sid = String(s?.driver_id || '').trim().toUpperCase();
                        if (sid && sid === me) return true;
                        if (sid) return false;
                        return isDriverPoolStatus(s?.status, s?.processing_status);
                    });
                } else if (role === 'Recipient') {
                    const username = String(payload.sub || '').trim();
                    const digits = username.replace(/\\D/g, '');
                    const suffix = digits.slice(-9);
                    if (suffix) {
                        console.info('Offline RBAC: Filtering for Recipient phone');
                        data = data.filter((s) => {
                            const d = String(s?.recipient_phone || '').replace(/\\D/g, '');
                            return d.endsWith(suffix);
                        });
                    }
                }
            } catch (e) {
                console.warn("Offline RBAC: Failed to decode token", e);
            }
        }

        return data;
    } catch (snapshotError) {
        console.error("Failed to load both API and static snapshot", snapshotError);
        throw snapshotError;
    }
}

export async function getShipment(token, awb, { refresh = false } = {}) {
    if (isDemoMode) {
        return demoGetShipment(awb);
    }

    const identifier = String(awb || '').trim();
    if (!identifier) {
        throw new Error('awb is required');
    }
    const fetchFromApi = async (apiUrl) => {
        const response = await axios.get(`${apiUrl}/shipments/${encodeURIComponent(identifier)}`, {
            params: refresh ? { refresh: true } : {},
            headers: authHeaders(token),
            timeout: 7000
        });
        safeLocalStorageSet(WORKING_API_URL_KEY, apiUrl);
        setDataSource('api', 'shipment');
        return response.data;
    };

    try {
        const API_URL = getApiUrl();
        if (API_URL) {
            return await fetchFromApi(API_URL);
        }
    } catch (error) {
        if (isAuthApiError(error)) {
            throw error;
        }
        if (!isRecoverableApiError(error)) throw error;
    }

    try {
        const detected = await autoDetectApiUrl({ persist: true });
        if (detected?.ok && detected?.apiUrl) {
            return await fetchFromApi(detected.apiUrl);
        }
    } catch (error) {
        if (isAuthApiError(error) || !isRecoverableApiError(error)) throw error;
    }

    console.warn("Backend shipment details unavailable, attempting static snapshot...");
    setDataSource('snapshot', 'shipment');
    try {
        const snapshotUrl = `${import.meta.env.BASE_URL}data/shipments.json`.replace('//', '/');
        const response = await axios.get(snapshotUrl);
        const data = Array.isArray(response.data) ? response.data : [];
        const found = data.find((s) => String(s?.awb || '').toUpperCase() === identifier.toUpperCase());
        if (found) return found;
    } catch { }
    throw new Error('Shipment unavailable from API and snapshot.');
}

export async function allocateShipment(token, awb, driver_id) {
    if (isDemoMode) {
        return demoAllocateShipment({ awb, driver_id });
    }

    const API_URL = getApiUrl();
    const identifier = String(awb || '').trim();
    if (!identifier) throw new Error('awb is required');
    const target = String(driver_id || '').trim();
    if (!target) throw new Error('driver_id is required');

    const response = await axios.post(`${API_URL}/shipments/${encodeURIComponent(identifier)}/allocate`, { driver_id: target }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });

    return response.data;
}

export async function getNotifications(token, { limit = 50, unread_only = false } = {}) {
    if (isDemoMode) {
        return demoGetNotifications({ limit, unread_only });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/notifications`, {
        params: { limit, unread_only },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function markNotificationRead(token, notificationId) {
    if (isDemoMode) {
        return demoMarkNotificationRead(notificationId);
    }

    const id = Number(notificationId);
    if (!Number.isFinite(id)) throw new Error('notification_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/notifications/${encodeURIComponent(String(id))}/read`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function listAdminNotes(token, { limit = 100 } = {}) {
    if (isDemoMode) {
        return demoListAdminNotes({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/admin/notes`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function createAdminNote(token, { text } = {}) {
    if (isDemoMode) {
        return demoCreateAdminNote({ text });
    }

    const content = String(text || '').trim();
    if (!content) throw new Error('text is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/admin/notes`, { text: content }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function updateLocation(token, payload) {
    if (isDemoMode) {
        return demoUpdateLocation(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/update-location`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function createTrackingRequest(token, payload) {
    if (isDemoMode) {
        return demoCreateTrackingRequest(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/tracking/requests`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function listTrackingInbox(token, { limit = 20 } = {}) {
    if (isDemoMode) {
        return demoListTrackingInbox({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/tracking/requests/inbox`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function listTrackingActive(token, { limit = 10 } = {}) {
    if (isDemoMode) {
        return demoListTrackingActive({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/tracking/requests/active`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoGetTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getTrackingLatest(token, requestId) {
    if (isDemoMode) {
        return demoGetTrackingLatest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/latest`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function acceptTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoAcceptTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/accept`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function denyTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoDenyTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/deny`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function stopTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoStopTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/stop`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

// [NEW] In-app Chat
export async function listChatThreads(token, { limit = 50, awb = null } = {}) {
    if (isDemoMode) {
        return demoListChatThreads({ limit, awb });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/chat/threads`, {
        params: { limit, awb: awb || undefined },
        headers: authHeaders(token),
        timeout: 15000
    });
    return response.data;
}

export async function ensureChatThread(token, { awb } = {}) {
    if (isDemoMode) {
        return demoEnsureChatThread({ awb });
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/chat/threads`, { awb: identifier }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    return response.data;
}

export async function getChatThread(token, threadId) {
    if (isDemoMode) {
        return demoGetChatThread(threadId);
    }

    const id = Number(threadId);
    if (!Number.isFinite(id)) throw new Error('thread_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/chat/threads/${encodeURIComponent(String(id))}`, {
        headers: authHeaders(token),
        timeout: 15000
    });
    return response.data;
}

export async function listChatMessages(token, threadId, { limit = 50, before_id = null } = {}) {
    if (isDemoMode) {
        return demoListChatMessages(threadId, { limit, before_id });
    }

    const id = Number(threadId);
    if (!Number.isFinite(id)) throw new Error('thread_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/chat/threads/${encodeURIComponent(String(id))}/messages`, {
        params: { limit, before_id: before_id ?? undefined },
        headers: authHeaders(token),
        timeout: 15000
    });
    return response.data;
}

export async function sendChatMessage(token, threadId, payload) {
    if (isDemoMode) {
        return demoSendChatMessage(threadId, payload);
    }

    const id = Number(threadId);
    if (!Number.isFinite(id)) throw new Error('thread_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/chat/threads/${encodeURIComponent(String(id))}/messages`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    return response.data;
}

export async function markChatRead(token, threadId, { last_read_message_id = null } = {}) {
    if (isDemoMode) {
        return demoMarkChatRead(threadId, { last_read_message_id });
    }

    const id = Number(threadId);
    if (!Number.isFinite(id)) throw new Error('thread_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/chat/threads/${encodeURIComponent(String(id))}/read`, {
        last_read_message_id: last_read_message_id ?? undefined
    }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    return response.data;
}

// [NEW] NDR reasons
export async function getNdrReasons(token) {
    if (isDemoMode) {
        return demoGetNdrReasons();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/ndr/reasons`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

// [NEW] Contact attempts (call / WhatsApp / SMS)
export async function createContactAttempt(token, payload) {
    if (isDemoMode) {
        return demoCreateContactAttempt(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/contacts/attempts`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

// [NEW] Shipment self-service actions
export async function updateShipmentInstructions(token, awb, { instructions } = {}) {
    if (isDemoMode) {
        return demoUpdateShipmentInstructions(awb, { instructions });
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.patch(`${API_URL}/shipments/${encodeURIComponent(identifier)}/instructions`, {
        instructions: instructions ?? null
    }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function requestReschedule(token, awb, payload) {
    if (isDemoMode) {
        return demoRequestReschedule(awb, payload);
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/shipments/${encodeURIComponent(identifier)}/reschedule-request`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function getPaymentLink(token, awb) {
    if (isDemoMode) {
        return demoGetPaymentLink(awb);
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/shipments/${encodeURIComponent(identifier)}/pay-link`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getShipmentPod(token, awb) {
    if (isDemoMode) {
        return demoGetShipmentPod(awb);
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/shipments/${encodeURIComponent(identifier)}/pod`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getShipmentLabelPdf(token, awb) {
    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    if (isDemoMode) {
        throw new Error('Label PDF is unavailable in demo mode.');
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/shipments/${encodeURIComponent(identifier)}/label`, {
        headers: authHeaders(token),
        responseType: 'blob',
        timeout: 30000
    });

    const filename = filenameFromDisposition(response?.headers?.['content-disposition'], `label_${identifier}.pdf`);
    return {
        blob: response.data,
        filename,
        requested_awb: identifier
    };
}

export async function getShipmentLabelsBatchPdf(token, awbs) {
    const list = normalizeAwbList(awbs);
    if (!list.length) throw new Error('Select at least one AWB.');

    if (isDemoMode) {
        throw new Error('Batch labels are unavailable in demo mode.');
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/shipments/labels/batch`, {
        awbs: list
    }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        responseType: 'blob',
        timeout: 120000
    });

    const headers = response?.headers || {};
    const filename = filenameFromDisposition(headers['content-disposition'], 'labels_batch.pdf');

    return {
        blob: response.data,
        filename,
        requested: Number(headers['x-labels-requested'] || list.length),
        found: Number(headers['x-labels-found'] || 0),
        missing: Number(headers['x-labels-missing'] || 0),
        missing_awbs: String(headers['x-labels-missing-awbs'] || '').trim(),
    };
}

// [NEW] Manifests
export async function createManifest(token, payload) {
    if (isDemoMode) {
        return demoCreateManifest(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/manifests`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function listManifests(token, { limit = 50 } = {}) {
    if (isDemoMode) {
        return demoListManifests({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/manifests`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getManifest(token, manifestId) {
    if (isDemoMode) {
        return demoGetManifest(manifestId);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/manifests/${encodeURIComponent(String(id))}`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function scanManifest(token, manifestId, payload) {
    if (isDemoMode) {
        return demoScanManifest(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/scan`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function closeManifest(token, manifestId, payload) {
    if (isDemoMode) {
        return demoCloseManifest(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/close`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

// [NEW] Route runs
export async function startRouteRun(token, payload) {
    if (isDemoMode) {
        return demoStartRouteRun(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/route-runs/start`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function listActiveRouteRuns(token, { limit = 50 } = {}) {
    if (isDemoMode) {
        return demoListActiveRouteRuns({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/route-runs/active`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function getRouteRun(token, runId) {
    if (isDemoMode) {
        return demoGetRouteRun(runId);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/route-runs/${encodeURIComponent(String(id))}`, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

export async function routeRunArrive(token, runId, awb, payload) {
    if (isDemoMode) {
        return demoRouteRunArrive(runId, awb, payload);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');
    const key = String(awb || '').trim().toUpperCase();
    if (!key) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/arrive`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function routeRunComplete(token, runId, awb, payload) {
    if (isDemoMode) {
        return demoRouteRunComplete(runId, awb, payload);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');
    const key = String(awb || '').trim().toUpperCase();
    if (!key) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/complete`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function routeRunSkip(token, runId, awb, payload) {
    if (isDemoMode) {
        return demoRouteRunSkip(runId, awb, payload);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');
    const key = String(awb || '').trim().toUpperCase();
    if (!key) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/skip`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function finishRouteRun(token, runId) {
    if (isDemoMode) {
        return demoFinishRouteRun(runId);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/finish`, null, {
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

// [NEW] Live ops
export async function getLiveDrivers(token, { limit = 100 } = {}) {
    if (isDemoMode) {
        return demoGetLiveDrivers({ limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/live/drivers`, {
        params: { limit },
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}

// [NEW] COD reconciliation
export async function getCodReport(token, params = {}) {
    if (isDemoMode) {
        return demoGetCodReport(params);
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/cod/report`, {
        params: params || {},
        headers: authHeaders(token),
        timeout: 7000
    });
    return response.data;
}
