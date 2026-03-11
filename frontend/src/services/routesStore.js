import { getCachedGeocode } from './geocodeService';
import { buildGeocodeHints, buildGeocodeQuery } from './shipmentGeo';
import { getWarehouseOrigin } from './warehouse';
import { bestInsertionIndex, optimizeRoundTripOrder } from './routeOptimizer';

const ROUTES_KEY = 'arynik_routes_v1';

const isValidCoordPair = (lat, lon) => (
    Number.isFinite(Number(lat))
    && Number.isFinite(Number(lon))
    && Math.abs(Number(lat)) > 0.0001
    && Math.abs(Number(lon)) > 0.0001
);

const pickShipmentCoord = (shipment) => {
    const latRaw =
        shipment?.latitude
        ?? shipment?.raw_data?.recipientLocation?.latitude
        ?? shipment?.raw_data?.recipientLocation?.lat;
    const lonRaw =
        shipment?.longitude
        ?? shipment?.raw_data?.recipientLocation?.longitude
        ?? shipment?.raw_data?.recipientLocation?.lon
        ?? shipment?.raw_data?.recipientLocation?.lng;

    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (isValidCoordPair(lat, lon)) return { lat, lon };

    // Fallback: reuse cached geocodes (no network). This makes daily route generation smarter even when
    // Postis doesn't provide lat/lon yet.
    const query = buildGeocodeQuery(shipment);
    if (String(query || '').trim().toLowerCase() === 'romania') return null;
    const hints = buildGeocodeHints(shipment);
    const cached = getCachedGeocode(query, hints);
    if (cached && isValidCoordPair(cached.lat, cached.lon)) {
        return { lat: Number(cached.lat), lon: Number(cached.lon) };
    }

    return null;
};

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
const normalizeRole = (value) => String(value || '').trim().toLowerCase();
const isAdminRole = (value) => normalizeRole(value) === 'admin';
const isDriverRole = (value) => normalizeRole(value) === 'driver';
const normalizeVehicleTypeCode = (value) => String(value || '').trim().toUpperCase();

const VEHICLE_TYPE_PROFILES = [
    { code: 'VAN_35T', label: '3.5t Van', supports_liftgate: true, max_volume_m3: 18, target_volume_m3: 16.5, max_weight_kg: 1400, target_weight_kg: 1200 },
    { code: 'TRUCK_75T', label: '7.5t Truck', supports_liftgate: true, max_volume_m3: 36, target_volume_m3: 33, max_weight_kg: 3500, target_weight_kg: 3200 },
    { code: 'TRUCK_12T', label: '12t Truck', supports_liftgate: true, max_volume_m3: 50, target_volume_m3: 46, max_weight_kg: 7000, target_weight_kg: 6500 },
    { code: 'TIR_40T', label: 'TIR 40t', supports_liftgate: false, max_volume_m3: 90, target_volume_m3: 82, max_weight_kg: 24000, target_weight_kg: 22000 },
    { code: 'SPRINTER', label: 'Sprinter', supports_liftgate: false, max_volume_m3: 13, target_volume_m3: 11.5, max_weight_kg: 900, target_weight_kg: 800 },
    { code: 'CUSTOM', label: 'Custom', supports_liftgate: true, max_volume_m3: null, target_volume_m3: null, max_weight_kg: null, target_weight_kg: null },
];
const VEHICLE_TYPE_BY_CODE = new Map(
    VEHICLE_TYPE_PROFILES.map((x) => [normalizeVehicleTypeCode(x?.code), x]).filter((x) => x[0])
);

const DEFAULT_ROUTE_VEHICLE_CODE = 'VAN_35T';
const DEFAULT_PARCEL_WEIGHT_KG = 2.0;
const DEFAULT_PARCEL_VOLUME_M3 = 0.05;
const VOLUMETRIC_KG_PER_M3 = 250;
const ROUTE_PLANNING_USE_CAPACITY = ['1', 'true', 'yes', 'on'].includes(
    String(import.meta.env.VITE_ROUTE_PLANNING_USE_CAPACITY ?? '0').trim().toLowerCase()
);
const ROUTE_PLANNING_MAX_STOPS_PER_ROUTE = Math.max(
    1,
    Number.parseInt(String(import.meta.env.VITE_ROUTE_PLANNING_MAX_STOPS_PER_ROUTE ?? '25'), 10) || 25
);

const toPositiveNumber = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
};

const roundLoad = (value, decimals = 2) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const pow = 10 ** decimals;
    return Math.round(n * pow) / pow;
};

const resolveVehicleProfile = (code) => {
    const key = normalizeVehicleTypeCode(code);
    return VEHICLE_TYPE_BY_CODE.get(key) || null;
};

const profileCapacityDefaults = (code) => {
    const profile = resolveVehicleProfile(code) || resolveVehicleProfile(DEFAULT_ROUTE_VEHICLE_CODE);
    if (!profile) {
        return {
            max_volume_m3: null,
            target_volume_m3: null,
            max_weight_kg: null,
            target_weight_kg: null,
        };
    }
    return {
        max_volume_m3: toPositiveNumber(profile.max_volume_m3),
        target_volume_m3: toPositiveNumber(profile.target_volume_m3),
        max_weight_kg: toPositiveNumber(profile.max_weight_kg),
        target_weight_kg: toPositiveNumber(profile.target_weight_kg),
    };
};

const routeVehicleCapacity = (route) => {
    const code = normalizeVehicleTypeCode(route?.vehicle_type_code || '');
    const defaults = profileCapacityDefaults(code || DEFAULT_ROUTE_VEHICLE_CODE);

    const maxVolume = toPositiveNumber(route?.max_volume_m3) ?? defaults.max_volume_m3;
    const targetVolume = toPositiveNumber(route?.target_volume_m3) ?? defaults.target_volume_m3 ?? maxVolume;
    const maxWeight = toPositiveNumber(route?.max_weight_kg) ?? defaults.max_weight_kg;
    const targetWeight = toPositiveNumber(route?.target_weight_kg) ?? defaults.target_weight_kg ?? maxWeight;

    return {
        vehicle_type_code: code || DEFAULT_ROUTE_VEHICLE_CODE,
        vehicle_has_lift: Boolean(route?.vehicle_has_lift),
        max_volume_m3: maxVolume,
        target_volume_m3: targetVolume,
        max_weight_kg: maxWeight,
        target_weight_kg: targetWeight,
    };
};

const parseDimensionsVolumeM3 = (dimensionsRaw) => {
    const text = String(dimensionsRaw || '').trim().toLowerCase();
    if (!text) return null;
    const nums = text
        .replace(/cm/g, '')
        .replace(/,/g, '.')
        .match(/[-+]?[0-9]*\.?[0-9]+/g);
    if (!Array.isArray(nums) || nums.length < 3) return null;
    const l = Number(nums[0]);
    const w = Number(nums[1]);
    const h = Number(nums[2]);
    if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(h) || l <= 0 || w <= 0 || h <= 0) {
        return null;
    }
    return (l * w * h) / 1000000;
};

const shipmentLoad = (shipment) => {
    const weight = toPositiveNumber(shipment?.weight) ?? toPositiveNumber(shipment?.raw_data?.weight) ?? null;
    const volumetricWeight = toPositiveNumber(shipment?.volumetric_weight) ?? toPositiveNumber(shipment?.raw_data?.volumetricWeight) ?? null;
    const dimsVolume = parseDimensionsVolumeM3(shipment?.dimensions) ?? parseDimensionsVolumeM3(shipment?.raw_data?.dimensions);
    const volumeFromVolumetric = volumetricWeight ? (volumetricWeight / VOLUMETRIC_KG_PER_M3) : null;
    const volume = toPositiveNumber(dimsVolume) ?? toPositiveNumber(volumeFromVolumetric) ?? DEFAULT_PARCEL_VOLUME_M3;
    const physicalWeight = weight ?? DEFAULT_PARCEL_WEIGHT_KG;
    const effectiveWeight = Math.max(physicalWeight, volumetricWeight ?? 0, DEFAULT_PARCEL_WEIGHT_KG);

    return {
        volume_m3: roundLoad(volume, 4),
        weight_kg: roundLoad(effectiveWeight, 3),
    };
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

const extractPlaceName = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
        const v =
            value?.name
            || value?.label
            || value?.value
            || value?.countyName
            || value?.localityName
            || value?.cityName
            || value?.regionName
            || value?.county
            || value?.locality
            || value?.city
            || value?.region;
        if (v && (typeof v === 'string' || typeof v === 'number')) return String(v);
        if (v && typeof v === 'object') return extractPlaceName(v);
        return '';
    }
    return String(value);
};

const normalizeCountyKey = (value) => (
    stripDiacritics(extractPlaceName(value))
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
    { name: 'Bacau', code: 'BC', aliases: ['bacau', 'bacău', 'bc'], seed: { lat: 46.5667, lon: 26.9167 } },
    { name: 'Iasi', code: 'IS', aliases: ['iasi', 'iași', 'is'], seed: { lat: 47.1585, lon: 27.6014 } },
    { name: 'Neamt', code: 'NT', aliases: ['neamt', 'neamț', 'nt'], seed: { lat: 46.9274, lon: 26.3700 } },
    { name: 'Vrancea', code: 'VN', aliases: ['vrancea', 'vn'], seed: { lat: 45.6965, lon: 27.1843 } },
    { name: 'Botosani', code: 'BT', aliases: ['botosani', 'botoșani', 'bt'], seed: { lat: 47.7486, lon: 26.6694 } },
    { name: 'Suceava', code: 'SV', aliases: ['suceava', 'sv'], seed: { lat: 47.6514, lon: 26.2556 } },
    { name: 'Vaslui', code: 'VS', aliases: ['vaslui', 'vs'], seed: { lat: 46.6407, lon: 27.7276 } },
];

const normalizeStatusText = (value) => (
    stripDiacritics(String(value || ''))
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
);

const ROUTING_ALLOWED_STATUS_MATCHERS = [
    (txt) => txt.includes('intrare in depozit') || txt.includes('in depozitul curierului') || txt.includes('courier warehouse') || txt.includes('in depot'),
    (txt) => txt.includes('expediere preluata de curier') || txt.includes('expeditie preluata de curier') || txt.includes('expedierea a fost preluata de curier') || txt.includes('incarcat la curier'),
    (txt) => txt.includes('refuzare colet') || txt.includes('livrare refuzata') || txt.includes('refuzat') || txt.includes('refused'),
    (txt) => txt.includes('livrare reprogramata') || txt.includes('reprogramat') || txt.includes('reschedule'),
];

const ROUTING_BLOCKING_STATUS_MATCHERS = [
    (txt) => txt.includes('finalizare pregatire depozit'),
    (txt) => txt.includes('initial'),
    (txt) => txt.includes('pending'),
    (txt) => txt.includes('in asteptare'),
];

const collectStatusSignals = (shipment) => {
    const raw = shipment?.raw_data || {};
    const clientStatus = raw?.clientShipmentStatus;

    const extraValues = [];
    const push = (v) => {
        const n = normalizeStatusText(v);
        if (!n) return;
        extraValues.push(n);
    };

    push(shipment?.processing_status);
    if (typeof clientStatus === 'string') {
        push(clientStatus);
    } else if (clientStatus && typeof clientStatus === 'object') {
        push(clientStatus.clientShipmentStatusDescription);
        push(clientStatus.statusDescription);
        push(clientStatus.defaultClientStatus);
        push(clientStatus.processingStatus);
        push(clientStatus.description);
        push(clientStatus.label);
        push(clientStatus.value);
    }

    return {
        primary: normalizeStatusText(shipment?.status),
        secondary: extraValues,
    };
};

export const isRoutingEligibleShipment = (shipment) => {
    const { primary, secondary } = collectStatusSignals(shipment);
    if (!primary) return false;

    const allowedPrimary = ROUTING_ALLOWED_STATUS_MATCHERS.some((match) => {
        try { return !!match(primary); } catch { return false; }
    });
    if (!allowedPrimary) return false;

    const blockedSecondary = secondary.some((txt) => ROUTING_BLOCKING_STATUS_MATCHERS.some((match) => {
        try { return !!match(txt); } catch { return false; }
    }));
    if (blockedSecondary) return false;

    return true;
};

const countyFromText = (value) => {
    const text = normalizeCountyKey(value);
    if (!text) return null;

    const hasAlias = (source, alias) => {
        if (!source || !alias) return false;
        if (source === alias) return true;
        if (alias.length <= 2) {
            const tokens = source.split(/[^a-z0-9]+/).filter(Boolean);
            return tokens.includes(alias);
        }
        return source.includes(alias);
    };

    for (const c of MOLDOVA_COUNTIES) {
        const aliases = Array.isArray(c.aliases) ? c.aliases : [];
        const allAliases = [c.name, c.code, ...aliases];
        for (const a of allAliases) {
            const key = normalizeCountyKey(a);
            if (!key) continue;
            if (hasAlias(text, key)) return c.name;
        }
    }

    return null;
};

export const inferShipmentCounty = (shipment) => {
    const raw = shipment?.raw_data || {};
    const recipientLocation = raw?.recipientLocation || {};
    const recipientPin = raw?.recipientPin || {};
    const client = raw?.client || {};

    const candidates = [
        shipment?.county,
        recipientLocation?.county,
        recipientLocation?.countyName,
        recipientLocation?.region,
        recipientLocation?.regionName,
        recipientLocation?.district,
        recipientPin?.county,
        recipientPin?.countyName,
        recipientPin?.region,
        recipientPin?.regionName,
        recipientPin?.countyCode,
        recipientPin?.county_code,
        client?.county,
        client?.countyName,
        client?.region,
        client?.regionName,
        client?.recipientCounty,
        client?.deliveryCounty,
        client?.address?.county,
        client?.address?.countyName,
        client?.deliveryAddress?.county,
        client?.deliveryAddress?.countyName,
        raw?.county,
        raw?.countyName,
        raw?.region,
        raw?.regionName,
        shipment?.locality,
        shipment?.delivery_address,
        recipientLocation?.locality,
        recipientLocation?.localityName,
        recipientPin?.locality,
        recipientPin?.localityName,
    ];

    let fallback = null;
    for (const value of candidates) {
        const rawName = extractPlaceName(value).trim();
        if (!rawName) continue;
        const mapped = countyFromText(rawName);
        if (mapped) return mapped;
        if (!fallback) fallback = rawName;
    }

    // Keep first meaningful non-empty value for outside-region tracking.
    return fallback;
};

export const isDeliverableShipment = (shipment) => {
    return isRoutingEligibleShipment(shipment);
};

export const listRoutes = () => (
    loadRoutes()
        .filter(Boolean)
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
);

export const canUserAccessRoute = (route, user) => {
    if (!route) return false;
    if (isAdminRole(user?.role)) return true;

    const myDriverId = resolveRouteDriverIdForUser(user);
    const routeDriverId = normalizeDriverId(route?.driver_id);
    if (!myDriverId || !routeDriverId) return false;
    return myDriverId === routeDriverId;
};

export const resolveRouteDriverIdForUser = (user, fallback = null) => {
    const explicit = normalizeDriverId(user?.driver_id || fallback);
    if (explicit) return explicit;
    if (isDriverRole(user?.role)) {
        const fromUsername = normalizeDriverId(user?.username);
        if (fromUsername) return fromUsername;
    }
    return null;
};

export const listRoutesForUser = (user) => (
    listRoutes().filter((r) => canUserAccessRoute(r, user))
);

export const getRoute = (routeId) => (
    loadRoutes().find((r) => r && r.id === routeId) || null
);

export const getRouteForUser = (routeId, user) => {
    const route = getRoute(routeId);
    if (!route) return null;
    return canUserAccessRoute(route, user) ? route : null;
};

export const createRoute = ({
    name,
    driver_id,
    driver_name,
    helper_name,
    vehicle_plate,
    vehicle_type_code,
    vehicle_has_lift,
    max_volume_m3,
    target_volume_m3,
    max_weight_kg,
    target_weight_kg,
    truck_phone,
    date,
    county,
    kind,
    region
} = {}) => {
    const routes = loadRoutes();
    const typeCode = normalizeVehicleTypeCode(vehicle_type_code || '') || DEFAULT_ROUTE_VEHICLE_CODE;
    const defaults = profileCapacityDefaults(typeCode);
    const route = {
        id: makeId(),
        name: String(name || '').trim() || 'New Route',
        driver_id: normalizeDriverId(driver_id),
        driver_name: normalizePersonName(driver_name),
        vehicle_plate: normalizeVehiclePlate(vehicle_plate),
        helper_name: normalizePersonName(helper_name),
        truck_phone: String(truck_phone || '').trim() || null,
        vehicle_type_code: typeCode,
        vehicle_has_lift: Boolean(vehicle_has_lift),
        max_volume_m3: toPositiveNumber(max_volume_m3) ?? defaults.max_volume_m3,
        target_volume_m3: toPositiveNumber(target_volume_m3) ?? defaults.target_volume_m3 ?? toPositiveNumber(max_volume_m3) ?? defaults.max_volume_m3,
        max_weight_kg: toPositiveNumber(max_weight_kg) ?? defaults.max_weight_kg,
        target_weight_kg: toPositiveNumber(target_weight_kg) ?? defaults.target_weight_kg ?? toPositiveNumber(max_weight_kg) ?? defaults.max_weight_kg,
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
    const nextVehicleTypeRaw = Object.prototype.hasOwnProperty.call(patch, 'vehicle_type_code')
        ? normalizeVehicleTypeCode(patch.vehicle_type_code)
        : normalizeVehicleTypeCode(prev.vehicle_type_code);
    const nextVehicleTypeCode = nextVehicleTypeRaw || DEFAULT_ROUTE_VEHICLE_CODE;
    const defaults = profileCapacityDefaults(nextVehicleTypeCode);
    const nextVehicleHasLift = Object.prototype.hasOwnProperty.call(patch, 'vehicle_has_lift')
        ? Boolean(patch.vehicle_has_lift)
        : Boolean(prev.vehicle_has_lift);
    const nextMaxVolume = Object.prototype.hasOwnProperty.call(patch, 'max_volume_m3')
        ? toPositiveNumber(patch.max_volume_m3)
        : toPositiveNumber(prev.max_volume_m3);
    const nextTargetVolume = Object.prototype.hasOwnProperty.call(patch, 'target_volume_m3')
        ? toPositiveNumber(patch.target_volume_m3)
        : toPositiveNumber(prev.target_volume_m3);
    const nextMaxWeight = Object.prototype.hasOwnProperty.call(patch, 'max_weight_kg')
        ? toPositiveNumber(patch.max_weight_kg)
        : toPositiveNumber(prev.max_weight_kg);
    const nextTargetWeight = Object.prototype.hasOwnProperty.call(patch, 'target_weight_kg')
        ? toPositiveNumber(patch.target_weight_kg)
        : toPositiveNumber(prev.target_weight_kg);
    const nextDriverName = Object.prototype.hasOwnProperty.call(patch, 'driver_name')
        ? normalizePersonName(patch.driver_name)
        : (prev.driver_name ?? null);
    const nextHelperName = Object.prototype.hasOwnProperty.call(patch, 'helper_name')
        ? normalizePersonName(patch.helper_name)
        : (prev.helper_name ?? null);
    const nextTruckPhone = Object.prototype.hasOwnProperty.call(patch, 'truck_phone')
        ? (String(patch.truck_phone || '').trim() || null)
        : (String(prev.truck_phone || '').trim() || null);
    const next = {
        ...prev,
        ...patch,
        id: prev.id,
        driver_id: nextDriverId,
        vehicle_plate: nextVehiclePlate,
        vehicle_type_code: nextVehicleTypeCode,
        vehicle_has_lift: nextVehicleHasLift,
        max_volume_m3: nextMaxVolume ?? defaults.max_volume_m3,
        target_volume_m3: nextTargetVolume ?? defaults.target_volume_m3 ?? nextMaxVolume ?? defaults.max_volume_m3,
        max_weight_kg: nextMaxWeight ?? defaults.max_weight_kg,
        target_weight_kg: nextTargetWeight ?? defaults.target_weight_kg ?? nextMaxWeight ?? defaults.max_weight_kg,
        truck_phone: nextTruckPhone,
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

export const findRouteForAwb = (awb, user = null) => {
    const normalized = normalizeAwb(awb);
    if (!normalized) return null;

    const routes = user ? listRoutesForUser(user) : loadRoutes();
    const found = routes.find((r) => Array.isArray(r?.awbs) && r.awbs.includes(normalized));
    return found || null;
};

export const listRoutesForDate = (date) => {
    const d = String(date || '').trim() || todayIsoDate();
    return listRoutes().filter((r) => String(r?.date || '') === d);
};

export const listRoutesForDateForUser = (date, user) => (
    listRoutesForDate(date).filter((r) => canUserAccessRoute(r, user))
);

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
        .sort((a, b) => {
            const ck = normalizeCountyKey(a?.county || a?.name).localeCompare(normalizeCountyKey(b?.county || b?.name));
            if (ck !== 0) return ck;
            const ai = Number(a?.route_index);
            const bi = Number(b?.route_index);
            if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
            return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
};

export const listMoldovaCountyRoutesForDateForUser = (date, user) => (
    listMoldovaCountyRoutesForDate(date).filter((r) => canUserAccessRoute(r, user))
);

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

export const generateDailyMoldovaCountyRoutes = ({ date, shipments, driver_id, drivers } = {}) => {
    const targetDate = String(date || '').trim() || todayIsoDate();
    const list = Array.isArray(shipments) ? shipments : [];
    const driverList = Array.isArray(drivers) ? drivers : [];
    const routes = loadRoutes();

    const countyKeys = new Map(MOLDOVA_COUNTIES.map((c) => [normalizeCountyKey(c.name), c]));
    const countySeeds = new Map(
        MOLDOVA_COUNTIES
            .map((c) => [normalizeCountyKey(c.name), c?.seed])
            .filter((entry) => entry[0] && isValidCoordPair(entry[1]?.lat, entry[1]?.lon))
            .map(([key, seed]) => [key, { lat: Number(seed.lat), lon: Number(seed.lon) }])
    );

    const parseRouteIndex = (route, fallback = 1) => {
        const byField = Number(route?.route_index);
        if (Number.isFinite(byField) && byField > 0) return Math.floor(byField);
        const m = String(route?.name || '').match(/#\s*(\d+)/i);
        if (m && Number.isFinite(Number(m[1]))) return Math.max(1, Number(m[1]));
        return Math.max(1, Number(fallback) || 1);
    };

    const driverById = new Map();
    const fleetPool = [];
    for (const d of driverList) {
        const id = normalizeDriverId(d?.driver_id);
        if (!id) continue;
        driverById.set(id, d);

        const role = normalizeRole(d?.role);
        if (role !== 'driver' || d?.active === false) continue;

        const code = normalizeVehicleTypeCode(d?.vehicle_type_code) || DEFAULT_ROUTE_VEHICLE_CODE;
        const defaults = profileCapacityDefaults(code);
        fleetPool.push({
            driver_id: id,
            driver_name: normalizePersonName(d?.name) || null,
            helper_name: normalizePersonName(d?.helper_name) || null,
            vehicle_plate: normalizeVehiclePlate(d?.truck_plate) || null,
            truck_phone: String(d?.phone_number || '').trim() || null,
            vehicle_type_code: code,
            vehicle_has_lift: Boolean(d?.vehicle_has_lift),
            max_volume_m3: toPositiveNumber(d?.max_volume_m3) ?? defaults.max_volume_m3,
            target_volume_m3: toPositiveNumber(d?.target_volume_m3) ?? defaults.target_volume_m3 ?? toPositiveNumber(d?.max_volume_m3) ?? defaults.max_volume_m3,
            max_weight_kg: toPositiveNumber(d?.max_weight_kg) ?? defaults.max_weight_kg,
            target_weight_kg: toPositiveNumber(d?.target_weight_kg) ?? defaults.target_weight_kg ?? toPositiveNumber(d?.max_weight_kg) ?? defaults.max_weight_kg,
        });
    }

    const countyRoutes = new Map();
    for (const r of routes) {
        if (!r) continue;
        if (String(r.date || '') !== targetDate) continue;
        const key = normalizeCountyKey(r.county || r.name);
        if (!key || !countyKeys.has(key)) continue;
        const arr = countyRoutes.get(key) || [];
        arr.push(r);
        countyRoutes.set(key, arr);
    }

    const usedDriverIdsToday = new Set();
    for (const r of routes) {
        if (!r || String(r.date || '') !== targetDate) continue;
        const did = normalizeDriverId(r?.driver_id);
        if (did) usedDriverIdsToday.add(did);
    }

    const takeFleetDriver = (preferredId = null) => {
        const pref = normalizeDriverId(preferredId);
        if (pref) {
            const match = fleetPool.find((f) => f.driver_id === pref);
            if (match) return match;
        }
        const free = fleetPool.find((f) => !usedDriverIdsToday.has(f.driver_id));
        if (free) return free;
        return fleetPool[0] || null;
    };

    let createdRoutes = 0;
    let createdCapacityRoutes = 0;
    const ensuredRoutes = [];

    for (const c of MOLDOVA_COUNTIES) {
        const key = normalizeCountyKey(c.name);
        let countyList = countyRoutes.get(key) || [];

        if (countyList.length === 0) {
            const prev = routes.find((x) => (
                x
                && normalizeCountyKey(x.county || x.name) === key
                && (x.vehicle_plate || x.driver_id)
            ));
            const preferredDriverId = normalizeDriverId(prev?.driver_id || driver_id);
            const fleet = takeFleetDriver(preferredDriverId);
            const code = normalizeVehicleTypeCode(prev?.vehicle_type_code || fleet?.vehicle_type_code) || DEFAULT_ROUTE_VEHICLE_CODE;
            const defaults = profileCapacityDefaults(code);

            const seeded = {
                id: makeId(),
                name: c.name,
                route_index: 1,
                driver_id: normalizeDriverId(prev?.driver_id || fleet?.driver_id || driver_id),
                driver_name: normalizePersonName(prev?.driver_name || fleet?.driver_name),
                helper_name: normalizePersonName(prev?.helper_name || fleet?.helper_name),
                vehicle_plate: normalizeVehiclePlate(prev?.vehicle_plate || fleet?.vehicle_plate),
                truck_phone: String(prev?.truck_phone || fleet?.truck_phone || '').trim() || null,
                vehicle_type_code: code,
                vehicle_has_lift: Boolean(prev?.vehicle_has_lift ?? fleet?.vehicle_has_lift),
                max_volume_m3: toPositiveNumber(prev?.max_volume_m3) ?? toPositiveNumber(fleet?.max_volume_m3) ?? defaults.max_volume_m3,
                target_volume_m3: toPositiveNumber(prev?.target_volume_m3) ?? toPositiveNumber(fleet?.target_volume_m3) ?? defaults.target_volume_m3 ?? defaults.max_volume_m3,
                max_weight_kg: toPositiveNumber(prev?.max_weight_kg) ?? toPositiveNumber(fleet?.max_weight_kg) ?? defaults.max_weight_kg,
                target_weight_kg: toPositiveNumber(prev?.target_weight_kg) ?? toPositiveNumber(fleet?.target_weight_kg) ?? defaults.target_weight_kg ?? defaults.max_weight_kg,
                date: targetDate,
                kind: 'county',
                region: 'Moldova',
                county: c.name,
                awbs: [],
                created_at: nowIso(),
                updated_at: nowIso()
            };
            routes.unshift(seeded);
            countyList = [seeded];
            countyRoutes.set(key, countyList);
            createdRoutes += 1;
        }

        countyList.sort((a, b) => parseRouteIndex(a) - parseRouteIndex(b));
        countyList.forEach((r, idx) => {
            const routeIdx = parseRouteIndex(r, idx + 1);
            r.route_index = routeIdx;
            if (routeIdx === 1 && !String(r.name || '').trim()) r.name = c.name;
            if (routeIdx > 1 && (!String(r.name || '').trim() || normalizeCountyKey(r.name) === key)) {
                r.name = `${c.name} #${routeIdx}`;
            }
            if (String(r.kind || '').toLowerCase() !== 'county') r.kind = 'county';
            if (String(r.region || '').toLowerCase() !== 'moldova') r.region = 'Moldova';
            if (!r.county) r.county = c.name;
            const did = normalizeDriverId(r.driver_id);
            if (did) usedDriverIdsToday.add(did);
            ensuredRoutes.push(r);
        });
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

    const shipmentByAwb = new Map();
    const loadByAwb = new Map();
    const coordsByAwb = new Map();
    for (const s of list) {
        const awb = normalizeAwb(s?.awb);
        if (!awb) continue;
        shipmentByAwb.set(awb, s);
        loadByAwb.set(awb, shipmentLoad(s));
        const coord = pickShipmentCoord(s);
        if (coord) coordsByAwb.set(awb, coord);
    }

    const warehouse = getWarehouseOrigin();
    const origin = isValidCoordPair(warehouse?.lat, warehouse?.lon)
        ? { lat: Number(warehouse.lat), lon: Number(warehouse.lon) }
        : null;

    const routeStates = new Map();
    const statesByCounty = new Map();
    const stateAssignedStopCount = (state) => {
        const seen = new Set();
        (Array.isArray(state?.existing_awbs) ? state.existing_awbs : []).forEach((a) => {
            const n = normalizeAwb(a);
            if (n) seen.add(n);
        });
        (Array.isArray(state?.stops) ? state.stops : []).forEach((s) => {
            const n = normalizeAwb(s?.awb);
            if (n) seen.add(n);
        });
        (Array.isArray(state?.appended) ? state.appended : []).forEach((a) => {
            const n = normalizeAwb(a);
            if (n) seen.add(n);
        });
        return seen.size;
    };

    const spawnStateForRoute = (route, countyKey) => {
        const existingAwbs = (Array.isArray(route?.awbs) ? route.awbs : []).map(normalizeAwb).filter(Boolean);
        const capacity = routeVehicleCapacity(route);
        const stops = [];
        let totalVolume = 0;
        let totalWeight = 0;

        for (const awb of existingAwbs) {
            const load = loadByAwb.get(awb);
            if (load) {
                totalVolume += Number(load.volume_m3 || 0);
                totalWeight += Number(load.weight_kg || 0);
            }
            const coord = coordsByAwb.get(awb);
            if (coord) stops.push({ awb, lat: coord.lat, lon: coord.lon });
        }

        const state = {
            route,
            county_key: countyKey,
            seed: countySeeds.get(countyKey) || null,
            existing_awbs: existingAwbs,
            stops: origin ? optimizeRoundTripOrder(origin, stops) : stops,
            appended: [],
            touched: false,
            created_new: false,
            over_capacity_awbs: [],
            current_volume: roundLoad(totalVolume, 4),
            current_weight: roundLoad(totalWeight, 3),
            capacity,
        };
        routeStates.set(route.id, state);
        const arr = statesByCounty.get(countyKey) || [];
        arr.push(state);
        statesByCounty.set(countyKey, arr);
        return state;
    };

    for (const r of ensuredRoutes) {
        const key = normalizeCountyKey(r?.county || r?.name);
        if (!key || !countyKeys.has(key)) continue;
        spawnStateForRoute(r, key);
    }

    const pickStateForLoad = (states, item) => {
        if (!Array.isArray(states) || states.length === 0) return null;
        let best = null;

        for (const state of states) {
            const stopCount = stateAssignedStopCount(state);
            if (stopCount >= ROUTE_PLANNING_MAX_STOPS_PER_ROUTE) continue;

            const capVol = toPositiveNumber(state?.capacity?.target_volume_m3);
            const capKg = toPositiveNumber(state?.capacity?.target_weight_kg);

            const nextVol = Number(state.current_volume || 0) + Number(item?.load?.volume_m3 || 0);
            const nextKg = Number(state.current_weight || 0) + Number(item?.load?.weight_kg || 0);

            const fitsVol = !ROUTE_PLANNING_USE_CAPACITY || capVol == null || nextVol <= capVol + 1e-9;
            const fitsKg = !ROUTE_PLANNING_USE_CAPACITY || capKg == null || nextKg <= capKg + 1e-9;
            if (!fitsVol || !fitsKg) continue;

            const volWaste = ROUTE_PLANNING_USE_CAPACITY && capVol ? Math.max(0, (capVol - nextVol) / capVol) : 0;
            const kgWaste = ROUTE_PLANNING_USE_CAPACITY && capKg ? Math.max(0, (capKg - nextKg) / capKg) : 0;
            const fitScore = ROUTE_PLANNING_USE_CAPACITY ? (volWaste + kgWaste) : stopCount;

            let deltaKm = 0;
            let insertionIndex = state.stops.length;
            if (origin && item?.coord) {
                const ins = bestInsertionIndex(origin, state.stops, { awb: item.awb, lat: item.coord.lat, lon: item.coord.lon });
                insertionIndex = Number(ins?.index) >= 0 ? ins.index : state.stops.length;
                deltaKm = Number(ins?.delta_km) || 0;
            }

            const score = fitScore + (deltaKm / 100);
            if (!best || score < best.score) {
                best = { state, insertionIndex, score };
            }
        }

        return best;
    };

    const pickLeastBadState = (states) => {
        if (!Array.isArray(states) || states.length === 0) return null;
        const ranked = states.slice().sort((a, b) => {
            const aVol = Number(a.current_volume || 0);
            const bVol = Number(b.current_volume || 0);
            if (aVol !== bVol) return aVol - bVol;
            return Number(a.current_weight || 0) - Number(b.current_weight || 0);
        });
        return ranked[0] || null;
    };

    const createAdditionalCountyRoute = (countyKey) => {
        const countySpec = countyKeys.get(countyKey);
        if (!countySpec) return null;
        const currentStates = statesByCounty.get(countyKey) || [];
        const nextIndex = currentStates.length + 1;
        const seedState = currentStates[0] || null;
        const preferredDriverId = normalizeDriverId(seedState?.route?.driver_id);
        const fleet = takeFleetDriver(preferredDriverId);

        const code = normalizeVehicleTypeCode(fleet?.vehicle_type_code || seedState?.route?.vehicle_type_code) || DEFAULT_ROUTE_VEHICLE_CODE;
        const defaults = profileCapacityDefaults(code);

        const route = {
            id: makeId(),
            name: `${countySpec.name} #${nextIndex}`,
            route_index: nextIndex,
            driver_id: normalizeDriverId(fleet?.driver_id || seedState?.route?.driver_id),
            driver_name: normalizePersonName(fleet?.driver_name || seedState?.route?.driver_name),
            helper_name: normalizePersonName(fleet?.helper_name || seedState?.route?.helper_name),
            vehicle_plate: normalizeVehiclePlate(fleet?.vehicle_plate || seedState?.route?.vehicle_plate),
            truck_phone: String(fleet?.truck_phone || seedState?.route?.truck_phone || '').trim() || null,
            vehicle_type_code: code,
            vehicle_has_lift: Boolean(fleet?.vehicle_has_lift ?? seedState?.route?.vehicle_has_lift),
            max_volume_m3: toPositiveNumber(fleet?.max_volume_m3) ?? toPositiveNumber(seedState?.route?.max_volume_m3) ?? defaults.max_volume_m3,
            target_volume_m3: toPositiveNumber(fleet?.target_volume_m3) ?? toPositiveNumber(seedState?.route?.target_volume_m3) ?? defaults.target_volume_m3 ?? defaults.max_volume_m3,
            max_weight_kg: toPositiveNumber(fleet?.max_weight_kg) ?? toPositiveNumber(seedState?.route?.max_weight_kg) ?? defaults.max_weight_kg,
            target_weight_kg: toPositiveNumber(fleet?.target_weight_kg) ?? toPositiveNumber(seedState?.route?.target_weight_kg) ?? defaults.target_weight_kg ?? defaults.max_weight_kg,
            date: targetDate,
            kind: 'county',
            region: 'Moldova',
            county: countySpec.name,
            awbs: [],
            created_at: nowIso(),
            updated_at: nowIso(),
        };
        if (route.driver_id) usedDriverIdsToday.add(route.driver_id);
        routes.unshift(route);
        createdRoutes += 1;
        createdCapacityRoutes += 1;
        const state = spawnStateForRoute(route, countyKey);
        state.created_new = true;
        return state;
    };

    let deliverableTotal = 0;
    let deliverableInMoldova = 0;
    let allocated = 0;
    let alreadyAssigned = 0;
    const missingCountyAwbs = [];
    const outsideRegionAwbs = [];
    const overCapacityAwbs = [];
    const missingCountySeen = new Set();
    const outsideRegionSeen = new Set();
    const countyCandidates = new Map();

    for (const s of list) {
        if (!isDeliverableShipment(s)) continue;
        deliverableTotal += 1;

        const awb = normalizeAwb(s?.awb);
        if (!awb) continue;

        const county = inferShipmentCounty(s);
        if (!county) {
            if (!missingCountySeen.has(awb)) {
                missingCountySeen.add(awb);
                missingCountyAwbs.push({
                    awb,
                    recipient_name: String(s?.recipient_name || '').trim() || null,
                    locality: String(s?.locality || s?.raw_data?.recipientLocation?.localityName || '').trim() || null,
                    status: String(s?.status || '').trim() || null,
                });
            }
            continue;
        }

        const key = normalizeCountyKey(county);
        const countySpec = countyKeys.get(key);
        if (!countySpec) {
            if (!outsideRegionSeen.has(awb)) {
                outsideRegionSeen.add(awb);
                outsideRegionAwbs.push({
                    awb,
                    county: String(county || '').trim() || null,
                    recipient_name: String(s?.recipient_name || '').trim() || null,
                    locality: String(s?.locality || s?.raw_data?.recipientLocation?.localityName || '').trim() || null,
                    status: String(s?.status || '').trim() || null,
                });
            }
            continue;
        }

        deliverableInMoldova += 1;
        if (assignedToday.has(awb)) {
            alreadyAssigned += 1;
            continue;
        }

        const items = countyCandidates.get(key) || [];
        items.push({
            awb,
            county_key: key,
            coord: coordsByAwb.get(awb) || null,
            load: loadByAwb.get(awb) || shipmentLoad(s),
        });
        countyCandidates.set(key, items);
    }

    const changedRouteIds = new Set();
    for (const c of MOLDOVA_COUNTIES) {
        const key = normalizeCountyKey(c.name);
        const candidates = countyCandidates.get(key) || [];
        if (!candidates.length) continue;

        const states = statesByCounty.get(key) || [];
        if (!states.length) continue;

        const refCap = routeVehicleCapacity(states[0]?.route || {});
        const refVol = toPositiveNumber(refCap.target_volume_m3) || 1;
        const refKg = toPositiveNumber(refCap.target_weight_kg) || 1;

        candidates.sort((a, b) => {
            const aScore = Math.max((a.load.volume_m3 || 0) / refVol, (a.load.weight_kg || 0) / refKg);
            const bScore = Math.max((b.load.volume_m3 || 0) / refVol, (b.load.weight_kg || 0) / refKg);
            return bScore - aScore;
        });

        for (const item of candidates) {
            if (assignedToday.has(item.awb)) continue;

            let best = pickStateForLoad(states, item);
            if (!best) {
                const spawned = createAdditionalCountyRoute(key);
                if (spawned) {
                    const nextStates = statesByCounty.get(key) || [];
                    best = pickStateForLoad(nextStates, item);
                }
            }

            if (!best) {
                const fallbackState = pickLeastBadState(statesByCounty.get(key) || []);
                if (!fallbackState) continue;
                best = { state: fallbackState, insertionIndex: fallbackState.stops.length, score: Number.POSITIVE_INFINITY };
                fallbackState.over_capacity_awbs.push(item.awb);
                overCapacityAwbs.push({
                    awb: item.awb,
                    county: c.name,
                    route_id: fallbackState.route?.id || null,
                });
            }

            const state = best.state;
            if (item.coord) {
                if (origin) {
                    state.stops.splice(Math.max(0, best.insertionIndex), 0, { awb: item.awb, lat: item.coord.lat, lon: item.coord.lon });
                } else {
                    state.stops.push({ awb: item.awb, lat: item.coord.lat, lon: item.coord.lon });
                }
            } else {
                state.appended.push(item.awb);
            }

            state.current_volume = roundLoad(Number(state.current_volume || 0) + Number(item.load.volume_m3 || 0), 4);
            state.current_weight = roundLoad(Number(state.current_weight || 0) + Number(item.load.weight_kg || 0), 3);
            state.touched = true;
            assignedToday.add(item.awb);
            allocated += 1;
        }
    }

    for (const [countyKey, countyStateList] of statesByCounty.entries()) {
        countyStateList.sort((a, b) => parseRouteIndex(a.route) - parseRouteIndex(b.route));
        countyStateList.forEach((state, idx) => {
            const route = state.route;
            const routeIdx = idx + 1;
            route.route_index = routeIdx;
            const countyName = countyKeys.get(countyKey)?.name || route?.county || route?.name || 'Route';
            if (routeIdx === 1) {
                if (!String(route.name || '').trim() || /#\s*\d+$/i.test(String(route.name || ''))) {
                    route.name = countyName;
                }
            } else {
                route.name = `${countyName} #${routeIdx}`;
            }
            if (state.created_new) state.touched = true;
        });
    }

    for (const state of routeStates.values()) {
        const r = state.route;
        const existingAwbs = (Array.isArray(r.awbs) ? r.awbs : []).map(normalizeAwb).filter(Boolean);
        const stopsOptimized = origin ? optimizeRoundTripOrder(origin, state.stops) : state.stops;
        const orderedAwbs = stopsOptimized.map((s) => normalizeAwb(s?.awb)).filter(Boolean);

        const merged = [];
        const seen = new Set();
        const pushUnique = (val) => {
            const key = normalizeAwb(val);
            if (!key || seen.has(key)) return;
            merged.push(key);
            seen.add(key);
        };

        orderedAwbs.forEach(pushUnique);
        state.appended.forEach(pushUnique);
        existingAwbs.forEach(pushUnique);

        const cap = routeVehicleCapacity(r);
        const volPct = cap.target_volume_m3 ? roundLoad((Number(state.current_volume || 0) / cap.target_volume_m3) * 100, 1) : null;
        const kgPct = cap.target_weight_kg ? roundLoad((Number(state.current_weight || 0) / cap.target_weight_kg) * 100, 1) : null;

        const prevJson = JSON.stringify(existingAwbs);
        const nextJson = JSON.stringify(merged);
        const prevLoadSig = JSON.stringify({
            load_volume_m3: toPositiveNumber(r?.load_volume_m3) ?? 0,
            load_weight_kg: toPositiveNumber(r?.load_weight_kg) ?? 0,
            utilization_volume_pct: toPositiveNumber(r?.utilization_volume_pct) ?? 0,
            utilization_weight_pct: toPositiveNumber(r?.utilization_weight_pct) ?? 0,
            over_capacity_awbs: Array.isArray(r?.over_capacity_awbs) ? r.over_capacity_awbs : [],
        });
        const nextLoadSig = JSON.stringify({
            load_volume_m3: roundLoad(state.current_volume || 0, 4),
            load_weight_kg: roundLoad(state.current_weight || 0, 3),
            utilization_volume_pct: volPct,
            utilization_weight_pct: kgPct,
            over_capacity_awbs: state.over_capacity_awbs,
        });

        if (state.touched || prevJson !== nextJson || prevLoadSig !== nextLoadSig || state.created_new) {
            r.awbs = merged;
            r.vehicle_type_code = cap.vehicle_type_code;
            r.vehicle_has_lift = cap.vehicle_has_lift;
            r.max_volume_m3 = cap.max_volume_m3;
            r.target_volume_m3 = cap.target_volume_m3;
            r.max_weight_kg = cap.max_weight_kg;
            r.target_weight_kg = cap.target_weight_kg;
            r.load_volume_m3 = roundLoad(state.current_volume || 0, 4);
            r.load_weight_kg = roundLoad(state.current_weight || 0, 3);
            r.utilization_volume_pct = volPct;
            r.utilization_weight_pct = kgPct;
            r.over_capacity_awbs = state.over_capacity_awbs;
            r.updated_at = nowIso();
            changedRouteIds.add(r.id);
        }
    }

    if (createdRoutes || changedRouteIds.size > 0 || allocated) {
        saveRoutes(routes);
    }

    const countyPlan = MOLDOVA_COUNTIES.map((c) => {
        const key = normalizeCountyKey(c.name);
        const items = (statesByCounty.get(key) || []).slice().sort((a, b) => parseRouteIndex(a.route) - parseRouteIndex(b.route));
        const totals = items.reduce((acc, s) => {
            acc.routes += 1;
            acc.stops += Array.isArray(s.route?.awbs) ? s.route.awbs.length : 0;
            acc.volume_m3 += Number(s.current_volume || 0);
            acc.weight_kg += Number(s.current_weight || 0);
            return acc;
        }, { routes: 0, stops: 0, volume_m3: 0, weight_kg: 0 });
        return {
            county: c.name,
            routes: totals.routes,
            stops: totals.stops,
            load_volume_m3: roundLoad(totals.volume_m3, 3),
            load_weight_kg: roundLoad(totals.weight_kg, 2),
        };
    });

    return {
        date: targetDate,
        created_routes: createdRoutes,
        capacity_split_routes: createdCapacityRoutes,
        allocated_awbs: allocated,
        deliverable_total: deliverableTotal,
        deliverable_in_moldova: deliverableInMoldova,
        already_assigned: alreadyAssigned,
        missing_county: missingCountyAwbs.length,
        outside_region: outsideRegionAwbs.length,
        over_capacity: overCapacityAwbs.length,
        missing_county_awbs: missingCountyAwbs,
        outside_region_awbs: outsideRegionAwbs,
        over_capacity_awbs: overCapacityAwbs,
        county_plan: countyPlan,
        routes: listMoldovaCountyRoutesForDate(targetDate)
    };
};
