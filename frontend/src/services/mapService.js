import axios from 'axios';

const OSRM_API_URL = 'https://router.project-osrm.org/route/v1/driving';

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
