import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronRight, Loader2, MessageCircle, Package, RefreshCw, Search, MapPin, Phone, User, List, Map as MapIcon, Navigation, MapPinned } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { allocateShipment, createTrackingRequest, ensureChatThread, getShipment, getShipments, updateAwb } from '../services/api';
import { geocodeAddress, getCachedGeocode } from '../services/geocodeService';
import { getRoute } from '../services/mapService';
import { buildGeocodeQuery, isValidCoord } from '../services/shipmentGeo';
import { getWarehouseOrigin } from '../services/warehouse';
import MapComponent from '../components/MapComponent';
import { hasPermission } from '../auth/rbac';
import { PERM_AWB_UPDATE, PERM_CHAT_READ, PERM_SHIPMENTS_ASSIGN } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import { queueItem } from '../store/queue';
import { createRoute, findRouteForAwb, generateDailyMoldovaCountyRoutes, listRoutes, moveAwbToRoute, routeDisplayName } from '../services/routesStore';

const MAX_MAP_GEOCODE = 200;

export default function Shipments() {
    const [shipments, setShipments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState(null);
    const [viewMode, setViewMode] = useState('list'); // 'list' or 'map'
    const [routeGeometry, setRouteGeometry] = useState(null);
    const [coordsByAwb, setCoordsByAwb] = useState({});
    const coordsByAwbRef = useRef({});
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routePicker, setRoutePicker] = useState({ open: false, awb: null });
    const [routes, setRoutes] = useState([]);
    const [assignMsg, setAssignMsg] = useState('');
    const [detailsBusy, setDetailsBusy] = useState({});
    const [deliverBusy, setDeliverBusy] = useState({});
    const [trackBusy, setTrackBusy] = useState({});
    const [chatBusy, setChatBusy] = useState({});
    const navigate = useNavigate();
    const { user } = useAuth();
    const { location: driverLocation } = useGeolocation();
    const canUpdateAwb = hasPermission(user, PERM_AWB_UPDATE);
    const canAllocate = hasPermission(user, PERM_SHIPMENTS_ASSIGN);
    const canChat = hasPermission(user, PERM_CHAT_READ);
    const canRoutes = ['Manager', 'Admin', 'Dispatcher', 'Driver'].includes(user?.role);
    const canRequestTracking = ['Admin', 'Manager', 'Dispatcher', 'Support', 'Recipient'].includes(String(user?.role || '').trim());

    const fetchShipments = async () => {
        setLoading(true);
        try {
            const token = user.token; // Use token from AuthContext
            const data = await getShipments(token);
            setShipments(data);
        } catch (error) {
            console.error('Failed to fetch shipments', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchShipments();
    }, []);

    useEffect(() => {
        setRoutes(listRoutes());
    }, []);

    const money = (amount, currency = 'RON') => {
        const n = Number(amount);
        if (!Number.isFinite(n)) return '--';
        return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
    };

    const carrierLabel = (shipment) => {
        const raw = shipment?.raw_data || {};
        const candidate = raw?.courier ?? raw?.carrier ?? null;

        const asString = (v) => String(v || '').trim();

        if (typeof candidate === 'string') {
            return asString(candidate);
        }

        const obj = (candidate && typeof candidate === 'object') ? candidate : {};
        const code = asString(
            obj?.courierId
            || obj?.carrierId
            || obj?.carrierCode
            || obj?.code
            || obj?.id
            || raw?.courierId
            || raw?.carrierId
            || raw?.carrierCode
        );
        const name = asString(obj?.courierName || obj?.carrierName || obj?.name || obj?.label || raw?.courierName || raw?.carrierName);

        const parts = [];
        if (code) parts.push(code);
        if (name && name.toLowerCase() !== code.toLowerCase()) parts.push(name);
        return parts.join(' ');
    };

    const servicesLabel = (shipment) => {
        const raw = shipment?.raw_data || {};
        const as = raw?.additionalServices || raw?.additional_services || {};
        const truthy = (v) => v === true || v === 1 || v === '1' || String(v || '').trim().toLowerCase() === 'true';

        const tags = [];
        if (truthy(as?.openPackage)) tags.push('Open');
        if (truthy(as?.priority)) tags.push('Priority');
        if (truthy(as?.insurance)) tags.push('Insured');
        if (truthy(as?.oversized)) tags.push('Oversized');
        if (truthy(as?.morning)) tags.push('Morning');
        if (truthy(as?.saturday)) tags.push('Saturday');

        const options = String(as?.options || '').trim();
        if (options) tags.push(options);

        if (!tags.length) return '';
        return `Srv: ${tags.join(', ')}`;
    };

    const parcelBarcodes = (shipment, { max = 3 } = {}) => {
        const raw = shipment?.raw_data || {};
        const candidates = [
            raw?.parcels,
            raw?.Parcels,
            raw?.packages,
            raw?.Packages,
            raw?.shipmentParcels,
            raw?.shipment_parcels,
        ];

        let list = null;
        for (const c of candidates) {
            if (Array.isArray(c) && c.length) {
                list = c;
                break;
            }
        }
        if (!Array.isArray(list)) return [];

        const out = [];
        for (const it of list) {
            if (out.length >= max) break;
            if (typeof it === 'string') {
                const v = it.trim();
                if (v) out.push(v);
                continue;
            }
            if (!it || typeof it !== 'object') continue;
            const v = String(it?.barCode || it?.barcode || it?.bar_code || it?.code || it?.id || '').trim();
            if (v) out.push(v);
        }
        return out;
    };

    const clientName = (shipment) => {
        const raw = shipment?.raw_data || {};
        const client = raw?.client || raw?.clientData || {};
        const senderLoc = raw?.senderLocation || {};
        const name =
            shipment?.sender_shop_name
            || client?.name
            || client?.clientName
            || senderLoc?.name
            || senderLoc?.shopName
            || '';
        return String(name || '').trim();
    };

    const loadDetails = async (awb, { refresh = true } = {}) => {
        const key = String(awb || '').toUpperCase();
        if (!key) return;

        setDetailsBusy((prev) => ({ ...prev, [key]: true }));
        try {
            const token = user?.token;
            const details = await getShipment(token, key, { refresh });
            setShipments((prev) => (
                (Array.isArray(prev) ? prev : []).map((s) => (
                    String(s?.awb || '').toUpperCase() === key
                        ? { ...s, ...details }
                        : s
                ))
            ));
        } catch (e) {
            console.warn('Failed to load shipment details', e);
            setAssignMsg(`Failed to load details for ${key}`);
            setTimeout(() => setAssignMsg(''), 2500);
        } finally {
            setDetailsBusy((prev) => ({ ...prev, [key]: false }));
        }
    };

    const markDelivered = async (shipment) => {
        if (!canUpdateAwb) return;
        const awb = String(shipment?.awb || '').toUpperCase();
        if (!awb) return;

        const locality = shipment?.locality || shipment?.raw_data?.recipientLocation?.locality || shipment?.raw_data?.recipientLocation?.localityName || '';
        const payload = locality ? { locality } : {};

        setDeliverBusy((prev) => ({ ...prev, [awb]: true }));
        try {
            const token = user?.token;
            await updateAwb(token, {
                awb,
                event_id: '2',
                timestamp: new Date().toISOString(),
                payload
            });

            setShipments((prev) => (
                (Array.isArray(prev) ? prev : []).map((s) => (
                    String(s?.awb || '').toUpperCase() === awb
                        ? { ...s, status: 'Delivered' }
                        : s
                ))
            ));

            setAssignMsg(`Marked ${awb} as Delivered`);
            setTimeout(() => setAssignMsg(''), 2500);

            // Pull full details + history in the background for reconciliation.
            loadDetails(awb, { refresh: true });
        } catch (e) {
            try {
                await queueItem(awb, '2', payload);
                setAssignMsg(`Queued Delivered for ${awb}`);
                setTimeout(() => setAssignMsg(''), 2500);
            } catch {
                setAssignMsg(`Failed to mark Delivered for ${awb}`);
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } finally {
            setDeliverBusy((prev) => ({ ...prev, [awb]: false }));
        }
    };

    const requestTrackingForAwb = async (awbRaw) => {
        if (!canRequestTracking) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb || !user?.token) return;

        setTrackBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const res = await createTrackingRequest(user.token, { awb, duration_sec: 1800 });
            const id = res?.id;
            if (id) {
                navigate(`/tracking/${encodeURIComponent(String(id))}`);
            } else {
                setAssignMsg('Tracking request created.');
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to request tracking';
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3000);
        } finally {
            setTrackBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const openChatForAwb = async (awbRaw) => {
        if (!canChat) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb || !user?.token) return;

        setChatBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const t = await ensureChatThread(user.token, { awb });
            if (t?.id) {
                navigate(`/chat/${encodeURIComponent(String(t.id))}`);
            } else {
                setAssignMsg('Chat unavailable.');
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to open chat';
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3000);
        } finally {
            setChatBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    // Format location for MapComponent
    const mapLocation = driverLocation ? {
        lat: driverLocation.latitude,
        lon: driverLocation.longitude
    } : null;

    useEffect(() => {
        coordsByAwbRef.current = coordsByAwb;
    }, [coordsByAwb]);

    const handleViewOnMap = async (shipment) => {
        const awb = String(shipment?.awb || '').toUpperCase();
        const query = buildGeocodeQuery(shipment);
        let lat = Number(shipment?.latitude);
        let lon = Number(shipment?.longitude);

        // Show the map immediately; geocoding happens in the background.
        setViewMode('map');
        setRouteGeometry(null);

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const cached = coordsByAwbRef.current?.[awb];
            if (cached && (!cached.q || cached.q === query) && isValidCoord(cached.lat) && isValidCoord(cached.lon)) {
                lat = Number(cached.lat);
                lon = Number(cached.lon);
            }
        }

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const cached = getCachedGeocode(query);
            if (cached && isValidCoord(cached.lat) && isValidCoord(cached.lon)) {
                lat = Number(cached.lat);
                lon = Number(cached.lon);
                if (awb) {
                    setCoordsByAwb((prev) => ({ ...prev, [awb]: { lat, lon, ts: Date.now(), source: 'cache', q: query } }));
                }
            }
        }

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const res = await geocodeAddress(query);
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                lat = Number(res.lat);
                lon = Number(res.lon);
                if (awb) {
                    setCoordsByAwb((prev) => ({ ...prev, [awb]: { lat, lon, ts: Date.now(), source: 'geocode', q: query } }));
                }
            }
        }

        const origin = getWarehouseOrigin();
        if (origin && isValidCoord(origin.lat) && isValidCoord(origin.lon) && isValidCoord(lat) && isValidCoord(lon)) {
            const geometry = await getRoute({ lat: origin.lat, lon: origin.lon }, { lat, lon });
            setRouteGeometry(geometry);
        } else {
            setRouteGeometry(null);
        }
    };

    const openRoutePicker = (awb) => {
        if (!canRoutes) return;
        try {
            // Ensure today's county routes exist so the dispatcher can allocate immediately.
            generateDailyMoldovaCountyRoutes({
                date: new Date().toISOString().slice(0, 10),
                shipments: [],
                driver_id: user?.driver_id || null
            });
        } catch { }
        setRoutes(listRoutes());
        setRoutePicker({ open: true, awb: String(awb || '').toUpperCase() });
    };

    const assignToRoute = async (routeId) => {
        const awb = routePicker.awb;
        if (!awb) return;
        const updated = moveAwbToRoute(routeId, awb, { scopeDate: true });
        if (updated) {
            const r = listRoutes().find((x) => x.id === routeId);
            setAssignMsg(`Assigned ${awb} to ${r?.name || 'route'}${r?.vehicle_plate ? ` (${r.vehicle_plate})` : ''}`);
            setTimeout(() => setAssignMsg(''), 2500);

            if (canAllocate) {
                const targetDriverId = String(r?.driver_id || '').trim();
                if (!targetDriverId) {
                    setAssignMsg('Route has no driver assigned; allocation not sent.');
                    setTimeout(() => setAssignMsg(''), 3000);
                } else {
                    try {
                        await allocateShipment(user?.token, awb, targetDriverId);
                        setAssignMsg(`Allocated ${awb} to ${targetDriverId} and notified recipient.`);
                        setTimeout(() => setAssignMsg(''), 3000);
                    } catch (e) {
                        console.warn('Allocation API failed', e);
                        const detail = e?.response?.data?.detail;
                        setAssignMsg(detail ? `Allocation failed: ${detail}` : 'Allocated locally only (API failed).');
                        setTimeout(() => setAssignMsg(''), 3000);
                    }
                }
            }
        }
        setRoutePicker({ open: false, awb: null });
    };

    const createAndAssign = () => {
        const awb = routePicker.awb;
        if (!awb) return;
        let plate = '';
        try { plate = localStorage.getItem('arynik_last_vehicle_plate_v1') || ''; } catch { }
        const route = createRoute({
            name: `Route ${new Date().toLocaleDateString()}`,
            driver_id: user?.driver_id || null,
            driver_name: user?.name || null,
            helper_name: user?.helper_name || null,
            vehicle_plate: String(plate || '').trim().toUpperCase() || null,
            date: new Date().toISOString().slice(0, 10)
        });
        moveAwbToRoute(route.id, awb, { scopeDate: true });
        setRoutePicker({ open: false, awb: null });
        setAssignMsg(`Created route and assigned ${awb}`);
        setTimeout(() => setAssignMsg(''), 2500);
        navigate(`/routes/${route.id}`);
    };

    const filtered = shipments.filter((s) => (
        s.awb?.toLowerCase().includes(search.toLowerCase())
        || (s.recipient_name && s.recipient_name?.toLowerCase().includes(search.toLowerCase()))
    ));

    const mapTargets = useMemo(() => filtered.slice(0, MAX_MAP_GEOCODE), [filtered]);
    const mapTargetsKey = useMemo(
        () => mapTargets.map((s) => String(s?.awb || '').toUpperCase()).join('|'),
        [mapTargets]
    );

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (!mapTargets || mapTargets.length === 0) return;

        let cancelled = false;

        (async () => {
            const total = mapTargets.length;
            const existing = coordsByAwbRef.current || {};
            const preload = {};
            const queue = [];
            let done = 0;

            // First, apply anything we can without network (shipment coords, in-memory state, localStorage cache).
            for (const s of mapTargets) {
                if (cancelled) return;
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) {
                    done += 1;
                    continue;
                }

                const query = buildGeocodeQuery(s);

                // Already has coordinates?
                if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                    preload[awb] = { lat: Number(s.latitude), lon: Number(s.longitude), ts: Date.now(), source: 'shipment', q: query };
                    done += 1;
                    continue;
                }

                // Cached in state (only if address hasn't changed).
                const fromState = existing[awb];
                if (fromState && (!fromState.q || fromState.q === query) && isValidCoord(fromState.lat) && isValidCoord(fromState.lon)) {
                    if (!fromState.q) preload[awb] = { ...fromState, q: query };
                    done += 1;
                    continue;
                }

                // Cached in localStorage (fast, no network).
                const fromCache = getCachedGeocode(query);
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

                queue.push({ awb, query });
            }

            if (cancelled) return;

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
                if (cancelled) return;
                if (Object.keys(batch).length === 0) return;
                const payload = batch;
                batch = {};
                batchCount = 0;
                lastFlushAt = Date.now();
                setCoordsByAwb((prev) => ({ ...prev, ...payload }));
            };

            for (const item of queue) {
                if (cancelled) return;
                const { awb, query } = item;
                setGeocoding({ active: true, done, total, current: awb });

                const res = await geocodeAddress(query);
                if (res && isValidCoord(res.lat) && isValidCoord(res.lon) && awb) {
                    batch[awb] = { lat: Number(res.lat), lon: Number(res.lon), ts: Date.now(), source: 'geocode', q: query };
                    batchCount += 1;
                }

                done += 1;

                const elapsed = Date.now() - lastFlushAt;
                if (batchCount >= 5 || elapsed > 300) flush();
            }

            flush();
            if (cancelled) return;
            setGeocoding({ active: false, done, total, current: '' });
        })();

        return () => {
            cancelled = true;
        };
    }, [viewMode, mapTargetsKey]);

    const mapShipments = useMemo(() => {
        if (viewMode !== 'map') return filtered;
        const coords = coordsByAwb || {};
        return filtered.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const c = coords[awb];
            const query = buildGeocodeQuery(s);
            if (c && (!c.q || c.q === query) && isValidCoord(c.lat) && isValidCoord(c.lon)) {
                return { ...s, latitude: Number(c.lat), longitude: Number(c.lon) };
            }
            return s;
        });
    }, [viewMode, filtered, coordsByAwb]);

    // Pagination
    const itemsPerPage = 20;
    const [currentPage, setCurrentPage] = useState(1);

    useEffect(() => {
        setCurrentPage(1);
    }, [search, viewMode]);

    const totalPages = Math.ceil(filtered.length / itemsPerPage);
    // Only paginate in list mode. Map mode handles all markers (might need clustering eventually)
    const paginatedShipments = viewMode === 'list'
        ? filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
        : filtered;

    const getStatusGradient = (status) => {
        if (status === 'Delivered') return 'from-emerald-500 to-emerald-600';
        if (status === 'In Transit') return 'from-blue-500 to-blue-600';
        return 'from-amber-500 to-amber-600';
    };

    const getStatusBg = (status) => {
        if (status === 'Delivered') return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
        if (status === 'In Transit') return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-20 right-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10">
                        <ArrowLeft />
                    </button>
                    <h1 className="flex-1 font-black text-xl text-gradient tracking-tight">Shipments</h1>

                    {/* View Toggle */}
                    <div className="flex glass-strong p-1 rounded-xl border border-white/10">
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <List size={20} />
                        </button>
                        <button
                            onClick={() => setViewMode('map')}
                            className={`p-2 rounded-lg transition-all ${viewMode === 'map' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <MapIcon size={20} />
                        </button>
                    </div>

                    <button
                        onClick={fetchShipments}
                        className={`p-2 rounded-xl glass-light hover:bg-violet-500/20 text-violet-400 transition-all border border-white/10 ${loading ? 'animate-spin' : ''}`}
                    >
                        <RefreshCw size={20} />
                    </button>
                </div>

                <div className="px-4 pb-2">
                    <div className="relative group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition-colors z-10" size={18} />
                        <input
                            type="text"
                            placeholder="Search AWB, Client..."
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-violet-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div className="flex-1 p-4 space-y-3 pb-32 relative z-10">
                <AnimatePresence mode="wait">
                    {assignMsg && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-300 text-xs font-bold"
                        >
                            {assignMsg}
                        </motion.div>
                    )}
                    {loading && shipments.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex flex-col items-center justify-center py-20 text-slate-400"
                        >
                            <div className="relative">
                                <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                                <Loader2 className="animate-spin relative z-10 text-violet-400" size={48} />
                            </div>
                            <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">Syncing Data...</p>
                        </motion.div>
                    ) : filtered.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-center py-20 text-slate-400"
                        >
                            <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                <Package className="text-slate-500" size={36} />
                            </div>
                            <p className="font-bold text-slate-300 text-lg">No shipments found</p>
                            <p className="text-sm mt-2 text-slate-500">Try adjusting your search</p>
                        </motion.div>
                    ) : viewMode === 'map' ? (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="h-[70vh] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl relative"
                        >
                            <MapComponent shipments={mapShipments} currentLocation={mapLocation} originLocation={getWarehouseOrigin()} routeGeometry={routeGeometry} />
                            {geocoding.active && (
                                <div className="absolute top-4 left-4 glass-strong rounded-2xl border border-white/10 px-4 py-3 text-white text-xs font-bold shadow-lg">
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="animate-spin text-violet-300" size={14} />
                                        <span className="uppercase tracking-widest text-[10px] text-slate-300">Geocoding</span>
                                    </div>
                                    <div className="mt-1 text-[10px] text-slate-400 font-black uppercase tracking-wider">
                                        {geocoding.done}/{geocoding.total} {geocoding.current ? `(${geocoding.current})` : ''}
                                    </div>
                                    <div className="mt-2 h-1.5 w-48 bg-white/10 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-violet-500 to-purple-500"
                                            style={{ width: `${Math.min(100, Math.round((geocoding.done / Math.max(1, geocoding.total)) * 100))}%` }}
                                        />
                                    </div>
                                    <div className="mt-2 text-[9px] text-slate-500 font-bold">
                                        Tip: search a city/awb first to reduce requests.
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    ) : (
                        <div className="space-y-3">
                            {paginatedShipments.map((s, idx) => (
                                <motion.div
                                    key={s.awb || idx} // Use AWB as key for better performance
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className={`glass-strong rounded-3xl overflow-hidden transition-all duration-300 border border-white/10 ${expanded === idx ? 'ring-2 ring-violet-500/30 shadow-glow-sm' : ''}`}
                                >
                                    <div
                                        onClick={() => {
                                            const next = expanded === idx ? null : idx;
                                            setExpanded(next);
                                            if (next !== null) {
                                                // Fetch cached details (no Postis refresh) so fields populate when available.
                                                loadDetails(s.awb, { refresh: false });
                                            }
                                        }}
                                        className="p-5 flex items-center gap-4 cursor-pointer relative"
                                    >
                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm bg-gradient-to-br ${getStatusGradient(s.status)}`}>
                                            <Package size={24} strokeWidth={2} className="text-white" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-center mb-1.5">
                                                <h3 className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-500">{s.awb}</h3>
                                                <div className="flex items-center gap-2">
                                                    {(() => {
                                                        const r = findRouteForAwb(s.awb);
                                                        if (!r) return null;
                                                        return (
                                                            <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border bg-emerald-500/15 text-emerald-300 border-emerald-500/20">
                                                                {routeDisplayName(r)}
                                                            </span>
                                                        );
                                                    })()}
                                                    <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${getStatusBg(s.status)}`}>
                                                        {s.status || 'Active'}
                                                    </span>
                                                </div>
                                            </div>

                                            <p className="text-sm font-bold text-white truncate leading-tight mb-2">{s.recipient_name}</p>

                                            <div className="flex items-center gap-1.5 text-slate-400">
                                                <MapPin size={11} strokeWidth={2.5} />
                                                <p className="text-[10px] font-medium truncate">{s.delivery_address || s.locality || 'No Address'}</p>
                                            </div>
                                        </div>

                                        <ChevronRight className={`text-slate-500 transition-transform duration-300 ${expanded === idx ? 'rotate-90 text-violet-400' : ''}`} size={20} />
                                    </div>

                                        <AnimatePresence>
                                            {expanded === idx && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.3, ease: 'easeInOut' }}
                                            >
                                                <div className="p-5 space-y-4 bg-black/20 border-t border-white/5">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="glass-light p-4 rounded-2xl flex items-center gap-3 border border-white/10">
                                                            <div className="p-2 bg-violet-500/20 rounded-xl">
                                                                <Phone size={16} className="text-violet-400" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">Contact</p>
                                                                <p className="text-xs font-bold text-white truncate">{s.recipient_phone || '--'}</p>
                                                            </div>
                                                        </div>

                                                        <div className="glass-light p-4 rounded-2xl flex items-center gap-3 border border-white/10">
                                                            <div className="p-2 bg-emerald-500/20 rounded-xl">
                                                                <User size={16} className="text-emerald-400" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">Recipient</p>
                                                                <p className="text-xs font-bold text-white truncate">{s.recipient_name}</p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Packages</p>
                                                            <p className="text-sm font-black text-white">
                                                                {Number.isFinite(Number(s.number_of_parcels)) ? Number(s.number_of_parcels) : (s?.raw_data?.numberOfDistinctBarcodes || s?.raw_data?.numberOfParcels || 1)}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Payment</p>
                                                            <p className="text-sm font-black text-white">
                                                                {money(
                                                                    s.payment_amount ?? s.shipping_cost ?? s.estimated_shipping_cost,
                                                                    s.currency || s?.raw_data?.currency || 'RON'
                                                                )}
                                                            </p>
                                                            <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                {(() => {
                                                                    const parts = [];
                                                                    if (Number.isFinite(Number(s.shipping_cost))) {
                                                                        parts.push(`Cost: ${money(s.shipping_cost, s.currency || 'RON')}`);
                                                                    }
                                                                    if (Number.isFinite(Number(s.estimated_shipping_cost))) {
                                                                        const same = Number(s.shipping_cost) === Number(s.estimated_shipping_cost);
                                                                        if (!same) {
                                                                            parts.push(`Est: ${money(s.estimated_shipping_cost, s.currency || 'RON')}`);
                                                                        }
                                                                    }
                                                                    return parts.length ? parts.join(' • ') : 'Not loaded';
                                                                })()}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">COD</p>
                                                            <p className="text-sm font-black text-white">
                                                                {money(s.cod_amount, s.currency || 'RON')}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Declared</p>
                                                            <p className="text-sm font-black text-white">
                                                                {money(s.declared_value, s.currency || 'RON')}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10 col-span-2">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Content</p>
                                                            <p className="text-xs font-bold text-white truncate">
                                                                {s.content_description
                                                                    || s?.raw_data?.contentDescription
                                                                    || s?.raw_data?.contents
                                                                    || s?.raw_data?.content
                                                                    || s?.raw_data?.packingList
                                                                    || s?.raw_data?.packingListNumber
                                                                    || s?.raw_data?.packingListId
                                                                    || s?.raw_data?.packing_list
                                                                    || s?.raw_data?.packing_list_number
                                                                    || s?.raw_data?.packing_list_id
                                                                    || s?.raw_data?.packageContent
                                                                    || s?.raw_data?.shipmentContent
                                                                    || s?.raw_data?.goodsDescription
                                                                    || s?.raw_data?.additionalServices?.contentDescription
                                                                    || s?.raw_data?.additionalServices?.contents
                                                                    || s?.raw_data?.additionalServices?.content
                                                                    || s?.raw_data?.additionalServices?.packingList
                                                                    || s?.raw_data?.additionalServices?.packingListNumber
                                                                    || s?.raw_data?.additionalServices?.packingListId
                                                                    || s?.raw_data?.productCategory?.name
                                                                    || (typeof s?.raw_data?.productCategory === 'string' ? s.raw_data.productCategory : '')
                                                                    || '--'}
                                                            </p>
                                                            <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                {s.dimensions ? `Dims: ${s.dimensions}` : ''}{s.weight ? ` • W: ${Number(s.weight).toFixed(2)} kg` : ''}{s.volumetric_weight ? ` • Vol: ${Number(s.volumetric_weight).toFixed(2)} kg` : ''}
                                                            </p>
                                                            {(() => {
                                                                const bcs = parcelBarcodes(s, { max: 2 });
                                                                if (!bcs.length) return null;
                                                                return (
                                                                    <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                        {`Barcode: ${bcs.join(' • ')}`}
                                                                    </p>
                                                                );
                                                            })()}
                                                            {s.delivery_instructions ? (
                                                                <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                    {`Instr: ${String(s.delivery_instructions)}`}
                                                                </p>
                                                            ) : null}
                                                            {(s.processing_status || s.send_type) ? (
                                                                <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                    {s.processing_status ? `Proc: ${s.processing_status}` : ''}{s.send_type ? `${s.processing_status ? ' • ' : ''}Type: ${s.send_type}` : ''}
                                                                </p>
                                                            ) : null}
                                                            <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                {s.shipment_reference ? `Ref: ${s.shipment_reference}` : ''}{s.client_order_id ? ` • Order: ${s.client_order_id}` : ''}
                                                            </p>
                                                            <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                {clientName(s) ? `Client: ${clientName(s)}` : ''}
                                                                {s.source_channel ? `${clientName(s) ? ' • ' : ''}Channel: ${s.source_channel}` : ''}
                                                            </p>
                                                            {(carrierLabel(s) || servicesLabel(s)) ? (
                                                                <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                    {carrierLabel(s) ? `Carrier: ${carrierLabel(s)}` : ''}
                                                                    {servicesLabel(s) ? `${carrierLabel(s) ? ' • ' : ''}${servicesLabel(s)}` : ''}
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                    </div>

                                                    {Array.isArray(s.tracking_history) && s.tracking_history.length > 0 && (
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-2">History</p>
                                                            <div className="space-y-2">
                                                                {s.tracking_history.slice(0, 4).map((ev, i) => (
                                                                    <div key={i} className="flex items-start justify-between gap-3">
                                                                        <p className="text-[11px] font-bold text-slate-200 truncate">
                                                                            {ev?.eventDescription || ev?.statusDescription || 'Update'}
                                                                        </p>
                                                                        <p className="text-[10px] font-bold text-slate-500 whitespace-nowrap">
                                                                            {ev?.eventDate ? new Date(ev.eventDate).toLocaleString() : ''}
                                                                        </p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    <div className="grid grid-cols-2 gap-3">
                                                        <button
                                                            onClick={() => loadDetails(s.awb, { refresh: true })}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm ${detailsBusy[String(s?.awb || '').toUpperCase()] ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            disabled={detailsBusy[String(s?.awb || '').toUpperCase()]}
                                                            title="Fetch full details + history from Postis"
                                                        >
                                                            <RefreshCw size={16} className={detailsBusy[String(s?.awb || '').toUpperCase()] ? 'animate-spin' : ''} />
                                                            Details
                                                        </button>
                                                        {canUpdateAwb ? (
                                                            <button
                                                                onClick={() => markDelivered(s)}
                                                                className={`w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm ${deliverBusy[String(s?.awb || '').toUpperCase()] ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                                disabled={deliverBusy[String(s?.awb || '').toUpperCase()] || String(s?.status || '').toLowerCase() === 'delivered'}
                                                                title="Mark as Delivered"
                                                            >
                                                                <CheckCircle2 size={16} />
                                                                Delivered
                                                            </button>
                                                        ) : (
                                                            <div className="w-full glass-light rounded-xl border border-white/10 flex items-center justify-center text-[10px] font-black uppercase tracking-widest text-slate-500">
                                                                Read-only
                                                            </div>
                                                        )}
                                                    </div>

                                                    <button
                                                        onClick={() => handleViewOnMap(s)}
                                                        className="w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                                                    >
                                                        <Navigation size={16} />
                                                        View on Map
                                                    </button>

                                                    {canRequestTracking && String(s?.driver_id || '').trim() ? (
                                                        <button
                                                            onClick={() => requestTrackingForAwb(s.awb)}
                                                            disabled={Boolean(trackBusy[String(s?.awb || '').toUpperCase()])}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-sky-600 to-indigo-700 hover:from-sky-500 hover:to-indigo-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm ${Boolean(trackBusy[String(s?.awb || '').toUpperCase()]) ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            title="Request driver live location"
                                                        >
                                                            {Boolean(trackBusy[String(s?.awb || '').toUpperCase()])
                                                                ? <Loader2 size={16} className="animate-spin" />
                                                                : <MapPin size={16} />
                                                            }
                                                            Track Driver
                                                        </button>
                                                    ) : null}

                                                    {canChat ? (
                                                        <button
                                                            onClick={() => openChatForAwb(s.awb)}
                                                            disabled={Boolean(chatBusy[String(s?.awb || '').toUpperCase()])}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm ${Boolean(chatBusy[String(s?.awb || '').toUpperCase()]) ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            title="Open chat"
                                                        >
                                                            {Boolean(chatBusy[String(s?.awb || '').toUpperCase()])
                                                                ? <Loader2 size={16} className="animate-spin" />
                                                                : <MessageCircle size={16} />
                                                            }
                                                            Chat
                                                        </button>
                                                    ) : null}

                                                    {canRoutes ? (
                                                        <button
                                                            onClick={() => openRoutePicker(s.awb)}
                                                            className="w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                                                        >
                                                            <MapPinned size={16} />
                                                            {canAllocate ? 'Allocate to Truck' : 'Assign to Route'}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </motion.div>
                            ))}

                            {/* Pagination Controls */}
                            {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4 glass-strong rounded-2xl p-4 border border-white/10">
                                    <button
                                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                        disabled={currentPage === 1}
                                        className="p-2 rounded-xl hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
                                    >
                                        <ArrowLeft size={20} />
                                    </button>
                                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <button
                                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                        disabled={currentPage === totalPages}
                                        className="p-2 rounded-xl hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
                                    >
                                        <ChevronRight size={20} />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </AnimatePresence>
            </div>

            {/* Route Picker Modal */}
            <AnimatePresence>
                {routePicker.open && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4"
                        onClick={() => setRoutePicker({ open: false, awb: null })}
                    >
                        <motion.div
                            initial={{ y: 30, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: 30, opacity: 0 }}
                            className="w-full max-w-md glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Assign AWB</p>
                                    <p className="text-sm font-bold text-white font-mono mt-1">{routePicker.awb}</p>
                                </div>
                                <button
                                    onClick={createAndAssign}
                                    className="px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                                >
                                    Create Route
                                </button>
                            </div>

                            <div className="space-y-2 max-h-[45vh] overflow-y-auto">
                                {routes.length === 0 ? (
                                    <p className="text-xs text-slate-500">No routes yet. Tap “Create Route”.</p>
                                ) : (
                                    routes.map((r) => (
                                        <button
                                            key={r.id}
                                            onClick={() => assignToRoute(r.id)}
                                            className="w-full p-4 rounded-2xl border border-white/10 hover:border-emerald-500/30 transition-all text-left glass-light flex items-center justify-between gap-3"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{routeDisplayName(r)}</p>
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                    {r.date} • {Array.isArray(r.awbs) ? r.awbs.length : 0} stops{r.vehicle_plate ? ` • ${r.vehicle_plate}` : ''}
                                                </p>
                                            </div>
                                            <span className="text-[10px] font-black text-emerald-300 uppercase tracking-wide">Select</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
