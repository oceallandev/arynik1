import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle2, Crosshair, ExternalLink, Loader2, MapPinned, MessageCircle, Phone, RefreshCw, Send } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import AwbLink from '../components/AwbLink';
import { hasPermission } from '../auth/rbac';
import { PERM_SHIPMENTS_READ } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import StatusSelect from './StatusSelect';
import { createContactAttempt, finishRouteRun, getRouteRun, getShipments, routeRunArrive, routeRunComplete, routeRunDepart, startRouteRun } from '../services/api';
import { getRouteForUser, routeDisplayName } from '../services/routesStore';
import { getCurrentPositionRobust, normalizeGeoErrorMessage } from '../services/location';
import MapComponent from '../components/MapComponent';
import { getRouteMultiDetails } from '../services/mapService';
import { getWarehouseOrigin } from '../services/warehouse';

const RUN_KEY = (routeId) => `arynik_route_run_id_${String(routeId || '')}`;

const whatsappDigits = (phone) => {
    const digits = String(phone || '').replace(/\\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00')) return digits.slice(2);
    if (digits.startsWith('0') && digits.length === 10) return `40${digits.slice(1)}`;
    return digits;
};

const openWhatsApp = (phone, message = '') => {
    const digits = whatsappDigits(phone);
    if (!digits) return;
    const url = new URL(`https://wa.me/${encodeURIComponent(digits)}`);
    const msg = String(message || '').trim();
    if (msg) url.searchParams.set('text', msg);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

const openGoogleMapsTo = (lat, lon, label = '') => {
    const la = Number(lat);
    const lo = Number(lon);
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        if (!label) return;
        url.searchParams.set('destination', label);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
        return;
    }
    url.searchParams.set('destination', `${la},${lo}`);
    if (label) {
        url.searchParams.set('destination_place_id', label);
    }
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

const openWazeTo = (lat, lon, label = '') => {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        if (!label) return;
        const url = new URL('https://www.waze.com/ul');
        url.searchParams.set('q', label);
        url.searchParams.set('navigate', 'yes');
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
        return;
    }
    const url = new URL('https://www.waze.com/ul');
    url.searchParams.set('ll', `${la},${lo}`);
    url.searchParams.set('navigate', 'yes');
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

const detectGps = async () => {
    const coords = await getCurrentPositionRobust({ timeout: 4000, fallbackTimeout: 6000 });
    const lat = Number(coords?.latitude);
    const lon = Number(coords?.longitude);
    const acc = Number(coords?.accuracy_m);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid GPS coordinates');
    return { latitude: lat, longitude: lon, accuracy_m: Number.isFinite(acc) ? acc : null };
};

export default function RouteRun() {
    const { routeId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const canReadShipments = hasPermission(user, PERM_SHIPMENTS_READ);

    const [route, setRoute] = useState(null);
    const [shipmentsByAwb, setShipmentsByAwb] = useState(new Map());
    const [loadingShipments, setLoadingShipments] = useState(true);

    const [run, setRun] = useState(null);
    const [runBusy, setRunBusy] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');
    const [navigationPicker, setNavigationPicker] = useState({ open: false, lat: null, lon: null, label: '' });

    const [idx, setIdx] = useState(0);
    const [statusAwb, setStatusAwb] = useState(null);

    const [routeGeometry, setRouteGeometry] = useState(null);
    const [routeMetrics, setRouteMetrics] = useState({ distance_km: null, duration_min: null, delay_min: 0, provider: null });

    useEffect(() => {
        const r = getRouteForUser(routeId, user);
        setRoute(r);
    }, [routeId, user?.role, user?.driver_id]);

    const warehouseOrigin = useMemo(() => getWarehouseOrigin(route?.county, route?.warehouse_id), [route?.county, route?.warehouse_id]);

    const awbs = useMemo(() => (Array.isArray(route?.awbs) ? route.awbs.map((x) => String(x || '').toUpperCase()).filter(Boolean) : []), [route?.awbs]);

    const activeStopIdx = useMemo(() => {
        if (!run?.id) return 0;
        const stops = Array.isArray(run?.stops) ? run.stops : [];
        for (let i = 0; i < awbs.length; i++) {
            const key = String(awbs[i] || '').toUpperCase();
            const s = stops.find((x) => String(x?.awb || '').toUpperCase() === key);
            const isFinished = s && (s.completed_at || ['DONE', 'SKIPPED', 'COMPLETED'].includes(String(s.state || '').toUpperCase()));
            if (!isFinished) return i;
        }
        return Math.max(0, awbs.length - 1);
    }, [run, awbs]);

    useEffect(() => {
        // Automatically snap the viewed delivery to the active stop whenever it updates
        // (e.g., when the run loads from the database, or when the driver completes a stop).
        setIdx(activeStopIdx);
    }, [activeStopIdx]);

    useEffect(() => {
        // Failsafe clamp to prevent viewing future locked stops if state gets misaligned.
        if (idx > activeStopIdx) {
            setIdx(activeStopIdx);
        }
    }, [idx, activeStopIdx]);

    const routeStopsForMap = useMemo(() => {
        return awbs.map((awb) => {
            const shipment = shipmentsByAwb.get(String(awb).toUpperCase()) || null;
            const lat = Number(shipment?.latitude ?? shipment?.raw_data?.recipientPin?.latitude ?? shipment?.raw_data?.recipientLocation?.latitude);
            const lon = Number(shipment?.longitude ?? shipment?.raw_data?.recipientPin?.longitude ?? shipment?.raw_data?.recipientLocation?.longitude);
            return {
                awb: String(awb).toUpperCase(),
                shipment,
                latitude: Number.isFinite(lat) ? lat : null,
                longitude: Number.isFinite(lon) ? lon : null,
                source: ''
            };
        });
    }, [awbs, shipmentsByAwb]);

    useEffect(() => {
        if (!route || awbs.length === 0) return;
        let cancelled = false;

        const computeRoute = async () => {
            const points = [];
            if (warehouseOrigin && Number.isFinite(warehouseOrigin.lat) && Number.isFinite(warehouseOrigin.lon)) {
                points.push({ lat: Number(warehouseOrigin.lat), lon: Number(warehouseOrigin.lon) });
            }
            routeStopsForMap.forEach((s) => {
                if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
                    points.push({ lat: s.latitude, lon: s.longitude });
                }
            });
            if (warehouseOrigin && points.length > 1) {
                points.push({ lat: Number(warehouseOrigin.lat), lon: Number(warehouseOrigin.lon) });
            }

            if (points.length < 2) {
                if (!cancelled) {
                    setRouteGeometry(null);
                    setRouteMetrics({ distance_km: null, duration_min: null, delay_min: 0, provider: null });
                }
                return;
            }

            const details = await getRouteMultiDetails(points, { requireGoogleTraffic: true });
            if (cancelled) return;

            if (!details) {
                setRouteGeometry(null);
                setRouteMetrics({ distance_km: null, duration_min: null, delay_min: 0, provider: 'google_traffic_unavailable' });
                return;
            }

            if (details.geometry) setRouteGeometry(details.geometry);
            const meters = Number(details.distance_m || 0);
            const seconds = Number(details.duration_s || 0);
            const secondsNoTraffic = Number(details.duration_no_traffic_s || 0);
            const delaySeconds = Number(details.delay_s || Math.max(0, seconds - secondsNoTraffic));
            
            setRouteMetrics({
                distance_km: meters > 0 ? Math.round((meters / 1000) * 10) / 10 : null,
                duration_min: seconds > 0 ? Math.round(seconds / 60) : null,
                delay_min: delaySeconds > 0 ? Math.round(delaySeconds / 60) : 0,
                provider: details.provider || null
            });
        };
        computeRoute();

        return () => { cancelled = true; };
    }, [routeStopsForMap, warehouseOrigin, route, awbs.length]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingShipments(true);
            if (!canReadShipments) {
                if (!cancelled) setShipmentsByAwb(new Map());
                if (!cancelled) setLoadingShipments(false);
                return;
            }
            try {
                const data = await getShipments(token);
                const map = new Map();
                (Array.isArray(data) ? data : []).forEach((s) => {
                    const key = String(s?.awb || '').toUpperCase();
                    if (key) map.set(key, s);
                });
                if (!cancelled) setShipmentsByAwb(map);
            } catch {
                if (!cancelled) setShipmentsByAwb(new Map());
            } finally {
                if (!cancelled) setLoadingShipments(false);
            }
        })();
        return () => { cancelled = true; };
    }, [token, canReadShipments]);

    const loadRunFromStorage = async () => {
        if (!token) return;
        setError('');
        try {
            const raw = localStorage.getItem(RUN_KEY(routeId));
            const id = raw ? Number(raw) : NaN;
            if (!Number.isFinite(id)) return;
            const data = await getRouteRun(token, id);
            setRun(data || null);
        } catch {
            // Ignore.
        }
    };

    useEffect(() => {
        loadRunFromStorage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, routeId]);

    const start = async () => {
        if (!token || !route || awbs.length === 0) return;
        setRunBusy(true);
        setError('');
        setMsg('');
        try {
            const res = await startRouteRun(token, {
                route_id: String(routeId || ''),
                route_name: routeDisplayName(route),
                awbs,
                truck_plate: route?.vehicle_plate || undefined,
                helper_name: route?.helper_name || undefined,
            });
            if (res?.id) {
                localStorage.setItem(RUN_KEY(routeId), String(res.id));
            }
            setRun(res || null);
            setMsg('Run started.');
            setTimeout(() => setMsg(''), 2500);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to start run'));
        } finally {
            setRunBusy(false);
        }
    };

    const refreshRun = async () => {
        if (!token) return;
        const id = Number(run?.id);
        if (!Number.isFinite(id)) return;
        setRunBusy(true);
        setError('');
        try {
            const data = await getRouteRun(token, id);
            setRun(data || run);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to refresh'));
        } finally {
            setRunBusy(false);
        }
    };

    const markArrived = async (awb) => {
        if (!token || !run?.id) return;
        const key = String(awb || '').toUpperCase();
        if (!key) return;
        
        setError('');
        
        // Optimistic UI update
        setRun((prev) => {
            if (!prev) return prev;
            const stops = Array.isArray(prev.stops) ? [...prev.stops] : [];
            const sIdx = stops.findIndex(s => String(s?.awb || '').toUpperCase() === key);
            if (sIdx >= 0) {
                stops[sIdx] = { ...stops[sIdx], state: 'ARRIVED' };
            } else {
                stops.push({ awb: key, state: 'ARRIVED' });
            }
            return { ...prev, stops };
        });

        // Background sync
        (async () => {
            try {
                const gps = await detectGps();
                await routeRunArrive(token, run.id, key, gps);
                await refreshRun();
            } catch (e) {
                console.warn('Background arrival failed', e);
            }
        })();
    };

    const markDepart = async (awb) => {
        if (!token || !run?.id) return;
        const key = String(awb || '').toUpperCase();
        if (!key) return;
        
        setError('');
        
        // Optimistic UI update
        setRun((prev) => {
            if (!prev) return prev;
            const stops = Array.isArray(prev.stops) ? [...prev.stops] : [];
            const sIdx = stops.findIndex(s => String(s?.awb || '').toUpperCase() === key);
            if (sIdx >= 0) {
                stops[sIdx] = { ...stops[sIdx], state: 'DEPARTED' };
            } else {
                stops.push({ awb: key, state: 'DEPARTED' });
            }
            return { ...prev, stops };
        });

        // Background sync
        (async () => {
            try {
                const gps = await detectGps();
                await routeRunDepart(token, run.id, key, gps);
                await refreshRun();
            } catch (e) {
                console.warn('Background departure failed', e);
            }
        })();
    };

    const onStatusComplete = async (outcome, meta) => {
        const awb = String(meta?.awb || statusAwb || '').toUpperCase();
        const eventId = meta?.event_id ? String(meta.event_id) : null;
        setStatusAwb(null);
        if (!token || !run?.id || !awb) return;

        setRunBusy(true);
        setError('');
        try {
            const newState = String(outcome || '').toUpperCase();
            
            // Optimistic UI Update: immediately complete the stop so the UI snaps to the next delivery
            setRun((prev) => {
                if (!prev) return prev;
                const stops = Array.isArray(prev.stops) ? [...prev.stops] : [];
                const sIdx = stops.findIndex(s => String(s?.awb || '').toUpperCase() === awb);
                if (sIdx >= 0) {
                    stops[sIdx] = { ...stops[sIdx], state: newState, completed_at: new Date().toISOString() };
                } else {
                    stops.push({ awb, state: newState, completed_at: new Date().toISOString() });
                }
                return { ...prev, stops };
            });

            let gps = null;
            try {
                gps = await detectGps();
            } catch { }
            await routeRunComplete(token, run.id, awb, {
                completion_event_id: eventId || undefined,
                latitude: gps?.latitude,
                longitude: gps?.longitude,
                data: { outcome: newState, event_id: eventId, ...meta?.payload }
            });
            await refreshRun();
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to update run stop'));
        } finally {
            setRunBusy(false);
        }
    };

    const finish = async () => {
        if (!token || !run?.id) return;
        setRunBusy(true);
        setError('');
        try {
            const updated = await finishRouteRun(token, run.id);
            setRun(updated || run);
            try { localStorage.removeItem(RUN_KEY(routeId)); } catch { }
            setMsg('Run finished.');
            setTimeout(() => setMsg(''), 2500);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to finish run'));
        } finally {
            setRunBusy(false);
        }
    };

    const currentAwb = awbs[idx] || null;
    const currentShipment = currentAwb ? shipmentsByAwb.get(String(currentAwb).toUpperCase()) : null;
    const currentStop = useMemo(() => {
        const stops = Array.isArray(run?.stops) ? run.stops : [];
        const key = String(currentAwb || '').toUpperCase();
        return stops.find((s) => String(s?.awb || '').toUpperCase() === key) || null;
    }, [run?.stops, currentAwb]);

    const phone = currentShipment?.recipient_phone || null;
    const lat = Number(currentShipment?.latitude ?? currentShipment?.raw_data?.recipientPin?.latitude ?? currentShipment?.raw_data?.recipientLocation?.latitude);
    const lon = Number(currentShipment?.longitude ?? currentShipment?.raw_data?.recipientPin?.longitude ?? currentShipment?.raw_data?.recipientLocation?.longitude);
    const needsLocationConfirmation = Boolean(
        currentShipment?.requires_location_confirmation
        || (
            !currentShipment?.has_precise_address
            && String(currentShipment?.location_granularity || '').toLowerCase() !== 'pin'
            && String(currentShipment?.locality || '').trim()
        )
    );

    const openNavigationPicker = (nextLat, nextLon, nextLabel = '') => {
        const la = Number(nextLat);
        const lo = Number(nextLon);
        const lab = String(nextLabel || '').trim();
        if ((!Number.isFinite(la) || !Number.isFinite(lo)) && !lab) return;
        setNavigationPicker({
            open: true,
            lat: la,
            lon: lo,
            label: lab,
        });
    };

    const closeNavigationPicker = () => {
        setNavigationPicker({ open: false, lat: null, lon: null, label: '' });
    };

    const startNavigationVia = (provider) => {
        const la = Number(navigationPicker?.lat);
        const lo = Number(navigationPicker?.lon);
        const lab = String(navigationPicker?.label || '').trim();
        if ((!Number.isFinite(la) || !Number.isFinite(lo)) && !lab) {
            closeNavigationPicker();
            return;
        }
        if (String(provider || '').toLowerCase() === 'waze') {
            openWazeTo(la, lo, lab);
        } else {
            openGoogleMapsTo(la, lo, lab);
        }
        closeNavigationPicker();
    };

    const logContact = async (channel, outcome = 'initiated', notes = '') => {
        if (!token || !currentAwb) return;
        try {
            await createContactAttempt(token, {
                awb: currentAwb,
                channel,
                to_phone: phone || undefined,
                outcome,
                notes: String(notes || '').trim() || undefined
            });
        } catch { }
    };

    if (statusAwb) {
        return (
            <StatusSelect
                awb={statusAwb}
                onBack={() => setStatusAwb(null)}
                onComplete={onStatusComplete}
            />
        );
    }

    const currentStopIsFinished = currentStop && (currentStop.completed_at || ['DONE', 'SKIPPED', 'COMPLETED'].includes(String(currentStop.state || '').toUpperCase()));
    const allStopsFinished = run?.stops?.length > 0 && run.stops.every(s => (s.completed_at || ['DONE', 'SKIPPED', 'COMPLETED'].includes(String(s.state || '').toUpperCase())));

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="min-w-0 flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => navigate(-1)}
                        className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all"
                        aria-label="Back"
                    >
                        <ArrowLeft size={18} />
                    </button>
                    <div className="min-w-0">
                        <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                            <MapPinned size={18} className="text-emerald-300" />
                            Route Run
                        </h1>
                        <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                            {route ? routeDisplayName(route) : `Route ${routeId}`}
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={refreshRun}
                    className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={runBusy}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={runBusy ? 'animate-spin' : ''} />
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-4 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}
                {msg ? (
                    <div className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-300 text-xs font-bold">
                        {msg}
                    </div>
                ) : null}

                {!route ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 text-slate-300 font-bold">
                        Route not found or access denied.
                    </div>
                ) : awbs.length === 0 ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 text-slate-300 font-bold">
                        This route has no stops.
                    </div>
                ) : (
                    <>
                        <div className="h-48 sm:h-64 w-full rounded-2xl overflow-hidden shadow-lg border border-white/10 relative z-20">
                            <MapComponent
                                shipments={routeStopsForMap}
                                originLocation={warehouseOrigin}
                                routeGeometry={routeGeometry}
                                showStopNumbers
                                showTraffic
                                trafficProvider={routeMetrics.provider}
                                returnToOrigin
                            />
                            {routeMetrics.distance_km ? (
                                <div className="absolute bottom-2 left-2 right-2 bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-xl p-2 flex justify-around items-center z-10 text-white shadow-lg pointer-events-none">
                                    <div className="text-center">
                                        <p className="text-[9px] text-slate-400 uppercase tracking-widest font-black">Dist</p>
                                        <p className="text-xs font-black text-emerald-300">~{routeMetrics.distance_km} km</p>
                                    </div>
                                    <div className="w-px h-5 bg-white/10"></div>
                                    <div className="text-center">
                                        <p className="text-[9px] text-slate-400 uppercase tracking-widest font-black">Time</p>
                                        <p className="text-xs font-black text-amber-300">~{routeMetrics.duration_min} min</p>
                                    </div>
                                    {routeMetrics.delay_min > 0 && (
                                        <>
                                            <div className="w-px h-5 bg-white/10"></div>
                                            <div className="text-center">
                                                <p className="text-[9px] text-rose-400 uppercase tracking-widest font-black">Delay</p>
                                                <p className="text-xs font-black text-rose-300">+{routeMetrics.delay_min} min</p>
                                            </div>
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </div>

                        <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Stop</div>
                                    <div className="text-lg font-black text-white truncate">
                                        {idx + 1}/{awbs.length} •{' '}
                                        <AwbLink
                                            awb={currentAwb}
                                            className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-emerald-300"
                                            title="Deschide detalii AWB"
                                        >
                                            {currentAwb}
                                        </AwbLink>
                                    </div>
                                    <div className="text-xs text-slate-300 font-bold mt-1 truncate">
                                        {loadingShipments ? 'Loading…' : (
                                            currentShipment?.recipient_name 
                                            || currentShipment?.raw_data?.recipientName 
                                            || currentShipment?.raw_data?.recipientContact 
                                            || currentShipment?.raw_data?.recipientCompany 
                                            || '--'
                                        )}
                                    </div>
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2 truncate">
                                        {
                                            currentShipment?.delivery_address 
                                            || currentShipment?.locality 
                                            || currentShipment?.raw_data?.recipientAddress 
                                            || currentShipment?.raw_data?.recipientLocation?.localityName 
                                            || ''
                                        }
                                    </div>
                                    {currentStop?.state ? (
                                        <div className="text-[10px] text-emerald-300 font-black uppercase tracking-widest mt-2">
                                            State: {currentStop.state}
                                        </div>
                                    ) : null}
                                </div>
                                {run?.id ? (
                                    <div className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest">
                                        Run #{run.id}
                                    </div>
                                ) : null}
                            </div>

                            {!run?.id ? (
                                <button
                                    type="button"
                                    onClick={start}
                                    disabled={runBusy}
                                    className={`w-full px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    {runBusy ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                                    Start run
                                </button>
                            ) : currentStopIsFinished ? (
                                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex flex-col items-center justify-center text-center space-y-2">
                                    <CheckCircle2 size={24} className="text-emerald-400" />
                                    <p className="text-xs font-black text-emerald-300 uppercase tracking-widest">
                                        Stop Completed
                                    </p>
                                    <p className="text-[10px] text-emerald-400/80 font-bold">
                                        AWB-ul a fost actualizat și nu mai poate fi modificat.
                                    </p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => markDepart(currentAwb)}
                                        disabled={runBusy}
                                        className={`px-4 py-3 rounded-2xl bg-sky-500/15 border border-sky-500/20 text-sky-200 text-xs font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                        <Send size={16} />
                                        Plecat spre client
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => markArrived(currentAwb)}
                                        disabled={runBusy}
                                        className={`px-4 py-3 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-xs font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                        <Crosshair size={16} />
                                        Arrived
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setStatusAwb(currentAwb)}
                                        disabled={runBusy}
                                        className={`px-4 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                        <CheckCircle2 size={16} />
                                        Update status
                                    </button>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-2 sm:gap-3">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!phone) return;
                                        logContact('call', 'initiated');
                                        window.location.href = `tel:${String(phone)}`;
                                    }}
                                    disabled={!phone}
                                    className="min-w-0 px-2 sm:px-4 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-wide sm:tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-1.5 sm:gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <Phone size={16} className="shrink-0" />
                                    <span className="truncate">Call</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!phone) return;
                                        const template = `Salut! 🚚 Sunt curierul tău Curieru.\\n\\nÎți aduc un colet la adresa ta (AWB: ${currentAwb}).\\n\\nTe rog să îmi trimiți aici pe WhatsApp *LOCAȚIA EXACTĂ* (un Pin / Location Share) ca să ajung direct la tine mai repede și fără probleme. 📍\\n\\nPentru a mă urmări LIVE pe hartă (ca la Uber) și a vedea când ajung, instalează gratuit aplicația noastră:\\n👉 https://curieru.com\\n\\nMulțumesc!`;
                                        openWhatsApp(phone, template);
                                        logContact('whatsapp', 'initiated');
                                    }}
                                    disabled={!phone}
                                    className="min-w-0 px-2 sm:px-4 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-xs font-black uppercase tracking-wide sm:tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-1.5 sm:gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <MessageCircle size={16} className="shrink-0" />
                                    <span className="truncate">Notificare Locație (WhatsApp)</span>
                                </button>
                            </div>

                            {needsLocationConfirmation ? (
                                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
                                    <p className="text-[11px] font-black uppercase tracking-wider">
                                        Adresa incompleta: localizare la nivel de localitate
                                    </p>
                                    <p className="text-[11px] font-bold mt-1">
                                        Contacteaza clientul pentru locatia exacta (Call / WhatsApp), apoi continua livrarea.
                                    </p>
                                </div>
                            ) : null}

                            <button
                                type="button"
                                onClick={() => openNavigationPicker(lat, lon, currentShipment?.delivery_address || currentShipment?.locality || '')}
                                disabled={(!Number.isFinite(lat) || !Number.isFinite(lon)) && !(currentShipment?.delivery_address || currentShipment?.locality)}
                                className="w-full px-4 py-3 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-xs font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                <ExternalLink size={16} />
                                Navigate
                            </button>

                            {run?.id ? (
                                <div className="space-y-2">
                                    <button
                                        type="button"
                                        onClick={finish}
                                        disabled={runBusy || !allStopsFinished}
                                        className={`w-full px-4 py-3 rounded-2xl border text-xs font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all ${
                                            allStopsFinished 
                                                ? 'bg-rose-500 hover:bg-rose-600 text-white border-rose-600 cursor-pointer shadow-lg shadow-rose-500/20' 
                                                : 'bg-rose-500/10 border-rose-500/20 text-rose-500 opacity-50 cursor-not-allowed'
                                        }`}
                                    >
                                        Finish run
                                    </button>
                                    {!allStopsFinished && (
                                        <p className="text-center text-[10px] font-bold text-rose-400/70">
                                            Toate AWB-urile trebuie actualizate înainte de a încheia traseul.
                                        </p>
                                    )}
                                </div>
                            ) : null}
                        </div>

                        <div className="glass-strong p-5 rounded-3xl border border-white/10">
                            <div className="flex items-center justify-between gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIdx((p) => Math.max(0, p - 1))}
                                    disabled={idx <= 0}
                                    className="px-4 py-2 rounded-2xl glass-light border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    Prev
                                </button>
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                    Tap a stop to jump
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setIdx((p) => Math.min(activeStopIdx, p + 1))}
                                    disabled={idx >= activeStopIdx}
                                    className="px-4 py-2 rounded-2xl glass-light border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    Next
                                </button>
                            </div>

                            <div className="mt-3 max-h-[56vh] overflow-y-auto space-y-2 pr-1">
                                {awbs.map((a, i) => {
                                    const isFuture = i > activeStopIdx;
                                    
                                    if (isFuture) {
                                        return (
                                            <div key={a} className="w-full p-3 rounded-2xl border glass-light border-white/5 opacity-50 text-left cursor-not-allowed">
                                                <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                                    {i + 1}. Urmatoarea oprire
                                                </div>
                                                <div className="text-xs font-bold text-slate-400 mt-1">Detalii ascunse</div>
                                                <div className="text-[10px] font-bold text-slate-600 mt-1">
                                                    Completează oprirea curentă pentru a debloca.
                                                </div>
                                            </div>
                                        );
                                    }

                                    const shipment = shipmentsByAwb.get(String(a || '').toUpperCase()) || null;
                                    const locality = String(
                                        shipment?.locality
                                        || shipment?.raw_data?.recipientLocation?.localityName
                                        || shipment?.raw_data?.recipientPin?.localityName
                                        || ''
                                    ).trim();
                                    const address = String(shipment?.delivery_address || '').trim();
                                    return (
                                        <button
                                            key={a}
                                            type="button"
                                            onClick={() => setIdx(i)}
                                            className={`w-full p-3 rounded-2xl border text-left ${i === idx
                                                ? 'bg-emerald-500/15 border-emerald-500/20 text-white'
                                                : 'glass-light border-white/10 text-slate-200 hover:bg-white/5'
                                                }`}
                                        >
                                            <div className="text-[10px] font-black uppercase tracking-widest">
                                                {i + 1}.{' '}
                                                <AwbLink
                                                    awb={a}
                                                    className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-emerald-300"
                                                    title="Deschide detalii AWB"
                                                >
                                                    {a}
                                                </AwbLink>
                                            </div>
                                            {shipment?.recipient_name ? (
                                                <div className="text-xs font-bold mt-1 truncate">{shipment.recipient_name}</div>
                                            ) : null}
                                            {(locality || address) ? (
                                                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mt-1 truncate">
                                                    {locality || address}
                                                </div>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </main>

            {navigationPicker.open ? (
                <div
                    className="fixed inset-0 z-[85] bg-black/70 backdrop-blur-sm p-4 flex items-end justify-center"
                    onClick={closeNavigationPicker}
                >
                    <div
                        className="w-full max-w-sm glass-strong rounded-3xl border-iridescent p-5 space-y-3"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Start Navigation With</p>
                        <button
                            type="button"
                            onClick={() => startNavigationVia('google')}
                            className="w-full px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all"
                        >
                            Google Maps
                        </button>
                        <button
                            type="button"
                            onClick={() => startNavigationVia('waze')}
                            className="w-full px-4 py-3 rounded-2xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all"
                        >
                            Waze
                        </button>
                        <button
                            type="button"
                            onClick={closeNavigationPicker}
                            className="w-full px-4 py-3 rounded-2xl bg-slate-900/45 border border-white/10 text-slate-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}
        </motion.div>
    );
}
