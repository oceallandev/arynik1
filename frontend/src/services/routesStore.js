const ROUTES_KEY = 'arynik_routes_v1';

const safeGet = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const safeSet = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch { }
};

const nowIso = () => new Date().toISOString();

const makeId = () => {
    try {
        return crypto.randomUUID();
    } catch {
        return `route-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }
};

const normalizeAwb = (awb) => String(awb || '').trim().toUpperCase();
const normalizeVehiclePlate = (value) => {
    const plate = String(value || '').trim().toUpperCase();
    return plate || null;
};

const loadRoutes = () => {
    const raw = safeGet(ROUTES_KEY);
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch { }

    return [];
};

const saveRoutes = (routes) => {
    const list = Array.isArray(routes) ? routes : [];
    safeSet(ROUTES_KEY, JSON.stringify(list));
    return list;
};

export const listRoutes = () => (
    loadRoutes()
        .filter(Boolean)
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
);

export const getRoute = (routeId) => (
    loadRoutes().find((r) => r && r.id === routeId) || null
);

export const createRoute = ({ name, driver_id, vehicle_plate, date } = {}) => {
    const routes = loadRoutes();
    const route = {
        id: makeId(),
        name: String(name || '').trim() || 'New Route',
        driver_id: driver_id ? String(driver_id) : null,
        vehicle_plate: normalizeVehiclePlate(vehicle_plate),
        date: date ? String(date) : new Date().toISOString().slice(0, 10),
        awbs: [],
        created_at: nowIso(),
        updated_at: nowIso()
    };

    routes.unshift(route);
    saveRoutes(routes);
    return route;
};

export const updateRoute = (routeId, patch = {}) => {
    const routes = loadRoutes();
    const idx = routes.findIndex((r) => r && r.id === routeId);
    if (idx === -1) return null;

    const prev = routes[idx] || {};
    const nextVehiclePlate = Object.prototype.hasOwnProperty.call(patch, 'vehicle_plate')
        ? normalizeVehiclePlate(patch.vehicle_plate)
        : prev.vehicle_plate ?? null;
    const next = {
        ...prev,
        ...patch,
        id: prev.id,
        vehicle_plate: nextVehiclePlate,
        updated_at: nowIso()
    };

    routes[idx] = next;
    saveRoutes(routes);
    return next;
};

export const deleteRoute = (routeId) => {
    const routes = loadRoutes().filter((r) => r && r.id !== routeId);
    saveRoutes(routes);
    return true;
};

export const addAwbToRoute = (routeId, awb) => {
    const normalized = normalizeAwb(awb);
    if (!normalized) return null;

    const route = getRoute(routeId);
    if (!route) return null;

    const existing = Array.isArray(route.awbs) ? route.awbs : [];
    if (existing.includes(normalized)) return route;

    return updateRoute(routeId, { awbs: [...existing, normalized] });
};

export const removeAwbFromRoute = (routeId, awb) => {
    const normalized = normalizeAwb(awb);
    const route = getRoute(routeId);
    if (!route) return null;

    const existing = Array.isArray(route.awbs) ? route.awbs : [];
    return updateRoute(routeId, { awbs: existing.filter((x) => x !== normalized) });
};

export const setRouteAwbOrder = (routeId, awbs) => {
    const route = getRoute(routeId);
    if (!route) return null;

    const next = (Array.isArray(awbs) ? awbs : [])
        .map(normalizeAwb)
        .filter(Boolean);

    return updateRoute(routeId, { awbs: next });
};

export const findRouteForAwb = (awb) => {
    const normalized = normalizeAwb(awb);
    if (!normalized) return null;

    const routes = loadRoutes();
    const found = routes.find((r) => Array.isArray(r?.awbs) && r.awbs.includes(normalized));
    return found || null;
};
