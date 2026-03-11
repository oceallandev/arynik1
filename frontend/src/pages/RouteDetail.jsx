import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, GripVertical, MapPinned, Plus, RefreshCw, ScanLine, Search, Trash2, List, Map as MapIcon, Wand2, ExternalLink, Truck, X, Play } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import MapComponent from '../components/MapComponent';
import Scanner from '../components/Scanner';
import { hasPermission } from '../auth/rbac';
import { normalizeRole, PERM_ROUTE_RUNS_WRITE, PERM_SHIPMENTS_ASSIGN, PERM_SHIPMENTS_READ, PERM_USERS_READ, PERM_USERS_WRITE, ROLE_DRIVER } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import { allocateShipment, getShipment, getShipments, listUsers } from '../services/api';
import { awbCandidatesFromScan, normalizeShipmentIdentifier } from '../services/awbScan';
import { geocodeAddress, getCachedGeocode } from '../services/geocodeService';
import { addHelper as addHelperToRoster, listHelpers as listHelperRoster } from '../services/helpersRoster';
import { getRouteMultiDetails } from '../services/mapService';
import { optimizeRoundTripOrder } from '../services/routeOptimizer';
import { buildGeocodeHints, buildGeocodeQuery, extractShipmentCoords, isValidCoord } from '../services/shipmentGeo';
import { getWarehouseOrigin } from '../services/warehouse';
import { getRouteForUser, isRoutingEligibleShipment, moveAwbToRoute, removeAwbFromRoute, routeDisplayName, setRouteAwbOrder, updateRoute } from '../services/routesStore';

const GOOGLE_MAX_WAYPOINTS = 23;
const ROUTE_TRAFFIC_REFRESH_MS = Math.max(30000, Number(import.meta.env.VITE_ROUTE_TRAFFIC_REFRESH_MS || 120000));

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
    const { location: driverLocation } = useGeolocation();

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
    const [helpersRoster, setHelpersRoster] = useState(() => listHelperRoster());
    const [addHelperOpen, setAddHelperOpen] = useState(false);
    const [addHelperName, setAddHelperName] = useState('');
    const [addHelperError, setAddHelperError] = useState('');

    const [coordsByAwb, setCoordsByAwb] = useState({});
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routeGeometry, setRouteGeometry] = useState(null);
    const [routeMetrics, setRouteMetrics] = useState({
        distance_km: null,
        duration_min: null,
        duration_no_traffic_min: null,
        delay_min: null,
        provider: null
    });

    const [draftAwbs, setDraftAwbs] = useState(null);
    const [reorder, setReorder] = useState({ active: false, dragging: '', over: '' });
    const reorderRef = useRef({ active: false, dragging: '', over: '', pointer_id: null, last_over: '' });
    const draftAwbsRef = useRef(null);
    const routeRef = useRef(null);
    const missingFetchFailuresRef = useRef(new Set());

    const mapLocation = driverLocation ? { lat: driverLocation.latitude, lon: driverLocation.longitude } : null;
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
            .filter((d) => String(d?.role || '').trim().toLowerCase() === 'driver' && d?.active !== false)
            .slice()
            .sort((a, b) => String(a?.driver_id || '').localeCompare(String(b?.driver_id || '')))
    ), [drivers]);

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

    const saveVehiclePlate = () => {
        if (!route) return;
        const plate = String(vehiclePlate || '').trim().toUpperCase();
        const updated = updateRoute(route.id, { vehicle_plate: plate || null });
        if (updated) setRoute(updated);
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
        if (!route.vehicle_plate && d?.truck_plate) patch.vehicle_plate = String(d.truck_plate).trim().toUpperCase();
        if (!route.helper_name && d?.helper_name) patch.helper_name = String(d.helper_name).trim();
        if (d?.phone_number) patch.truck_phone = String(d.phone_number).trim();
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
        const desiredPlate = String(d?.truck_plate || '').trim().toUpperCase();
        const desiredPhone = String(d?.phone_number || '').trim();
        const desiredType = String(d?.vehicle_type_code || '').trim().toUpperCase();

        if (desiredName && !String(route?.driver_name || '').trim()) patch.driver_name = desiredName;
        if (desiredHelper && !String(route?.helper_name || '').trim()) patch.helper_name = desiredHelper;
        if (desiredPlate && !String(route?.vehicle_plate || '').trim()) patch.vehicle_plate = desiredPlate;
        if (desiredPhone && !String(route?.truck_phone || '').trim()) patch.truck_phone = desiredPhone;
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
        missingFetchFailuresRef.current = new Set();
    }, [route?.id]);

    const effectiveAwbs = draftAwbs !== null ? draftAwbs : routeAwbs;

    const routeStops = useMemo(() => (
        effectiveAwbs.map((awb) => {
            const s = shipmentsByAwb.get(String(awb).toUpperCase());
            if (s) return s;
            return { awb, status: 'Unknown', recipient_name: 'Unknown', delivery_address: '', locality: '' };
        })
    ), [effectiveAwbs, shipmentsByAwb]);

    const routeStopsWithCoords = useMemo(() => (
        routeStops.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const query = buildGeocodeQuery(s);
            const cached = coordsByAwb[awb];
            const canUseCached = cached && (!cached.q || cached.q === query) && isValidCoord(cached.lat) && isValidCoord(cached.lon);
            const direct = extractShipmentCoords(s);
            const lat = direct?.lat ?? (canUseCached ? Number(cached.lat) : null);
            const lon = direct?.lon ?? (canUseCached ? Number(cached.lon) : null);

            return {
                ...s,
                latitude: Number.isFinite(lat) ? lat : null,
                longitude: Number.isFinite(lon) ? lon : null
            };
        })
    ), [routeStops, coordsByAwb]);

    const mapCoverage = useMemo(() => {
        const total = Array.isArray(routeStopsWithCoords) ? routeStopsWithCoords.length : 0;
        let withCoords = 0;
        (Array.isArray(routeStopsWithCoords) ? routeStopsWithCoords : []).forEach((s) => {
            if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) withCoords += 1;
        });
        return { total, withCoords, missing: Math.max(0, total - withCoords) };
    }, [routeStopsWithCoords]);
    const routeStopsCoordsSignature = useMemo(
        () => JSON.stringify(routeStopsWithCoords.map((s) => [s.awb, s.latitude, s.longitude])),
        [routeStopsWithCoords]
    );

    useEffect(() => {
        if (!route || !Array.isArray(routeAwbs) || routeAwbs.length === 0) return;
        const token = user?.token;
        if (!token) return;

        const known = new Set(
            (Array.isArray(shipments) ? shipments : [])
                .map((s) => String(s?.awb || '').trim().toUpperCase())
                .filter(Boolean)
        );
        const missing = routeAwbs
            .map((awb) => String(awb || '').trim().toUpperCase())
            .filter((awb) => awb && !known.has(awb) && !missingFetchFailuresRef.current.has(awb));
        if (missing.length === 0) return;

        let cancelled = false;
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

        (async () => {
            const chunkSize = 8;
            for (let i = 0; i < missing.length; i += chunkSize) {
                if (cancelled) return;
                const chunk = missing.slice(i, i + chunkSize);
                const rows = await Promise.all(
                    chunk.map(async (awb) => {
                        try {
                            const one = await getShipment(token, awb);
                            return one && typeof one === 'object' ? one : null;
                        } catch {
                            missingFetchFailuresRef.current.add(awb);
                            return null;
                        }
                    })
                );
                const fetched = rows.filter(Boolean);
                if (fetched.length > 0 && !cancelled) {
                    setShipments((prev) => mergeFetchedShipments(prev, fetched));
                }
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
        return null;
    };

    const handleAddAwb = async (awb) => {
        if (!route || !canEditRoute) return;
        const normalized = normalizeShipmentIdentifier(awb);
        if (!normalized) return;
        if (!routeEligibleByAwb.has(normalized)) {
            setAddAwbNotice(`AWB ${normalized} nu este eligibil pentru rutare.`);
            return;
        }
        const alreadyInRoute = (Array.isArray(route?.awbs) ? route.awbs : [])
            .some((x) => String(x || '').trim().toUpperCase() === normalized);

        const updated = moveAwbToRoute(route.id, normalized, { scopeDate: true });
        setRoute(updated);
        setAddAwb('');
        setSearch('');

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
            setAddAwbNotice('AWB invalid sau status neeligibil pentru rutare.');
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

    const handleRemoveAwb = (awb) => {
        if (!route || !canEditRoute) return;
        const updated = removeAwbFromRoute(route.id, awb);
        setRoute(updated);
    };

    useEffect(() => {
        draftAwbsRef.current = draftAwbs;
    }, [draftAwbs]);

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
        if (updated) setRoute(updated);
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
        const total = routeStops.length;
        const existing = coordsByAwb || {};
        const preload = {};
        const queue = [];
        let done = 0;

        for (const s of routeStops) {
            const awb = String(s?.awb || '').toUpperCase();
            if (!awb) {
                done += 1;
                continue;
            }

            const query = buildGeocodeQuery(s);
            const hints = buildGeocodeHints(s);
            const direct = extractShipmentCoords(s);

            // Already has coordinates?
            if (direct && isValidCoord(direct.lat) && isValidCoord(direct.lon)) {
                preload[awb] = { lat: Number(direct.lat), lon: Number(direct.lon), ts: Date.now(), source: 'shipment', q: query };
                done += 1;
                continue;
            }

            // Cached in state?
            const fromState = existing[awb];
            if (fromState && (!fromState.q || fromState.q === query) && isValidCoord(fromState.lat) && isValidCoord(fromState.lon)) {
                if (!fromState.q) preload[awb] = { ...fromState, q: query };
                done += 1;
                continue;
            }

            // Cached in localStorage (fast, no network).
            const fromCache = getCachedGeocode(query, hints);
            if (fromCache) {
                if (isValidCoord(fromCache.lat) && isValidCoord(fromCache.lon)) {
                    preload[awb] = {
                        lat: Number(fromCache.lat),
                        lon: Number(fromCache.lon),
                        ts: Number(fromCache.ts || Date.now()),
                        source: 'cache',
                        q: query
                    };
                }
                // Negative cache counts as "done" (do not retry unless query changes).
                done += 1;
                continue;
            }

            if (!String(query || '').trim() || String(query || '').trim().toLowerCase() === 'romania') {
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

            let res = await geocodeAddress(query, hints, user?.token);
            if ((!res || !isValidCoord(res?.lat) || !isValidCoord(res?.lon)) && (hints?.expectedLocality || hints?.expectedCounty)) {
                // Fallback geocode without strict locality/county matching to avoid dropping valid points.
                res = await geocodeAddress(query, {}, user?.token);
            }
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                batch[awb] = { lat: Number(res.lat), lon: Number(res.lon), ts: Date.now(), source: 'geocode', q: query };
                batchCount += 1;
            }

            done += 1;

            const elapsed = Date.now() - lastFlushAt;
            if (batchCount >= 3 || elapsed > 300) flush();
        }

        flush();
        setGeocoding({ active: false, done, total, current: '' });
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

        const details = await getRouteMultiDetails(points);
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
        recomputeRouteGeometry(routeStopsWithCoords);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, geocoding.active, reorder.active, routeStopsCoordsSignature]);

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (geocoding.active || reorder.active) return;

        const timer = setInterval(() => {
            recomputeRouteGeometry(routeStopsWithCoords);
        }, ROUTE_TRAFFIC_REFRESH_MS);

        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, geocoding.active, reorder.active, routeStopsCoordsSignature]);

    const optimizeOrder = async () => {
        if (!route || !canEditRoute) return;
        if (!geocoding.active && mapCoverage.missing > 0) {
            await ensureGeocodedStops();
        }

        const stops = routeStops
            .map((s) => {
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) return null;
                const direct = extractShipmentCoords(s);
                const query = buildGeocodeQuery(s);
                const hints = buildGeocodeHints(s);
                const fromState = coordsByAwb[awb];
                const fromCache = getCachedGeocode(query, hints);
                const lat = direct?.lat
                    ?? (isValidCoord(fromState?.lat) ? Number(fromState.lat) : null)
                    ?? (isValidCoord(fromCache?.lat) ? Number(fromCache.lat) : null);
                const lon = direct?.lon
                    ?? (isValidCoord(fromState?.lon) ? Number(fromState.lon) : null)
                    ?? (isValidCoord(fromCache?.lon) ? Number(fromCache.lon) : null);
                if (!isValidCoord(lat) || !isValidCoord(lon)) return null;
                return { awb, lat: Number(lat), lon: Number(lon) };
            })
            .filter(Boolean);

        if (stops.length < 2) return;

        const start = warehouseOrigin && isValidCoord(warehouseOrigin.lat) && isValidCoord(warehouseOrigin.lon)
            ? { lat: Number(warehouseOrigin.lat), lon: Number(warehouseOrigin.lon) }
            : { lat: stops[0].lat, lon: stops[0].lon };

        const ordered = optimizeRoundTripOrder(start, stops);

        const orderedAwbs = ordered.map((s) => s.awb);
        const otherAwbs = routeAwbs.filter((awb) => !orderedAwbs.includes(String(awb).toUpperCase()));
        const updated = setRouteAwbOrder(route.id, [...orderedAwbs, ...otherAwbs]);
        setRoute(updated);
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

        const allStops = routeStopsWithCoords
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
                            {driversLoading && (
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">
                                    Loading...
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <div className="glass-light rounded-2xl border border-white/10 p-3">
                                <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Plate</p>
                                <input
                                    value={vehiclePlate}
                                    onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
                                    onBlur={canEditRoute ? saveVehiclePlate : undefined}
                                    readOnly={!canEditRoute}
                                    placeholder="BC75ARI"
                                    className="w-full bg-transparent outline-none text-white font-mono text-sm tracking-wider placeholder-slate-600"
                                />
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
                                                    return <option value={current}>{current}</option>;
                                                }
                                                return null;
                                            })()}
                                            {availableDrivers.map((d) => (
                                                <option key={d.driver_id} value={String(d.driver_id || '').trim().toUpperCase()}>
                                                    {String(d.driver_id || '').trim().toUpperCase()} • {String(d.name || '').trim() || 'Unnamed'}
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
                                        {String(route?.driver_name || route?.driver_id || driverName || '').trim() || 'Unassigned'}
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
                                    <button
                                        onClick={optimizeOrder}
                                        className="p-2 rounded-xl glass-light border border-white/10 text-amber-400 hover:bg-amber-500/10 active:scale-95 transition-all"
                                        title="Optimize order"
                                    >
                                        <Wand2 size={18} />
                                    </button>
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
                            <MapComponent shipments={routeStopsWithCoords} currentLocation={mapLocation} originLocation={warehouseOrigin} routeGeometry={routeGeometry} showStopNumbers showTraffic trafficProvider={routeMetrics.provider} />
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
                                            className={`glass-light rounded-2xl border p-3 flex items-center gap-3 ${isOver ? 'border-emerald-500/40' : 'border-white/10'} ${isDragging ? 'opacity-70' : ''}`}
                                        >
                                            {canEditRoute ? (
                                                <button
                                                    type="button"
                                                    className="p-2 rounded-xl glass-strong border border-white/10 text-slate-200 active:scale-95 transition-all cursor-grab touch-none"
                                                    onPointerDown={(e) => startReorder(awb, e)}
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
                                                <p className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate">{awb}</p>
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
                                            </div>

                                            {canEditRoute ? (
                                                <button
                                                    onClick={() => handleRemoveAwb(awb)}
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
                                        className="glass-strong p-5 rounded-3xl border border-white/10"
                                    >
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-black">
                                                {idx + 1}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate">{s.awb}</p>
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
                                                    onClick={() => handleRemoveAwb(s.awb)}
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
            {scannerOpen ? (
                <Scanner
                    onScan={(value) => { void handleScanAdd(value); }}
                    onClose={() => setScannerOpen(false)}
                />
            ) : null}
        </motion.div>
    );
}
