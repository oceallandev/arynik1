import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, RefreshCw, Search, Truck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getCodReport } from '../services/api';

const money = (amount, currency = 'RON') => {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '--';
    return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
};

export default function Finance() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('drivers'); // drivers | shipments
    const [search, setSearch] = useState('');

    const refresh = async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        try {
            const res = await getCodReport(token, { limit: 2000 });
            setData(res || null);
        } catch (e) {
            setData(null);
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load COD report'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const needle = useMemo(() => String(search || '').trim().toLowerCase(), [search]);
    const totals = data?.totals || {};

    const drivers = useMemo(() => {
        const list = Array.isArray(data?.by_driver) ? data.by_driver : [];
        if (!needle) return list;
        return list.filter((d) => (
            String(d?.driver_id || '').toLowerCase().includes(needle)
            || String(d?.name || '').toLowerCase().includes(needle)
            || String(d?.truck_plate || '').toLowerCase().includes(needle)
        ));
    }, [data?.by_driver, needle]);

    const shipments = useMemo(() => {
        const list = Array.isArray(data?.shipments) ? data.shipments : [];
        if (!needle) return list;
        return list.filter((s) => (
            String(s?.awb || '').toLowerCase().includes(needle)
            || String(s?.driver_id || '').toLowerCase().includes(needle)
            || String(s?.recipient_name || '').toLowerCase().includes(needle)
        ));
    }, [data?.shipments, needle]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent">
                <div className="flex items-center justify-between">
                    <div className="min-w-0">
                        <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                            <DollarSign size={18} className="text-amber-300" />
                            COD Finance
                        </h1>
                        <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                            Reconciliation report
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={refresh}
                        className={`w-12 h-12 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                        disabled={loading}
                        aria-label="Refresh"
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin text-slate-300' : 'text-slate-300'} />
                    </button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3">
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Expected</div>
                        <div className="text-sm font-black text-white mt-1">{money(totals.expected_total || 0)}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Collected</div>
                        <div className="text-sm font-black text-white mt-1">{money(totals.collected_total || 0)}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Delta</div>
                        <div className="text-sm font-black text-white mt-1">{money(totals.delta_total || 0)}</div>
                    </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                    <div className="flex-1">
                        <div className="relative">
                            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search driver, truck, AWB..."
                                className="w-full pl-11 pr-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/20 transition-all text-sm font-medium"
                            />
                        </div>
                    </div>
                    <div className="p-1 rounded-2xl bg-slate-900/40 border border-white/10 flex">
                        <button
                            type="button"
                            onClick={() => setTab('drivers')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === 'drivers'
                                ? 'bg-white/10 text-white'
                                : 'text-slate-400 hover:text-slate-200'
                                }`}
                        >
                            Drivers
                        </button>
                        <button
                            type="button"
                            onClick={() => setTab('shipments')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === 'shipments'
                                ? 'bg-white/10 text-white'
                                : 'text-slate-400 hover:text-slate-200'
                                }`}
                        >
                            Shipments
                        </button>
                    </div>
                </div>
            </header>

            <main className="flex-1 p-6 pb-32 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                {loading ? (
                    <div className="glass-strong rounded-3xl border border-white/10 p-8 text-slate-300 font-bold">
                        Loading…
                    </div>
                ) : tab === 'drivers' ? (
                    <div className="space-y-3">
                        {drivers.map((d) => (
                            <div key={d.driver_id || d.truck_plate || Math.random()} className="glass-strong p-5 rounded-3xl border border-white/10">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-black text-white truncate">
                                            {d.name || d.driver_id || 'Driver'}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                            {d.driver_id ? `ID ${d.driver_id}` : ''}{d.truck_plate ? ` • Truck ${String(d.truck_plate).toUpperCase()}` : ''}
                                        </div>
                                    </div>
                                    <Truck size={18} className="text-emerald-300" />
                                </div>

                                <div className="mt-3 grid grid-cols-3 gap-3">
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Shipments</div>
                                        <div className="text-sm font-black text-white mt-1">{Number(d.shipments || 0)}</div>
                                    </div>
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Expected</div>
                                        <div className="text-sm font-black text-white mt-1">{money(d.expected_total || 0)}</div>
                                    </div>
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Delta</div>
                                        <div className="text-sm font-black text-white mt-1">{money(d.delta_total || 0)}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {drivers.length === 0 ? (
                            <div className="text-slate-500 font-bold">No data.</div>
                        ) : null}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {shipments.map((s) => (
                            <div key={s.awb} className="glass-strong p-5 rounded-3xl border border-white/10">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-black text-white truncate">{String(s.awb || '').toUpperCase()}</div>
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                            {s.driver_id ? `Driver ${s.driver_id}` : 'Driver —'}{s.recipient_name ? ` • ${s.recipient_name}` : ''}
                                        </div>
                                        {s.delivered_at ? (
                                            <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider mt-1">
                                                Delivered: {fmtDateTime(s.delivered_at)}
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="px-2.5 py-1 rounded-full bg-slate-900/40 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest">
                                        {s.delta === null || s.delta === undefined ? '—' : (Number(s.delta) === 0 ? 'OK' : `Δ ${money(s.delta)}`)}
                                    </div>
                                </div>
                                <div className="mt-3 grid grid-cols-3 gap-3">
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Expected</div>
                                        <div className="text-sm font-black text-white mt-1">{money(s.cod_expected || 0)}</div>
                                    </div>
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Collected</div>
                                        <div className="text-sm font-black text-white mt-1">{s.cod_collected === null || s.cod_collected === undefined ? '--' : money(s.cod_collected)}</div>
                                    </div>
                                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Method</div>
                                        <div className="text-sm font-black text-white mt-1">{s.cod_method || '--'}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {shipments.length === 0 ? (
                            <div className="text-slate-500 font-bold">No data.</div>
                        ) : null}
                    </div>
                )}
            </main>
        </motion.div>
    );
}

