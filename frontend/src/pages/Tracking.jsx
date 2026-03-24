import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, MapPin, RefreshCw, Square, ShieldAlert } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import MapComponent from '../components/MapComponent';
import { normalizeRole } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { getTrackingLatest, getTrackingRequest, stopTrackingRequest } from '../services/api';

const fmtDateTime = (iso) => {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return '';
    }
};

const LIVE_POLL_MS = 2000;
const DETAILS_POLL_MS = 12000;

export default function Tracking() {
    const navigate = useNavigate();
    const { requestId } = useParams();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [req, setReq] = useState(null);
    const [loc, setLoc] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busyStop, setBusyStop] = useState(false);
    const [error, setError] = useState('');
    const [statusMsg, setStatusMsg] = useState('');

    const role = normalizeRole(user?.role);
    const canStop = useMemo(() => {
        const uid = String(user?.driver_id || '').trim();
        if (!uid || !req?.id) return false;
        const isRequester = uid === String(req?.created_by_user_id || '').trim();
        const isTarget = uid === String(req?.target_driver_id || '').trim();
        if (isTarget && role === 'Driver') return false;
        return isRequester || isTarget;
    }, [role, user?.driver_id, req?.id, req?.created_by_user_id, req?.target_driver_id]);

    const refresh = async ({ withDetails = true } = {}) => {
        if (!token) return;
        setError('');
        try {
            let reqLocal = req;
            if (withDetails) {
                const r = await getTrackingRequest(token, requestId);
                setReq(r);
                reqLocal = r;
            }

            try {
                const latest = await getTrackingLatest(token, requestId);
                setLoc(latest);
                setStatusMsg('');
            } catch (e) {
                const detail = String(e?.response?.data?.detail || e?.message || '');
                setLoc(null);
                const st = String(reqLocal?.status || '').trim();
                if (st === 'Pending') setStatusMsg('Activating live location...');
                else if (st === 'Denied') setStatusMsg('Driver denied the request.');
                else if (st === 'Stopped') setStatusMsg('Tracking was stopped.');
                else if (st === 'Accepted' && detail.toLowerCase().includes('no location')) setStatusMsg('Waiting for first GPS update...');
                else setStatusMsg(detail || 'No location yet');
            }
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load tracking'));
            setReq(null);
            setLoc(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        refresh({ withDetails: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestId, token]);

    useEffect(() => {
        if (!token) return;
        const id = setInterval(() => refresh({ withDetails: false }), LIVE_POLL_MS);
        const detailsId = setInterval(() => refresh({ withDetails: true }), DETAILS_POLL_MS);
        return () => {
            clearInterval(id);
            clearInterval(detailsId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestId, token]);

    const stop = async () => {
        if (!canStop || !req?.id || !token) return;
        setBusyStop(true);
        setError('');
        try {
            const updated = await stopTrackingRequest(token, req.id);
            setReq(updated || req);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to stop tracking'));
        } finally {
            setBusyStop(false);
        }
    };

    const currentLocation = loc ? { lat: Number(loc.latitude), lon: Number(loc.longitude) } : null;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

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
                            <MapPin size={18} className="text-emerald-300" />
                            Live Tracking
                        </h1>
                        <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                            Request #{requestId}
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => refresh({ withDetails: true })}
                    className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={loading}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-3 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                {loading ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 flex items-center gap-3 text-slate-300">
                        <Loader2 className="animate-spin" size={18} />
                        <span className="text-sm font-bold">Loading...</span>
                    </div>
                ) : null}

                {req ? (
                    <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs text-slate-500 font-black uppercase tracking-widest">Status</p>
                                <p className="text-sm font-black text-white truncate">{String(req.status || '—')}</p>
                            </div>
                            {canStop && String(req.status || '') === 'Accepted' ? (
                                <button
                                    type="button"
                                    onClick={stop}
                                    disabled={busyStop}
                                    className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all ${busyStop
                                        ? 'opacity-60 cursor-not-allowed bg-slate-900/40 border-white/10 text-slate-400'
                                        : 'bg-rose-500/15 border-rose-500/20 text-rose-200 hover:bg-rose-500/20 active:scale-95'
                                        }`}
                                    title="Stop tracking"
                                >
                                    {busyStop ? <Loader2 size={14} className="animate-spin inline-block mr-1 -mt-0.5" /> : <Square size={14} className="inline-block mr-1 -mt-0.5" />}
                                    Stop
                                </button>
                            ) : null}
                        </div>

                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                            Created: {req.created_at ? fmtDateTime(req.created_at) : '--'}
                            {req.awb ? ` • AWB ${String(req.awb).toUpperCase()}` : ''}
                        </p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                            Driver: {req.target_driver_name ? String(req.target_driver_name).trim() : String(req.target_driver_id || '--')}
                            {req.target_truck_plate ? ` • Truck ${String(req.target_truck_plate).toUpperCase()}` : ''}
                            {req.target_truck_phone ? ` • Phone ${req.target_truck_phone}` : ''}
                        </p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                            Expires: {req.expires_at ? fmtDateTime(req.expires_at) : '--'}
                            {req.last_location_at ? ` • Last update ${fmtDateTime(req.last_location_at)}` : ''}
                        </p>
                    </div>
                ) : null}

                <div className="glass-strong p-4 rounded-3xl border border-white/10 overflow-hidden relative">
                    {loc ? (
                        <>
                            <MapComponent
                                shipments={[]}
                                routeGeometry={null}
                                currentLocation={currentLocation}
                                originLocation={null}
                                showStopNumbers={false}
                                currentLocationLabel="Locație Curier"
                                currentLocationPlate={String(req?.target_truck_plate || '').trim().toUpperCase()}
                            />
                            <div className="mt-3 text-xs text-slate-300 font-bold flex items-center justify-between">
                                <span>GPS Actualizat: {fmtDateTime(loc.timestamp)}</span>
                                <span className="flex h-2 w-2 relative">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="w-full h-64 flex flex-col items-center justify-center p-6 text-center bg-slate-900/40 rounded-2xl relative overflow-hidden">
                            <div className="absolute inset-0 bg-map-pattern opacity-5 pointer-events-none"></div>
                            <div className="w-16 h-16 rounded-full bg-orange-500/20 border border-orange-500/30 flex items-center justify-center mb-4 z-10 shadow-lg shadow-orange-500/10">
                                <ShieldAlert size={32} className="text-orange-400 drop-shadow-md" />
                            </div>
                            <h3 className="text-base font-black text-white uppercase tracking-tight mb-2 z-10 drop-shadow-md">
                                Confidențialitate & Securitate
                            </h3>
                            <p className="text-xs text-slate-300 font-bold max-w-[280px] leading-relaxed z-10 drop-shadow-md">
                                {statusMsg || 'Așteptăm actualizări de la curier...'}
                            </p>
                        </div>
                    )}
                </div>
            </main>
        </motion.div>
    );
}
