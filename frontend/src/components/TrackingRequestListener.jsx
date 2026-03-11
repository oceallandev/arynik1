import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, MapPin } from 'lucide-react';
import { normalizeRole } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import {
    acceptTrackingRequest,
    listTrackingInbox,
    listTrackingActive,
    updateLocation
} from '../services/api';

const fmtTime = (iso) => {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
};

const isHardLocationError = (value) => {
    const msg = String(value || '').trim().toLowerCase();
    if (!msg) return false;
    return (
        msg.includes('denied')
        || msg.includes('permission')
        || msg.includes('not supported')
        || msg.includes('secure context')
        || msg.includes('secure origin')
    );
};

const LOCATION_PUSH_MIN_MS = 3000;
const LOCATION_PUSH_HEARTBEAT_MS = 6000;

export default function TrackingRequestListener() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const role = normalizeRole(user?.role);
    const isDriver = role === 'Driver';

    const [pending, setPending] = useState([]);
    const [active, setActive] = useState(null);
    const [error, setError] = useState('');

    // Driver location reporting is mandatory and always-on.
    const enabled = isDriver;
    const { location, error: geoError } = useGeolocation({ enabled });
    const hardGeoBlocked = useMemo(() => isHardLocationError(geoError), [geoError]);

    const activeUntilMs = useMemo(() => {
        if (!active?.expires_at) return null;
        const t = new Date(active.expires_at).getTime();
        return Number.isFinite(t) ? t : null;
    }, [active?.expires_at]);

    const locationRef = useRef(null);
    useEffect(() => {
        if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
            locationRef.current = {
                latitude: Number(location.latitude),
                longitude: Number(location.longitude),
            };
        }
    }, [location?.latitude, location?.longitude]);

    useEffect(() => {
        if (!isDriver || !token) return;

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

                // Auto-accept pending requests for drivers so tracking cannot be hidden.
                const pend = Array.isArray(items) ? items : [];
                for (const req of pend) {
                    const rid = req?.id;
                    if (!rid) continue;
                    try {
                        const accepted = await acceptTrackingRequest(token, rid);
                        if (cancelled) return;
                        if (accepted?.id) {
                            setActive(accepted);
                            setPending((prev) => (Array.isArray(prev) ? prev.filter((r) => String(r?.id) !== String(rid)) : prev));
                        }
                    } catch {
                        // Keep retrying on next poll.
                    }
                }
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
    }, [isDriver, token]);

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
    const pushLocation = async (coords) => {
        if (!enabled || !token || !coords) return;
        const payload = {
            latitude: Number(coords.latitude),
            longitude: Number(coords.longitude),
        };
        if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude)) return;

        const now = Date.now();
        if (now - lastSentAtRef.current < LOCATION_PUSH_MIN_MS) return;
        lastSentAtRef.current = now;

        try {
            await updateLocation(token, payload);
            setError('');
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to send location'));
        }
    };

    useEffect(() => {
        if (!enabled || !token || !location) return;
        pushLocation(location);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, location?.latitude, location?.longitude, token]);

    useEffect(() => {
        if (!enabled || !token) return;
        const id = setInterval(() => {
            const coords = locationRef.current;
            if (!coords) return;
            pushLocation(coords);
        }, LOCATION_PUSH_HEARTBEAT_MS);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, token]);

    const currentPending = useMemo(() => {
        const list = Array.isArray(pending) ? pending : [];
        return list.length > 0 ? list[0] : null;
    }, [pending]);

    if (!isDriver) return null;
    if (!currentPending && !active && !geoError && !error) return null;

    return (
        <>
            {hardGeoBlocked ? (
                <div className="fixed inset-0 z-[85] bg-slate-950/90 backdrop-blur-sm p-6 flex items-center justify-center">
                    <div className="w-full max-w-md rounded-3xl border border-amber-500/30 bg-slate-900/95 p-6 shadow-2xl">
                        <div className="flex items-start gap-3">
                            <div className="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                                <AlertTriangle size={18} className="text-amber-200" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-base font-black text-white">Locatia este obligatorie pentru sofer</p>
                                <p className="mt-2 text-sm font-semibold text-slate-300">
                                    Activeaza accesul la locatie (GPS) pentru aplicatie. Fara locatie activa nu se poate continua livrarea.
                                </p>
                                <p className="mt-2 text-xs font-bold text-amber-200 break-words">{String(geoError || '').trim()}</p>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
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
                                        <p className="text-sm font-black text-white truncate">Automatic live location ON</p>
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
                        ) : currentPending ? (
                            <div className="flex items-start gap-3">
                                <div className="w-11 h-11 rounded-2xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
                                    <MapPin size={18} className="text-violet-200" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-white truncate">Location request auto-accepted</p>
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

                                <div className="w-11 h-11 rounded-2xl border flex items-center justify-center transition-all bg-emerald-500/15 border-emerald-500/20 text-emerald-200">
                                    <Loader2 size={18} className="animate-spin" />
                                </div>
                            </div>
                        ) : (
                            <div className="flex items-start gap-3">
                                <div className="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
                                    <MapPin size={18} className="text-amber-200" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-white truncate">Automatic live location required</p>
                                    {geoError ? (
                                        <p className="mt-1 text-[11px] font-bold text-amber-200">
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
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
