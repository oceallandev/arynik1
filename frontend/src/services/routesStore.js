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
const todayIsoDate = () => new Date().toISOString().slice(0, 10);

const makeId = () => {
    try {
        return crypto.randomUUID();
    } catch {
        return `route-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }
};

const normalizeAwb = (awb) => String(awb || '').trim().toUpperCase();
const normalizeDriverId = (value) => {
    const id = String(value || '').trim().toUpperCase();
    return id || null;
};
const normalizeVehiclePlate = (value) => {
    const plate = String(value || '').trim().toUpperCase();
    return plate || null;
};
const normalizePersonName = (value) => {
    const name = String(value || '').trim();
    return name || null;
};

const stripDiacritics = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    } catch {
        return String(value || '');
    }
};

const normalizeCountyKey = (value) => (
    stripDiacritics(String(value || ''))
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
);

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

export const MOLDOVA_COUNTIES = [
    { name: 'Bacau', code: 'BC', aliases: ['bacau', 'bacău', 'bc'] },
    { name: 'Iasi', code: 'IS', aliases: ['iasi', 'iași', 'is'] },
    { name: 'Neamt', code: 'NT', aliases: ['neamt', 'neamț', 'nt'] },
    { name: 'Galati', code: 'GL', aliases: ['galati', 'galați', 'gl'] },
    { name: 'Botosani', code: 'BT', aliases: ['botosani', 'botoșani', 'bt'] },
    { name: 'Suceava', code: 'SV', aliases: ['suceava', 'sv'] },
    { name: 'Vaslui', code: 'VS', aliases: ['vaslui', 'vs'] },
];

export const inferShipmentCounty = (shipment) => {
    const raw =
        shipment?.county
        || shipment?.raw_data?.recipientLocation?.county
        || shipment?.raw_data?.recipientLocation?.countyName
        || shipment?.raw_data?.recipientLocation?.region
        || shipment?.raw_data?.recipientLocation?.regionName
        || shipment?.raw_data?.county
        || shipment?.raw_data?.countyName;

    const normalized = normalizeCountyKey(raw);
    if (!normalized) return null;

    for (const c of MOLDOVA_COUNTIES) {
        const aliases = Array.isArray(c.aliases) ? c.aliases : [];
        for (const a of aliases) {
            const key = normalizeCountyKey(a);
            if (!key) continue;
            if (normalized === key) return c.name;
            if (normalized.includes(` ${key} `)) return c.name;
            if (normalized.startsWith(`${key} `)) return c.name;
            if (normalized.endsWith(` ${key}`)) return c.name;
            if (normalized.includes(key)) return c.name;
        }
        if (normalizeCountyKey(c.name) === normalized) return c.name;
    }

    return null;
};

export const isDeliverableShipment = (shipment) => {
    const status = stripDiacritics(String(shipment?.status || '')).trim().toLowerCase();
    if (!status) return true; // unknown, treat as active

    if (status.includes('delivered') || status.includes('livrat')) return false;
    if (status.includes('return') || status.includes('returnat') || status.includes('returnata')) return false;
    if (status.includes('anulat') || status.includes('anulata') || status.includes('cancel')) return false;
    if (status.includes('refuz')) return false;
    return true;
};

export const listRoutes = () => (
    loadRoutes()
        .filter(Boolean)
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
);

export const getRoute = (routeId) => (
    loadRoutes().find((r) => r && r.id === routeId) || null
);

export const createRoute = ({ name, driver_id, driver_name, helper_name, vehicle_plate, date, county, kind, region } = {}) => {
    const routes = loadRoutes();
    const route = {
        id: makeId(),
        name: String(name || '').trim() || 'New Route',
        driver_id: normalizeDriverId(driver_id),
        driver_name: normalizePersonName(driver_name),
        vehicle_plate: normalizeVehiclePlate(vehicle_plate),
        helper_name: normalizePersonName(helper_name),
        date: date ? String(date) : todayIsoDate(),
        kind: kind ? String(kind) : undefined,
        region: region ? String(region) : undefined,
        county: county ? String(county) : undefined,
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
    const nextDriverId = Object.prototype.hasOwnProperty.call(patch, 'driver_id')
        ? normalizeDriverId(patch.driver_id)
        : (prev.driver_id ?? null);
    const nextVehiclePlate = Object.prototype.hasOwnProperty.call(patch, 'vehicle_plate')
        ? normalizeVehiclePlate(patch.vehicle_plate)
        : prev.vehicle_plate ?? null;
    const nextDriverName = Object.prototype.hasOwnProperty.call(patch, 'driver_name')
        ? normalizePersonName(patch.driver_name)
        : (prev.driver_name ?? null);
    const nextHelperName = Object.prototype.hasOwnProperty.call(patch, 'helper_name')
        ? normalizePersonName(patch.helper_name)
        : (prev.helper_name ?? null);
    const next = {
        ...prev,
        ...patch,
        id: prev.id,
        driver_id: nextDriverId,
        vehicle_plate: nextVehiclePlate,
        driver_name: nextDriverName,
        helper_name: nextHelperName,
        updated_at: nowIso()
    };

    routes[idx] = next;
    saveRoutes(routes);
    return next;
};

export const routeCrewLabel = (route) => {
    const plate = normalizeVehiclePlate(route?.vehicle_plate);
    const driver = normalizePersonName(route?.driver_name) || String(route?.driver_id || '').trim() || null;
    const helper = normalizePersonName(route?.helper_name);

    const parts = [];
    if (plate) parts.push(plate);
    if (driver) parts.push(driver);
    let label = parts.join(' - ');
    if (helper) label = label ? `${label} + ${helper}` : helper;
    return label || '';
};

export const routeDisplayName = (route) => {
    const crew = routeCrewLabel(route);
    if (crew) return crew;

    const fallback = String(route?.name || route?.county || '').trim();
    return fallback || 'Route';
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

export const listRoutesForDate = (date) => {
    const d = String(date || '').trim() || todayIsoDate();
    return listRoutes().filter((r) => String(r?.date || '') === d);
};

export const listMoldovaCountyRoutesForDate = (date) => {
    const d = String(date || '').trim() || todayIsoDate();
    const keySet = new Set(MOLDOVA_COUNTIES.map((c) => normalizeCountyKey(c.name)));

    return listRoutes()
        .filter((r) => String(r?.date || '') === d)
        .filter((r) => String(r?.kind || '').toLowerCase() === 'county' || String(r?.region || '').toLowerCase() === 'moldova')
        .filter((r) => {
            const key = normalizeCountyKey(r?.county || r?.name);
            return key && keySet.has(key);
        })
        .sort((a, b) => normalizeCountyKey(a?.county || a?.name).localeCompare(normalizeCountyKey(b?.county || b?.name)));
};

export const moveAwbToRoute = (routeId, awb, { scopeDate = true } = {}) => {
    const normalized = normalizeAwb(awb);
    if (!normalized) return null;

    const routes = loadRoutes();
    const idx = routes.findIndex((r) => r && r.id === routeId);
    if (idx === -1) return null;

    const target = routes[idx];
    const targetDate = String(target?.date || '');
    const targetAwbs = Array.isArray(target?.awbs) ? target.awbs : [];

    let changed = false;

    // Remove from other routes (same date by default) to keep a single allocation.
    for (let i = 0; i < routes.length; i += 1) {
        const r = routes[i];
        if (!r || !Array.isArray(r.awbs) || r.awbs.length === 0) continue;
        if (i === idx) continue;
        if (scopeDate && targetDate && String(r.date || '') !== targetDate) continue;
        if (!r.awbs.includes(normalized)) continue;
        routes[i] = { ...r, awbs: r.awbs.filter((x) => x !== normalized), updated_at: nowIso() };
        changed = true;
    }

    if (!targetAwbs.includes(normalized)) {
        routes[idx] = { ...target, awbs: [...targetAwbs, normalized], updated_at: nowIso() };
        changed = true;
    }

    if (!changed) return routes[idx];
    saveRoutes(routes);
    return routes[idx];
};

export const generateDailyMoldovaCountyRoutes = ({ date, shipments, driver_id } = {}) => {
    const targetDate = String(date || '').trim() || todayIsoDate();
    const list = Array.isArray(shipments) ? shipments : [];

    const routes = loadRoutes();
    const countyKeys = new Map(MOLDOVA_COUNTIES.map((c) => [normalizeCountyKey(c.name), c]));
    const existingByCountyKey = new Map();

    for (const r of routes) {
        if (!r) continue;
        if (String(r.date || '') !== targetDate) continue;
        const key = normalizeCountyKey(r.county || r.name);
        if (key && countyKeys.has(key)) {
            existingByCountyKey.set(key, r);
        }
    }

    let createdRoutes = 0;
    const ensuredRoutes = [];

    for (const c of MOLDOVA_COUNTIES) {
        const key = normalizeCountyKey(c.name);
        let r = existingByCountyKey.get(key);
        if (!r) {
            // Carry over last known vehicle plate/driver for this county if available.
            const prev = routes.find((x) => (
                x
                && normalizeCountyKey(x.county || x.name) === key
                && (x.vehicle_plate || x.driver_id)
            ));

            r = {
                id: makeId(),
                name: c.name,
                driver_id: normalizeDriverId(prev?.driver_id || driver_id),
                driver_name: prev?.driver_name || null,
                vehicle_plate: normalizeVehiclePlate(prev?.vehicle_plate) || null,
                helper_name: prev?.helper_name || null,
                date: targetDate,
                kind: 'county',
                region: 'Moldova',
                county: c.name,
                awbs: [],
                created_at: nowIso(),
                updated_at: nowIso()
            };
            routes.unshift(r);
            existingByCountyKey.set(key, r);
            createdRoutes += 1;
        } else {
            // Best-effort: ensure metadata is present (do not clobber custom names).
            let changed = false;
            if (String(r.kind || '').toLowerCase() !== 'county') {
                r.kind = 'county';
                changed = true;
            }
            if (String(r.region || '').toLowerCase() !== 'moldova') {
                r.region = 'Moldova';
                changed = true;
            }
            if (!r.county) {
                r.county = c.name;
                changed = true;
            }
            if (changed) r.updated_at = nowIso();
        }
        ensuredRoutes.push(r);
    }

    const assignedToday = new Set();
    for (const r of routes) {
        if (!r) continue;
        if (String(r.date || '') !== targetDate) continue;
        (Array.isArray(r.awbs) ? r.awbs : []).forEach((a) => {
            const n = normalizeAwb(a);
            if (n) assignedToday.add(n);
        });
    }

    let deliverableTotal = 0;
    let deliverableInMoldova = 0;
    let allocated = 0;
    let alreadyAssigned = 0;
    let missingCounty = 0;
    let outsideRegion = 0;

    const changedRouteIds = new Set();

    for (const s of list) {
        if (!isDeliverableShipment(s)) continue;
        deliverableTotal += 1;

        const awb = normalizeAwb(s?.awb);
        if (!awb) continue;

        const county = inferShipmentCounty(s);
        if (!county) {
            missingCounty += 1;
            continue;
        }

        const key = normalizeCountyKey(county);
        const countySpec = countyKeys.get(key);
        if (!countySpec) {
            outsideRegion += 1;
            continue;
        }

        deliverableInMoldova += 1;

        if (assignedToday.has(awb)) {
            alreadyAssigned += 1;
            continue;
        }

        const route = existingByCountyKey.get(normalizeCountyKey(countySpec.name));
        if (!route) continue;

        const existingAwbs = Array.isArray(route.awbs) ? route.awbs : [];
        if (!existingAwbs.includes(awb)) {
            route.awbs = [...existingAwbs, awb];
            route.updated_at = nowIso();
            changedRouteIds.add(route.id);
            assignedToday.add(awb);
            allocated += 1;
        }
    }

    if (createdRoutes || changedRouteIds.size > 0 || allocated) {
        saveRoutes(routes);
    }

    return {
        date: targetDate,
        created_routes: createdRoutes,
        allocated_awbs: allocated,
        deliverable_total: deliverableTotal,
        deliverable_in_moldova: deliverableInMoldova,
        already_assigned: alreadyAssigned,
        missing_county: missingCounty,
        outside_region: outsideRegion,
        routes: ensuredRoutes
    };
};
