import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, MapPinned, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import DriversMap from '../components/DriversMap';
import { getLiveDrivers, listActiveRouteRuns } from '../services/api';

const fmtDateTime = (iso) => {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return '';
    }
};

const progressLabel = (run) => {
    const stops = Array.isArray(run?.stops) ? run.stops : [];
    const total = stops.length;
    const done = stops.filter((s) => ['Done', 'Skipped'].includes(String(s?.state || ''))).length;
    if (!total) return '0/0';
    return `${done}/${total}`;
};

export default function LiveOps() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [drivers, setDrivers] = useState([]);
    const [runs, setRuns] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const refresh = async () => {
        if (!token) return;
        setError('');
        try {
            const [dRes, rRes] = await Promise.all([
                getLiveDrivers(token, { limit: 200 }),
                listActiveRouteRuns(token, { limit: 50 }).catch(() => [])
            ]);
            setDrivers(Array.isArray(dRes?.drivers) ? dRes.drivers : []);
            setRuns(Array.isArray(rRes) ? rRes : []);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load live ops'));
            setDrivers([]);
            setRuns([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        refresh();
        if (!token) return;
        const id = setInterval(() => refresh(), 10000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const staleCount = useMemo(() => (
        (Array.isArray(drivers) ? drivers : []).filter((d) => Number(d?.age_sec) > 5 * 60).length
    ), [drivers]);

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
                <div className="min-w-0">
                    <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                        <Activity size={18} className="text-violet-300" />
                        Live Ops
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                        {drivers.length} drivers • {staleCount} stale
                    </p>
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    className={`w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={loading}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </header>

            <main className="flex-1 p-4 pb-32 space-y-4 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                <div className="glass-strong p-4 rounded-3xl border border-white/10">
                    <DriversMap drivers={drivers} />
                    <div className="mt-3 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                        Updated: {fmtDateTime(new Date().toISOString())}
                    </div>
                </div>

                <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Active route runs</div>
                        <MapPinned size={16} className="text-emerald-300" />
                    </div>
                    {runs.length === 0 ? (
                        <div className="text-slate-500 text-sm font-bold">No active runs.</div>
                    ) : (
                        <div className="space-y-2">
                            {runs.map((r) => (
                                <div
                                    key={r.id}
                                    className="glass-light p-4 rounded-2xl border border-white/10 flex items-center justify-between gap-3"
                                >
                                    <div className="min-w-0">
                                        <div className="text-sm font-black text-white truncate">
                                            {r.route_name || `Route #${r.id}`}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                            Driver {r.driver_id}{r.truck_plate ? ` • Truck ${String(r.truck_plate).toUpperCase()}` : ''}{r.started_at ? ` • Started ${fmtDateTime(r.started_at)}` : ''}
                                        </div>
                                    </div>
                                    <div className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest whitespace-nowrap">
                                        {progressLabel(r)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </motion.div>
    );
}

