import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Play, Square, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import {
    acceptTrackingRequest,
    denyTrackingRequest,
    listTrackingInbox,
    listTrackingActive,
    stopTrackingRequest,
    updateLocation
} from '../services/api';

const fmtTime = (iso) => {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
};

export default function TrackingRequestListener() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const role = String(user?.role || '').trim();

    const [pending, setPending] = useState([]);
    const [active, setActive] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');

    const enabled = role === 'Driver' && Boolean(active);
    const { location, error: geoError } = useGeolocation({ enabled });

    const activeUntilMs = useMemo(() => {
        if (!active?.expires_at) return null;
        const t = new Date(active.expires_at).getTime();
        return Number.isFinite(t) ? t : null;
    }, [active?.expires_at]);

    useEffect(() => {
        if (role !== 'Driver' || !token) return;

        let cancelled = false;
        const refresh = async () => {
            try {
                const items = await listTrackingInbox(token, { limit: 20 }).catch(() => []);
                if (!cancelled) setPending(Array.isArray(items) ? items : []);

                let actives = null;
                try {
                    const data = await listTrackingActive(token, { limit: 5 });
                    actives = Array.isArray(data) ? data : [];
                } catch {
                    actives = null; // Do not clear local state on transient API errors.
                }

                if (cancelled || actives === null) return;

                setActive((prev) => {
                    if (!prev) return actives[0] || null;
                    const stillActive = actives.some((r) => String(r?.id) === String(prev?.id));
                    return stillActive ? prev : null;
                });
            } catch (e) {
                // Non-fatal; keep the app usable even if tracking endpoints are down.
            }
        };

        refresh();
        const id = setInterval(refresh, 10000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [role, token]);

    // Auto-clear when the active request expires.
    useEffect(() => {
        if (!activeUntilMs) return;
        const tick = () => {
            if (Date.now() >= activeUntilMs) {
                setActive(null);
            }
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [activeUntilMs]);

    const lastSentAtRef = useRef(0);
    useEffect(() => {
        if (!enabled || !location || !token) return;

        const now = Date.now();
        if (now - lastSentAtRef.current < 8000) return;
        lastSentAtRef.current = now;

        const payload = {
            latitude: Number(location.latitude),
            longitude: Number(location.longitude)
        };
        if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude)) return;

        (async () => {
            try {
                await updateLocation(token, payload);
                setError('');
            } catch (e) {
                setError(String(e?.response?.data?.detail || e?.message || 'Failed to send location'));
            }
        })();
    }, [enabled, location?.latitude, location?.longitude, token]);

    const currentPending = useMemo(() => {
        if (active) return null;
        const list = Array.isArray(pending) ? pending : [];
        return list.length > 0 ? list[0] : null;
    }, [pending, active]);

    const doAccept = async () => {
        if (!currentPending?.id || !token) return;
        setBusyId(currentPending.id);
        setError('');
        try {
            const res = await acceptTrackingRequest(token, currentPending.id);
            setActive(res || null);
            setPending((prev) => (Array.isArray(prev) ? prev.filter((r) => String(r?.id) !== String(currentPending.id)) : prev));
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to accept request'));
        } finally {
            setBusyId(null);
        }
    };

    const doDeny = async () => {
        if (!currentPending?.id || !token) return;
        setBusyId(currentPending.id);
        setError('');
        try {
            await denyTrackingRequest(token, currentPending.id);
            setPending((prev) => (Array.isArray(prev) ? prev.filter((r) => String(r?.id) !== String(currentPending.id)) : prev));
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to deny request'));
        } finally {
            setBusyId(null);
        }
    };

    const doStop = async () => {
        if (!active?.id || !token) return;
        setBusyId(active.id);
        setError('');
        try {
            await stopTrackingRequest(token, active.id);
            setActive(null);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to stop tracking'));
        } finally {
            setBusyId(null);
        }
    };

    if (role !== 'Driver') return null;
    if (!currentPending && !active) return null;

    return (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-0 right-0 z-[70] px-4">
            <div className="max-w-xl mx-auto">
                <div className="glass-strong rounded-3xl border-iridescent p-4 shadow-2xl">
                    {active ? (
                        <div className="flex items-start gap-3">
                            <div className="w-11 h-11 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                                <MapPin size={18} className="text-emerald-200" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-black text-white truncate">Sharing live location</p>
                                    <button
                                        type="button"
                                        onClick={doStop}
                                        disabled={String(busyId) === String(active.id)}
                                        className={`px-3 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all ${String(busyId) === String(active.id)
                                            ? 'opacity-60 cursor-not-allowed bg-slate-900/40 border-white/10 text-slate-400'
                                            : 'bg-rose-500/15 border-rose-500/20 text-rose-200 hover:bg-rose-500/20 active:scale-95'
                                            }`}
                                        title="Stop sharing"
                                    >
                                        <Square size={14} className="inline-block mr-1 -mt-0.5" />
                                        Stop
                                    </button>
                                </div>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                    Until {active.expires_at ? fmtTime(active.expires_at) : '--'}
                                    {active.awb ? ` • AWB ${String(active.awb).toUpperCase()}` : ''}
                                </p>
                                {geoError ? (
                                    <p className="mt-2 text-[11px] font-bold text-amber-200">
                                        Location error: {geoError}
                                    </p>
                                ) : null}
                                {error ? (
                                    <p className="mt-2 text-[11px] font-bold text-rose-200">
                                        {error}
                                    </p>
                                ) : null}
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-start gap-3">
                            <div className="w-11 h-11 rounded-2xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
                                <MapPin size={18} className="text-violet-200" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-black text-white truncate">Location request</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                    Expires {currentPending?.expires_at ? fmtTime(currentPending.expires_at) : '--'}
                                    {currentPending?.awb ? ` • AWB ${String(currentPending.awb).toUpperCase()}` : ''}
                                </p>
                                {error ? (
                                    <p className="mt-2 text-[11px] font-bold text-rose-200">
                                        {error}
                                    </p>
                                ) : null}
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={doDeny}
                                    disabled={String(busyId) === String(currentPending?.id)}
                                    className={`w-11 h-11 rounded-2xl border flex items-center justify-center transition-all ${String(busyId) === String(currentPending?.id)
                                        ? 'opacity-60 cursor-not-allowed bg-slate-900/40 border-white/10 text-slate-500'
                                        : 'bg-slate-900/40 border-white/10 text-slate-300 hover:bg-white/5 active:scale-95'
                                        }`}
                                    title="Deny"
                                >
                                    <X size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={doAccept}
                                    disabled={String(busyId) === String(currentPending?.id)}
                                    className={`px-4 h-11 rounded-2xl border text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${String(busyId) === String(currentPending?.id)
                                        ? 'opacity-60 cursor-not-allowed bg-emerald-500/10 border-emerald-500/20 text-emerald-200'
                                        : 'bg-emerald-500/15 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95'
                                        }`}
                                    title="Start sharing"
                                >
                                    {String(busyId) === String(currentPending?.id) ? (
                                        <Loader2 size={16} className="animate-spin" />
                                    ) : (
                                        <Play size={16} />
                                    )}
                                    Share
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
