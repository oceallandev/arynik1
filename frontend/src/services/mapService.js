import axios from 'axios';

const OSRM_API_URL = 'https://router.project-osrm.org/route/v1/driving';
const GOOGLE_DIRECTIONS_API_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const GOOGLE_MAPS_API_KEY = String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
const GOOGLE_MAX_POINTS = 25; // origin + destination + up to 23 waypoints

const decodePolyline = (encoded) => {
    const out = [];
    if (!encoded || typeof encoded !== 'string') return out;

    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let b;
        let shift = 0;
        let result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
        lat += dLat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
        lng += dLng;

        out.push([lng / 1e5, lat / 1e5]); // GeoJSON [lon, lat]
    }
    return out;
};

const getGoogleRouteMultiDetails = async (points) => {
    const list = Array.isArray(points) ? points.filter(Boolean) : [];
    if (!GOOGLE_MAPS_API_KEY || list.length < 2 || list.length > GOOGLE_MAX_POINTS) return null;

    const origin = `${list[0].lat},${list[0].lon}`;
    const destination = `${list[list.length - 1].lat},${list[list.length - 1].lon}`;
    const waypointsList = list.slice(1, -1).map((p) => `${p.lat},${p.lon}`).filter(Boolean);

    const params = {
        key: GOOGLE_MAPS_API_KEY,
        origin,
        destination,
        mode: 'driving',
        departure_time: 'now',
        traffic_model: 'best_guess',
    };
    if (waypointsList.length > 0) params.waypoints = waypointsList.join('|');

    try {
        const response = await axios.get(GOOGLE_DIRECTIONS_API_URL, { params, timeout: 15000 });
        const route = response?.data?.routes?.[0];
        if (!route) return null;

        const geometryPoints = decodePolyline(route?.overview_polyline?.points || '');
        const legs = Array.isArray(route?.legs) ? route.legs : [];

        const distance_m = legs.reduce((sum, leg) => {
            const v = Number(leg?.distance?.value);
            return sum + (Number.isFinite(v) ? v : 0);
        }, 0);
        const duration_s = legs.reduce((sum, leg) => {
            const traffic = Number(leg?.duration_in_traffic?.value);
            const normal = Number(leg?.duration?.value);
            return sum + (Number.isFinite(traffic) ? traffic : (Number.isFinite(normal) ? normal : 0));
        }, 0);

        return {
            geometry: geometryPoints.length > 1 ? { type: 'LineString', coordinates: geometryPoints } : null,
            distance_m: Number.isFinite(distance_m) ? distance_m : 0,
            duration_s: Number.isFinite(duration_s) ? duration_s : 0,
            provider: 'google_traffic',
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

    const google = await getGoogleRouteMultiDetails(list);
    if (google) return google;

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
