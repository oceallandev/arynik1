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

export async function login(username, password) {
    if (isDemoMode) {
        return demoLogin(username, password);
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

    const response = await axios.post(`${API_URL}/login`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return response.data;
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

    const response = await axios.get(`${API_URL}/shipments`, {
        headers: authHeaders(token)
    });

    return response.data;
}
