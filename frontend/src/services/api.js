import axios from 'axios';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { del as idbDel, get as idbGet, keys as idbKeys, set as idbSet } from 'idb-keyval';
import {
    demoGetAnalytics,
    demoGetLogs,
    demoGetMe,
    demoGetRoles,
    demoListWarehouses,
    demoListStores,
    demoCreateWarehouse,
    demoUpdateWarehouse,
    demoCreateStore,
    demoUpdateStore,
    demoListCarriers,
    demoRecommendCarriers,
    demoListUsers,
    demoCreateUser,
    demoUpdateUser,
    demoDeleteUser,
    demoSeedFlancoStoreAccounts,
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
    demoUpdateAdminNote,
    demoGetProviderSecretsStatus,
    demoUpdateProviderSecrets,
    demoGetMapsProviderConfig,
    demoUpdateMapsProviderConfig,
    demoTopupMapsProviderCredit,
    demoAllocateShipment,
    demoCreateManualShipment,
    demoConfirmShipmentReturn,
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
    demoImportManifestAwbs,
    demoCloseManifest,
    demoApproveManifestUnload,
    demoStartRouteRun,
    demoListActiveRouteRuns,
    demoGetRouteRun,
    demoRouteRunDepart,
    demoRouteRunArrive,
    demoRouteRunComplete,
    demoRouteRunSkip,
    demoFinishRouteRun,
    demoGetLiveDrivers,
    demoGetCodReport,
    demoUpdateShipmentInstructions,
    demoRequestReschedule,
    demoGetPaymentLink,
    demoGetShipmentPod,
    demoAskVirtualAssistant,
    demoSyncMyDevicePhone
} from './demoApi';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';
const FORCE_BACKEND_ONLINE = ['1', 'true', 'yes', 'on'].includes(
    String(import.meta.env.VITE_FORCE_BACKEND_ONLINE ?? (import.meta.env.PROD ? '1' : '0')).trim().toLowerCase()
);
export const isBackendForcedOnline = () => FORCE_BACKEND_ONLINE;
const DISABLE_LOCAL_FALLBACK = FORCE_BACKEND_ONLINE || ['1', 'true', 'yes', 'on'].includes(
    String(import.meta.env.VITE_DISABLE_LOCAL_FALLBACK ?? (import.meta.env.PROD ? '1' : '0')).trim().toLowerCase()
);

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const EXTRA_API_CANDIDATES = import.meta.env.VITE_API_CANDIDATES || '';
const DEFAULT_PUBLIC_BACKEND_URL = import.meta.env.VITE_PUBLIC_BACKEND_URL || 'https://arynik-backend.onrender.com';
const API_URL_KEY = 'arynik_api_url_v1';
const WORKING_API_URL_KEY = 'arynik_api_url_working_v1';
const DATA_SOURCE_KEY = 'arynik_data_source_v1'; // 'api' | 'snapshot'
const DATA_SOURCE_REASON_KEY = 'arynik_data_source_reason_v1';
const AUTH_INVALID_EVENT = 'arynik:auth-invalid';
const OFFLINE_CACHE_PREFIX = 'api-cache-v2:';
const OFFLINE_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h
const BACKEND_RETRY_DELAYS_MS = [1200, 2600];
const BACKEND_RETRY_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const BACKEND_RETRY_SAFE_POST_PREFIXES = [
    '/postis/sync',
    '/routes/plans/generate',
    '/maps/geocode',
    '/maps/geocode-shipments',
    '/maps/route-metrics',
    '/maps/route-optimize',
    '/update-location',
    '/login',
];

const KNOWN_API_PATH_SUFFIXES = ['/docs', '/redoc', '/openapi.json', '/health'];

const normalizeApiPathname = (pathname) => {
    let path = String(pathname || '').trim();
    if (!path || path === '/') return '';
    path = path.replace(/\/+$/, '');

    // Accept users pasting docs/health URLs and normalize to backend base path.
    let lowered = path.toLowerCase();
    let changed = true;
    while (changed) {
        changed = false;
        for (const suffix of KNOWN_API_PATH_SUFFIXES) {
            if (lowered === suffix || lowered.endsWith(`${suffix}`)) {
                path = path.slice(0, Math.max(0, path.length - suffix.length)).replace(/\/+$/, '');
                lowered = path.toLowerCase();
                changed = true;
                break;
            }
        }
    }

    return path === '/' ? '' : path;
};

const expandApiBaseVariants = (value) => {
    const out = [];
    const push = (candidate) => {
        const v = String(candidate || '').trim();
        if (!v) return;
        if (!out.includes(v)) out.push(v);
    };

    const normalized = sanitizeBaseUrl(value);
    if (!normalized) return out;
    push(normalized);

    try {
        const parsed = new URL(normalized);
        const baseOrigin = `${parsed.protocol}//${parsed.host}`;
        const path = normalizeApiPathname(parsed.pathname);
        if (!path) {
            const host = String(parsed.hostname || '').trim().toLowerCase();
            const canTryApiSuffix = isLocalHost(host);
            if (canTryApiSuffix) push(`${baseOrigin}/api`);
        } else if (path.toLowerCase().endsWith('/api')) {
            const rootPath = path.slice(0, -4).replace(/\/+$/, '');
            push(`${baseOrigin}${rootPath || ''}`);
        }
    } catch {
        // Ignore parse errors for non-URL candidates.
    }

    return out;
};

const sanitizeBaseUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    // API base URLs should never include hash-router fragments.
    const withoutHash = raw.split('#')[0].trim();
    if (!withoutHash) return '';

    let normalized = withoutHash;
    try {
        const parsed = new URL(withoutHash);
        const cleanPath = normalizeApiPathname(parsed.pathname || '');
        normalized = `${parsed.protocol}//${parsed.host}${cleanPath}`;
    } catch {
        // Keep non-URL inputs (for example localhost:8000) as entered.
    }

    return normalized.replace(/\/+$/, '');
};

const isKnownArynikBackendHost = (host) => {
    const normalized = String(host || '').trim().toLowerCase();
    if (!normalized) return false;
    if (isLocalHost(normalized)) return true;
    if (normalized.endsWith('.onrender.com')) return true;
    if (normalized === 'curieru.com' || normalized.endsWith('.curieru.com')) return true;
    return false;
};

const isAllowedArynikApiHost = (value) => {
    try {
        const parsed = new URL(String(value || '').trim());
        const host = String(parsed.hostname || '').trim().toLowerCase();
        if (!host) return true;
        return isKnownArynikBackendHost(host);
    } catch {
        return true;
    }
};

export const isLikelyFrontendUrl = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return false;
    if (raw.includes('/#/')) return true;

    try {
        const parsed = new URL(raw);
        const host = String(parsed.hostname || '').toLowerCase();
        const path = String(parsed.pathname || '').toLowerCase();
        const apiPath = path === '/api' || path.startsWith('/api/');
        const knownFrontendHost = (
            host === 'anunta.eu'
            || host.endsWith('.anunta.eu')
        );

        if (host.includes('github.io')) return true;
        if (path.endsWith('/index.html')) return true;
        if (path === '/arynik1' || path === '/arynik1/') return true;
        if (knownFrontendHost && !apiPath) return true;
        if (typeof window !== 'undefined') {
            const appHost = String(window.location.hostname || '').toLowerCase();
            if (host && appHost && host === appHost && !apiPath && !isKnownArynikBackendHost(host)) return true;
        }
    } catch {
        // Non-URL input; no additional checks.
    }

    return false;
};

export const getApiUrlIssue = (value) => {
    const api = sanitizeBaseUrl(value);
    if (!api) return '';

    if (!isAllowedArynikApiHost(api)) {
        return 'Use the Arynik backend URL (curieru.com, arynik-backend.onrender.com) or localhost.';
    }

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

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const isLocalHost = (host) => {
    const h = String(host || '').trim().toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
};

const canUseHttpApi = () => {
    if (typeof window === 'undefined') return true;
    if (window.location.protocol !== 'https:') return true;
    return isLocalHost(window.location.hostname);
};

const isNativeAndroid = () => {
    try {
        return Boolean(Capacitor?.isNativePlatform?.()) && String(Capacitor.getPlatform?.() || '').toLowerCase() === 'android';
    } catch {
        return false;
    }
};

const extractApiErrorDetail = (error) => {
    const detail = error?.response?.data?.detail;
    if (typeof detail === 'string') return detail.trim();
    if (detail && typeof detail === 'object') {
        try {
            return JSON.stringify(detail);
        } catch {
            return '';
        }
    }
    return String(error?.response?.statusText || error?.message || '').trim();
};

const extractErrorRequestPath = (error) => {
    const raw = String(error?.config?.url || '').trim();
    if (!raw) return '';
    try {
        return String(new URL(raw).pathname || '').trim().toLowerCase();
    } catch {
        if (raw.startsWith('/')) return raw.toLowerCase();
        return '';
    }
};

const isInfraEndpointPath = (pathRaw) => {
    let path = String(pathRaw || '').trim().toLowerCase();
    if (!path) return false;
    // Accept misconfigured base URLs that include a leading /api prefix.
    // Example bad target: https://host/api/routes/plans/generate (404 on many backends)
    if (path === '/api') path = '/';
    if (path.startsWith('/api/')) path = path.slice(4) || '/';
    return (
        path.startsWith('/postis/sync')
        || path.startsWith('/routes/plans/generate')
        || path.startsWith('/sync-drivers')
        || path.startsWith('/health')
        || path.startsWith('/maps/')
        || path.startsWith('/live/')
        || path.startsWith('/route-runs/')
    );
};

const isGenericNotFoundError = (error) => {
    const status = Number(error?.response?.status || 0);
    if (status !== 404) return false;
    const detail = extractApiErrorDetail(error).toLowerCase();
    if (!detail) return true;
    return (
        detail === 'not found'
        || detail === '404 not found'
        || detail.includes('route not found')
        || detail.includes('cannot get')
        || detail.includes('cannot post')
        || detail.includes('<!doctype html')
        || detail.includes('<html')
    );
};

const isRecoverableApiError = (error) => {
    if (!error) return true;
    if (error?.__arynikRecoverable) return true;
    if (!error.response) return true;
    const status = Number(error?.response?.status || 0);
    if (status === 404) {
        const path = extractErrorRequestPath(error);
        if (isInfraEndpointPath(path)) return true;
        return isGenericNotFoundError(error);
    }
    return status === 405 || status >= 500;
};

const isInvalidSessionApiError = (error) => {
    const status = Number(error?.response?.status || 0);
    return status === 401;
};

const toAbsoluteUrlSafe = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        return new URL(raw);
    } catch {
        if (typeof window === 'undefined') return null;
        try {
            return new URL(raw, window.location.origin);
        } catch {
            return null;
        }
    }
};

const knownBackendHosts = () => {
    const out = new Set();
    const rawCandidates = [
        DEFAULT_PUBLIC_BACKEND_URL,
        DEFAULT_API_URL,
        safeLocalStorageGet(API_URL_KEY),
        safeLocalStorageGet(WORKING_API_URL_KEY),
        ...splitApiCandidates(EXTRA_API_CANDIDATES),
    ];
    rawCandidates.forEach((c) => {
        const u = toAbsoluteUrlSafe(c);
        const host = String(u?.hostname || '').trim().toLowerCase();
        if (host) out.add(host);
    });
    return out;
};

const isBackendRequestConfig = (cfg) => {
    const u = toAbsoluteUrlSafe(cfg?.url);
    if (!u) return false;

    const host = String(u.hostname || '').trim().toLowerCase();
    const path = String(u.pathname || '').trim().toLowerCase();
    if (!host) return false;
    if (isLocalHost(host) || host.endsWith('.onrender.com')) return true;
    if (typeof window !== 'undefined') {
        const appHost = String(window.location.hostname || '').trim().toLowerCase();
        if (appHost && host === appHost) {
            let p = path;
            if (p === '/api') p = '/';
            if (p.startsWith('/api/')) p = p.slice(4) || '/';
            if (
                p.startsWith('/login')
                || p.startsWith('/health')
                || p.startsWith('/me')
                || p.startsWith('/users')
                || p.startsWith('/roles')
                || p.startsWith('/vehicle-types')
                || p.startsWith('/stats')
                || p.startsWith('/analytics')
                || p.startsWith('/status-options')
                || p.startsWith('/shipments')
                || p.startsWith('/routes')
                || p.startsWith('/fleet')
                || p.startsWith('/postis')
                || p.startsWith('/sync-drivers')
                || p.startsWith('/maps')
                || p.startsWith('/tracking')
                || p.startsWith('/chat')
                || p.startsWith('/contacts')
                || p.startsWith('/admin')
                || p.startsWith('/notifications')
                || p.startsWith('/ndr')
                || p.startsWith('/manifests')
                || p.startsWith('/route-runs')
                || p.startsWith('/live')
                || p.startsWith('/cod')
                || p.startsWith('/update-awb')
                || p.startsWith('/logs')
                || p.startsWith('/avize')
            ) {
                return true;
            }
        }
    }
    const knownHosts = knownBackendHosts();
    return knownHosts.has(host);
};

const isRetrySafeBackendRequest = (cfg) => {
    const method = String(cfg?.method || 'get').trim().toLowerCase();
    if (method === 'get' || method === 'head' || method === 'options') return true;
    if (method !== 'post') return false;

    const u = toAbsoluteUrlSafe(cfg?.url);
    const path = String(u?.pathname || '').trim().toLowerCase();
    if (!path) return false;
    return BACKEND_RETRY_SAFE_POST_PREFIXES.some((prefix) => path.startsWith(String(prefix).toLowerCase()));
};

const shouldRetryBackendRequest = (error) => {
    const cfg = error?.config || {};
    if (!isBackendRequestConfig(cfg)) return false;
    if (!isRetrySafeBackendRequest(cfg)) return false;
    if (isInvalidSessionApiError(error)) return false;

    const attempt = Number(cfg?.__arynikBackendRetryAttempt || 0);
    if (attempt >= BACKEND_RETRY_DELAYS_MS.length) return false;

    if (!error?.response) return true;
    const status = Number(error?.response?.status || 0);
    return BACKEND_RETRY_TRANSIENT_STATUSES.has(status);
};

const requestEndpointPathFromUrl = (rawUrl) => {
    const raw = String(rawUrl || '').trim();
    if (!raw) return '';
    const parsed = toAbsoluteUrlSafe(raw);
    if (!parsed) return '';
    let path = String(parsed.pathname || '').trim();
    const search = String(parsed.search || '').trim();
    if (!path.startsWith('/')) path = `/${path}`;
    const lower = path.toLowerCase();
    if (lower === '/api') path = '/';
    else if (lower.startsWith('/api/')) path = path.slice(4) || '/';
    return `${path}${search}`;
};

const requestBaseFromUrl = (rawUrl) => {
    const parsed = toAbsoluteUrlSafe(rawUrl);
    if (!parsed) return '';
    const p = String(parsed.pathname || '').trim().toLowerCase();
    if (p === '/api') return `${parsed.protocol}//${parsed.host}/api`;
    return `${parsed.protocol}//${parsed.host}`;
};

const rebaseRequestUrl = (rawUrl, targetBaseUrl) => {
    const endpoint = requestEndpointPathFromUrl(rawUrl);
    const base = pickUsableApiUrl(canonicalizePreferredApiUrl(targetBaseUrl));
    if (!endpoint || !base) return '';
    return `${base}${endpoint}`;
};

const failoverCandidatesForConfig = async (cfg, { timeout = 9000 } = {}) => {
    const out = [];
    const add = (raw) => {
        for (const candidate of expandApiBaseVariants(raw)) {
            const picked = pickUsableApiUrl(canonicalizePreferredApiUrl(candidate));
            if (!picked) continue;
            if (!isPlausibleBackendCandidate(picked)) continue;
            if (!out.includes(picked)) out.push(picked);
        }
    };

    const cfgUrl = String(cfg?.url || '').trim();
    const currentBase = requestBaseFromUrl(cfgUrl);
    if (currentBase) add(currentBase);

    try {
        const detected = await autoDetectApiUrl({ persist: true, timeout });
        if (detected?.ok && detected?.apiUrl) add(detected.apiUrl);
    } catch { }

    (buildApiCandidates() || []).forEach((c) => add(c));
    return out;
};

const decodeJwtPayloadSafe = (token) => {
    try {
        const part = String(token || '').split('.')[1];
        if (!part) return null;
        const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => (`%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`)).join(''));
        return JSON.parse(jsonPayload);
    } catch {
        return null;
    }
};

const hashString = (value) => {
    const s = String(value || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }
    return `h${Math.abs(h)}`;
};

const authScopeForConfig = (config) => {
    const auth = String(config?.headers?.Authorization || config?.headers?.authorization || '').trim();
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!token) return 'anon';
    const payload = decodeJwtPayloadSafe(token) || {};
    const sub = String(payload?.sub || '').trim();
    const did = String(payload?.driver_id || '').trim();
    const role = String(payload?.role || '').trim();
    return hashString([sub, did, role].filter(Boolean).join('|') || token.slice(0, 24));
};

const stableParamsString = (params) => {
    if (!params || typeof params !== 'object') return '';
    const out = [];
    const keys = Object.keys(params).sort((a, b) => a.localeCompare(b));
    keys.forEach((k) => {
        const v = params[k];
        if (v === undefined || v === null || v === '') return;
        if (Array.isArray(v)) {
            v.forEach((item) => out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`));
            return;
        }
        out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    });
    return out.join('&');
};

const offlineCacheKeyFromConfig = (config) => {
    const method = String(config?.method || '').trim().toLowerCase();
    if (method !== 'get') return '';
    if (config?.offlineCache === false) return '';
    const url = String(config?.url || '').trim();
    if (!url) return '';
    const params = stableParamsString(config?.params);
    const scoped = authScopeForConfig(config);
    return `${OFFLINE_CACHE_PREFIX}${scoped}|${url}${params ? `?${params}` : ''}`;
};

const writeOfflineCache = async (cacheKey, response) => {
    const key = String(cacheKey || '').trim();
    if (!key) return;
    try {
        await idbSet(key, {
            ts: Date.now(),
            status: Number(response?.status || 200),
            data: response?.data ?? null,
        });
    } catch { }
};

const readOfflineCache = async (cacheKey) => {
    const key = String(cacheKey || '').trim();
    if (!key) return null;
    try {
        const entry = await idbGet(key);
        if (!entry || typeof entry !== 'object') return null;
        const ts = Number(entry?.ts || 0);
        if (!Number.isFinite(ts) || ts <= 0) return null;
        if ((Date.now() - ts) > OFFLINE_CACHE_MAX_AGE_MS) {
            await idbDel(key).catch(() => { });
            return null;
        }
        return entry;
    } catch {
        return null;
    }
};

const shouldFallbackToOfflineCache = (error) => {
    if (DISABLE_LOCAL_FALLBACK) return false;
    if (!error) return true;
    if (isInvalidSessionApiError(error)) return false;
    if (!error.response) return true;
    const status = Number(error?.response?.status || 0);
    return status >= 500 || status === 405;
};

let lastAuthInvalidAt = 0;

const emitAuthInvalid = (error) => {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - lastAuthInvalidAt < 1500) return;

    const url = String(error?.config?.url || '').toLowerCase();
    if (url.endsWith('/login') || url.includes('/login?')) return;
    if (!isInvalidSessionApiError(error)) return;

    lastAuthInvalidAt = now;
    safeLocalStorageRemove('token');
    notifyDataSource('api', 'auth_invalid');
    try {
        window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT, {
            detail: {
                status: Number(error?.response?.status || 0),
                message: String(error?.response?.data?.detail || 'Session invalid')
            }
        }));
    } catch { }
};

axios.interceptors.response.use(
    async (response) => {
        const cacheKey = offlineCacheKeyFromConfig(response?.config);
        if (cacheKey) {
            await writeOfflineCache(cacheKey, response);
        }
        return response;
    },
    async (error) => {
        emitAuthInvalid(error);

        const cfg = error?.config || {};
        const skipFailover = Boolean(cfg?.__arynikSkipFailover);
        if (shouldRetryBackendRequest(error)) {
            const attempt = Number(cfg?.__arynikBackendRetryAttempt || 0);
            const delay = BACKEND_RETRY_DELAYS_MS[Math.min(attempt, BACKEND_RETRY_DELAYS_MS.length - 1)] || 1200;
            const nextCfg = {
                ...cfg,
                __arynikBackendRetryAttempt: attempt + 1,
                timeout: Math.max(Number(cfg?.timeout || 0), 10000) + 6000,
            };
            try {
                await waitMs(delay);
                return await axios.request(nextCfg);
            } catch (retryError) {
                // Continue with normal fallback chain (offline cache / error propagation).
                error = retryError;
            }
        }

        const finalCfg = error?.config || cfg;
        if (!skipFailover && isBackendRequestConfig(finalCfg) && isRecoverableApiError(error)) {
            const currentBase = sanitizeBaseUrl(requestBaseFromUrl(finalCfg?.url));
            const tried = new Set();
            if (currentBase) tried.add(currentBase);
            const alreadyTried = Array.isArray(finalCfg?.__arynikFailoverTriedBases)
                ? finalCfg.__arynikFailoverTriedBases.map((x) => sanitizeBaseUrl(x)).filter(Boolean)
                : [];
            alreadyTried.forEach((b) => tried.add(b));

            try {
                const candidates = await failoverCandidatesForConfig(finalCfg, { timeout: 9000 });
                for (const candidateBase of candidates) {
                    const key = sanitizeBaseUrl(candidateBase);
                    if (!key || tried.has(key)) continue;
                    const rebasedUrl = rebaseRequestUrl(finalCfg?.url, candidateBase);
                    if (!rebasedUrl) continue;
                    try {
                        const response = await axios.request({
                            ...finalCfg,
                            url: rebasedUrl,
                            __arynikSkipFailover: true,
                            __arynikFailoverTriedBases: [...Array.from(tried), key],
                            timeout: Math.max(Number(finalCfg?.timeout || 0), 10000),
                        });
                        safeLocalStorageSet(WORKING_API_URL_KEY, key);
                        safeLocalStorageSet(API_URL_KEY, key);
                        setDataSource('api', 'failover');
                        return response;
                    } catch (failoverErr) {
                        if (!isRecoverableApiError(failoverErr)) throw failoverErr;
                        tried.add(key);
                        error = failoverErr;
                    }
                }
            } catch {
                // Continue with offline cache/error propagation.
            }
        }

        const cacheKey = offlineCacheKeyFromConfig(finalCfg);
        if (cacheKey && shouldFallbackToOfflineCache(error)) {
            const cached = await readOfflineCache(cacheKey);
            if (cached && Object.prototype.hasOwnProperty.call(cached, 'data')) {
                notifyDataSource('snapshot', 'offline_cache');
                setDataSource('snapshot', 'offline_cache');
                return {
                    data: cached.data,
                    status: 200,
                    statusText: 'OK (offline cache)',
                    headers: { 'x-arynik-offline-cache': '1' },
                    config: finalCfg,
                    request: error?.request,
                };
            }
        }

        if (!error?.response && /network error|failed to fetch|network request failed/i.test(String(error?.message || ''))) {
            error.message = 'Conexiunea cu serverul este indisponibila momentan. Verifica internetul sau backend-ul si incearca din nou.';
        }
        return Promise.reject(error);
    }
);

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
    const variants = expandApiBaseVariants(value);
    for (const variant of variants) {
        const v = sanitizeBaseUrl(variant);
        if (!v) continue;
        if (/^http:\/\//i.test(v) && !canUseHttpApi()) continue;
        if (!arr.includes(v)) arr.push(v);
    }
};

const buildApiCandidates = () => {
    const out = [];
    const mandatory = [];
    const pushMandatory = (value) => {
        const v = sanitizeBaseUrl(value);
        if (!v || mandatory.includes(v)) return;
        mandatory.push(v);
    };
    pushMandatory(DEFAULT_PUBLIC_BACKEND_URL);
    pushMandatory(DEFAULT_API_URL);
    for (const c of splitApiCandidates(EXTRA_API_CANDIDATES)) pushMandatory(c);
    if (typeof window !== 'undefined') {
        const appHost = String(window.location.hostname || '').trim().toLowerCase();
        const isAnuntaHost = appHost === 'anunta.eu' || appHost.endsWith('.anunta.eu');
        if (isAnuntaHost) {
            pushMandatory('https://arynik-backend.onrender.com');
        }
    }

    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        pushUnique(out, params.get('api'));
    }
    for (const c of mandatory) pushUnique(out, c);
    if (typeof window !== 'undefined') {
        pushUnique(out, safeLocalStorageGet(WORKING_API_URL_KEY));
        pushUnique(out, safeLocalStorageGet(API_URL_KEY));
    }

    if (typeof window !== 'undefined') {
        const origin = sanitizeBaseUrl(window.location.origin);
        pushUnique(out, origin);
        if (isLocalHost(window.location.hostname)) {
            pushUnique(out, `${origin}/api`);
            pushUnique(out, 'http://localhost:8000');
        }
    }

    return out;
};

const pickUsableApiUrl = (value) => {
    const api = sanitizeBaseUrl(value);
    if (!api) return '';
    if (!isAllowedArynikApiHost(api)) return '';
    if (getApiUrlIssue(api)) return '';
    if (/^http:\/\//i.test(api) && !canUseHttpApi()) return '';
    return api;
};

const canonicalizePreferredApiUrl = (value) => {
    const api = sanitizeBaseUrl(value);
    if (!api) return '';
    try {
        const parsed = new URL(api);
        const path = String(parsed.pathname || '').trim().toLowerCase().replace(/\/+$/, '');
        if (path === '/api') {
            const host = String(parsed.hostname || '').trim().toLowerCase();
            // Keep /api only for localhost/dev.
            const keepApiPath = isLocalHost(host);
            if (!keepApiPath) return `${parsed.protocol}//${parsed.host}`;
        }
    } catch {
        return api;
    }
    return api;
};

const isPlausibleBackendCandidate = (value) => {
    const api = sanitizeBaseUrl(value);
    if (!api) return false;
    const parsed = toAbsoluteUrlSafe(api);
    if (!parsed) return false;

    const host = String(parsed.hostname || '').trim().toLowerCase();
    const path = String(parsed.pathname || '').trim().toLowerCase();
    if (!host) return false;
    if (isLocalHost(host) || host.endsWith('.onrender.com')) return true;

    if (typeof window !== 'undefined') {
        const appHost = String(window.location.hostname || '').trim().toLowerCase();
        if (host && appHost && host !== appHost) return true;
        if (path === '/api' || path.startsWith('/api/')) return true;
    }

    return false;
};

const notifyDataSource = (source, reason) => {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent('arynik:data-source', { detail: { source, reason } }));
    } catch { }
};

const setDataSource = (source, reason = '') => {
    if (typeof window === 'undefined') return;
    let s = String(source || '').trim() || 'api';
    let r = String(reason || '').trim();
    if (FORCE_BACKEND_ONLINE && s.toLowerCase() === 'snapshot') {
        s = 'api';
        r = 'backend_forced_online';
    }
    safeLocalStorageSet(DATA_SOURCE_KEY, s);
    safeLocalStorageSet(DATA_SOURCE_REASON_KEY, r);
    notifyDataSource(s, r);
};

const forceDataSourceApiIfNeeded = () => {
    if (!FORCE_BACKEND_ONLINE || typeof window === 'undefined') return;
    const current = String(safeLocalStorageGet(DATA_SOURCE_KEY) || '').trim().toLowerCase();
    if (current === 'snapshot') {
        safeLocalStorageSet(DATA_SOURCE_KEY, 'api');
        safeLocalStorageSet(DATA_SOURCE_REASON_KEY, 'backend_forced_online');
    }
};

export const getDataSource = () => {
    forceDataSourceApiIfNeeded();
    if (FORCE_BACKEND_ONLINE) return 'api';
    return safeLocalStorageGet(DATA_SOURCE_KEY) || 'api';
};

export const getDataSourceReason = () => {
    forceDataSourceApiIfNeeded();
    if (FORCE_BACKEND_ONLINE) {
        return safeLocalStorageGet(DATA_SOURCE_REASON_KEY) || 'backend_forced_online';
    }
    return safeLocalStorageGet(DATA_SOURCE_REASON_KEY) || '';
};
export const clearOfflineApiCache = async () => {
    try {
        const all = await idbKeys();
        const targets = (Array.isArray(all) ? all : []).filter((k) => String(k || '').startsWith(OFFLINE_CACHE_PREFIX));
        await Promise.all(targets.map((k) => idbDel(k)));
        return targets.length;
    } catch {
        return 0;
    }
};

export const getApiUrl = () => {
    if (typeof window === 'undefined') {
        return pickUsableApiUrl(DEFAULT_API_URL) || pickUsableApiUrl(DEFAULT_PUBLIC_BACKEND_URL) || sanitizeBaseUrl(DEFAULT_API_URL);
    }

    const params = new URLSearchParams(window.location.search);
    const fromQuery = pickUsableApiUrl(canonicalizePreferredApiUrl(params.get('api')));
    const fromStorage = safeLocalStorageGet(API_URL_KEY);
    const fromWorking = safeLocalStorageGet(WORKING_API_URL_KEY);

    if (fromQuery) return fromQuery;

    // Prefer the last known-good URL to avoid getting stuck on a stale manual value.
    const workingUrl = pickUsableApiUrl(canonicalizePreferredApiUrl(fromWorking));
    if (workingUrl) return workingUrl;
    if (fromWorking) safeLocalStorageRemove(WORKING_API_URL_KEY);

    const storageUrl = pickUsableApiUrl(canonicalizePreferredApiUrl(fromStorage));
    if (storageUrl) return storageUrl;
    if (fromStorage) safeLocalStorageRemove(API_URL_KEY);

    const envDefault = sanitizeBaseUrl(DEFAULT_API_URL);
    if (envDefault) {
        const isLocalDefault = /(^https?:\/\/localhost)|(^https?:\/\/127\.0\.0\.1)|(^https?:\/\/\[?::1\]?)/i.test(envDefault);
        if (!(isLocalDefault && !isLocalHost(window.location.hostname))) {
            if (!/^http:\/\//i.test(envDefault) || canUseHttpApi()) {
                const usable = pickUsableApiUrl(envDefault);
                if (usable) return usable;
            }
        }
    }

    const publicFallback = pickUsableApiUrl(DEFAULT_PUBLIC_BACKEND_URL);
    if (publicFallback) return publicFallback;

    if (isLocalHost(window.location.hostname)) return 'http://localhost:8000';
    return '';
};

export const setApiUrl = (value) => {
    const v = sanitizeBaseUrl(canonicalizePreferredApiUrl(value));
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
                __arynikSkipFailover: true,
            });
            if (Number(response?.status) !== 200) continue;
            const payload = response?.data;
            const looksLikeApi = payload && typeof payload === 'object'
                && (Object.prototype.hasOwnProperty.call(payload, 'ok')
                    || Object.prototype.hasOwnProperty.call(payload, 'postis_configured'));
            if (!looksLikeApi) continue;
            const canonicalBase = canonicalizePreferredApiUrl(baseUrl);
            if (persist) {
                safeLocalStorageSet(API_URL_KEY, canonicalBase);
                safeLocalStorageSet(WORKING_API_URL_KEY, canonicalBase);
            }
            return { ok: true, apiUrl: canonicalBase, issue: '' };
        } catch {
            continue;
        }
    }
    return {
        ok: false,
        apiUrl: '',
        issue: 'No reachable backend API detected. Backend-ul este indisponibil sau API URL este invalid.',
    };
}

const resolveApiUrlOrThrow = async ({ timeout = 12000 } = {}) => {
    let apiUrl = getApiUrl();
    if (apiUrl) return apiUrl;

    const detected = await autoDetectApiUrl({ persist: true, timeout });
    if (detected?.ok && detected?.apiUrl) return sanitizeBaseUrl(detected.apiUrl);

    const publicFallback = pickUsableApiUrl(DEFAULT_PUBLIC_BACKEND_URL);
    if (publicFallback && isPlausibleBackendCandidate(publicFallback)) return publicFallback;

    if (typeof window !== 'undefined') {
        const sameHostApi = pickUsableApiUrl(`${sanitizeBaseUrl(window.location.origin)}/api`);
        if (sameHostApi) return sameHostApi;
    }

    if (typeof window !== 'undefined' && isLocalHost(window.location.hostname)) {
        const localFallback = pickUsableApiUrl('http://localhost:8000');
        if (localFallback) return localFallback;
    }

    throw new Error(detected?.issue || 'Backend indisponibil. Verifica API URL in Settings.');
};

const apiRequestWithFallback = async (requestFactory, { timeout = 12000 } = {}) => {
    const requestOn = async (baseUrl) => {
        const response = await requestFactory(baseUrl);
        safeLocalStorageSet(WORKING_API_URL_KEY, baseUrl);
        safeLocalStorageSet(API_URL_KEY, baseUrl);
        setDataSource('api', 'live');
        return response;
    };

    const primaryApiUrl = await resolveApiUrlOrThrow({ timeout });
    try {
        return await requestOn(primaryApiUrl);
    } catch (error) {
        if (!isRecoverableApiError(error)) throw error;
        let lastError = error;
        const tried = new Set([sanitizeBaseUrl(primaryApiUrl)]);

        let detectedUrl = '';
        try {
            const detected = await autoDetectApiUrl({ persist: true, timeout });
            detectedUrl = sanitizeBaseUrl(detected?.apiUrl);
        } catch {
            detectedUrl = '';
        }

        const fallbackCandidates = [];
        const pushFallbackCandidate = (rawUrl) => {
            for (const candidate of expandApiBaseVariants(rawUrl)) {
                const picked = pickUsableApiUrl(candidate);
                if (!picked) continue;
                if (!isPlausibleBackendCandidate(picked)) continue;
                const key = sanitizeBaseUrl(picked);
                if (!key || tried.has(key) || fallbackCandidates.includes(picked)) continue;
                fallbackCandidates.push(picked);
            }
        };

        pushFallbackCandidate(detectedUrl);
        (buildApiCandidates() || []).forEach((raw) => pushFallbackCandidate(raw));

        for (const fallbackApiUrl of fallbackCandidates) {
            tried.add(sanitizeBaseUrl(fallbackApiUrl));
            try {
                return await requestOn(fallbackApiUrl);
            } catch (candidateError) {
                if (!isRecoverableApiError(candidateError)) throw candidateError;
                lastError = candidateError;
            }
        }

        throw lastError;
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

export async function login(username, password) {
    if (isDemoMode) {
        return demoLogin(username, password);
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

    const isValidLoginPayload = (payload) => (
        Boolean(payload)
        && typeof payload === 'object'
        && typeof payload.access_token === 'string'
        && payload.access_token.trim().length > 0
    );

    const invalidLoginPayloadError = (baseUrl) => {
        const err = new Error(`Invalid login response payload from ${baseUrl}`);
        // Treat as recoverable: this usually means API URL points to a frontend/static host.
        err.__arynikRecoverable = true;
        return err;
    };

    const shouldRetryLoginAttempt = (error) => {
        if (!error) return true;
        if (error?.__arynikRecoverable) return true;
        if (isInvalidSessionApiError(error)) return false;
        if (!error?.response) return true;
        const status = Number(error?.response?.status || 0);
        return status === 429 || status >= 500;
    };

    const doLogin = async (baseUrl, { attempts = 3 } = {}) => {
        let lastError = null;
        for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt += 1) {
            try {
                // Warm up cold backends (Render) without failing the login flow.
                if (attempt === 0) {
                    await axios.get(`${baseUrl}/health`, {
                        timeout: Math.max(10000, apiTimeoutMs(baseUrl, { forHealth: true })),
                        validateStatus: () => true,
                    }).catch(() => null);
                }

                const response = await axios.post(`${baseUrl}/login`, params, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: Math.max(12000, apiTimeoutMs(baseUrl) + 8000)
                });
                if (!isValidLoginPayload(response?.data)) {
                    throw invalidLoginPayloadError(baseUrl);
                }
                safeLocalStorageSet(WORKING_API_URL_KEY, baseUrl);
                safeLocalStorageSet(API_URL_KEY, baseUrl);
                setDataSource('api', 'login');
                return response.data;
            } catch (error) {
                lastError = error;
                if (!shouldRetryLoginAttempt(error) || attempt >= (attempts - 1)) {
                    throw error;
                }
                await waitMs([900, 1800, 3200][Math.min(attempt, 2)] || 1800);
            }
        }
        throw lastError || new Error(`Login failed for ${baseUrl}`);
    };

    const tried = new Set();
    const attemptLogins = async (rawCandidates = []) => {
        for (const raw of rawCandidates) {
            const api = pickUsableApiUrl(canonicalizePreferredApiUrl(raw));
            const key = sanitizeBaseUrl(api);
            if (!api || !key || tried.has(key)) continue;
            tried.add(key);
            try {
                const attempts = isRenderApiUrl(api) ? 4 : 3;
                return await doLogin(api, { attempts });
            } catch (error) {
                if (!isRecoverableApiError(error) && !error?.__arynikRecoverable) throw error;
            }
        }
        return null;
    };

    const firstPass = await attemptLogins([
        getApiUrl(),
        safeLocalStorageGet(WORKING_API_URL_KEY),
        safeLocalStorageGet(API_URL_KEY),
    ]);
    if (firstPass) return firstPass;

    try {
        const detected = await autoDetectApiUrl({ persist: true, timeout: 20000 });
        const detectedLogin = await attemptLogins([detected?.apiUrl]);
        if (detectedLogin) return detectedLogin;
    } catch (error) {
        if (!isRecoverableApiError(error) && !error?.__arynikRecoverable) {
            throw error;
        }
    }

    const finalPass = await attemptLogins(buildApiCandidates() || []);
    if (finalPass) return finalPass;

    setDataSource('api', 'login_failed');
    throw new Error('Backend login unavailable. Backend-ul este indisponibil momentan. Reincearca in cateva secunde.');
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

export async function syncMyDevicePhone(token, { phone_number, source = undefined } = {}) {
    if (isDemoMode) {
        return demoSyncMyDevicePhone({ phone_number, source });
    }

    const phone = String(phone_number || '').trim();
    if (!phone) throw new Error('phone_number is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/me/device-phone`, {
            phone_number: phone,
            source: source ? String(source) : undefined,
        }, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
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

export async function listWarehouses(token) {
    if (isDemoMode) {
        return demoListWarehouses();
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/warehouses`, {
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function listStores(token, { warehouse_id = null } = {}) {
    if (isDemoMode) {
        return demoListStores({ warehouse_id });
    }

    const params = {};
    if (warehouse_id != null && warehouse_id !== '') params.warehouse_id = warehouse_id;

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/stores`, {
            params,
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function createWarehouse(token, payload = {}) {
    if (isDemoMode) {
        return demoCreateWarehouse(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/warehouses`, payload || {}, {
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

export async function updateWarehouse(token, warehouseId, patch = {}) {
    if (isDemoMode) {
        return demoUpdateWarehouse(warehouseId, patch);
    }

    const id = Number(warehouseId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('warehouse_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/warehouses/${encodeURIComponent(String(id))}`, patch || {}, {
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

export async function createStore(token, payload = {}) {
    if (isDemoMode) {
        return demoCreateStore(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/stores`, payload || {}, {
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

export async function listCarriers(token, { include_inactive = false } = {}) {
    if (isDemoMode) {
        return demoListCarriers({ include_inactive });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/carriers`, {
            params: { include_inactive: Boolean(include_inactive) },
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );

    return response.data;
}

export async function recommendCarrier(token, payload = {}) {
    if (isDemoMode) {
        return demoRecommendCarriers(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/carriers/recommendation`, payload || {}, {
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

export async function updateStore(token, storeId, patch = {}) {
    if (isDemoMode) {
        return demoUpdateStore(storeId, patch);
    }

    const id = Number(storeId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('store_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/stores/${encodeURIComponent(String(id))}`, patch || {}, {
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

export async function seedFlancoStoreAccounts(token, { reset_passwords = true } = {}) {
    if (isDemoMode) {
        return demoSeedFlancoStoreAccounts({ reset_passwords });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/users/seed-flanco-store-accounts`, null, {
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

export async function deleteUser(token, driverId) {
    if (isDemoMode) {
        return demoDeleteUser(driverId);
    }

    const identifier = String(driverId || '').trim();
    if (!identifier) throw new Error('driver_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.delete(`${API_URL}/users/${encodeURIComponent(identifier)}`, {
            headers: authHeaders(token),
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

export async function listFleetVehicles(token, { include_inactive = false, sync_from_drivers = false } = {}) {
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

export async function listFleetPhones(token, { include_inactive = false } = {}) {
    if (isDemoMode) {
        return [];
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/phones`, {
            params: {
                include_inactive: include_inactive ? 1 : undefined,
            },
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetPhone(token, payload) {
    if (isDemoMode) {
        return { id: `demo-phone-${Date.now()}`, ...(payload || {}) };
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/phones`, payload || {}, {
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

export async function updateFleetPhone(token, phoneId, patch) {
    if (isDemoMode) {
        return { id: phoneId, ...(patch || {}) };
    }
    const identifier = Number(phoneId);
    if (!Number.isFinite(identifier) || identifier <= 0) throw new Error('phone_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.patch(`${API_URL}/fleet/phones/${encodeURIComponent(String(identifier))}`, patch || {}, {
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

export async function listFleetActiveAssignments(token, { driver_id, vehicle_id, phone_id, limit = 100 } = {}) {
    if (isDemoMode) {
        return [];
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/fleet/assignments/active`, {
            params: {
                driver_id: driver_id || undefined,
                vehicle_id: vehicle_id || undefined,
                phone_id: phone_id || undefined,
                limit: limit || undefined,
            },
            headers: authHeaders(token),
            timeout: 12000
        }),
        { timeout: 12000 }
    );
    return response.data;
}

export async function createFleetAssignment(token, payload) {
    if (isDemoMode) {
        return { id: `demo-assignment-${Date.now()}`, ...(payload || {}) };
    }
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/fleet/assignments`, payload || {}, {
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

export async function createManualRoutePlan(token, payload) {
    if (isDemoMode) return null;
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/manual`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json',
            },
            timeout: 30000
        }),
        { timeout: 30000 }
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

export async function deleteRoutePlan(token, planId) {
    if (isDemoMode) {
        return {
            deleted_plan_id: Number(planId) || 0,
            deleted_plan_status: 'Draft',
            deleted_plan_date: null,
            deleted_county: null,
            deleted_awbs: [],
            reset_assignment_count: 0,
            replanned_summary: null,
        };
    }
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.delete(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}`, {
            headers: authHeaders(token),
            timeout: 30000
        }),
        { timeout: 30000 }
    );
    return response.data;
}

export async function assignRoutePlan(token, planId, vehiclePlate, { driver_id = null, helper_name = null } = {}) {
    if (isDemoMode) return null;
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const plate = String(vehiclePlate || '').trim().toUpperCase() || null;
    const driverId = String(driver_id || '').trim().toUpperCase() || null;
    const helperName = String(helper_name || '').trim() || null;
    if (!plate && !driverId) throw new Error('vehicle_plate or driver_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}/assign`, {
            vehicle_plate: plate,
            driver_id: driverId,
            helper_name: helperName,
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

export async function issueRouteAviz(token, planId) {
    if (isDemoMode) return null;
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}/avize`, null, {
            headers: authHeaders(token),
            timeout: 25000
        }),
        { timeout: 25000 }
    );
    return response.data;
}

export async function listRouteAvize(token, planId, { limit = 100 } = {}) {
    if (isDemoMode) return [];
    const id = Number(planId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('plan_id is required');
    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/routes/plans/${encodeURIComponent(String(id))}/avize`, {
            params: { limit: Number(limit) || 100 },
            headers: authHeaders(token),
            timeout: 15000
        }),
        { timeout: 15000 }
    );
    return response.data;
}

export async function getRouteAvizPdf(token, avizId, { download = false } = {}) {
    if (isDemoMode) {
        throw new Error('Aviz PDF is unavailable in demo mode.');
    }
    const id = Number(avizId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('aviz_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/avize/${encodeURIComponent(String(id))}/pdf`, {
            params: { download: download ? 1 : 0 },
            headers: authHeaders(token),
            responseType: 'blob',
            timeout: 60000
        }),
        { timeout: 60000 }
    );
    const filename = filenameFromDisposition(response?.headers?.['content-disposition'], `aviz_${id}.pdf`);
    return {
        blob: response.data,
        filename,
    };
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
    try {
        const response = await apiRequestWithFallback(
            (API_URL) => {
                const reqTimeout = Math.max(apiTimeoutMs(API_URL) + 25000, 35000);
                return axios.get(`${API_URL}/shipments`, {
                    headers: authHeaders(token),
                    timeout: reqTimeout
                });
            },
            { timeout: 35000 }
        );
        setDataSource('api', 'shipments');
        return response.data;
    } catch (error) {
        if (isInvalidSessionApiError(error)) {
            setDataSource('api', 'shipments');
            throw error;
        }
        setDataSource('api', 'backend_required_shipments');
        throw error;
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
        if (isInvalidSessionApiError(error)) {
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
        if (isInvalidSessionApiError(error) || !isRecoverableApiError(error)) throw error;
    }

    setDataSource('api', 'backend_required_shipment');
    throw new Error('Backend indisponibil. Verifica conexiunea la server si API URL backend din Settings, apoi reincearca.');
}

export async function geocodeShipmentsBatch(token, awbs, { refresh_missing = true } = {}) {
    if (isDemoMode) {
        const normalized = normalizeAwbList(awbs);
        return {
            total: normalized.length,
            found: 0,
            refreshed: false,
            refresh_stats: null,
            points: normalized.map((awb) => ({ awb, lat: null, lon: null, source: null })),
        };
    }

    const normalizedAwbs = normalizeAwbList(awbs).slice(0, 400);
    if (normalizedAwbs.length === 0) {
        return { total: 0, found: 0, refreshed: false, refresh_stats: null, points: [] };
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/maps/geocode-shipments`, {
            awbs: normalizedAwbs,
            refresh_missing: Boolean(refresh_missing),
        }, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 90000
        }),
        { timeout: 90000 }
    );
    return response.data;
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

export async function createManualShipment(token, payload = {}) {
    if (isDemoMode) {
        return demoCreateManualShipment(payload);
    }

    const awb = String(payload?.awb || '').trim().toUpperCase();
    const recipient_name = String(payload?.recipient_name || '').trim();
    const delivery_address = String(payload?.delivery_address || '').trim();
    const locality = String(payload?.locality || '').trim();
    if (!awb) throw new Error('awb is required');
    if (!recipient_name) throw new Error('recipient_name is required');
    if (!delivery_address) throw new Error('delivery_address is required');
    if (!locality) throw new Error('locality is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/shipments/manual`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 12000
    });
    return response.data;
}

export async function confirmShipmentReturn(token, awb, payload = {}) {
    if (isDemoMode) {
        return demoConfirmShipmentReturn(awb, payload);
    }

    const identifier = String(awb || '').trim().toUpperCase();
    if (!identifier) throw new Error('awb is required');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/shipments/${encodeURIComponent(identifier)}/confirm-return`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 12000
    });
    return response.data;
}

export async function getNotifications(token, { limit = 50, unread_only = false, scope = 'mine' } = {}) {
    if (isDemoMode) {
        return demoGetNotifications({ limit, unread_only, scope });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/notifications`, {
        params: { limit, unread_only, scope: String(scope || 'mine') },
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

export async function createAdminNote(token, { text, status } = {}) {
    if (isDemoMode) {
        return demoCreateAdminNote({ text, status });
    }

    const content = String(text || '').trim();
    if (!content) throw new Error('text is required');
    const noteStatus = String(status || '').trim() || 'In Progress';

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/admin/notes`, { text: content, status: noteStatus }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function updateAdminNote(token, noteId, { status } = {}) {
    if (isDemoMode) {
        return demoUpdateAdminNote(noteId, { status });
    }

    const id = Number(noteId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('note_id is required');
    const nextStatus = String(status || '').trim();
    if (!nextStatus) throw new Error('status is required');

    const API_URL = getApiUrl();
    const response = await axios.patch(`${API_URL}/admin/notes/${encodeURIComponent(String(id))}`, { status: nextStatus }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });
    return response.data;
}

export async function getProviderSecretsStatus(token) {
    if (isDemoMode) {
        return demoGetProviderSecretsStatus();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/admin/provider-secrets`, {
        headers: authHeaders(token),
        timeout: 10000
    });
    return response.data;
}

export async function updateProviderSecrets(token, payload = {}) {
    if (isDemoMode) {
        return demoUpdateProviderSecrets(payload);
    }

    const body = {
        openai_api_key: payload?.openai_api_key,
        elevenlabs_api_key: payload?.elevenlabs_api_key,
        persist_to_env: payload?.persist_to_env !== false,
    };

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/admin/provider-secrets`, body, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 12000
    });
    return response.data;
}

export async function getMapsProviderConfig(token) {
    if (isDemoMode) {
        return demoGetMapsProviderConfig();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/admin/maps-provider-config`, {
        headers: authHeaders(token),
        timeout: 12000
    });
    return response.data;
}

export async function updateMapsProviderConfig(token, payload = {}) {
    if (isDemoMode) {
        return demoUpdateMapsProviderConfig(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/admin/maps-provider-config`, payload || {}, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 12000
    });
    return response.data;
}

export async function topupMapsProviderCredit(token, payload = {}) {
    if (isDemoMode) {
        return demoTopupMapsProviderCredit(payload);
    }

    const amount = Number(payload?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than 0');

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/admin/maps-provider-credit`, {
        amount,
        note: payload?.note ? String(payload.note) : undefined,
    }, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 12000
    });
    return response.data;
}

export async function updateLocation(token, payload) {
    if (isDemoMode) {
        return demoUpdateLocation(payload);
    }

    if (isNativeAndroid()) {
        try {
            const API_URL = await resolveApiUrlOrThrow({ timeout: 12000 });
            const headers = {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            };
            const response = await CapacitorHttp.post({
                url: `${API_URL}/update-location`,
                headers,
                data: payload || {},
                connectTimeout: 10000,
                readTimeout: 10000,
            });
            const status = Number(response?.status || 0);
            if (status >= 200 && status < 300) {
                safeLocalStorageSet(WORKING_API_URL_KEY, API_URL);
                safeLocalStorageSet(API_URL_KEY, API_URL);
                setDataSource('api', 'native_http');
                return response.data;
            }
            throw new Error(`Native HTTP update-location failed with status ${status || 'unknown'}`);
        } catch (nativeErr) {
            console.warn('Native HTTP location update failed, fallback to axios', nativeErr);
        }
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/update-location`, payload, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 8000
        }),
        { timeout: 8000 }
    );
    return response.data;
}

export async function createTrackingRequest(token, payload) {
    if (isDemoMode) {
        return demoCreateTrackingRequest(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/tracking/requests`, payload, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 9000
        }),
        { timeout: 9000 }
    );
    return response.data;
}

export async function listTrackingInbox(token, { limit = 20 } = {}) {
    if (isDemoMode) {
        return demoListTrackingInbox({ limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/tracking/requests/inbox`, {
            params: { limit },
            headers: authHeaders(token),
            timeout: 8000
        }),
        { timeout: 8000 }
    );
    return response.data;
}

export async function listTrackingActive(token, { limit = 10 } = {}) {
    if (isDemoMode) {
        return demoListTrackingActive({ limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/tracking/requests/active`, {
            params: { limit },
            headers: authHeaders(token),
            timeout: 8000
        }),
        { timeout: 8000 }
    );
    return response.data;
}

export async function getTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoGetTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}`, {
            headers: authHeaders(token),
            timeout: 8000
        }),
        { timeout: 8000 }
    );
    return response.data;
}

export async function getTrackingLatest(token, requestId) {
    if (isDemoMode) {
        return demoGetTrackingLatest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/latest`, {
            headers: authHeaders(token),
            timeout: 8000
        }),
        { timeout: 8000 }
    );
    return response.data;
}

export async function acceptTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoAcceptTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/accept`, null, {
            headers: authHeaders(token),
            timeout: 9000
        }),
        { timeout: 9000 }
    );
    return response.data;
}

export async function denyTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoDenyTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/deny`, null, {
            headers: authHeaders(token),
            timeout: 9000
        }),
        { timeout: 9000 }
    );
    return response.data;
}

export async function stopTrackingRequest(token, requestId) {
    if (isDemoMode) {
        return demoStopTrackingRequest(requestId);
    }

    const id = Number(requestId);
    if (!Number.isFinite(id)) throw new Error('request_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/tracking/requests/${encodeURIComponent(String(id))}/stop`, null, {
            headers: authHeaders(token),
            timeout: 9000
        }),
        { timeout: 9000 }
    );
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

export async function askVirtualAssistant(token, payload = {}) {
    if (isDemoMode) {
        return demoAskVirtualAssistant(payload);
    }

    const question = String(payload?.question || '').trim();
    if (!question) throw new Error('question is required');

    const body = {
        question,
        awb: payload?.awb ? String(payload.awb).trim().toUpperCase() : undefined,
        thread_id: Number.isFinite(Number(payload?.thread_id)) ? Number(payload.thread_id) : undefined,
        context: (payload?.context && typeof payload.context === 'object') ? payload.context : undefined,
    };

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/assistant/ask`, body, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 20000
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

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/manifests`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function listManifests(token, { limit = 50 } = {}) {
    if (isDemoMode) {
        return demoListManifests({ limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/manifests`, {
            params: { limit },
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function getManifest(token, manifestId) {
    if (isDemoMode) {
        return demoGetManifest(manifestId);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/manifests/${encodeURIComponent(String(id))}`, {
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function scanManifest(token, manifestId, payload) {
    if (isDemoMode) {
        return demoScanManifest(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/scan`, payload, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function importManifestAwbs(token, manifestId, payload = {}) {
    if (isDemoMode) {
        return demoImportManifestAwbs(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const file = payload?.file ?? null;
    const googleSheetUrl = String(payload?.google_sheet_url || '').trim();
    if (!file && !googleSheetUrl) throw new Error('Provide a file upload or Google Sheet URL.');

    const formData = new FormData();
    if (file) formData.append('file', file);
    if (googleSheetUrl) formData.append('google_sheet_url', googleSheetUrl);

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/import-awbs`, formData, {
            headers: authHeaders(token),
            timeout: 180000
        }),
        { timeout: 180000 }
    );
    return response.data;
}

export async function closeManifest(token, manifestId, payload) {
    if (isDemoMode) {
        return demoCloseManifest(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/close`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function approveManifestUnload(token, manifestId, payload = {}) {
    if (isDemoMode) {
        return demoApproveManifestUnload(manifestId, payload);
    }

    const id = Number(manifestId);
    if (!Number.isFinite(id)) throw new Error('manifest_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/manifests/${encodeURIComponent(String(id))}/approve-unload`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 180000
        }),
        { timeout: 180000 }
    );
    return response.data;
}

// [NEW] Route runs
export async function startRouteRun(token, payload) {
    if (isDemoMode) {
        return demoStartRouteRun(payload);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/start`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function listActiveRouteRuns(token, { limit = 50 } = {}) {
    if (isDemoMode) {
        return demoListActiveRouteRuns({ limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/route-runs/active`, {
            params: { limit },
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function getRouteRun(token, runId) {
    if (isDemoMode) {
        return demoGetRouteRun(runId);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/route-runs/${encodeURIComponent(String(id))}`, {
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
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

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/arrive`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function routeRunDepart(token, runId, awb, payload) {
    if (isDemoMode) {
        return demoRouteRunDepart(runId, awb, payload);
    }
    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');
    const key = String(awb || '').trim().toUpperCase();
    if (!key) throw new Error('awb is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/depart`, payload || {}, {
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

export async function routeRunComplete(token, runId, awb, payload) {
    if (isDemoMode) {
        return demoRouteRunComplete(runId, awb, payload);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');
    const key = String(awb || '').trim().toUpperCase();
    if (!key) throw new Error('awb is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/complete`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
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

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/stops/${encodeURIComponent(key)}/skip`, payload || {}, {
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

export async function finishRouteRun(token, runId) {
    if (isDemoMode) {
        return demoFinishRouteRun(runId);
    }

    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('run_id is required');

    const response = await apiRequestWithFallback(
        (API_URL) => axios.post(`${API_URL}/route-runs/${encodeURIComponent(String(id))}/finish`, null, {
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

// [NEW] Live ops
export async function getLiveDrivers(token, { limit = 100, only_drivers = true, trail_points = 8, trail_minutes = 120 } = {}) {
    if (isDemoMode) {
        return demoGetLiveDrivers({ limit });
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/live/drivers`, {
            params: { limit, only_drivers, trail_points, trail_minutes },
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}

// [NEW] COD reconciliation
export async function getCodReport(token, params = {}) {
    if (isDemoMode) {
        return demoGetCodReport(params);
    }

    const response = await apiRequestWithFallback(
        (API_URL) => axios.get(`${API_URL}/cod/report`, {
            params: params || {},
            headers: authHeaders(token),
            timeout: 20000
        }),
        { timeout: 20000 }
    );
    return response.data;
}
