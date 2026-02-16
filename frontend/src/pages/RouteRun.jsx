import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle2, Crosshair, ExternalLink, Loader2, MapPinned, MessageCircle, Phone, RefreshCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import StatusSelect from './StatusSelect';
import { createContactAttempt, finishRouteRun, getRouteRun, getShipments, routeRunArrive, routeRunComplete, startRouteRun } from '../services/api';
import { getRoute, routeDisplayName } from '../services/routesStore';

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
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('destination', `${la},${lo}`);
    if (label) url.searchParams.set('destination_place_id', label);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

const detectGps = async () => {
    if (!navigator.geolocation) throw new Error('Geolocation is not supported');
    const coords = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            (p) => resolve(p.coords),
            (e) => reject(new Error(e?.message || 'GPS error')),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    });
    const lat = Number(coords?.latitude);
    const lon = Number(coords?.longitude);
    const acc = Number(coords?.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid GPS coordinates');
    return { latitude: lat, longitude: lon, accuracy_m: Number.isFinite(acc) ? acc : null };
};

export default function RouteRun() {
    const { routeId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [route, setRoute] = useState(null);
    const [shipmentsByAwb, setShipmentsByAwb] = useState(new Map());
    const [loadingShipments, setLoadingShipments] = useState(true);

    const [run, setRun] = useState(null);
    const [runBusy, setRunBusy] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');

    const [idx, setIdx] = useState(0);
    const [statusAwb, setStatusAwb] = useState(null);

    useEffect(() => {
        const r = getRoute(routeId);
        setRoute(r);
    }, [routeId]);

    const awbs = useMemo(() => (Array.isArray(route?.awbs) ? route.awbs.map((x) => String(x || '').toUpperCase()).filter(Boolean) : []), [route?.awbs]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingShipments(true);
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
    }, [token]);

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
                truck_plate: route?.vehicle_plate || user?.truck_plate || undefined,
                helper_name: route?.helper_name || user?.helper_name || undefined,
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
        setRunBusy(true);
        setError('');
        try {
            const gps = await detectGps();
            await routeRunArrive(token, run.id, key, gps);
            await refreshRun();
            setMsg('Arrived logged.');
            setTimeout(() => setMsg(''), 2000);
        } catch (e) {
            setError(String(e?.message || e?.response?.data?.detail || 'Failed to log arrival'));
        } finally {
            setRunBusy(false);
        }
    };

    const onStatusComplete = async (outcome, meta) => {
        const awb = String(meta?.awb || statusAwb || '').toUpperCase();
        const eventId = meta?.event_id ? String(meta.event_id) : null;
        setStatusAwb(null);
        if (!token || !run?.id || !awb) return;

        setRunBusy(true);
        setError('');
        try {
            let gps = null;
            try {
                gps = await detectGps();
            } catch { }
            await routeRunComplete(token, run.id, awb, {
                completion_event_id: eventId || undefined,
                latitude: gps?.latitude,
                longitude: gps?.longitude,
                data: { outcome: String(outcome || '').toUpperCase(), event_id: eventId }
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
                        Route not found on this device.
                    </div>
                ) : awbs.length === 0 ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 text-slate-300 font-bold">
                        This route has no stops.
                    </div>
                ) : (
                    <>
                        <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Stop</div>
                                    <div className="text-lg font-black text-white truncate">
                                        {idx + 1}/{awbs.length} • {currentAwb}
                                    </div>
                                    <div className="text-xs text-slate-300 font-bold mt-1 truncate">
                                        {loadingShipments ? 'Loading…' : (currentShipment?.recipient_name || '--')}
                                    </div>
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2 truncate">
                                        {currentShipment?.delivery_address || currentShipment?.locality || ''}
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
                            ) : (
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => markArrived(currentAwb)}
                                        disabled={runBusy}
                                        className={`px-4 py-3 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                        <Crosshair size={16} />
                                        Arrived
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setStatusAwb(currentAwb)}
                                        disabled={runBusy}
                                        className={`px-4 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                        <CheckCircle2 size={16} />
                                        Update status
                                    </button>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!phone) return;
                                        logContact('call', 'initiated');
                                        window.location.href = `tel:${String(phone)}`;
                                    }}
                                    disabled={!phone}
                                    className="px-4 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <Phone size={16} />
                                    Call
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { if (!phone) return; openWhatsApp(phone, `AWB ${currentAwb}`); logContact('whatsapp', 'initiated'); }}
                                    disabled={!phone}
                                    className="px-4 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <MessageCircle size={16} />
                                    WhatsApp
                                </button>
                            </div>

                            <button
                                type="button"
                                onClick={() => openGoogleMapsTo(lat, lon, currentShipment?.delivery_address || '')}
                                disabled={!Number.isFinite(lat) || !Number.isFinite(lon)}
                                className="w-full px-4 py-3 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                <ExternalLink size={16} />
                                Navigate
                            </button>

                            {run?.id ? (
                                <button
                                    type="button"
                                    onClick={finish}
                                    disabled={runBusy}
                                    className={`w-full px-4 py-3 rounded-2xl bg-rose-500/15 border border-rose-500/20 text-rose-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${runBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    Finish run
                                </button>
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
                                    onClick={() => setIdx((p) => Math.min(awbs.length - 1, p + 1))}
                                    disabled={idx >= awbs.length - 1}
                                    className="px-4 py-2 rounded-2xl glass-light border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    Next
                                </button>
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2">
                                {awbs.slice(0, 40).map((a, i) => (
                                    <button
                                        key={a}
                                        type="button"
                                        onClick={() => setIdx(i)}
                                        className={`p-3 rounded-2xl border text-left ${i === idx
                                            ? 'bg-emerald-500/15 border-emerald-500/20 text-white'
                                            : 'glass-light border-white/10 text-slate-200 hover:bg-white/5'
                                            }`}
                                    >
                                        <div className="text-[10px] font-black uppercase tracking-widest">{i + 1}. {a}</div>
                                    </button>
                                ))}
                            </div>
                            {awbs.length > 40 ? (
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-3">
                                    Showing first 40 stops
                                </div>
                            ) : null}
                        </div>
                    </>
                )}
            </main>
        </motion.div>
    );
}
