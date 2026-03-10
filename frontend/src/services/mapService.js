import axios from 'axios';
import { getApiUrl } from './api';

const OSRM_API_URL = 'https://router.project-osrm.org/route/v1/driving';

const getBackendTrafficRouteMultiDetails = async (points) => {
    const list = Array.isArray(points) ? points.filter(Boolean) : [];
    if (list.length < 2) return null;

    const apiUrl = String(getApiUrl() || '').trim();
    if (!apiUrl) return null;

    let token = '';
    try {
        token = String(localStorage.getItem('token') || '').trim();
    } catch {
        token = '';
    }

    try {
        const response = await axios.post(
            `${apiUrl}/maps/route-metrics`,
            {
                points: list.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
            },
            {
                timeout: 15000,
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            }
        );
        const data = response?.data || {};
        return {
            geometry: data?.geometry || null,
            distance_m: Number.isFinite(Number(data?.distance_m)) ? Number(data.distance_m) : 0,
            duration_s: Number.isFinite(Number(data?.duration_s)) ? Number(data.duration_s) : 0,
            provider: String(data?.provider || 'google_traffic'),
        };
    } catch {
        return null;
    }
};

/**
 * Fetch a driving route between two points.
 * @param {Object} start - { lat, lon }
 * @param {Object} end - { lat, lon }
 * @returns {Promise<Object>} - OSRM route geometry
 */
export async function getRoute(start, end) {
    if (!start || !end) return null;

    try {
        const url = `${OSRM_API_URL}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`;
        const response = await axios.get(url);

        if (response.data.code === 'Ok' && response.data.routes.length > 0) {
            return response.data.routes[0].geometry;
        }
        return null;
    } catch (error) {
        console.error('Error fetching route:', error);
        return null; // Fail silently or handle error upstream
    }
}

/**
 * Fetch a driving route across multiple waypoints (in order), including distance/duration.
 * @param {Array} points - [{ lat, lon }, ...] (2+ points)
 * @returns {Promise<{geometry:Object, distance_m:number, duration_s:number} | null>}
 */
export async function getRouteMultiDetails(points) {
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
 * @returns {Promise<Object|null>} - OSRM route geometry
 */
export async function getRouteMulti(points) {
    const details = await getRouteMultiDetails(points);
    return details?.geometry || null;
}
