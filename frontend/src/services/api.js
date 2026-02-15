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
    demoLogin,
    demoUpdateAwb,
    demoRecipientSignup,
    demoGetNotifications,
    demoMarkNotificationRead,
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
    demoMarkChatRead
} from './demoApi';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const API_URL_KEY = 'arynik_api_url_v1';

const sanitizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

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

export const getApiUrl = () => {
    if (typeof window === 'undefined') {
        return sanitizeBaseUrl(DEFAULT_API_URL);
    }

    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('api');
    const fromStorage = safeLocalStorageGet(API_URL_KEY);

    const candidate = fromQuery
        ? sanitizeBaseUrl(fromQuery)
        : sanitizeBaseUrl(fromStorage || DEFAULT_API_URL);

    return candidate || sanitizeBaseUrl(DEFAULT_API_URL);
};

export const setApiUrl = (value) => {
    const v = sanitizeBaseUrl(value);
    if (v) safeLocalStorageSet(API_URL_KEY, v);
    else safeLocalStorageRemove(API_URL_KEY);
};

const authHeaders = (token) => (
    token
        ? { Authorization: `Bearer ${token}` }
        : {}
);

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

    const API_URL = getApiUrl();
    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

    try {
        const response = await axios.post(`${API_URL}/login`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 3000
        });

        return response.data;
    } catch (error) {
        // If we got an HTTP response (e.g. 401), it's a real auth failure: do not bypass.
        if (error && error.response) {
            throw error;
        }

        console.warn('Login API unavailable; using snapshot/offline token.', error);

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
}

export async function recipientSignup(payload) {
    if (isDemoMode) {
        return demoRecipientSignup(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/recipient/signup`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 7000
    });

    return response.data;
}

export async function getStats(token) {
    if (isDemoMode) {
        return demoGetStats();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/stats`, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getMe(token) {
    if (isDemoMode) {
        return demoGetMe(token);
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/me`, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getAnalytics(token, { scope = 'self', awb_limit = 200 } = {}) {
    if (isDemoMode) {
        return demoGetAnalytics({ scope, awb_limit });
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/analytics`, {
        params: { scope, awb_limit },
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getRoles(token) {
    if (isDemoMode) {
        return demoGetRoles();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/roles`, {
        headers: authHeaders(token),
        timeout: 5000
    });

    return response.data;
}

export async function listUsers(token) {
    if (isDemoMode) {
        return demoListUsers();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/users`, {
        headers: authHeaders(token),
        timeout: 7000
    });

    return response.data;
}

export async function createUser(token, payload) {
    if (isDemoMode) {
        return demoCreateUser(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/users`, payload, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });

    return response.data;
}

export async function updateUser(token, driverId, patch) {
    if (isDemoMode) {
        return demoUpdateUser(driverId, patch);
    }

    const identifier = String(driverId || '').trim();
    if (!identifier) throw new Error('driver_id is required');

    const API_URL = getApiUrl();
    const response = await axios.patch(`${API_URL}/users/${encodeURIComponent(identifier)}`, patch, {
        headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json'
        },
        timeout: 7000
    });

    return response.data;
}

export async function syncDrivers(token) {
    if (isDemoMode) {
        return demoSyncDrivers();
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/sync-drivers`, null, {
        headers: authHeaders(token),
        timeout: 15000
    });

    return response.data;
}

export async function getPostisSyncStatus(token) {
    if (isDemoMode) {
        return demoGetPostisSyncStatus();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/postis/sync/status`, {
        headers: authHeaders(token),
        timeout: 15000
    });
    return response.data;
}

export async function triggerPostisSync(token, { wait = false } = {}) {
    if (isDemoMode) {
        return demoTriggerPostisSync({ wait });
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/postis/sync`, null, {
        params: { wait: wait ? 1 : undefined },
        headers: authHeaders(token),
        timeout: wait ? 10 * 60 * 1000 : 15000
    });
    return response.data;
}

export async function getStatusOptions(token) {
    if (isDemoMode) {
        return demoGetStatusOptions();
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/status-options`, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function updateAwb(token, payload) {
    if (isDemoMode) {
        return demoUpdateAwb(payload);
    }

    const API_URL = getApiUrl();
    const response = await axios.post(`${API_URL}/update-awb`, payload, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getLogs(token, params = {}) {
    if (isDemoMode) {
        return demoGetLogs(params);
    }

    const API_URL = getApiUrl();
    const response = await axios.get(`${API_URL}/logs`, {
        params,
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getShipments(token) {
    if (isDemoMode) {
        return demoGetShipments();
    }

    const API_URL = getApiUrl();
    try {
        const response = await axios.get(`${API_URL}/shipments`, {
            headers: authHeaders(token),
            timeout: 5000 // Fail fast if backend is unreachable
        });
        return response.data;
    } catch (error) {
        console.warn("Backend API unavailable, attempting to load static snapshot...", error);
        try {
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

                    // Filter for Drivers
                    if (role === 'Driver') {
                        console.info(`Offline RBAC: Filtering for Driver ${driverId}`);
                        data = data.filter(s => s.driver_id === driverId);
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
            throw error; // Throw original error or new one
        }
    }
}

export async function getShipment(token, awb, { refresh = false } = {}) {
    if (isDemoMode) {
        return demoGetShipment(awb);
    }

    const API_URL = getApiUrl();
    const identifier = String(awb || '').trim();
    if (!identifier) {
        throw new Error('awb is required');
    }

    try {
        const response = await axios.get(`${API_URL}/shipments/${encodeURIComponent(identifier)}`, {
            params: refresh ? { refresh: true } : {},
            headers: authHeaders(token),
            timeout: 7000
        });
        return response.data;
    } catch (error) {
        console.warn("Backend shipment details unavailable, attempting static snapshot...", error);
        try {
            const snapshotUrl = `${import.meta.env.BASE_URL}data/shipments.json`.replace('//', '/');
            const response = await axios.get(snapshotUrl);
            const data = Array.isArray(response.data) ? response.data : [];
            const found = data.find((s) => String(s?.awb || '').toUpperCase() === identifier.toUpperCase());
            if (found) return found;
        } catch { }
        throw error;
    }
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
        timeout: 7000
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
        timeout: 7000
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
        timeout: 7000
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
        timeout: 7000
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
        timeout: 7000
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
        timeout: 7000
    });
    return response.data;
}
