import axios from 'axios';
import {
    demoGetLogs,
    demoGetShipments,
    demoGetStats,
    demoGetStatusOptions,
    demoLogin,
    demoUpdateAwb
} from './demoApi';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

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

    return 'D001';
};

export async function login(username, password) {
    if (isDemoMode) {
        return demoLogin(username, password);
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

    try {
        const response = await axios.post(`${API_URL}/login`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
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

export async function getStats(token) {
    if (isDemoMode) {
        return demoGetStats();
    }

    const response = await axios.get(`${API_URL}/stats`, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getStatusOptions(token) {
    if (isDemoMode) {
        return demoGetStatusOptions();
    }

    const response = await axios.get(`${API_URL}/status-options`, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function updateAwb(token, payload) {
    if (isDemoMode) {
        return demoUpdateAwb(payload);
    }

    const response = await axios.post(`${API_URL}/update-awb`, payload, {
        headers: authHeaders(token)
    });

    return response.data;
}

export async function getLogs(token, params = {}) {
    if (isDemoMode) {
        return demoGetLogs(params);
    }

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
