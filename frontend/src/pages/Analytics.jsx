import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, CheckCircle2, Loader2, RefreshCw, Search, Truck, User, Package } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getAnalytics } from '../services/api';

const pct = (num, den) => {
    const n = Number(num) || 0;
    const d = Number(den) || 0;
    if (!d) return 0;
    return Math.round((n / d) * 100);
};

const fmtTime = (iso) => {
    if (!iso) return '--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString();
};

const includesNeedle = (value, needle) => String(value || '').toLowerCase().includes(needle);

const StatChip = ({ label, value, tone = 'slate' }) => {
    const tones = {
        slate: 'bg-slate-500/15 text-slate-300 border-white/10',
        emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/20',
        rose: 'bg-rose-500/15 text-rose-300 border-rose-400/20',
        violet: 'bg-violet-500/15 text-violet-300 border-violet-400/20',
        amber: 'bg-amber-500/15 text-amber-200 border-amber-400/20',
    };

    return (
        <div className={`px-3 py-2 rounded-2xl border ${tones[tone] || tones.slate}`}>
            <div className="text-[9px] font-black uppercase tracking-widest opacity-80">{label}</div>
            <div className="text-sm font-black mt-0.5">{value}</div>
        </div>
    );
};

const TabButton = ({ active, icon: Icon, label, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        className={`flex-1 p-3 rounded-2xl border transition-all flex items-center justify-center gap-2 ${active
            ? 'bg-gradient-to-br from-violet-600/30 to-purple-600/10 border-violet-400/30 text-white'
            : 'bg-slate-900/30 border-white/10 text-slate-300 hover:bg-white/5'
            }`}
    >
        <Icon size={16} className={active ? 'text-violet-200' : 'text-slate-400'} />
        <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
    </button>
);

export default function Analytics() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const canViewAll = useMemo(() => (
        ['Admin', 'Manager', 'Dispatcher', 'Support', 'Finance'].includes(user?.role)
    ), [user?.role]);

    const [scope, setScope] = useState(canViewAll ? 'all' : 'self');
    const [tab, setTab] = useState('trucks'); // trucks | drivers | awbs | events
    const [search, setSearch] = useState('');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!canViewAll) {
            setScope('self');
        }
    }, [canViewAll]);

    const fetchAnalytics = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await getAnalytics(token, { scope });
            setData(res);
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to load analytics';
            setError(String(detail));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAnalytics();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, scope]);

    const needle = useMemo(() => String(search || '').trim().toLowerCase(), [search]);

    const filteredTrucks = useMemo(() => {
        const list = Array.isArray(data?.trucks) ? data.trucks : [];
        if (!needle) return list;
        return list.filter((t) => (
            includesNeedle(t?.truck_plate, needle)
            || includesNeedle(t?.truck_phone, needle)
            || (Array.isArray(t?.drivers) && t.drivers.some((d) => includesNeedle(d?.name, needle) || includesNeedle(d?.driver_id, needle)))
        ));
    }, [data?.trucks, needle]);

    const filteredDrivers = useMemo(() => {
        const list = Array.isArray(data?.drivers) ? data.drivers : [];
        if (!needle) return list;
        return list.filter((d) => (
            includesNeedle(d?.name, needle)
            || includesNeedle(d?.driver_id, needle)
            || includesNeedle(d?.truck_plate, needle)
            || includesNeedle(d?.truck_phone, needle)
            || includesNeedle(d?.role, needle)
        ));
    }, [data?.drivers, needle]);

    const filteredAwbs = useMemo(() => {
        const list = Array.isArray(data?.awbs) ? data.awbs : [];
        if (!needle) return list;
        return list.filter((a) => (
            includesNeedle(a?.awb, needle)
            || includesNeedle(a?.status, needle)
            || includesNeedle(a?.driver_id, needle)
        ));
    }, [data?.awbs, needle]);

    const filteredEvents = useMemo(() => {
        const list = Array.isArray(data?.events) ? data.events : [];
        if (!needle) return list;
        return list.filter((e) => (
            includesNeedle(e?.event_id, needle)
            || includesNeedle(e?.label, needle)
            || includesNeedle(e?.description, needle)
        ));
    }, [data?.events, needle]);

    const totals = data?.totals || {};
    const totalUpdates = Number(totals?.updates_total) || 0;
    const totalSuccess = Number(totals?.updates_success) || 0;
    const totalShipments = Number(totals?.shipments_total) || 0;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-glow-md">
                            <BarChart3 size={20} className="text-white" />
                        </div>
                        <div>
                            <h1 className="text-lg font-black text-white leading-none">Statistics</h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1">
                                {data?.generated_at ? `Updated ${fmtTime(data.generated_at)}` : 'Mobile analytics'}
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={fetchAnalytics}
                        className="w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all"
                        aria-label="Refresh analytics"
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin text-slate-300' : 'text-slate-300'} />
                    </button>
                </div>

                <div className="mt-5 flex items-center gap-3">
                    <StatChip label="Shipments" value={totalShipments} tone="violet" />
                    <StatChip label="Updates" value={totalUpdates} tone="slate" />
                    <StatChip label="Success" value={`${pct(totalSuccess, totalUpdates)}%`} tone="emerald" />
                </div>

                <div className="mt-4 flex items-center gap-3">
                    <div className="flex-1">
                        <div className="relative">
                            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search truck, driver, AWB, ESCH..."
                                className="w-full pl-11 pr-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/20 transition-all text-sm font-medium"
                            />
                        </div>
                    </div>

                    {canViewAll ? (
                        <div className="p-1 rounded-2xl bg-slate-900/40 border border-white/10 flex">
                            <button
                                type="button"
                                onClick={() => setScope('self')}
                                className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${scope === 'self'
                                    ? 'bg-white/10 text-white'
                                    : 'text-slate-400 hover:text-slate-200'
                                    }`}
                            >
                                My
                            </button>
                            <button
                                type="button"
                                onClick={() => setScope('all')}
                                className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${scope === 'all'
                                    ? 'bg-white/10 text-white'
                                    : 'text-slate-400 hover:text-slate-200'
                                    }`}
                            >
                                All
                            </button>
                        </div>
                    ) : null}
                </div>

                <div className="mt-4 flex items-center gap-3">
                    <TabButton active={tab === 'trucks'} icon={Truck} label="Trucks" onClick={() => setTab('trucks')} />
                    <TabButton active={tab === 'drivers'} icon={User} label="Drivers" onClick={() => setTab('drivers')} />
                    <TabButton active={tab === 'awbs'} icon={Package} label="AWB" onClick={() => setTab('awbs')} />
                    <TabButton active={tab === 'events'} icon={Activity} label="ESCH" onClick={() => setTab('events')} />
                </div>
            </header>

            <main className="flex-1 p-6 pb-32 relative z-10">
                <AnimatePresence mode="wait">
                    {loading ? (
                        <motion.div
                            key="loading"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="glass-strong rounded-3xl border-iridescent p-8 flex items-center justify-center gap-3"
                        >
                            <Loader2 className="animate-spin text-violet-300" size={20} />
                            <span className="text-sm font-black text-white uppercase tracking-wider">Loading analytics</span>
                        </motion.div>
                    ) : error ? (
                        <motion.div
                            key="error"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="bg-rose-500/10 border border-rose-500/30 text-rose-300 px-6 py-5 rounded-3xl font-bold"
                        >
                            {error}
                        </motion.div>
                    ) : (
                        <motion.div
                            key={tab}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="space-y-4"
                        >
                            {tab === 'trucks' ? (
                                <>
                                    {filteredTrucks.length === 0 ? (
                                        <div className="text-slate-400 font-bold text-sm">No trucks found.</div>
                                    ) : filteredTrucks.map((t) => {
                                        const updatesTotal = Number(t?.updates_total) || 0;
                                        const updatesSuccess = Number(t?.updates_success) || 0;
                                        const sBuckets = t?.shipments_by_bucket || {};
                                        return (
                                            <div key={t?.truck_plate || 'unassigned'} className="glass-strong rounded-3xl border-iridescent p-5">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Truck</div>
                                                        <div className="text-xl font-black text-white truncate mt-1">
                                                            {t?.truck_plate || 'Unassigned'}
                                                        </div>
                                                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                            Phone: {t?.truck_phone || '--'} • Drivers: {Array.isArray(t?.drivers) ? t.drivers.length : 0}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <div className="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-400/20">
                                                            <CheckCircle2 size={18} className="text-emerald-300" />
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-3 gap-3">
                                                    <StatChip label="Shipments" value={t?.shipments_total || 0} tone="violet" />
                                                    <StatChip label="Delivered" value={sBuckets?.delivered || 0} tone="emerald" />
                                                    <StatChip label="Active" value={sBuckets?.active || 0} tone="amber" />
                                                </div>

                                                <div className="mt-3 grid grid-cols-3 gap-3">
                                                    <StatChip label="Updates" value={updatesTotal} tone="slate" />
                                                    <StatChip label="Success" value={`${pct(updatesSuccess, updatesTotal)}%`} tone="emerald" />
                                                    <StatChip label="Last" value={t?.last_update ? fmtTime(t.last_update) : '--'} tone="slate" />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            ) : null}

                            {tab === 'drivers' ? (
                                <>
                                    {filteredDrivers.length === 0 ? (
                                        <div className="text-slate-400 font-bold text-sm">No drivers found.</div>
                                    ) : filteredDrivers.map((d) => {
                                        const updatesTotal = Number(d?.updates_total) || 0;
                                        const updatesSuccess = Number(d?.updates_success) || 0;
                                        const sBuckets = d?.shipments_by_bucket || {};
                                        return (
                                            <div key={d?.driver_id} className="glass-strong rounded-3xl border-iridescent p-5">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Driver</div>
                                                        <div className="text-xl font-black text-white truncate mt-1">
                                                            {d?.name || d?.username || d?.driver_id}
                                                        </div>
                                                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                            ID: {d?.driver_id} • {d?.role || 'Role'} • Truck: {d?.truck_plate || '--'}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-3 gap-3">
                                                    <StatChip label="Shipments" value={d?.shipments_total || 0} tone="violet" />
                                                    <StatChip label="Delivered" value={sBuckets?.delivered || 0} tone="emerald" />
                                                    <StatChip label="Active" value={sBuckets?.active || 0} tone="amber" />
                                                </div>

                                                <div className="mt-3 grid grid-cols-3 gap-3">
                                                    <StatChip label="Updates" value={updatesTotal} tone="slate" />
                                                    <StatChip label="Success" value={`${pct(updatesSuccess, updatesTotal)}%`} tone="emerald" />
                                                    <StatChip label="Last" value={d?.last_update ? fmtTime(d.last_update) : '--'} tone="slate" />
                                                </div>

                                                <div className="mt-3 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                                    Last login: {d?.last_login ? fmtTime(d.last_login) : '--'} • Truck phone: {d?.truck_phone || '--'}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            ) : null}

                            {tab === 'awbs' ? (
                                <>
                                    {filteredAwbs.length === 0 ? (
                                        <div className="text-slate-400 font-bold text-sm">No AWBs found.</div>
                                    ) : filteredAwbs.map((a) => {
                                        const updatesTotal = Number(a?.updates_total) || 0;
                                        const updatesSuccess = Number(a?.updates_success) || 0;
                                        return (
                                            <div key={a?.awb} className="glass-strong rounded-3xl border-iridescent p-5">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">AWB</div>
                                                        <div className="text-lg font-black text-white truncate mt-1">{a?.awb}</div>
                                                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                            Status: {a?.status || '--'} • Driver: {a?.driver_id || '--'}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-3 gap-3">
                                                    <StatChip label="Updates" value={updatesTotal} tone="slate" />
                                                    <StatChip label="Success" value={`${pct(updatesSuccess, updatesTotal)}%`} tone="emerald" />
                                                    <StatChip label="Last" value={a?.last_update ? fmtTime(a.last_update) : '--'} tone="slate" />
                                                </div>

                                                <div className="mt-3 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                                    ESCH: {a?.last_event_id || '--'} • Outcome: {a?.last_outcome || '--'}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            ) : null}

                            {tab === 'events' ? (
                                <>
                                    {filteredEvents.length === 0 ? (
                                        <div className="text-slate-400 font-bold text-sm">No ESCH events found.</div>
                                    ) : filteredEvents.map((e) => {
                                        const total = Number(e?.total) || 0;
                                        const success = Number(e?.success) || 0;
                                        return (
                                            <div key={e?.event_id} className="glass-strong rounded-3xl border-iridescent p-5">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">ESCH</div>
                                                        <div className="text-lg font-black text-white truncate mt-1">
                                                            {e?.event_id} {e?.label ? `• ${e.label}` : ''}
                                                        </div>
                                                        {e?.description ? (
                                                            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                                {e.description}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-3 gap-3">
                                                    <StatChip label="Total" value={total} tone="slate" />
                                                    <StatChip label="Success" value={`${pct(success, total)}%`} tone="emerald" />
                                                    <StatChip label="Failed" value={(Number(e?.failed) || 0)} tone="rose" />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            ) : null}
                        </motion.div>
                    )}
                </AnimatePresence>
            </main>
        </motion.div>
    );
}

