import axios from 'axios';
import { autoDetectApiUrl, getApiUrl } from './api';

const OSRM_API_URL = 'https://router.project-osrm.org/route/v1/driving';
const FORCE_GOOGLE_TRAFFIC = !['0', 'false', 'no', 'off'].includes(
    String(import.meta.env.VITE_FORCE_GOOGLE_TRAFFIC ?? '1').trim().toLowerCase()
);
const GOOGLE_TRAFFIC_TIMEOUT_MS = Math.max(7000, Number(import.meta.env.VITE_GOOGLE_TRAFFIC_TIMEOUT_MS || 15000));
const GOOGLE_TRAFFIC_RETRIES = Math.max(1, Number(import.meta.env.VITE_GOOGLE_TRAFFIC_RETRIES || 2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRouteMetricsPayload = (data) => ({
    geometry: data?.geometry || null,
    distance_m: Number.isFinite(Number(data?.distance_m)) ? Number(data.distance_m) : 0,
    duration_s: Number.isFinite(Number(data?.duration_s)) ? Number(data.duration_s) : 0,
    duration_no_traffic_s: Number.isFinite(Number(data?.duration_no_traffic_s)) ? Number(data.duration_no_traffic_s) : 0,
    delay_s: Number.isFinite(Number(data?.delay_s)) ? Number(data.delay_s) : 0,
    provider: String(data?.provider || 'google_traffic'),
});

const parseRouteOptimizePayload = (data) => {
    const orderRaw = Array.isArray(data?.optimized_order) ? data.optimized_order : [];
    const optimized_order = orderRaw
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 0);
    return {
        ...parseRouteMetricsPayload(data),
        optimized_order,
    };
};

const readToken = () => {
    try {
        return String(localStorage.getItem('token') || '').trim();
    } catch {
        return '';
    }
};

const requestBackendTrafficRouteMultiDetails = async (apiUrl, list, token) => {
    const response = await axios.post(
        `${apiUrl}/maps/route-metrics`,
        {
            points: list.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
        },
        {
            timeout: GOOGLE_TRAFFIC_TIMEOUT_MS,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
    );
    return parseRouteMetricsPayload(response?.data || {});
};

const requestBackendRouteOptimization = async (apiUrl, origin, stops, { returnToOrigin = true } = {}, token) => {
    const response = await axios.post(
        `${apiUrl}/maps/route-optimize`,
        {
            origin: { lat: Number(origin?.lat), lon: Number(origin?.lon) },
            stops: (Array.isArray(stops) ? stops : []).map((p) => ({ lat: Number(p?.lat), lon: Number(p?.lon) })),
            return_to_origin: Boolean(returnToOrigin),
        },
        {
            timeout: GOOGLE_TRAFFIC_TIMEOUT_MS,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
    );
    return parseRouteOptimizePayload(response?.data || {});
};

const getBackendTrafficRouteMultiDetails = async (points) => {
    const list = Array.isArray(points) ? points.filter(Boolean) : [];
    if (list.length < 2) return null;

    const candidates = [];
    const initialUrl = String(getApiUrl() || '').trim();
    if (initialUrl) candidates.push(initialUrl);
    try {
        const detected = await autoDetectApiUrl({ persist: true, timeout: GOOGLE_TRAFFIC_TIMEOUT_MS });
        const detectedUrl = String(detected?.apiUrl || '').trim();
        if (detected?.ok && detectedUrl && !candidates.includes(detectedUrl)) candidates.push(detectedUrl);
    } catch {
        // Continue with current URL only.
    }
    if (candidates.length === 0) return null;

    const token = readToken();
    let lastError = null;

    for (const apiUrl of candidates) {
        for (let attempt = 1; attempt <= GOOGLE_TRAFFIC_RETRIES; attempt += 1) {
            try {
                return await requestBackendTrafficRouteMultiDetails(apiUrl, list, token);
            } catch (error) {
                lastError = error;
                const status = Number(error?.response?.status || 0);
                const retryable = !status || status >= 500 || status === 429;
                if (!retryable || attempt >= GOOGLE_TRAFFIC_RETRIES) break;
                await sleep(180 * attempt);
            }
        }
    }

    if (lastError) {
        console.warn('Google traffic route metrics unavailable', lastError);
    }
    return null;
};

/**
 * Fetch a driving route between two points (Google traffic-first).
 * @param {Object} start - { lat, lon }
 * @param {Object} end - { lat, lon }
 * @returns {Promise<Object>} - GeoJSON LineString geometry
 */
export async function getRoute(start, end) {
    if (!start || !end) return null;

    const trafficDetails = await getRouteMultiDetails([start, end], { requireGoogleTraffic: true });
    if (trafficDetails?.geometry) return trafficDetails.geometry;
    return null;
}

/**
 * Fetch a driving route across multiple waypoints (in order), including distance/duration.
 * @param {Array} points - [{ lat, lon }, ...] (2+ points)
 * @param {Object} options
 * @param {boolean} options.requireGoogleTraffic - when true, do not fallback to non-traffic providers
 * @returns {Promise<{geometry:Object, distance_m:number, duration_s:number} | null>}
 */
export async function getRouteMultiDetails(points, { requireGoogleTraffic = FORCE_GOOGLE_TRAFFIC } = {}) {
    const list = Array.isArray(points) ? points.filter(Boolean) : [];
    if (list.length < 2) return null;

    const trafficAware = await getBackendTrafficRouteMultiDetails(list);
    if (trafficAware) return trafficAware;

    const coords = list
        .map((p) => `${p.lon},${p.lat}`)
        .join(';');

    try {
        const url = `${OSRM_API_URL}/${coords}?overview=full&geometries=geojson&steps=false`;
        const response = await axios.get(url);

        if (response.data.code === 'Ok' && response.data.routes.length > 0) {
            const r = response.data.routes[0] || {};
            return {
                geometry: r.geometry || null,
                distance_m: Number.isFinite(Number(r.distance)) ? Number(r.distance) : 0,
                duration_s: Number.isFinite(Number(r.duration)) ? Number(r.duration) : 0,
                duration_no_traffic_s: 0,
                delay_s: 0,
                provider: 'osrm'
            };
        }
        return null;
    } catch (error) {
        console.error('Error fetching multi-route:', error);
        return null;
    }
}

/**
 * Fetch a driving route across multiple waypoints (in order).
 * @param {Array} points - [{ lat, lon }, ...] (2+ points)
 * @param {Object} options
 * @returns {Promise<Object|null>} - OSRM route geometry
 */
export async function getRouteMulti(points, options = {}) {
    const details = await getRouteMultiDetails(points, options);
    return details?.geometry || null;
}

/**
 * Optimize stop order with backend Google Directions (optimize:true).
 * Falls back to null when unavailable.
 * @param {Object} origin - { lat, lon }
 * @param {Array} stops - [{ lat, lon }, ...]
 * @param {Object} options
 * @returns {Promise<{optimized_order:number[], geometry:Object|null, distance_m:number, duration_s:number, duration_no_traffic_s:number, delay_s:number, provider:string} | null>}
 */
export async function optimizeStopsOrder(origin, stops, { returnToOrigin = true } = {}) {
    const stopList = Array.isArray(stops) ? stops.filter(Boolean) : [];
    if (!origin || stopList.length < 2) return null;

    const candidates = [];
    const initialUrl = String(getApiUrl() || '').trim();
    if (initialUrl) candidates.push(initialUrl);
    try {
        const detected = await autoDetectApiUrl({ persist: true, timeout: GOOGLE_TRAFFIC_TIMEOUT_MS });
        const detectedUrl = String(detected?.apiUrl || '').trim();
        if (detected?.ok && detectedUrl && !candidates.includes(detectedUrl)) candidates.push(detectedUrl);
    } catch {
        // Continue with current URL only.
    }
    if (candidates.length === 0) return null;

    const token = readToken();
    let lastError = null;
    for (const apiUrl of candidates) {
        for (let attempt = 1; attempt <= GOOGLE_TRAFFIC_RETRIES; attempt += 1) {
            try {
                return await requestBackendRouteOptimization(
                    apiUrl,
                    origin,
                    stopList,
                    { returnToOrigin },
                    token
                );
            } catch (error) {
                lastError = error;
                const status = Number(error?.response?.status || 0);
                const retryable = !status || status >= 500 || status === 429;
                if (!retryable || attempt >= GOOGLE_TRAFFIC_RETRIES) break;
                await sleep(180 * attempt);
            }
        }
    }

    if (lastError) {
        console.warn('Google route optimization unavailable', lastError);
    }
    return null;
}
