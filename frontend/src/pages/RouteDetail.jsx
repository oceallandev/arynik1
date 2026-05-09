import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, GripVertical, MapPinned, Plus, RefreshCw, ScanLine, Search, Trash2, List, Map as MapIcon, Wand2, Loader2, ExternalLink, Truck, X, Play, Save, ArrowDownUp, Clock, Activity, Flag } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import AwbLink from '../components/AwbLink';
import MapComponent from '../components/MapComponent';
import Scanner from '../components/Scanner';
import { hasPermission } from '../auth/rbac';
import { normalizeRole, PERM_ROUTE_RUNS_WRITE, PERM_SHIPMENTS_ASSIGN, PERM_SHIPMENTS_READ, PERM_USERS_READ, PERM_USERS_WRITE, ROLE_DRIVER } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import { allocateShipment, apiUpdateRoutePlanAwbs, createManualRoutePlan, geocodeShipmentsBatch, getShipment, getShipments, listFleetVehicles, listUsers, getRouteHistory } from '../services/api';
import { awbCandidatesFromScan, normalizeShipmentIdentifier } from '../services/awbScan';
import { geocodeAddress, getCachedGeocode } from '../services/geocodeService';
import { addHelper as addHelperToRoster, listHelpers as listHelperRoster } from '../services/helpersRoster';
import { getRouteMultiDetails, optimizeStopsOrder } from '../services/mapService';
import { optimizeRoundTripOrder } from '../services/routeOptimizer';
import { buildGeocodeHints, buildGeocodeQuery, extractShipmentCoords, isValidCoord } from '../services/shipmentGeo';
import { getWarehouseOrigin } from '../services/warehouse';
import {
    MOLDOVA_COUNTIES,
    createRoute,
    getRouteForUser,
    isRoutingEligibleShipment,
    listRoutesForDateForUser,
    moveAwbToRoute,
    removeAwbFromRoute,
    routeDisplayName,
    setRouteAwbOrder,
    updateRoute
} from '../services/routesStore';

const GOOGLE_MAX_WAYPOINTS = 23;
const ROUTE_TRAFFIC_REFRESH_MS = Math.max(30000, Number(import.meta.env.VITE_ROUTE_TRAFFIC_REFRESH_MS || 120000));
const MAX_SHIPMENT_FETCH_ATTEMPTS = 3;
const AUTO_GEOCODE_MIN_GAP_MS = 1400;
const AUTO_GEOCODE_REPEAT_WINDOW_MS = 20000;
const RO_LAT_MIN = 43.3;
const RO_LAT_MAX = 48.5;
const RO_LON_MIN = 20.0;
const RO_LON_MAX = 30.0;
const ROMANIA_CENTER = { lat: 45.9432, lon: 24.9668 };
const COUNTY_CENTROIDS = {
    alba: { lat: 46.0680, lon: 23.5800 },
    arad: { lat: 46.1700, lon: 21.3160 },
    arges: { lat: 44.8560, lon: 24.8690 },
    bacau: { lat: 46.5710, lon: 26.9200 },
    bihor: { lat: 47.0460, lon: 21.9190 },
    'bistrita nasaud': { lat: 47.1300, lon: 24.5000 },
    botosani: { lat: 47.7470, lon: 26.6690 },
    braila: { lat: 45.2690, lon: 27.9570 },
    brasov: { lat: 45.6570, lon: 25.6010 },
    bucuresti: { lat: 44.4268, lon: 26.1025 },
    buzau: { lat: 45.1500, lon: 26.8200 },
    calarasi: { lat: 44.2050, lon: 27.3330 },
    'caras severin': { lat: 45.3000, lon: 21.8900 },
    cluj: { lat: 46.7700, lon: 23.5900 },
    constanta: { lat: 44.1730, lon: 28.6500 },
    covasna: { lat: 45.8660, lon: 25.7900 },
    dambovita: { lat: 44.9280, lon: 25.4570 },
    dolj: { lat: 44.3300, lon: 23.7940 },
    galati: { lat: 45.4350, lon: 28.0070 },
    giurgiu: { lat: 43.9030, lon: 25.9690 },
    gorj: { lat: 45.0430, lon: 23.2740 },
    harghita: { lat: 46.3630, lon: 25.8020 },
    hunedoara: { lat: 45.7930, lon: 22.9070 },
    ialomita: { lat: 44.5630, lon: 27.3660 },
    iasi: { lat: 47.1580, lon: 27.6010 },
    ilfov: { lat: 44.5350, lon: 26.0800 },
    maramures: { lat: 47.6600, lon: 23.5900 },
    mehedinti: { lat: 44.6360, lon: 22.6590 },
    mures: { lat: 46.5420, lon: 24.5570 },
    neamt: { lat: 46.9280, lon: 26.3700 },
    olt: { lat: 44.4300, lon: 24.3650 },
    prahova: { lat: 44.9450, lon: 26.0220 },
    salaj: { lat: 47.1830, lon: 23.0500 },
    'satu mare': { lat: 47.7920, lon: 22.8850 },
    sibiu: { lat: 45.7980, lon: 24.1250 },
    suceava: { lat: 47.6510, lon: 26.2550 },
    teleorman: { lat: 43.9730, lon: 25.3330 },
    timis: { lat: 45.7530, lon: 21.2250 },
    tulcea: { lat: 45.1710, lon: 28.7910 },
    valcea: { lat: 45.0990, lon: 24.3700 },
    vaslui: { lat: 46.6400, lon: 27.7300 },
    vrancea: { lat: 45.7000, lon: 27.1850 },
};

const normalizeCountyKey = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/^jud(?:et|etul)?\s+/i, '')
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    } catch {
        return String(value || '').toLowerCase().trim();
    }
};

const hashToUnit = (seed) => {
    const text = String(seed || '');
    let h = 0;
    for (let i = 0; i < text.length; i += 1) {
        h = ((h << 5) - h) + text.charCodeAt(i);
        h |= 0;
    }
    const n = Math.abs(h % 1000000);
    return n / 1000000;
};

const fallbackCoordForStop = (stop, routeCounty = '') => {
    const awb = String(stop?.awb || '').trim().toUpperCase();
    const locality = String(stop?.locality || stop?.raw_data?.recipientLocation?.localityName || '').trim();
    const countyRaw = String(stop?.county || routeCounty || '').trim();
    const countyKey = normalizeCountyKey(countyRaw);
    const countyBase = COUNTY_CENTROIDS[countyKey] || ROMANIA_CENTER;

    const seed = [awb, locality, countyKey].filter(Boolean).join('|') || awb || 'romania-default';
    const localityJitterLat = locality ? 0.055 : 0.18;
    const localityJitterLon = locality ? 0.08 : 0.24;
    const latJitter = (hashToUnit(`${seed}:lat`) * 2 - 1) * localityJitterLat;
    const lonJitter = (hashToUnit(`${seed}:lon`) * 2 - 1) * localityJitterLon;

    const lat = Math.min(48.25, Math.max(43.70, Number(countyBase.lat) + latJitter));
    const lon = Math.min(29.75, Math.max(20.20, Number(countyBase.lon) + lonJitter));
    return { lat, lon, source: countyKey ? 'fallback-county-hash' : 'fallback-romania-hash' };
};

const pickCoordCandidate = (...values) => {
    for (const raw of values) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    return null;
};

const toFiniteCoord = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).trim().replace(',', '.');
    if (!normalized) return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
};

const isRomaniaCoord = (lat, lon) => (
    Number.isFinite(Number(lat))
    && Number.isFinite(Number(lon))
    && Number(lat) >= RO_LAT_MIN
    && Number(lat) <= RO_LAT_MAX
    && Number(lon) >= RO_LON_MIN
    && Number(lon) <= RO_LON_MAX
);

const normalizeRomaniaCoordPair = (latRaw, lonRaw) => {
    const lat = toFiniteCoord(latRaw);
    const lon = toFiniteCoord(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (isRomaniaCoord(lat, lon)) return { lat: Number(lat), lon: Number(lon) };
    // Recover swapped pairs.
    if (isRomaniaCoord(lon, lat)) return { lat: Number(lon), lon: Number(lat) };
    return null;
};

const isFallbackGeoSource = (value) => {
    const src = String(value || '').trim().toLowerCase();
    if (!src) return false;
    return (
        src.startsWith('fallback')
        || src.includes('fallback-')
        || src.includes('romania-hash')
        || src.includes('locality-center')
    );
};

const isLocalityCenterSource = (value) => String(value || '').trim().toLowerCase().includes('locality-center');

const isTrustedDirectGeoSource = (value) => {
    const src = String(value || '').trim().toLowerCase();
    return (
        src === 'postis-pin'
        || src === 'postis-pin-raw'
        || src === 'postis-location'
        || src === 'postis-location-raw'
        || src === 'shipment-manual'
        || src === 'recipient-pin'
    );
};

const sanitizeAddressText = (value) => (
    String(value || '')
        .trim()
        .replace(/\b(?:cod\s*postal|postal\s*code|postcode|zip)\s*[:#-]?\s*0{5}\b/ig, ' ')
        .replace(/(^|[^\d])0{5}(?=$|[^\d])/g, '$1 ')
        .replace(/\s*[,;|/]\s*(?=[,;|/]|$)/g, ', ')
        .replace(/^[\s,;|/-]+|[\s,;|/-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
);

const hasStreetAndNumber = (address) => {
    const text = sanitizeAddressText(address);
    if (!text) return false;
    const normalized = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const hasNumber = Array.from(normalized.matchAll(/\b(\d+)[a-z]?\b/g)).some((m) => String(m?.[1] || '').split('').some((ch) => ch !== '0'));
    const hasStreetToken = /\b(str|strada|bd|bulevard|calea|aleea|sos|soseaua|drum|dn|dj|nr)\b/.test(normalized);
    const hasSeparator = normalized.includes(',') || normalized.includes('/');
    return Boolean(hasNumber && (hasStreetToken || hasSeparator));
};

const buildLocalityFallbackQuery = (stop, routeCounty = '') => {
    const locality = String(
        stop?.locality
        || stop?.raw_data?.recipientLocation?.localityName
        || stop?.raw_data?.recipientPin?.localityName
        || ''
    ).trim();
    const county = String(
        stop?.county
        || stop?.raw_data?.recipientLocation?.countyName
        || routeCounty
        || ''
    ).trim();
    const parts = [locality, county, 'Romania'].filter(Boolean);
    if (parts.length < 2) return '';
    return parts.join(', ');
};

const stopNeedsLocationConfirmation = (stop) => {
    if (!stop || typeof stop !== 'object') return false;
    if (typeof stop.requires_location_confirmation === 'boolean') return stop.requires_location_confirmation;
    const granularity = String(stop.location_granularity || '').trim().toLowerCase();
    if (granularity === 'pin') return false;
    const address = String(stop.delivery_address || '').trim();
    const locality = String(stop.locality || stop?.raw_data?.recipientLocation?.localityName || stop?.raw_data?.recipientPin?.localityName || '').trim();
    if (!locality) return false;
    return !hasStreetAndNumber(address);
};

const moveBefore = (list, item, beforeItem) => {
    const arr = Array.isArray(list) ? list.slice() : [];
    const itemKey = String(item || '').trim().toUpperCase();
    const beforeKey = String(beforeItem || '').trim().toUpperCase();
    if (!itemKey || !beforeKey) return arr;

    const fromIdx = arr.findIndex((x) => String(x || '').toUpperCase() === itemKey);
    const toIdx = arr.findIndex((x) => String(x || '').toUpperCase() === beforeKey);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return arr;

    const [moved] = arr.splice(fromIdx, 1);
    const insertAt = fromIdx < toIdx ? Math.max(0, toIdx - 1) : toIdx;
    arr.splice(insertAt, 0, moved);
    return arr;
};

const Modal = ({ open, title, children, onClose }) => (
    <AnimatePresence>
        {open && (
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 24, opacity: 0 }}
                    className="w-full max-w-md glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{title}</p>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-2 rounded-2xl glass-light border border-white/10 text-slate-300 hover:text-white active:scale-95 transition-all"
                            aria-label="Close"
                        >
                            <X size={18} />
                        </button>
                    </div>
                    {children}
                </motion.div>
            </motion.div>
        )}
    </AnimatePresence>
);

export default function RouteDetail() {
    const { routeId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const canAllocate = hasPermission(user, PERM_SHIPMENTS_ASSIGN);
    const canRunRoute = hasPermission(user, PERM_ROUTE_RUNS_WRITE);
    const canReadShipments = hasPermission(user, PERM_SHIPMENTS_READ);
    const isDriver = normalizeRole(user?.role) === ROLE_DRIVER;
    const canEditRoute = canAllocate && !isDriver;
    const canReadUsers = useMemo(() => hasPermission(user, PERM_USERS_READ), [user]);
    const canWriteUsers = useMemo(() => hasPermission(user, PERM_USERS_WRITE), [user]);
    const { location: driverLocation } = useGeolocation({ enabled: isDriver });

    const [route, setRoute] = useState(null);
    const [shipments, setShipments] = useState([]);
    const [loadingShipments, setLoadingShipments] = useState(true);
    const [search, setSearch] = useState('');
    const [addAwb, setAddAwb] = useState('');
    const [scannerOpen, setScannerOpen] = useState(false);
    const [addAwbNotice, setAddAwbNotice] = useState('');
    const [viewMode, setViewMode] = useState('list');
    const [vehiclePlate, setVehiclePlate] = useState('');
    const [driverName, setDriverName] = useState('');
    const [helperName, setHelperName] = useState('');
    const [drivers, setDrivers] = useState([]);
    const [driversLoading, setDriversLoading] = useState(false);
    const [fleetVehicles, setFleetVehicles] = useState([]);
    const [fleetLoading, setFleetLoading] = useState(false);
    const [helpersRoster, setHelpersRoster] = useState(() => listHelperRoster());
    const [addHelperOpen, setAddHelperOpen] = useState(false);
    const [addHelperName, setAddHelperName] = useState('');
    const [addHelperError, setAddHelperError] = useState('');
    const [stopDetailsAwb, setStopDetailsAwb] = useState('');
    const [stopMoveTargetRouteId, setStopMoveTargetRouteId] = useState('');
    const [stopMoveCountyName, setStopMoveCountyName] = useState('');
    const [stopMoveBusy, setStopMoveBusy] = useState(false);
    const [stopMoveError, setStopMoveError] = useState('');

    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyEvents, setHistoryEvents] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const [coordsByAwb, setCoordsByAwb] = useState({});
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routeOptimizeBusy, setRouteOptimizeBusy] = useState(false);
    const [routeGeometry, setRouteGeometry] = useState(null);
    const [routeMetrics, setRouteMetrics] = useState({
        distance_km: null,
        duration_min: null,
        duration_no_traffic_min: null,
        delay_min: null,
        provider: null
    });

    const loadHistory = async () => {
        setHistoryOpen(true);
        setHistoryLoading(true);
        try {
            const data = await getRouteHistory(user?.token, routeId);
            setHistoryEvents(Array.isArray(data) ? data : []);
        } catch (err) {
            console.error(err);
            setHistoryEvents([]);
        } finally {
            setHistoryLoading(false);
        }
    };

    const [draftAwbs, setDraftAwbs] = useState(null);
    const [optimizedSavings, setOptimizedSavings] = useState(null);
    const [reorder, setReorder] = useState({ active: false, dragging: '', over: '' });
    const reorderRef = useRef({ active: false, dragging: '', over: '', pointer_id: null, last_over: '' });
    const draftAwbsRef = useRef(null);
    const routeRef = useRef(null);
    const missingFetchFailuresRef = useRef(new Map());
    const autoGeocodeRef = useRef({ lastAt: 0, lastSignature: '' });

    // Dispatch view should focus on route points, not on the admin's personal location.
    const mapLocation = (isDriver && driverLocation)
        ? { lat: driverLocation.latitude, lon: driverLocation.longitude }
        : null;
    const warehouseOrigin = getWarehouseOrigin();

    useEffect(() => {
        routeRef.current = route;
    }, [route]);

    const money = (amount, currency = 'RON') => {
        const n = Number(amount);
        if (!Number.isFinite(n)) return '--';
        return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
    };

    useEffect(() => {
        const r = getRouteForUser(routeId, user);
        setRoute(r);
    }, [routeId, user?.role, user?.driver_id]);

    useEffect(() => {
        setVehiclePlate(String(route?.vehicle_plate || '').toUpperCase());
        setDriverName(String(route?.driver_name || '').trim());
        setHelperName(String(route?.helper_name || '').trim());
    }, [route?.vehicle_plate, route?.driver_name, route?.helper_name, route?.id]);

    useEffect(() => {
        if (!canReadUsers) return;
        let cancelled = false;

        (async () => {
            setDriversLoading(true);
            try {
                const token = user?.token;
                const data = await listUsers(token);
                if (!cancelled) setDrivers(Array.isArray(data) ? data : []);
            } catch (e) {
                console.warn('Failed to load users list', e);
                if (!cancelled) setDrivers([]);
            } finally {
                if (!cancelled) setDriversLoading(false);
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canReadUsers, user?.token]);

    useEffect(() => {
        if (!canEditRoute) return;
        let cancelled = false;
        (async () => {
            setFleetLoading(true);
            try {
                const rows = await listFleetVehicles(user?.token, {
                    include_inactive: false,
                    sync_from_drivers: false,
                });
                if (!cancelled) setFleetVehicles(Array.isArray(rows) ? rows : []);
            } catch (e) {
                console.warn('Failed to load fleet vehicles', e);
                if (!cancelled) setFleetVehicles([]);
            } finally {
                if (!cancelled) setFleetLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [canEditRoute, user?.token]);

    const driversById = useMemo(() => {
        const map = new Map();
        (Array.isArray(drivers) ? drivers : []).forEach((d) => {
            const id = String(d?.driver_id || '').trim().toUpperCase();
            if (!id) return;
            map.set(id, d);
        });
        return map;
    }, [drivers]);

    const availableDrivers = useMemo(() => (
        (Array.isArray(drivers) ? drivers : [])
            .filter((d) => normalizeRole(d?.role) === ROLE_DRIVER && d?.active !== false)
            .slice()
            .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
    ), [drivers]);

    const availableFleetVehicles = useMemo(() => (
        (Array.isArray(fleetVehicles) ? fleetVehicles : [])
            .filter((v) => String(v?.plate || '').trim())
            .slice()
            .sort((a, b) => String(a?.plate || '').localeCompare(String(b?.plate || '')))
    ), [fleetVehicles]);

    const fleetByPlate = useMemo(() => {
        const map = new Map();
        availableFleetVehicles.forEach((v) => {
            const plate = String(v?.plate || '').trim().toUpperCase();
            if (!plate) return;
            map.set(plate, v);
        });
        return map;
    }, [availableFleetVehicles]);

    const helperOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        const add = (value) => {
            const name = String(value || '').trim().replace(/\s+/g, ' ');
            if (!name) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push(name);
        };

        (Array.isArray(helpersRoster) ? helpersRoster : []).forEach(add);
        (Array.isArray(drivers) ? drivers : []).forEach((d) => add(d?.helper_name));
        add(helperName);

        return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }, [helpersRoster, drivers, helperName]);

    const assignVehicle = (plateRaw) => {
        if (!route) return;
        const plate = String(plateRaw || '').trim().toUpperCase();
        const selected = plate ? fleetByPlate.get(plate) : null;
        const patch = {
            vehicle_plate: plate || null,
        };
        if (selected) {
            patch.vehicle_type_code = String(selected?.vehicle_type_code || '').trim().toUpperCase() || null;
            patch.vehicle_has_lift = typeof selected?.vehicle_has_lift === 'boolean' ? Boolean(selected.vehicle_has_lift) : null;
            patch.max_volume_m3 = Number.isFinite(Number(selected?.max_volume_m3)) ? Number(selected.max_volume_m3) : null;
            patch.target_volume_m3 = Number.isFinite(Number(selected?.target_volume_m3)) ? Number(selected.target_volume_m3) : null;
            patch.max_weight_kg = Number.isFinite(Number(selected?.max_weight_kg)) ? Number(selected.max_weight_kg) : null;
            patch.target_weight_kg = Number.isFinite(Number(selected?.target_weight_kg)) ? Number(selected.target_weight_kg) : null;
            patch.truck_phone = String(selected?.assigned_phone || '').trim() || null;

            if (!String(route?.driver_id || '').trim() && String(selected?.assigned_driver_id || '').trim()) {
                const did = String(selected.assigned_driver_id || '').trim().toUpperCase();
                const fromUsers = did ? driversById.get(did) : null;
                patch.driver_id = did || null;
                patch.driver_name = String(fromUsers?.name || selected?.assigned_driver_name || '').trim() || null;
            }
            if (!String(route?.helper_name || '').trim() && String(selected?.helper_name || '').trim()) {
                patch.helper_name = String(selected.helper_name || '').trim() || null;
            }
        }

        const updated = updateRoute(route.id, patch);
        if (updated) setRoute(updated);
        setVehiclePlate(plate);
        if (plate) {
            try { localStorage.setItem('arynik_last_vehicle_plate_v1', plate); } catch { }
        }
    };

    const assignHelper = (name) => {
        if (!route) return;
        const next = String(name || '').trim();
        setHelperName(next);
        const updated = updateRoute(route.id, { helper_name: next || null });
        if (updated) setRoute(updated);
    };

    const assignDriver = (driverId) => {
        if (!route) return;
        const id = String(driverId || '').trim().toUpperCase();
        const d = id ? driversById.get(id) : null;
        const patch = {
            driver_id: id || null,
            driver_name: (d?.name || '').trim() || null,
        };

        // Convenience: fill blanks from the selected driver profile.
        if (!route.helper_name && d?.helper_name) patch.helper_name = String(d.helper_name).trim();
        if (d?.vehicle_type_code) patch.vehicle_type_code = String(d.vehicle_type_code).trim().toUpperCase();
        if (typeof d?.vehicle_has_lift === 'boolean') patch.vehicle_has_lift = Boolean(d.vehicle_has_lift);
        if (Number.isFinite(Number(d?.max_volume_m3))) patch.max_volume_m3 = Number(d.max_volume_m3);
        if (Number.isFinite(Number(d?.target_volume_m3))) patch.target_volume_m3 = Number(d.target_volume_m3);
        if (Number.isFinite(Number(d?.max_weight_kg))) patch.max_weight_kg = Number(d.max_weight_kg);
        if (Number.isFinite(Number(d?.target_weight_kg))) patch.target_weight_kg = Number(d.target_weight_kg);

        const updated = updateRoute(route.id, patch);
        if (updated) setRoute(updated);
    };

    const submitAddHelper = () => {
        const name = String(addHelperName || '').trim();
        if (!name) {
            setAddHelperError('Helper name is required.');
            return;
        }

        const next = addHelperToRoster(name);
        setHelpersRoster(next);
        setAddHelperOpen(false);
        setAddHelperName('');
        setAddHelperError('');
        assignHelper(name);
    };

    // Backfill crew metadata when we have the users list (keeps route titles readable).
    useEffect(() => {
        if (!route || driversById.size === 0) return;
        const id = String(route?.driver_id || '').trim().toUpperCase();
        if (!id) return;
        const d = driversById.get(id);
        if (!d) return;

        const patch = {};
        const desiredName = String(d?.name || '').trim();
        const desiredHelper = String(d?.helper_name || '').trim();
        const desiredType = String(d?.vehicle_type_code || '').trim().toUpperCase();

        if (desiredName && !String(route?.driver_name || '').trim()) patch.driver_name = desiredName;
        if (desiredHelper && !String(route?.helper_name || '').trim()) patch.helper_name = desiredHelper;
        if (desiredType && !String(route?.vehicle_type_code || '').trim()) patch.vehicle_type_code = desiredType;
        if (Number.isFinite(Number(d?.max_volume_m3)) && !Number.isFinite(Number(route?.max_volume_m3))) patch.max_volume_m3 = Number(d.max_volume_m3);
        if (Number.isFinite(Number(d?.target_volume_m3)) && !Number.isFinite(Number(route?.target_volume_m3))) patch.target_volume_m3 = Number(d.target_volume_m3);
        if (Number.isFinite(Number(d?.max_weight_kg)) && !Number.isFinite(Number(route?.max_weight_kg))) patch.max_weight_kg = Number(d.max_weight_kg);
        if (Number.isFinite(Number(d?.target_weight_kg)) && !Number.isFinite(Number(route?.target_weight_kg))) patch.target_weight_kg = Number(d.target_weight_kg);
        if (typeof d?.vehicle_has_lift === 'boolean' && typeof route?.vehicle_has_lift !== 'boolean') patch.vehicle_has_lift = Boolean(d.vehicle_has_lift);

        if (Object.keys(patch).length === 0) return;
        const updated = updateRoute(route.id, patch);
        if (updated) setRoute(updated);
    }, [route?.id, route?.driver_id, driversById]);

    const refreshShipments = async () => {
        if (!canReadShipments) {
            setShipments([]);
            setLoadingShipments(false);
            return;
        }
        setLoadingShipments(true);
        try {
            const token = user?.token;
            const data = await getShipments(token);
            setShipments(Array.isArray(data) ? data : []);
        } catch (e) {
            console.warn('Failed to load shipments', e);
            setShipments([]);
        } finally {
            setLoadingShipments(false);
        }
    };

    useEffect(() => {
        refreshShipments();
    }, [canReadShipments, user?.token]);

    useEffect(() => {
        if (!addAwbNotice) return undefined;
        const id = setTimeout(() => setAddAwbNotice(''), 3000);
        return () => clearTimeout(id);
    }, [addAwbNotice]);

    const shipmentsByAwb = useMemo(() => {
        const map = new Map();
        shipments.forEach((s) => {
            if (s?.awb) map.set(String(s.awb).toUpperCase(), s);
        });
        return map;
    }, [shipments]);

    const routeEligibleShipments = useMemo(
        () => (Array.isArray(shipments) ? shipments : []).filter((s) => isRoutingEligibleShipment(s)),
        [shipments]
    );

    const routeEligibleByAwb = useMemo(() => {
        const map = new Map();
        routeEligibleShipments.forEach((s) => {
            const awb = String(s?.awb || '').trim().toUpperCase();
            if (awb) map.set(awb, s);
        });
        return map;
    }, [routeEligibleShipments]);

    const plannedStopHintsByAwb = useMemo(() => {
        const map = new Map();
        const rawStops = Array.isArray(route?.data?.stops)
            ? route.data.stops
            : (Array.isArray(route?.data?.stop_hints) ? route.data.stop_hints : []);
        rawStops.forEach((row) => {
            const awb = String(row?.awb || '').trim().toUpperCase();
            if (!awb) return;
            map.set(awb, row);
        });
        return map;
    }, [route?.data]);

    const routeAwbs = Array.isArray(route?.awbs) ? route.awbs : [];
    const routeAwbsRef = useRef(routeAwbs);
    useEffect(() => {
        routeAwbsRef.current = routeAwbs;
        // If the route changes (new stop added/removed) while we're dragging, cancel the draft.
        if (reorderRef.current.active) {
            reorderRef.current = { active: false, dragging: '', over: '', pointer_id: null, last_over: '' };
            setReorder({ active: false, dragging: '', over: '' });
            setDraftAwbs(null);
            draftAwbsRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeAwbs.join('|')]);

    useEffect(() => {
        missingFetchFailuresRef.current = new Map();
        setOptimizedSavings(null);
    }, [route?.id]);

    useEffect(() => {
        autoGeocodeRef.current = { lastAt: 0, lastSignature: '' };
    }, [route?.id]);

    const effectiveAwbs = draftAwbs !== null ? draftAwbs : routeAwbs;

    const routeStops = useMemo(() => (
        effectiveAwbs.map((awb) => {
            const key = String(awb || '').toUpperCase();
            const s = shipmentsByAwb.get(key);
            if (s) return s;
            const hint = plannedStopHintsByAwb.get(key);
            if (hint && typeof hint === 'object') {
                const hintLat = pickCoordCandidate(hint?.latitude, hint?.lat);
                const hintLon = pickCoordCandidate(hint?.longitude, hint?.lon, hint?.lng);
                return {
                    awb: key,
                    status: String(hint?.status || 'Planned').trim() || 'Planned',
                    recipient_name: String(hint?.recipient_name || hint?.name || '').trim() || 'Unknown',
                    delivery_address: String(hint?.delivery_address || hint?.address || '').trim(),
                    locality: String(hint?.locality || hint?.city || '').trim(),
                    county: String(hint?.county || hint?.county_name || hint?.region || '').trim(),
                    latitude: Number.isFinite(hintLat) ? Number(hintLat) : null,
                    longitude: Number.isFinite(hintLon) ? Number(hintLon) : null,
                    raw_data: {
                        recipientLocation: {
                            localityName: String(hint?.locality || hint?.city || '').trim() || undefined,
                            countyName: String(hint?.county || hint?.county_name || hint?.region || '').trim() || undefined,
                        }
                    }
                };
            }
            return {
                awb: key,
                status: 'Unknown',
                recipient_name: 'Unknown',
                delivery_address: '',
                locality: '',
                county: String(route?.county || '').trim(),
            };
        })
    ), [effectiveAwbs, shipmentsByAwb, plannedStopHintsByAwb, route?.county]);

    const stopDetailsStop = useMemo(() => {
        const key = String(stopDetailsAwb || '').trim().toUpperCase();
        if (!key) return null;
        return (Array.isArray(routeStops) ? routeStops : []).find((s) => String(s?.awb || '').trim().toUpperCase() === key) || null;
    }, [routeStops, stopDetailsAwb]);

    const stopDetailsIndex = useMemo(() => {
        const key = String(stopDetailsAwb || '').trim().toUpperCase();
        if (!key) return -1;
        return (Array.isArray(routeAwbs) ? routeAwbs : []).findIndex((x) => String(x || '').trim().toUpperCase() === key);
    }, [routeAwbs, stopDetailsAwb]);

    const moveRouteCandidates = useMemo(() => {
        const dateKey = String(route?.date || '').trim();
        if (!dateKey) return [];
        const rows = listRoutesForDateForUser(dateKey, user);
        return (Array.isArray(rows) ? rows : [])
            .filter((r) => String(r?.id || '') !== String(route?.id || ''))
            .sort((a, b) => String(routeDisplayName(a) || '').localeCompare(String(routeDisplayName(b) || '')));
    }, [route?.date, route?.id, user]);

    const moveCountyOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        const addCounty = (value) => {
            const name = String(value || '').trim();
            if (!name) return;
            const key = normalizeCountyKey(name);
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(name);
        };

        MOLDOVA_COUNTIES.forEach((row) => addCounty(row?.name));
        addCounty(route?.county);
        addCounty(stopDetailsStop?.county);
        return out.sort((a, b) => String(a).localeCompare(String(b)));
    }, [route?.county, stopDetailsStop?.county]);

    const routeStopsWithCoords = useMemo(() => (
        routeStops.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const cached = coordsByAwb[awb];
            const canUseCached = cached && isValidCoord(cached.lat) && isValidCoord(cached.lon);
            const cachedFallback = Boolean(cached?.fallback) || isFallbackGeoSource(cached?.source || cached?.provider);
            const source = s?.geocode_source || s?.source || s?.provider;
            const shipmentFallback = isFallbackGeoSource(source);
            const needsConfirmation = stopNeedsLocationConfirmation(s);
            const directAllowed = !isLocalityCenterSource(source) && (!needsConfirmation || isTrustedDirectGeoSource(source));
            const direct = directAllowed ? extractShipmentCoords(s) : null;
            const usableCached = canUseCached && !cachedFallback;
            const candidateLat = direct?.lat ?? (usableCached ? Number(cached.lat) : null);
            const candidateLon = direct?.lon ?? (usableCached ? Number(cached.lon) : null);
            const normalized = normalizeRomaniaCoordPair(candidateLat, candidateLon);

            return {
                ...s,
                latitude: normalized ? Number(normalized.lat) : null,
                longitude: normalized ? Number(normalized.lon) : null,
                geo_fallback: Boolean(s?.geo_fallback) || (direct ? shipmentFallback : cachedFallback),
            };
        })
    ), [routeStops, coordsByAwb]);

    const routeStopsForMap = useMemo(() => (
        routeStopsWithCoords.map((s) => {
            const normalized = normalizeRomaniaCoordPair(s?.latitude, s?.longitude);
            if (normalized) {
                return {
                    ...s,
                    latitude: Number(normalized.lat),
                    longitude: Number(normalized.lon),
                };
            }
            const fb = fallbackCoordForStop(s, route?.county);
            const fbNormalized = normalizeRomaniaCoordPair(fb.lat, fb.lon) || ROMANIA_CENTER;
            return {
                ...s,
                latitude: Number(fbNormalized.lat),
                longitude: Number(fbNormalized.lon),
                geo_fallback: true,
            };
        })
    ), [routeStopsWithCoords, route?.county]);

    const mapCoverage = useMemo(() => {
        const total = Array.isArray(routeStopsForMap) ? routeStopsForMap.length : 0;
        let withCoords = 0;
        let estimated = 0;
        (Array.isArray(routeStopsForMap) ? routeStopsForMap : []).forEach((s) => {
            if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                withCoords += 1;
                if (Boolean(s?.geo_fallback)) estimated += 1;
            }
        });
        const exact = Math.max(0, withCoords - estimated);
        return { total, withCoords, missing: Math.max(0, total - withCoords), estimated, exact };
    }, [routeStopsForMap]);
    const needsLocationConfirmCount = useMemo(
        () => (Array.isArray(routeStops) ? routeStops.filter((s) => stopNeedsLocationConfirmation(s)).length : 0),
        [routeStops]
    );
    const routeStopsCoordsSignature = useMemo(
        () => JSON.stringify(routeStopsForMap.map((s) => [s.awb, s.latitude, s.longitude])),
        [routeStopsForMap]
    );
    const routeStopsGeocodeSignature = useMemo(
        () => JSON.stringify(routeStops.map((s) => [String(s?.awb || '').toUpperCase(), buildGeocodeQuery(s)])),
        [routeStops]
    );

    const fetchMissingRouteShipments = async ({ forceRefresh = false } = {}) => {
        if (!route || !Array.isArray(routeAwbs) || routeAwbs.length === 0) return { changed: false, fetched: [] };
        const token = user?.token;
        if (!token) return { changed: false, fetched: [] };

        const known = new Set(
            (Array.isArray(shipments) ? shipments : [])
                .map((s) => String(s?.awb || '').trim().toUpperCase())
                .filter(Boolean)
        );

        const failureMap = missingFetchFailuresRef.current;
        const missing = routeAwbs
            .map((awb) => String(awb || '').trim().toUpperCase())
            .filter((awb) => {
                if (!awb || known.has(awb)) return false;
                const attempts = Number(failureMap.get(awb) || 0);
                return forceRefresh || attempts < MAX_SHIPMENT_FETCH_ATTEMPTS;
            });
        if (missing.length === 0) return { changed: false, fetched: [] };

        const mergeFetchedShipments = (prev, fetched) => {
            const out = Array.isArray(prev) ? prev.slice() : [];
            const idxByAwb = new Map();
            out.forEach((row, idx) => {
                const key = String(row?.awb || '').trim().toUpperCase();
                if (key) idxByAwb.set(key, idx);
            });
            fetched.forEach((row) => {
                const key = String(row?.awb || '').trim().toUpperCase();
                if (!key) return;
                const idx = idxByAwb.get(key);
                if (Number.isInteger(idx)) {
                    out[idx] = row;
                } else {
                    out.push(row);
                    idxByAwb.set(key, out.length - 1);
                }
            });
            return out;
        };

        let changed = false;
        const fetchedAll = [];
        const chunkSize = 8;
        for (let i = 0; i < missing.length; i += chunkSize) {
            const chunk = missing.slice(i, i + chunkSize);
            // eslint-disable-next-line no-await-in-loop
            const rows = await Promise.all(
                chunk.map(async (awb) => {
                    const key = String(awb || '').trim().toUpperCase();
                    if (!key) return null;
                    try {
                        const direct = await getShipment(token, key);
                        if (direct && typeof direct === 'object') {
                            failureMap.delete(key);
                            return direct;
                        }
                    } catch (error) {
                        const status = Number(error?.response?.status || 0);
                        const shouldRetryWithRefresh = forceRefresh || status === 404;
                        if (shouldRetryWithRefresh) {
                            try {
                                const refreshed = await getShipment(token, key, { refresh: true });
                                if (refreshed && typeof refreshed === 'object') {
                                    failureMap.delete(key);
                                    return refreshed;
                                }
                            } catch {
                                // Count below.
                            }
                        }
                    }

                    const prevAttempts = Number(failureMap.get(key) || 0);
                    failureMap.set(key, prevAttempts + 1);
                    return null;
                })
            );

            const fetched = rows.filter(Boolean);
            if (fetched.length > 0) {
                changed = true;
                fetchedAll.push(...fetched);
                setShipments((prev) => mergeFetchedShipments(prev, fetched));
            }
        }

        return { changed, fetched: fetchedAll };
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await fetchMissingRouteShipments({ forceRefresh: false });
            } catch (e) {
                if (!cancelled) console.warn('Failed to hydrate route AWB details', e);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route?.id, routeAwbs.join('|'), user?.token, shipments.length]);

    const filteredAdd = useMemo(() => {
        const q = String(search || '').trim().toLowerCase();
        if (!q) return [];
        const existing = new Set(effectiveAwbs.map((x) => String(x).toUpperCase()));
        return routeEligibleShipments
            .filter((s) => {
                const awb = String(s?.awb || '').toLowerCase();
                const name = String(s?.recipient_name || '').toLowerCase();
                return (awb.includes(q) || name.includes(q)) && !existing.has(String(s?.awb || '').toUpperCase());
            })
            .slice(0, 30);
    }, [search, routeEligibleShipments, effectiveAwbs]);

    const resolveAddCandidate = (rawValue) => {
        const parsed = awbCandidatesFromScan(rawValue);
        if (!parsed?.normalized) return null;
        const known = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
            .find((cand) => routeEligibleByAwb.has(String(cand || '').trim().toUpperCase()));
        if (known) return String(known).trim().toUpperCase();
        return String(parsed.coreCandidate || parsed.normalized).trim().toUpperCase();
    };

    const handleAddAwb = async (awb) => {
        if (!route || !canEditRoute) return;
        const normalized = normalizeShipmentIdentifier(awb);
        if (!normalized) return;
        
        const isEligible = routeEligibleByAwb.has(normalized);

        const alreadyInRoute = (Array.isArray(route?.awbs) ? route.awbs : [])
            .some((x) => String(x || '').trim().toUpperCase() === normalized);

        const updated = moveAwbToRoute(route.id, normalized, { scopeDate: true });
        if (updated) {
            setRoute(updated);
            if (updated.source_plan_id) {
                apiUpdateRoutePlanAwbs(user?.token, updated.source_plan_id, updated.awbs).catch(e => {
                    setAddAwbNotice('Eroare: ' + String(e?.response?.data?.detail || e?.message || 'salvare esuata.'));
                });
            }
        }
        setAddAwb('');
        setSearch('');
        
        if (!isEligible && !alreadyInRoute) {
            setAddAwbNotice(`AWB ${normalized} adăugat manual.`);
        }

        if (alreadyInRoute) return;

        if (updated && canAllocate) {
            const targetDriverId = String(updated?.driver_id || '').trim();
            if (!targetDriverId) return;
            try {
                await allocateShipment(user?.token, normalized, targetDriverId);
            } catch (e) {
                console.warn('Allocation API failed', e);
            }
        }
    };

    const addAwbFromValue = async (rawValue, source = 'manual') => {
        const candidate = resolveAddCandidate(rawValue);
        if (!candidate) {
            setAddAwbNotice('AWB invalid.');
            return;
        }
        const existed = (Array.isArray(route?.awbs) ? route.awbs : [])
            .some((x) => String(x || '').trim().toUpperCase() === candidate);
        await handleAddAwb(candidate);
        if (source === 'scan') {
            setAddAwbNotice(existed ? `AWB ${candidate} este deja in ruta.` : `AWB ${candidate} adaugat din scanare.`);
        }
    };

    const handleManualAdd = async () => {
        await addAwbFromValue(addAwb, 'manual');
    };

    const handleScanAdd = async (value) => {
        setScannerOpen(false);
        await addAwbFromValue(value, 'scan');
    };

    const openStopDetails = (stopLike) => {
        const awb = String(stopLike?.awb || stopLike || '').trim().toUpperCase();
        if (!awb) return;
        const stop = (Array.isArray(routeStops) ? routeStops : []).find((s) => String(s?.awb || '').trim().toUpperCase() === awb) || null;
        const defaultCounty = String(stop?.county || route?.county || '').trim();
        setStopDetailsAwb(awb);
        setStopMoveTargetRouteId('');
        setStopMoveCountyName(defaultCounty);
        setStopMoveError('');
    };

    const closeStopDetails = () => {
        setStopDetailsAwb('');
        setStopMoveTargetRouteId('');
        setStopMoveCountyName('');
        setStopMoveBusy(false);
        setStopMoveError('');
    };

    useEffect(() => {
        const selected = String(stopDetailsAwb || '').trim().toUpperCase();
        if (!selected) return;
        const stillExists = (Array.isArray(routeAwbs) ? routeAwbs : [])
            .some((x) => String(x || '').trim().toUpperCase() === selected);
        if (!stillExists) {
            closeStopDetails();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeAwbs.join('|'), stopDetailsAwb]);

    const handleRemoveAwb = (awb, { closeAfter = false } = {}) => {
        if (!route || !canEditRoute) return;
        const updated = removeAwbFromRoute(route.id, awb);
        if (updated) {
            setRoute(updated);
            if (updated.source_plan_id) {
                apiUpdateRoutePlanAwbs(user?.token, updated.source_plan_id, updated.awbs).catch(e => {
                    setAddAwbNotice('Eroare: ' + String(e?.response?.data?.detail || e?.message || 'salvare esuata.'));
                });
            }
        }
        if (closeAfter) closeStopDetails();
    };

    const reorderStopByDelta = (awb, delta) => {
        if (!route || !canEditRoute) return;
        const key = String(awb || '').trim().toUpperCase();
        if (!key) return;
        const list = Array.isArray(routeAwbs) ? routeAwbs.map((x) => String(x || '').trim().toUpperCase()) : [];
        const fromIdx = list.findIndex((x) => x === key);
        if (fromIdx === -1) return;
        const shift = Number(delta);
        if (!Number.isFinite(shift) || shift === 0) return;
        const toIdx = Math.min(Math.max(0, fromIdx + shift), Math.max(0, list.length - 1));
        if (toIdx === fromIdx) return;
        const next = list.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        const updated = setRouteAwbOrder(route.id, next);
        if (updated) {
            setRoute(updated);
            if (updated.source_plan_id) {
                apiUpdateRoutePlanAwbs(user?.token, updated.source_plan_id, updated.awbs).catch(e => {
                    setAddAwbNotice('Eroare: ' + String(e?.response?.data?.detail || e?.message || 'salvare esuata.'));
                });
            }
        }
        setAddAwbNotice(`Stop ${key} moved to position ${toIdx + 1}.`);
    };

    const moveSelectedStopToRoute = async (targetRouteId) => {
        if (!route || !canEditRoute) return;
        const awb = String(stopDetailsAwb || '').trim().toUpperCase();
        const targetId = String(targetRouteId || '').trim();
        if (!awb || !targetId) {
            setStopMoveError('Select a target route.');
            return;
        }

        setStopMoveBusy(true);
        setStopMoveError('');
        const originalRouteId = String(route?.id || '');
        try {
            let movedRoute = moveAwbToRoute(targetId, awb, { scopeDate: true });
            if (!movedRoute) {
                throw new Error('Failed to move stop to target route.');
            }
            if (movedRoute.source_plan_id) {
                // Sync target route
                await apiUpdateRoutePlanAwbs(user?.token, movedRoute.source_plan_id, movedRoute.awbs);
            } else if (route?.source_plan_id) {
                const createdPlan = await createManualRoutePlan(user?.token, {
                    plan_date: String(movedRoute?.date || route?.date || '').trim() || undefined,
                    county: String(movedRoute?.county || '').trim() || 'Manual',
                    route_index: Number.isFinite(Number(movedRoute?.route_index)) ? Number(movedRoute.route_index) : undefined,
                    name: String(movedRoute?.name || '').trim() || undefined,
                    awbs: Array.isArray(movedRoute?.awbs) ? movedRoute.awbs : [awb],
                    assigned_driver_id: movedRoute?.driver_id || undefined,
                    assigned_driver_name: movedRoute?.driver_name || undefined,
                    assigned_helper_name: movedRoute?.helper_name || undefined,
                    assigned_phone: movedRoute?.truck_phone || undefined,
                    assigned_vehicle_plate: movedRoute?.vehicle_plate || undefined,
                    vehicle_type_code: movedRoute?.vehicle_type_code || undefined,
                    vehicle_has_lift: Boolean(movedRoute?.vehicle_has_lift),
                    max_volume_m3: Number.isFinite(Number(movedRoute?.max_volume_m3)) ? Number(movedRoute.max_volume_m3) : undefined,
                    target_volume_m3: Number.isFinite(Number(movedRoute?.target_volume_m3)) ? Number(movedRoute.target_volume_m3) : undefined,
                    max_weight_kg: Number.isFinite(Number(movedRoute?.max_weight_kg)) ? Number(movedRoute.max_weight_kg) : undefined,
                    target_weight_kg: Number.isFinite(Number(movedRoute?.target_weight_kg)) ? Number(movedRoute.target_weight_kg) : undefined,
                });
                if (createdPlan?.id) {
                    movedRoute = updateRoute(movedRoute.id, { source_plan_id: Number(createdPlan.id) }) || movedRoute;
                }
            }
            const refreshed = getRouteForUser(route.id, user);
            if (refreshed) {
                setRoute(refreshed);
                if (refreshed.source_plan_id) {
                    // Sync current route
                    await apiUpdateRoutePlanAwbs(user?.token, refreshed.source_plan_id, refreshed.awbs);
                }
            }
            setAddAwbNotice(`AWB ${awb} moved to ${routeDisplayName(movedRoute)}.`);
            closeStopDetails();
        } catch (e) {
            if (originalRouteId && originalRouteId !== targetId) {
                const rolledBack = moveAwbToRoute(originalRouteId, awb, { scopeDate: true });
                if (rolledBack) setRoute(rolledBack);
            }
            setStopMoveError(String(e?.response?.data?.detail || e?.message || 'Failed to move stop.'));
        } finally {
            setStopMoveBusy(false);
        }
    };

    const createCountyRouteAndMoveSelectedStop = async () => {
        if (!route || !canEditRoute) return;
        const awb = String(stopDetailsAwb || '').trim().toUpperCase();
        const county = String(stopMoveCountyName || '').trim();
        if (!awb) return;
        if (!county) {
            setStopMoveError('Select a county first.');
            return;
        }

        const normalizedCounty = normalizeCountyKey(county);
        let target = moveRouteCandidates.find((r) => (
            normalizeCountyKey(r?.county || r?.name) === normalizedCounty
        )) || null;

        if (!target) {
            target = createRoute({
                name: `${county} Route`,
                date: String(route?.date || '').trim() || undefined,
                county,
                kind: 'county',
                region: 'Moldova',
                driver_id: route?.driver_id || null,
                driver_name: route?.driver_name || null,
                helper_name: route?.helper_name || null,
                vehicle_plate: route?.vehicle_plate || null,
                vehicle_type_code: route?.vehicle_type_code || null,
                vehicle_has_lift: typeof route?.vehicle_has_lift === 'boolean' ? Boolean(route.vehicle_has_lift) : false,
                max_volume_m3: Number(route?.max_volume_m3),
                target_volume_m3: Number(route?.target_volume_m3),
                max_weight_kg: Number(route?.max_weight_kg),
                target_weight_kg: Number(route?.target_weight_kg),
                truck_phone: route?.truck_phone || null,
            });
        }

        await moveSelectedStopToRoute(String(target?.id || ''));
    };

    useEffect(() => {
        draftAwbsRef.current = draftAwbs;
    }, [draftAwbs]);

    const reverseOrder = async () => {
        if (!route || !canEditRoute) return;
        const currentAwbs = Array.isArray(routeAwbs) ? [...routeAwbs] : [];
        if (currentAwbs.length < 2) return;
        
        currentAwbs.reverse();
        
        const updated = setRouteAwbOrder(route.id, currentAwbs);
        if (updated) {
            setRoute(updated);
            if (updated.source_plan_id) {
                try {
                    await apiUpdateRoutePlanAwbs(user?.token, updated.source_plan_id, updated.awbs);
                    setAddAwbNotice('Ruta a fost inversata cu succes.');
                } catch (e) {
                    setAddAwbNotice('Eroare: ' + String(e?.response?.data?.detail || e?.message || 'salvare esuata.'));
                }
            } else {
                setAddAwbNotice('Ruta a fost inversata cu succes (draft).');
            }
        }
    };

    const startReorder = (awb, e) => {
        if (!route || !canEditRoute) return;
        const key = String(awb || '').trim().toUpperCase();
        if (!key) return;
        if (reorderRef.current.active) return;

        if (e) {
            try { e.preventDefault(); } catch { }
            try { e.stopPropagation(); } catch { }
        }

        const base = Array.isArray(effectiveAwbs) ? effectiveAwbs.slice() : [];
        setDraftAwbs(base);
        draftAwbsRef.current = base;

        reorderRef.current = {
            active: true,
            dragging: key,
            over: key,
            pointer_id: e?.pointerId ?? null,
            last_over: key,
        };
        setReorder({ active: true, dragging: key, over: key });

        try {
            if (e?.currentTarget?.setPointerCapture && Number.isFinite(Number(e.pointerId))) {
                e.currentTarget.setPointerCapture(e.pointerId);
            }
        } catch { }
    };

    const finishReorder = () => {
        if (!reorderRef.current.active) return;

        const draft = draftAwbsRef.current;
        const saved = routeAwbsRef.current;
        const routeNow = routeRef.current;

        reorderRef.current = { active: false, dragging: '', over: '', pointer_id: null, last_over: '' };
        setReorder({ active: false, dragging: '', over: '' });

        if (!routeNow || !routeNow.id) {
            setDraftAwbs(null);
            draftAwbsRef.current = null;
            return;
        }

        if (!Array.isArray(draft) || !Array.isArray(saved) || draft.join('|') === saved.join('|')) {
            setDraftAwbs(null);
            draftAwbsRef.current = null;
            return;
        }

        const updated = setRouteAwbOrder(routeNow.id, draft);
        if (updated) {
            setRoute(updated);
            if (updated.source_plan_id) {
                apiUpdateRoutePlanAwbs(user?.token, updated.source_plan_id, updated.awbs).catch(e => {
                    setAddAwbNotice('Eroare: ' + String(e?.response?.data?.detail || e?.message || 'salvare esuata.'));
                });
            }
        }
        // Keep the draft until the route store updates, to avoid UI flicker.
    };

    useEffect(() => {
        if (!reorder.active) return undefined;

        const onMove = (e) => {
            const st = reorderRef.current;
            if (!st.active) return;
            if (st.pointer_id !== null && e.pointerId !== st.pointer_id) return;

            const el = document.elementFromPoint(e.clientX, e.clientY);
            const item = el && el.closest ? el.closest('[data-stop-awb]') : null;
            const overAwb = item ? String(item.getAttribute('data-stop-awb') || '').trim().toUpperCase() : '';

            if (!overAwb) return;
            if (overAwb === st.dragging) return;
            if (overAwb === st.last_over) return;

            st.last_over = overAwb;
            st.over = overAwb;
            setReorder((prev) => (prev.over === overAwb ? prev : { ...prev, over: overAwb }));

            setDraftAwbs((prev) => {
                const list = Array.isArray(prev) ? prev : (routeAwbsRef.current || []);
                const next = moveBefore(list, st.dragging, overAwb);
                draftAwbsRef.current = next;
                return next;
            });
        };

        const onEnd = () => finishReorder();

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);

        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reorder.active]);

    useEffect(() => {
        if (draftAwbs === null) return;
        if (!Array.isArray(draftAwbs)) return;
        if (draftAwbs.join('|') === routeAwbs.join('|')) {
            setDraftAwbs(null);
            draftAwbsRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeAwbs.join('|')]);

    const ensureGeocodedStops = async () => {
        if (!routeStops || routeStops.length === 0) return;
        try {
            let stopsForGeocode = routeStops;
        // If AWBs were created from draft plans and details are missing, force one backend refresh
        // so map geocoding has real addresses instead of placeholder "Unknown" rows.
        const unknownRows = stopsForGeocode.filter((s) => {
            const hasAddress = String(s?.delivery_address || '').trim();
            const hasLocality = String(s?.locality || s?.raw_data?.recipientLocation?.localityName || s?.raw_data?.recipientPin?.localityName || '').trim();
            return !hasAddress && !hasLocality;
        });
        if (unknownRows.length > 0) {
            try {
                const hydration = await fetchMissingRouteShipments({ forceRefresh: true });
                if (hydration?.changed && Array.isArray(hydration.fetched) && hydration.fetched.length > 0) {
                    const freshByAwb = new Map();
                    hydration.fetched.forEach((row) => {
                        const awb = String(row?.awb || '').trim().toUpperCase();
                        if (awb) freshByAwb.set(awb, row);
                    });
                    stopsForGeocode = stopsForGeocode.map((s) => {
                        const awb = String(s?.awb || '').trim().toUpperCase();
                        return freshByAwb.get(awb) || s;
                    });
                }
            } catch (e) {
                console.warn('Failed to refresh missing AWB details before geocoding', e);
            }
        }

        const total = stopsForGeocode.length;
        const existing = coordsByAwb || {};
        const preload = {};
        const batchCoordsByAwb = {};
        const queue = [];
        let done = 0;

        const batchAwbs = stopsForGeocode
            .map((s) => String(s?.awb || '').trim().toUpperCase())
            .filter(Boolean);
        if (batchAwbs.length > 0 && user?.token) {
            try {
                const batch = await geocodeShipmentsBatch(user?.token, batchAwbs, { refresh_missing: true });
                const points = Array.isArray(batch?.points) ? batch.points : [];
                points.forEach((p) => {
                    const awb = String(p?.awb || '').trim().toUpperCase();
                    const lat = Number(p?.lat);
                    const lon = Number(p?.lon);
                    if (!awb || !isValidCoord(lat) || !isValidCoord(lon)) return;
                    const normalized = normalizeRomaniaCoordPair(lat, lon);
                    if (!normalized) return;
                    const source = String(p?.source || 'db').trim();
                    batchCoordsByAwb[awb] = {
                        lat: Number(normalized.lat),
                        lon: Number(normalized.lon),
                        ts: Date.now(),
                        source: `batch:${source || 'db'}`,
                        fallback: isFallbackGeoSource(source),
                    };
                });
            } catch (e) {
                console.warn('Batch shipment geocoding failed; continuing with per-address geocode.', e);
            }
        }

        for (const s of stopsForGeocode) {
            const awb = String(s?.awb || '').toUpperCase();
            if (!awb) {
                done += 1;
                continue;
            }

            const hintsBase = buildGeocodeHints(s);
            const routeCountyHint = String(route?.county || '').trim();
            const hints = {
                ...hintsBase,
                expectedCounty: String(hintsBase?.expectedCounty || '').trim() || routeCountyHint,
            };
            const needsConfirmation = stopNeedsLocationConfirmation(s);
            let query = buildGeocodeQuery(s);
            if (routeCountyHint) {
                const q = String(query || '');
                if (!q.toLowerCase().includes(routeCountyHint.toLowerCase())) {
                    const clean = q.replace(/\s*,\s*romania\s*$/i, '').trim();
                    query = [clean, routeCountyHint, 'Romania'].filter(Boolean).join(', ');
                }
            }
            const source = s?.geocode_source || s?.source || s?.provider;
            const shipmentSourceFallback = isFallbackGeoSource(source);
            const directAllowed = !stopNeedsLocationConfirmation(s) || isTrustedDirectGeoSource(source);
            const direct = directAllowed ? extractShipmentCoords(s) : null;

            const fromBatch = batchCoordsByAwb[awb];
            if (fromBatch && !fromBatch.fallback && isValidCoord(fromBatch.lat) && isValidCoord(fromBatch.lon)) {
                preload[awb] = { ...fromBatch, q: query };
                done += 1;
                continue;
            }

            // Already has coordinates?
            const normalizedDirect = direct ? normalizeRomaniaCoordPair(direct.lat, direct.lon) : null;
            if (!shipmentSourceFallback && normalizedDirect && isValidCoord(normalizedDirect.lat) && isValidCoord(normalizedDirect.lon)) {
                preload[awb] = { lat: Number(normalizedDirect.lat), lon: Number(normalizedDirect.lon), ts: Date.now(), source: 'shipment', q: query };
                done += 1;
                continue;
            }

            if (needsConfirmation) {
                const fb = fallbackCoordForStop(s, route?.county);
                preload[awb] = {
                    lat: Number(fb.lat),
                    lon: Number(fb.lon),
                    ts: Date.now(),
                    source: String(fb.source || 'fallback-incomplete-address'),
                    fallback: true,
                    q: query,
                };
                done += 1;
                continue;
            }

            // Cached in state?
            const fromState = existing[awb];
            const stateSourceFallback = isFallbackGeoSource(fromState?.source || fromState?.provider);
            if (fromState && !stateSourceFallback && (!fromState.q || fromState.q === query) && isValidCoord(fromState.lat) && isValidCoord(fromState.lon)) {
                if (!fromState.q) preload[awb] = { ...fromState, q: query };
                done += 1;
                continue;
            }

            // Cached in localStorage (fast, no network).
            const fromCache = getCachedGeocode(query, hints);
            if (fromCache) {
                const cacheFallback = isFallbackGeoSource(fromCache?.provider || fromCache?.source);
                if (!cacheFallback && isValidCoord(fromCache.lat) && isValidCoord(fromCache.lon)) {
                    preload[awb] = {
                        lat: Number(fromCache.lat),
                        lon: Number(fromCache.lon),
                        ts: Number(fromCache.ts || Date.now()),
                        source: 'cache',
                        q: query
                    };
                    done += 1;
                    continue;
                }
                // We may have a strict-hints negative cache; check a relaxed cache before queueing retry.
                const relaxedCache = getCachedGeocode(query, {});
                const relaxedFallback = isFallbackGeoSource(relaxedCache?.provider || relaxedCache?.source);
                if (relaxedCache && !relaxedFallback && isValidCoord(relaxedCache.lat) && isValidCoord(relaxedCache.lon)) {
                    preload[awb] = {
                        lat: Number(relaxedCache.lat),
                        lon: Number(relaxedCache.lon),
                        ts: Number(relaxedCache.ts || Date.now()),
                        source: 'cache-relaxed',
                        q: query
                    };
                    done += 1;
                    continue;
                }
            }

            const normalizedQuery = String(query || '').trim().toLowerCase();
            if (!String(query || '').trim() || normalizedQuery === 'romania') {
                const fb = fallbackCoordForStop(s, route?.county);
                preload[awb] = {
                    lat: Number(fb.lat),
                    lon: Number(fb.lon),
                    ts: Date.now(),
                    source: String(fb.source || 'fallback-local'),
                    q: query,
                };
                done += 1;
                continue;
            }

            queue.push({ awb, query, hints });
        }

        if (Object.keys(preload).length > 0) {
            setCoordsByAwb((prev) => ({ ...prev, ...preload }));
        }

        if (queue.length === 0) {
            setGeocoding({ active: false, done: total, total, current: '' });
            return;
        }

        setGeocoding({ active: true, done, total, current: '' });

        let batch = {};
        let batchCount = 0;
        let lastFlushAt = Date.now();

        const flush = () => {
            if (Object.keys(batch).length === 0) return;
            const payload = batch;
            batch = {};
            batchCount = 0;
            lastFlushAt = Date.now();
            setCoordsByAwb((prev) => ({ ...prev, ...payload }));
        };

        for (const item of queue) {
            const { awb, query, hints } = item;
            setGeocoding({ active: true, done, total, current: awb });

            let res = null;
            try {
                res = await geocodeAddress(query, hints, user?.token);
                if ((!res || !isValidCoord(res?.lat) || !isValidCoord(res?.lon)) && (hints?.expectedLocality || hints?.expectedCounty)) {
                    // Fallback geocode without strict locality/county matching to avoid dropping valid points.
                    res = await geocodeAddress(query, {}, user?.token);
                }
            } catch (error) {
                console.warn(`Failed geocoding stop ${awb}`, error);
            }
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                batch[awb] = { lat: Number(res.lat), lon: Number(res.lon), ts: Date.now(), source: 'geocode', q: query };
                batchCount += 1;
            } else {
                const stop = stopsForGeocode.find((s) => String(s?.awb || '').trim().toUpperCase() === awb) || null;
                const localityQuery = buildLocalityFallbackQuery(stop, route?.county);
                if (localityQuery) {
                    try {
                        let localRes = await geocodeAddress(localityQuery, {
                            expectedLocality: String(hints?.expectedLocality || '').trim(),
                            expectedCounty: String(hints?.expectedCounty || '').trim() || String(route?.county || '').trim().toLowerCase(),
                        }, user?.token);
                        if ((!localRes || !isValidCoord(localRes?.lat) || !isValidCoord(localRes?.lon)) && (hints?.expectedLocality || hints?.expectedCounty)) {
                            localRes = await geocodeAddress(localityQuery, {}, user?.token);
                        }
                        if (localRes && isValidCoord(localRes.lat) && isValidCoord(localRes.lon)) {
                            batch[awb] = {
                                lat: Number(localRes.lat),
                                lon: Number(localRes.lon),
                                ts: Date.now(),
                                source: 'geocode-locality',
                                q: localityQuery,
                            };
                            batchCount += 1;
                            done += 1;
                            const elapsed = Date.now() - lastFlushAt;
                            if (batchCount >= 3 || elapsed > 300) flush();
                            continue;
                        }
                    } catch (error) {
                        console.warn(`Locality geocode fallback failed for ${awb}`, error);
                    }
                }

                const fb = fallbackCoordForStop(stop, route?.county);
                batch[awb] = {
                    lat: Number(fb.lat),
                    lon: Number(fb.lon),
                    ts: Date.now(),
                    source: String(fb.source || 'fallback-local'),
                    q: query,
                };
                batchCount += 1;
            }

            done += 1;

            const elapsed = Date.now() - lastFlushAt;
            if (batchCount >= 3 || elapsed > 300) flush();
        }

        flush();
        setGeocoding({ active: false, done, total, current: '' });
        } catch (error) {
            console.warn('ensureGeocodedStops failed unexpectedly; applying deterministic fallback coords.', error);
            const emergency = {};
            (Array.isArray(routeStops) ? routeStops : []).forEach((s) => {
                const awb = String(s?.awb || '').trim().toUpperCase();
                if (!awb) return;
                const fb = fallbackCoordForStop(s, route?.county);
                emergency[awb] = {
                    lat: Number(fb.lat),
                    lon: Number(fb.lon),
                    ts: Date.now(),
                    source: String(fb.source || 'fallback-emergency'),
                    q: '',
                };
            });
            if (Object.keys(emergency).length > 0) {
                setCoordsByAwb((prev) => ({ ...prev, ...emergency }));
            }
            setGeocoding({ active: false, done: 0, total: (Array.isArray(routeStops) ? routeStops.length : 0), current: '' });
        }
    };

    const recomputeRouteGeometry = async (stopsWithCoords) => {
        const stops = Array.isArray(stopsWithCoords) ? stopsWithCoords : [];
        const points = [];

        const originPoint = (warehouseOrigin && isValidCoord(warehouseOrigin.lat) && isValidCoord(warehouseOrigin.lon))
            ? { lat: Number(warehouseOrigin.lat), lon: Number(warehouseOrigin.lon) }
            : null;

        if (originPoint) points.push(originPoint);

        stops.forEach((s) => {
            if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                points.push({ lat: Number(s.latitude), lon: Number(s.longitude) });
            }
        });

        // Close the loop back to base (trucks return to warehouse each night).
        if (originPoint && points.length > 1) points.push(originPoint);

        if (points.length < 2) {
            setRouteGeometry(null);
            setRouteMetrics({
                distance_km: null,
                duration_min: null,
                duration_no_traffic_min: null,
                delay_min: null,
                provider: null
            });
            return;
        }

        const details = await getRouteMultiDetails(points, { requireGoogleTraffic: true });
        if (!details) {
            setRouteMetrics((prev) => ({
                distance_km: prev?.distance_km ?? null,
                duration_min: prev?.duration_min ?? null,
                duration_no_traffic_min: prev?.duration_no_traffic_min ?? null,
                delay_min: prev?.delay_min ?? null,
                provider: 'google_traffic_unavailable'
            }));
            return;
        }

        if (details?.geometry) {
            setRouteGeometry(details.geometry);
        }

        const meters = Number(details?.distance_m || 0);
        const seconds = Number(details?.duration_s || 0);
        const secondsNoTraffic = Number(details?.duration_no_traffic_s || 0);
        const delaySeconds = Number(details?.delay_s || Math.max(0, seconds - secondsNoTraffic));
        setRouteMetrics({
            distance_km: meters > 0 ? Math.round((meters / 1000) * 10) / 10 : null,
            duration_min: seconds > 0 ? Math.round(seconds / 60) : null,
            duration_no_traffic_min: secondsNoTraffic > 0 ? Math.round(secondsNoTraffic / 60) : null,
            delay_min: delaySeconds > 0 ? Math.round(delaySeconds / 60) : 0,
            provider: details?.provider || null
        });
    };

    useEffect(() => {
        if (viewMode !== 'map') return;
        // If stops change while map view is open (new AWB added), geocode missing ones.
        (async () => {
            await ensureGeocodedStops();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, routeAwbs.join('|')]);

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (geocoding.active) return;
        if (reorder.active) return;
        recomputeRouteGeometry(routeStopsForMap);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, geocoding.active, reorder.active, routeStopsCoordsSignature]);

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (geocoding.active || reorder.active) return;

        const timer = setInterval(() => {
            recomputeRouteGeometry(routeStopsForMap);
        }, ROUTE_TRAFFIC_REFRESH_MS);

        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, geocoding.active, reorder.active, routeStopsCoordsSignature]);

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (geocoding.active || reorder.active) return;
        if (mapCoverage.total <= 0 || mapCoverage.missing <= 0) return;

        const now = Date.now();
        const signature = `${String(route?.id || '')}|${routeStopsGeocodeSignature}|${mapCoverage.missing}`;
        const gate = autoGeocodeRef.current || { lastAt: 0, lastSignature: '' };
        const elapsed = now - Number(gate.lastAt || 0);
        if (signature === gate.lastSignature && elapsed < AUTO_GEOCODE_REPEAT_WINDOW_MS) return;
        if (elapsed < AUTO_GEOCODE_MIN_GAP_MS) return;

        autoGeocodeRef.current = { lastAt: now, lastSignature: signature };
        (async () => {
            await ensureGeocodedStops();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, geocoding.active, reorder.active, mapCoverage.total, mapCoverage.missing, route?.id, routeStopsGeocodeSignature]);

    const optimizeOrder = async () => {
        if (!route || !canEditRoute) return;
        setRouteOptimizeBusy(true);
        setDraftAwbs(null);
        draftAwbsRef.current = null;

        try {
            if (!geocoding.active && mapCoverage.missing > 0) {
                await ensureGeocodedStops();
            }

            const stops = routeStopsForMap
            .map((s) => {
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) return null;
                if ((Boolean(s?.geo_fallback) || stopNeedsLocationConfirmation(s)) && isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                    return { awb, lat: Number(s.latitude), lon: Number(s.longitude) };
                }
                const direct = extractShipmentCoords(s);
                const directFallback = isFallbackGeoSource(s?.geocode_source || s?.source || s?.provider);
                const query = buildGeocodeQuery(s);
                const hints = buildGeocodeHints(s);
                const fromState = coordsByAwb[awb];
                const fromCache = getCachedGeocode(query, hints);
                const lat = (!directFallback ? direct?.lat : null)
                    ?? (isValidCoord(fromState?.lat) ? Number(fromState.lat) : null)
                    ?? (isValidCoord(fromCache?.lat) ? Number(fromCache.lat) : null)
                    ?? (isValidCoord(s?.latitude) ? Number(s.latitude) : null);
                const lon = (!directFallback ? direct?.lon : null)
                    ?? (isValidCoord(fromState?.lon) ? Number(fromState.lon) : null)
                    ?? (isValidCoord(fromCache?.lon) ? Number(fromCache.lon) : null)
                    ?? (isValidCoord(s?.longitude) ? Number(s.longitude) : null);
                if (!isValidCoord(lat) || !isValidCoord(lon)) return null;
                return { awb, lat: Number(lat), lon: Number(lon) };
            })
            .filter(Boolean);

        if (stops.length < 2) {
            setAddAwbNotice('Not enough stops with valid coordinates to optimize.');
            return;
        }

        const preOptimizeMetrics = { ...routeMetrics };

        const start = warehouseOrigin && isValidCoord(warehouseOrigin.lat) && isValidCoord(warehouseOrigin.lon)
            ? { lat: Number(warehouseOrigin.lat), lon: Number(warehouseOrigin.lon) }
            : { lat: stops[0].lat, lon: stops[0].lon };

        let orderedAwbs = [];
        let usedGoogle = false;
        const googleOptimized = await optimizeStopsOrder(start, stops, {
            returnToOrigin: Boolean(warehouseOrigin && isValidCoord(warehouseOrigin.lat) && isValidCoord(warehouseOrigin.lon)),
        });
        if (Array.isArray(googleOptimized?.optimized_order) && googleOptimized.optimized_order.length === stops.length) {
            const orderedGoogle = [];
            const seen = new Set();
            googleOptimized.optimized_order.forEach((idx) => {
                const n = Number(idx);
                if (!Number.isInteger(n) || n < 0 || n >= stops.length) return;
                const item = stops[n];
                if (!item?.awb || seen.has(item.awb)) return;
                seen.add(item.awb);
                orderedGoogle.push(item);
            });
            if (orderedGoogle.length === stops.length) {
                usedGoogle = true;
                orderedAwbs = orderedGoogle.map((s) => s.awb);
                if (googleOptimized?.geometry) setRouteGeometry(googleOptimized.geometry);
                const meters = Number(googleOptimized?.distance_m || 0);
                const seconds = Number(googleOptimized?.duration_s || 0);
                const secondsNoTraffic = Number(googleOptimized?.duration_no_traffic_s || 0);
                const delaySeconds = Number(googleOptimized?.delay_s || Math.max(0, seconds - secondsNoTraffic));
                setRouteMetrics({
                    distance_km: meters > 0 ? Math.round((meters / 1000) * 10) / 10 : null,
                    duration_min: seconds > 0 ? Math.round(seconds / 60) : null,
                    duration_no_traffic_min: secondsNoTraffic > 0 ? Math.round(secondsNoTraffic / 60) : null,
                    delay_min: delaySeconds > 0 ? Math.round(delaySeconds / 60) : 0,
                    provider: String(googleOptimized?.provider || 'google_traffic')
                });
            }
        }

        if (!usedGoogle) {
            const ordered = optimizeRoundTripOrder(start, stops);
            orderedAwbs = ordered.map((s) => s.awb);
        }

        const otherAwbs = routeAwbs.filter((awb) => !orderedAwbs.includes(String(awb).toUpperCase()));
        const updated = setRouteAwbOrder(route.id, [...orderedAwbs, ...otherAwbs]);
        setRoute(updated);
        
        // Calculate savings if we used Google Traffic with metrics
        if (usedGoogle && googleOptimized) {
            const newMeters = Number(googleOptimized.distance_m || 0);
            const newSeconds = Number(googleOptimized.duration_s || 0);
            const newDistKm = newMeters > 0 ? Math.round((newMeters / 1000) * 10) / 10 : null;
            const newDurMin = newSeconds > 0 ? Math.round(newSeconds / 60) : null;
            
            if (preOptimizeMetrics.distance_km && newDistKm && preOptimizeMetrics.distance_km > newDistKm) {
                const savedKm = Math.round((preOptimizeMetrics.distance_km - newDistKm) * 10) / 10;
                const savedMin = (preOptimizeMetrics.duration_min && newDurMin && preOptimizeMetrics.duration_min > newDurMin) 
                    ? (preOptimizeMetrics.duration_min - newDurMin) 
                    : 0;
                setOptimizedSavings({ savedKm, savedMin });
            } else {
                setOptimizedSavings(null);
            }
        }

        setAddAwbNotice(
            usedGoogle
                ? 'Ordinea opririlor a fost optimizata cu Google Traffic live.'
                : 'Ordinea opririlor a fost optimizata local (fallback).'
        );
        } catch (e) {
            setAddAwbNotice('Eroare optimizare: ' + e.message);
        } finally {
            setRouteOptimizeBusy(false);
        }
    };

    const openGoogleMaps = () => {
        const toAddressTarget = (stop) => {
            const parts = [
                String(stop?.delivery_address || '').trim(),
                String(stop?.locality || stop?.raw_data?.recipientLocation?.localityName || stop?.raw_data?.recipientPin?.localityName || '').trim(),
                String(stop?.county || stop?.raw_data?.recipientLocation?.countyName || '').trim(),
                'Romania'
            ].filter(Boolean);
            return parts.length ? parts.join(', ') : '';
        };

        const allStops = routeStopsForMap
            .map((s) => {
                if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                    return `${Number(s.latitude)},${Number(s.longitude)}`;
                }
                return toAddressTarget(s);
            })
            .map((x) => String(x || '').trim())
            .filter(Boolean);

        if (allStops.length === 0) return;

        const hasOrigin = (warehouseOrigin && isValidCoord(warehouseOrigin.lat) && isValidCoord(warehouseOrigin.lon));
        const origin = hasOrigin
            ? `${Number(warehouseOrigin.lat)},${Number(warehouseOrigin.lon)}`
            : allStops[0];

        const maxStopsInSingleGoogleRoute = GOOGLE_MAX_WAYPOINTS + 1; // waypoints + destination
        const chunks = [];
        for (let i = 0; i < allStops.length; i += maxStopsInSingleGoogleRoute) {
            chunks.push(allStops.slice(i, i + maxStopsInSingleGoogleRoute));
        }

        chunks.forEach((stops, idx) => {
            if (!Array.isArray(stops) || stops.length === 0) return;

            const segmentOrigin = idx === 0
                ? origin
                : (allStops[(idx * maxStopsInSingleGoogleRoute) - 1] || origin);
            const isSingleChunk = chunks.length === 1;
            const roundTrip = hasOrigin && isSingleChunk && stops.length <= GOOGLE_MAX_WAYPOINTS;

            const url = new URL('https://www.google.com/maps/dir/');
            url.searchParams.set('api', '1');
            url.searchParams.set('travelmode', 'driving');
            url.searchParams.set('dir_action', 'navigate');
            url.searchParams.set('origin', segmentOrigin);

            if (roundTrip) {
                url.searchParams.set('destination', origin);
                url.searchParams.set('waypoints', stops.join('|'));
            } else {
                const destination = stops[stops.length - 1];
                url.searchParams.set('destination', destination);
                const waypoints = (idx === 0 && !hasOrigin)
                    ? stops.slice(1, -1)
                    : stops.slice(0, -1);
                if (waypoints.length > 0) url.searchParams.set('waypoints', waypoints.join('|'));
            }

            window.open(url.toString(), '_blank', 'noopener,noreferrer');
        });

        if (chunks.length > 1) {
            setAddAwbNotice(`Ruta are ${allStops.length} opriri. Am deschis ${chunks.length} segmente Google Maps cu toate opririle.`);
        }
    };

    if (!route) {
        return (
            <div className="min-h-screen flex items-center justify-center text-slate-400">
                Route not found or access denied.
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10">
                        <ArrowLeft />
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="font-black text-xl text-gradient tracking-tight truncate">{routeDisplayName(route)}</h1>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mt-1">
                            {route.date} • {routeAwbs.length} stops{route.county ? ` • ${route.county}` : (route.name ? ` • ${route.name}` : '')}
                        </p>
                    </div>

                    {/* View Toggle */}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={loadHistory}
                            className="p-2 rounded-xl bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 shadow-glow-sm border border-orange-500/20 active:scale-95 transition-all flex items-center gap-1.5"
                            title="Istoric Traseu"
                        >
                            <Clock size={20} />
                        </button>

                        {canRunRoute ? (
                            <button
                                type="button"
                                onClick={() => navigate(`/routes/${routeId}/run`)}
                                className="p-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white shadow-glow-sm border border-white/10 active:scale-95 transition-all"
                                title="Run route"
                                aria-label="Run route"
                            >
                                <Play size={20} />
                            </button>
                        ) : null}

                        <div className="flex glass-strong p-1 rounded-xl border border-white/10">
                            {canEditRoute && route?.source_plan_id ? (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        if (!route?.source_plan_id) return;
                                        try {
                                            setAddAwbNotice('Se salveaza modficarile in sistem...');
                                            await apiUpdateRoutePlanAwbs(user?.token, route.source_plan_id, routeAwbs);
                                            setAddAwbNotice('Modificari salvate cu succes in server.');
                                        } catch (e) {
                                            console.warn('Eroare la salvare', e);
                                            setAddAwbNotice('Eroare la salvarea modificarilor in backend.');
                                        }
                                    }}
                                    className="p-2 mr-2 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/40 hover:text-white transition-all shadow-glow-sm"
                                    title="Salveaza Modificari (Sincronizeaza Backend)"
                                >
                                    <Save size={20} />
                                </button>
                            ) : null}
                            <button
                                onClick={() => setViewMode('list')}
                                className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                            >
                                <List size={20} />
                            </button>
                            <button
                                onClick={() => setViewMode('map')}
                                className={`p-2 rounded-lg transition-all ${viewMode === 'map' ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                            >
                                <MapIcon size={20} />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="px-4 pb-2 space-y-3">
                    <div className="glass-strong rounded-2xl border border-white/10 p-4 space-y-3">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                                <Truck size={18} className="text-emerald-300" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em]">Truck & Crew</p>
                                <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                    Route title = plate + driver (+ helper)
                                </p>
                            </div>
                            {(driversLoading || fleetLoading) && (
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">
                                    Loading...
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <div className="glass-light rounded-2xl border border-white/10 p-3">
                                <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Plate</p>
                                {canEditRoute ? (
                                    <select
                                        value={String(vehiclePlate || route?.vehicle_plate || '').trim().toUpperCase()}
                                        onChange={(e) => assignVehicle(e.target.value)}
                                        className="w-full bg-transparent outline-none text-white text-xs font-black"
                                    >
                                        <option value="">Unassigned</option>
                                        {availableFleetVehicles.map((v) => {
                                            const plate = String(v?.plate || '').trim().toUpperCase();
                                            if (!plate) return null;
                                            const type = String(v?.vehicle_type_code || '').trim().toUpperCase();
                                            const drv = String(v?.assigned_driver_name || '').trim();
                                            return (
                                                <option key={plate} value={plate}>
                                                    {plate}{type ? ` • ${type}` : ''}{drv ? ` • ${drv}` : ''}
                                                </option>
                                            );
                                        })}
                                    </select>
                                ) : (
                                    <p className="text-white font-mono text-sm tracking-wider truncate">
                                        {String(route?.vehicle_plate || vehiclePlate || '').trim().toUpperCase() || 'Unassigned'}
                                    </p>
                                )}
                            </div>

                            <div className="glass-light rounded-2xl border border-white/10 p-3">
                                <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Driver</p>
                                {canReadUsers && canEditRoute ? (
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={String(route?.driver_id || '').trim().toUpperCase()}
                                            onChange={(e) => assignDriver(e.target.value)}
                                            className="w-full bg-transparent outline-none text-white text-xs font-bold"
                                        >
                                            <option value="">Unassigned</option>
                                            {(() => {
                                                const current = String(route?.driver_id || '').trim().toUpperCase();
                                                const hasCurrent = current && availableDrivers.some((d) => String(d?.driver_id || '').trim().toUpperCase() === current);
                                                if (current && !hasCurrent) {
                                                    const currentName = String(route?.driver_name || driverName || '').trim();
                                                    return <option value={current}>{currentName || 'Current driver'}</option>;
                                                }
                                                return null;
                                            })()}
                                            {availableDrivers.map((d) => (
                                                <option key={d.driver_id} value={String(d.driver_id || '').trim().toUpperCase()}>
                                                    {String(d.name || '').trim() || 'Unnamed'}
                                                </option>
                                            ))}
                                        </select>
                                        {canWriteUsers && (
                                            <button
                                                type="button"
                                                onClick={() => navigate(`/users?create=1&role=Driver&returnTo=${encodeURIComponent(`/routes/${routeId}`)}`)}
                                                className="p-2 rounded-xl glass-strong border border-white/10 text-emerald-300 hover:bg-emerald-500/10 active:scale-95 transition-all"
                                                title="Add driver"
                                                aria-label="Add driver"
                                            >
                                                <Plus size={16} />
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-white text-sm font-bold truncate">
                                        {String(route?.driver_name || driverName || '').trim() || 'Unassigned'}
                                    </p>
                                )}
                            </div>

                            <div className="glass-light rounded-2xl border border-white/10 p-3 col-span-2">
                                <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Helper</p>
                                {canReadUsers && canEditRoute ? (
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={String(helperName || '').trim()}
                                            onChange={(e) => assignHelper(e.target.value)}
                                            className="w-full bg-transparent outline-none text-white text-xs font-bold"
                                        >
                                            <option value="">Unassigned</option>
                                            {(() => {
                                                const current = String(helperName || '').trim();
                                                const hasCurrent = current && helperOptions.some((h) => String(h || '').trim().toLowerCase() === current.toLowerCase());
                                                if (current && !hasCurrent) {
                                                    return <option value={current}>{current}</option>;
                                                }
                                                return null;
                                            })()}
                                            {helperOptions.map((h) => (
                                                <option key={String(h).toLowerCase()} value={h}>{h}</option>
                                            ))}
                                        </select>
                                        {canWriteUsers && (
                                            <button
                                                type="button"
                                                onClick={() => { setAddHelperOpen(true); setAddHelperName(''); setAddHelperError(''); }}
                                                className="p-2 rounded-xl glass-strong border border-white/10 text-emerald-300 hover:bg-emerald-500/10 active:scale-95 transition-all"
                                                title="Add helper"
                                                aria-label="Add helper"
                                            >
                                                <Plus size={16} />
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-white text-sm font-bold truncate">
                                        {String(route?.helper_name || helperName || '').trim() || 'Unassigned'}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="glass-light rounded-2xl border border-white/10 p-3">
                            <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Capacity</p>
                            <p className="text-[11px] text-slate-300 font-black">
                                {(() => {
                                    const typeCode = String(route?.vehicle_type_code || '').trim().toUpperCase() || 'VAN_35T';
                                    const volCap = Number(route?.target_volume_m3 ?? route?.max_volume_m3);
                                    const kgCap = Number(route?.target_weight_kg ?? route?.max_weight_kg);
                                    const volLoad = Number(route?.load_volume_m3);
                                    const kgLoad = Number(route?.load_weight_kg);
                                    const volCapTxt = Number.isFinite(volCap) && volCap > 0 ? `${volCap.toFixed(1)} mc` : 'n/a';
                                    const kgCapTxt = Number.isFinite(kgCap) && kgCap > 0 ? `${Math.round(kgCap)} kg` : 'n/a';
                                    const volLoadTxt = Number.isFinite(volLoad) && volLoad > 0 ? `${volLoad.toFixed(1)} mc` : '0 mc';
                                    const kgLoadTxt = Number.isFinite(kgLoad) && kgLoad > 0 ? `${Math.round(kgLoad)} kg` : '0 kg';
                                    return `${typeCode} • ${volLoadTxt}/${volCapTxt} • ${kgLoadTxt}/${kgCapTxt}`;
                                })()}
                            </p>
                        </div>
                    </div>

                    {canEditRoute ? (
                        <>
                            <div className="grid grid-cols-4 gap-2">
                                <input
                                    value={addAwb}
                                    onChange={(e) => setAddAwb(e.target.value)}
                                    placeholder="Add AWB..."
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            void handleManualAdd();
                                        }
                                    }}
                                    className="col-span-2 w-full px-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-emerald-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                                />
                                <button
                                    onClick={() => { void handleManualAdd(); }}
                                    className="btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                                >
                                    <Plus size={18} />
                                    Add
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setScannerOpen(true)}
                                    className="py-3 glass-strong border border-white/10 rounded-2xl text-emerald-300 font-black text-[10px] uppercase tracking-widest hover:bg-emerald-500/10 active:scale-[0.99] transition-all flex items-center justify-center gap-1.5"
                                    title="Scan AWB"
                                >
                                    <ScanLine size={16} />
                                    Scan
                                </button>
                            </div>
                            {addAwbNotice ? (
                                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-300 px-1">
                                    {addAwbNotice}
                                </div>
                            ) : null}

                            <div className="relative group">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-emerald-400 transition-colors z-10" size={18} />
                                <input
                                    type="text"
                                    placeholder="Search shipments to add..."
                                    className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-emerald-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>

                            {search && filteredAdd.length > 0 && (
                                <div className="glass-strong rounded-2xl border border-white/10 overflow-hidden">
                                    {filteredAdd.map((s) => (
                                        <button
                                            key={s.awb}
                                            onClick={() => handleAddAwb(s.awb)}
                                            className="w-full p-4 flex items-center gap-3 hover:bg-white/5 transition-all text-left border-b border-white/5 last:border-b-0"
                                        >
                                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                                                <MapPinned size={16} className="text-emerald-400" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate">{s.awb}</p>
                                                <p className="text-sm font-bold text-white truncate">{s.recipient_name || 'Unknown'}</p>
                                                <p className="text-[10px] text-slate-500 font-medium truncate">{s.delivery_address || s.locality || ''}</p>
                                            </div>
                                            <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wide">Add</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : null}
                </div>
            </div>

            <div className="flex-1 p-4 space-y-3 pb-32 relative z-10">
                {viewMode === 'map' ? (
                    <div className="space-y-3">
                        <div className="glass-strong rounded-2xl border border-white/10 p-4 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Route Map</p>
                                <p className="text-[10px] text-slate-500 font-medium truncate">
                                    {geocoding.active
                                        ? `Geocoding ${geocoding.done}/${geocoding.total} (${geocoding.current})`
                                        : (canEditRoute ? 'Tap "Optimize" for a quick route order' : 'View assigned stops and navigation in real-time')}
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold mt-1">
                                    {routeMetrics.distance_km ? `~${routeMetrics.distance_km} km` : 'Distance: N/A'}
                                    {routeMetrics.duration_min ? ` • ~${routeMetrics.duration_min} min` : ''}
                                    {routeMetrics.provider === 'google_traffic' ? ' • Traffic live' : ''}
                                </p>
                                <p className="text-[10px] text-slate-300 font-black mt-1">
                                    {routeMetrics.provider === 'google_traffic'
                                        ? `Trafic live: ACTIV • Intarziere estimata: +${Number(routeMetrics.delay_min || 0)} min`
                                        : 'Trafic live: sincronizare automata in curs...'}
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold mt-1">
                                    Refresh trafic Google: automat la fiecare {Math.round(ROUTE_TRAFFIC_REFRESH_MS / 60000)} min
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold mt-1">
                                    Puncte pe harta: {mapCoverage.withCoords}/{mapCoverage.total}
                                    {mapCoverage.missing > 0 ? ` • fara coordonate: ${mapCoverage.missing}` : ' • toate punctele sunt vizibile'}
                                </p>
                                {mapCoverage.total > 0 ? (
                                    <p className="text-[10px] text-slate-400 font-bold mt-1">
                                        Precizie coordonate: exacte {mapCoverage.exact}/{mapCoverage.total}
                                        {mapCoverage.estimated > 0 ? ` • aproximate ${mapCoverage.estimated}` : ''}
                                    </p>
                                ) : null}
                                {needsLocationConfirmCount > 0 ? (
                                    <p className="text-[10px] text-amber-300 font-black mt-1">
                                        Opriri cu adresa incompleta: {needsLocationConfirmCount} • soferul trebuie sa contacteze clientul pentru locatia exacta
                                    </p>
                                ) : null}
                                {optimizedSavings && (
                                    <div className="mt-2 inline-flex items-center gap-2 bg-emerald-500/20 border border-emerald-500/30 px-3 py-1.5 rounded-xl">
                                        <Wand2 size={14} className="text-emerald-400" />
                                        <span className="text-xs font-black text-emerald-300">
                                            Optimizare: salvati {optimizedSavings.savedKm} km {optimizedSavings.savedMin > 0 ? `si ${optimizedSavings.savedMin} min` : ''}!
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={ensureGeocodedStops}
                                    className={`p-2 rounded-xl glass-light border border-white/10 text-emerald-400 hover:bg-emerald-500/10 active:scale-95 transition-all ${geocoding.active ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    disabled={geocoding.active}
                                    title="Geocode stops"
                                >
                                    <RefreshCw size={18} className={geocoding.active ? 'animate-spin' : ''} />
                                </button>
                                {canEditRoute ? (
                                    <>
                                        <button
                                            onClick={reverseOrder}
                                            disabled={routeOptimizeBusy || routeStops.length < 2}
                                            className={`p-2 rounded-xl glass-light border border-white/10 text-sky-400 hover:bg-sky-500/10 active:scale-95 transition-all ${routeOptimizeBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                            title="Inversare ruta"
                                        >
                                            <ArrowDownUp size={18} className={routeOptimizeBusy ? 'opacity-50' : ''} />
                                        </button>
                                        <button
                                            onClick={optimizeOrder}
                                            disabled={routeOptimizeBusy || routeStops.length < 2}
                                            className={`p-2 rounded-xl glass-light border border-white/10 text-amber-400 hover:bg-amber-500/10 active:scale-95 transition-all ${routeOptimizeBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                            title="Optimize order"
                                        >
                                            {routeOptimizeBusy ? <Loader2 size={18} className="animate-spin" /> : <Wand2 size={18} />}
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    onClick={openGoogleMaps}
                                    className="p-2 rounded-xl glass-light border border-white/10 text-slate-200 hover:bg-white/10 active:scale-95 transition-all"
                                    title="Open in Google Maps"
                                >
                                    <ExternalLink size={18} />
                                </button>
                            </div>
                        </div>

                        <div className="h-[70vh] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl">
                            <MapComponent
                                shipments={routeStopsForMap}
                                currentLocation={mapLocation}
                                originLocation={warehouseOrigin}
                                routeGeometry={routeGeometry}
                                showStopNumbers
                                showTraffic
                                trafficProvider={routeMetrics.provider}
                                returnToOrigin
                                onOpenStopDetails={openStopDetails}
                            />
                        </div>

                        <div className="glass-strong rounded-2xl border border-white/10 p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Stops</p>
                                    <p className="text-[10px] text-slate-500 font-medium truncate">
                                        {canEditRoute
                                            ? 'Drag the handle to reorder stops. Numbers on the map update automatically.'
                                            : 'Stops are read-only for drivers. Follow route order and complete deliveries.'}
                                    </p>
                                </div>
                                {canEditRoute && reorder.active && (
                                    <span className="text-[10px] font-black uppercase tracking-widest text-amber-300">
                                        Reordering…
                                    </span>
                                )}
                            </div>

                            <div className="mt-3 space-y-2 max-h-[58vh] overflow-y-auto pr-1">
                                {routeStops.map((s, idx) => {
                                    const awb = String(s?.awb || '').toUpperCase();
                                    const isDragging = reorder.active && reorder.dragging === awb;
                                    const isOver = reorder.active && reorder.over === awb;
                                    return (
                                        <div
                                            key={awb || idx}
                                            data-stop-awb={awb}
                                            onClick={() => openStopDetails(s)}
                                            className={`glass-light rounded-2xl border p-3 flex items-center gap-3 cursor-pointer ${isOver ? 'border-emerald-500/40' : 'border-white/10'} ${isDragging ? 'opacity-70' : ''}`}
                                        >
                                            {canEditRoute ? (
                                                <button
                                                    type="button"
                                                    className="p-2 rounded-xl glass-strong border border-white/10 text-slate-200 active:scale-95 transition-all cursor-grab touch-none"
                                                    onPointerDown={(e) => startReorder(awb, e)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    title="Drag to reorder"
                                                    aria-label="Drag to reorder"
                                                >
                                                    <GripVertical size={18} />
                                                </button>
                                            ) : null}

                                            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-300 font-black">
                                                {idx + 1}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <AwbLink
                                                    awb={awb}
                                                    className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate cursor-pointer hover:text-emerald-300"
                                                    title="Deschide detalii AWB"
                                                >
                                                    {awb}
                                                </AwbLink>
                                                <p className="text-sm font-bold text-white truncate mt-1">{s.recipient_name || 'Unknown'}</p>
                                                <p className="text-[10px] text-slate-500 font-medium truncate mt-1">{s.delivery_address || s.locality || ''}</p>
                                                {(() => {
                                                    const locality = String(s?.locality || s?.raw_data?.recipientLocation?.localityName || s?.raw_data?.recipientPin?.localityName || '').trim();
                                                    if (!locality) return null;
                                                    return (
                                                        <p className="inline-flex mt-1 px-2 py-0.5 rounded-full border border-sky-400/40 bg-sky-500/20 text-[10px] font-black uppercase tracking-wide text-sky-100">
                                                            Localitate: {locality}
                                                        </p>
                                                    );
                                                })()}
                                                {stopNeedsLocationConfirmation(s) ? (
                                                    <p className="inline-flex mt-1 px-2 py-0.5 rounded-full border border-amber-400/40 bg-amber-500/20 text-[10px] font-black uppercase tracking-wide text-amber-100">
                                                        Adresa incompleta: contact client
                                                    </p>
                                                ) : null}
                                            </div>

                                            {canEditRoute ? (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleRemoveAwb(awb);
                                                    }}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                    title="Remove from route"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                ) : (
                    <AnimatePresence mode="wait">
                        {routeStops.length === 0 ? (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="text-center py-20 text-slate-400"
                            >
                                <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                    <MapPinned className="text-slate-500" size={36} />
                                </div>
                                <p className="font-bold text-slate-300 text-lg">No stops yet</p>
                                <p className="text-sm mt-2 text-slate-500">
                                    {canEditRoute ? 'Add an AWB above to allocate it to this route' : 'No stops are assigned to this route yet'}
                                </p>
                            </motion.div>
                        ) : (
                            <div className="space-y-3">
                                {routeStops.map((s, idx) => (
                                    <motion.div
                                        key={`${s.awb}-${idx}`}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.02 }}
                                        onClick={() => openStopDetails(s)}
                                        className="glass-strong p-5 rounded-3xl border border-white/10 cursor-pointer"
                                    >
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-black">
                                                {idx + 1}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <AwbLink
                                                    awb={s.awb}
                                                    className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate cursor-pointer hover:text-emerald-300"
                                                    title="Deschide detalii AWB"
                                                >
                                                    {s.awb}
                                                </AwbLink>
                                                <p className="text-sm font-bold text-white truncate mt-1">{s.recipient_name || 'Unknown'}</p>
                                                <p className="text-[10px] text-slate-500 font-medium truncate mt-1">{s.delivery_address || s.locality || ''}</p>
                                                {(() => {
                                                    const locality = String(s?.locality || s?.raw_data?.recipientLocation?.localityName || s?.raw_data?.recipientPin?.localityName || '').trim();
                                                    if (!locality) return null;
                                                    return (
                                                        <p className="inline-flex mt-1 px-2 py-0.5 rounded-full border border-sky-400/40 bg-sky-500/20 text-[10px] font-black uppercase tracking-wide text-sky-100">
                                                            Localitate: {locality}
                                                        </p>
                                                    );
                                                })()}
                                                {stopNeedsLocationConfirmation(s) ? (
                                                    <p className="inline-flex mt-1 px-2 py-0.5 rounded-full border border-amber-400/40 bg-amber-500/20 text-[10px] font-black uppercase tracking-wide text-amber-100">
                                                        Adresa incompleta: contact client
                                                    </p>
                                                ) : null}
                                                {(() => {
                                                    const c =
                                                        s.content_description
                                                        || s?.raw_data?.contentDescription
                                                        || s?.raw_data?.contents
                                                        || s?.raw_data?.content
                                                        || s?.raw_data?.packingList
                                                        || s?.raw_data?.packingListNumber
                                                        || s?.raw_data?.packingListId
                                                        || s?.raw_data?.additionalServices?.packingList
                                                        || s?.raw_data?.additionalServices?.packingListNumber
                                                        || s?.raw_data?.additionalServices?.packingListId
                                                        || '';
                                                    const text = String(c || '').trim();
                                                    if (!text) return null;
                                                    return (
                                                        <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                            {text}
                                                        </p>
                                                    );
                                                })()}
                                                <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                    {(Number.isFinite(Number(s?.number_of_parcels)) ? Number(s.number_of_parcels) : (s?.raw_data?.numberOfDistinctBarcodes || s?.raw_data?.numberOfParcels || 1))}
                                                    {' '}pkg
                                                </p>
                                                <p className="text-[10px] text-emerald-300 font-black mt-1 truncate">
                                                    Courier: {money(s.payment_amount ?? s.shipping_cost ?? s.estimated_shipping_cost, s.currency || 'RON')}
                                                </p>
                                            </div>
                                            {canEditRoute ? (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleRemoveAwb(s.awb);
                                                    }}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                    title="Remove from route"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                            ) : null}
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        )}
                    </AnimatePresence>
                )}
            </div>

            <Modal
                open={Boolean(stopDetailsStop)}
                title="Stop Details"
                onClose={closeStopDetails}
            >
                {stopDetailsStop ? (
                    <div className="space-y-3">
                        <div className="glass-light rounded-2xl border border-white/10 p-3">
                            <AwbLink
                                awb={stopDetailsStop?.awb}
                                className="text-[10px] font-black uppercase tracking-widest text-slate-500 cursor-pointer hover:text-emerald-300"
                                title="Deschide detalii AWB"
                            >
                                {String(stopDetailsStop?.awb || '').trim().toUpperCase() || 'AWB'}
                            </AwbLink>
                            <p className="text-sm text-white font-bold mt-1">
                                {String(stopDetailsStop?.recipient_name || '').trim() || 'Unknown recipient'}
                            </p>
                            <p className="text-[11px] text-slate-400 font-medium mt-1">
                                {String(stopDetailsStop?.delivery_address || '').trim() || '-'}
                            </p>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                {[stopDetailsStop?.locality, stopDetailsStop?.county].filter(Boolean).join(', ') || 'Romania'}
                                {stopDetailsIndex >= 0 ? ` • Stop #${stopDetailsIndex + 1}` : ''}
                            </p>
                            <p className="text-[10px] text-emerald-300 font-black mt-1">
                                COD: {Number.isFinite(Number(stopDetailsStop?.cod_amount || 0)) ? Number(stopDetailsStop.cod_amount).toFixed(2) : '0.00'} {String(stopDetailsStop?.currency || 'RON').toUpperCase()}
                            </p>
                        </div>

                        {canEditRoute ? (
                            <>
                                <div className="grid grid-cols-3 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => reorderStopByDelta(stopDetailsStop?.awb, -1)}
                                        disabled={stopMoveBusy || stopDetailsIndex <= 0}
                                        className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${stopMoveBusy || stopDetailsIndex <= 0 ? 'opacity-50 cursor-not-allowed bg-slate-900/35 border-white/10 text-slate-500' : 'bg-blue-500/15 border-blue-500/30 text-blue-100 hover:bg-blue-500/25'}`}
                                    >
                                        Move Up
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => reorderStopByDelta(stopDetailsStop?.awb, 1)}
                                        disabled={stopMoveBusy || stopDetailsIndex < 0 || stopDetailsIndex >= Math.max(0, routeAwbs.length - 1)}
                                        className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${stopMoveBusy || stopDetailsIndex < 0 || stopDetailsIndex >= Math.max(0, routeAwbs.length - 1) ? 'opacity-50 cursor-not-allowed bg-slate-900/35 border-white/10 text-slate-500' : 'bg-blue-500/15 border-blue-500/30 text-blue-100 hover:bg-blue-500/25'}`}
                                    >
                                        Move Down
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveAwb(stopDetailsStop?.awb, { closeAfter: true })}
                                        disabled={stopMoveBusy}
                                        className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${stopMoveBusy ? 'opacity-50 cursor-not-allowed bg-slate-900/35 border-white/10 text-slate-500' : 'bg-rose-500/15 border-rose-500/30 text-rose-100 hover:bg-rose-500/25'}`}
                                    >
                                        Remove
                                    </button>
                                </div>

                                <div className="glass-light rounded-2xl border border-white/10 p-3 space-y-2">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Move To Existing Route</p>
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={stopMoveTargetRouteId}
                                            onChange={(e) => { setStopMoveTargetRouteId(e.target.value); setStopMoveError(''); }}
                                            className="flex-1 px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        >
                                            <option value="">Select route...</option>
                                            {moveRouteCandidates.map((r) => (
                                                <option key={String(r?.id || '')} value={String(r?.id || '')}>
                                                    {routeDisplayName(r)}{r?.county ? ` • ${String(r.county).trim()}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={() => moveSelectedStopToRoute(stopMoveTargetRouteId)}
                                            disabled={stopMoveBusy || !String(stopMoveTargetRouteId || '').trim()}
                                            className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${stopMoveBusy || !String(stopMoveTargetRouteId || '').trim() ? 'opacity-50 cursor-not-allowed bg-slate-900/35 border-white/10 text-slate-500' : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-100 hover:bg-emerald-500/25'}`}
                                        >
                                            Move
                                        </button>
                                    </div>
                                </div>

                                <div className="glass-light rounded-2xl border border-white/10 p-3 space-y-2">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Move To Another County</p>
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={stopMoveCountyName}
                                            onChange={(e) => { setStopMoveCountyName(e.target.value); setStopMoveError(''); }}
                                            className="flex-1 px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        >
                                            <option value="">Select county...</option>
                                            {moveCountyOptions.map((county) => (
                                                <option key={normalizeCountyKey(county) || county} value={county}>{county}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={createCountyRouteAndMoveSelectedStop}
                                            disabled={stopMoveBusy || !String(stopMoveCountyName || '').trim()}
                                            className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${stopMoveBusy || !String(stopMoveCountyName || '').trim() ? 'opacity-50 cursor-not-allowed bg-slate-900/35 border-white/10 text-slate-500' : 'bg-amber-500/15 border-amber-500/30 text-amber-100 hover:bg-amber-500/25'}`}
                                        >
                                            Create & Move
                                        </button>
                                    </div>
                                </div>

                                {stopMoveError ? (
                                    <div className="text-xs font-bold text-rose-200">
                                        {stopMoveError}
                                    </div>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                ) : null}
            </Modal>

            <Modal
                open={addHelperOpen}
                title="Add Helper"
                onClose={() => setAddHelperOpen(false)}
            >
                <div className="space-y-3">
                    <input
                        value={addHelperName}
                        onChange={(e) => { setAddHelperName(e.target.value); setAddHelperError(''); }}
                        placeholder="Helper name (ex: Andrei Popescu)"
                        className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />
                    {addHelperError && (
                        <div className="text-xs font-bold text-rose-200">{addHelperError}</div>
                    )}

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setAddHelperOpen(false)}
                            className="flex-1 px-4 py-3 rounded-2xl glass-light border border-white/10 text-slate-200 text-xs font-black uppercase tracking-widest hover:bg-white/10 active:scale-[0.99] transition-all"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={submitAddHelper}
                            className="flex-1 px-4 py-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all"
                        >
                            Add
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal open={historyOpen} title="Istoric Traseu" onClose={() => setHistoryOpen(false)}>
                <div className="max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar space-y-4 relative">
                    {historyLoading ? (
                        <div className="flex justify-center p-8">
                            <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
                        </div>
                    ) : historyEvents.length === 0 ? (
                        <div className="text-center p-8 text-slate-400 text-sm">
                            Nu există date de istoric încă pentru această rută.
                        </div>
                    ) : (
                        <div className="relative border-l-2 border-slate-700/50 ml-3 pl-5 py-2 space-y-6">
                            {historyEvents.map((evt, idx) => {
                                const isStartEnd = evt.type === 'ROUTE_STARTED' || evt.type === 'ROUTE_FINISHED';
                                const iconColor = isStartEnd ? "text-emerald-400 bg-emerald-500/20 border-emerald-500/30" : "text-amber-400 bg-amber-500/20 border-amber-500/30";
                                const Icon = evt.type === 'ROUTE_STARTED' ? Play : (evt.type === 'ROUTE_FINISHED' ? Flag : Activity);
                                
                                return (
                                    <div key={idx} className="relative">
                                        <div className={`absolute -left-[1.65rem] top-1.5 w-6 h-6 rounded-full border ${iconColor} flex items-center justify-center shadow-lg backdrop-blur-sm`}>
                                            <Icon className="w-3 h-3" />
                                        </div>
                                        <div>
                                            <div className="flex items-baseline justify-between gap-2 mb-1">
                                                <span className="text-xs font-black text-white/90">{evt.actor_name || evt.actor_id || "Sistem"}</span>
                                                <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">
                                                    {new Date(evt.timestamp).toLocaleString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                </span>
                                            </div>
                                            <div className="text-sm font-medium text-slate-300">
                                                {evt.description}
                                            </div>
                                            {evt.awb && (
                                                <div className="mt-1 text-[11px] font-bold text-indigo-300 p-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-md w-fit">
                                                    AWB: {evt.awb} {evt.status ? ` → ${evt.status}` : ''}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </Modal>

            {scannerOpen ? (
                <Scanner
                    onScan={(value) => { void handleScanAdd(value); }}
                    onClose={() => setScannerOpen(false)}
                />
            ) : null}
        </motion.div>
    );
}
