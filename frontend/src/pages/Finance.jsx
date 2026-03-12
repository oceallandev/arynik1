import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, DollarSign, RefreshCw, Search, SlidersHorizontal, Truck } from 'lucide-react';
import AwbLink from '../components/AwbLink';
import { useAuth } from '../context/AuthContext';
import { getCodReport } from '../services/api';

const money = (amount, currency = 'RON') => {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '--';
    return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
};

const toDateInputValue = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const fmtDateTime = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '--';
        return d.toLocaleString();
    } catch {
        return '--';
    }
};

const codRemaining = (row) => Number(row?.cod_remaining ?? row?.delta ?? row?.remaining_total ?? row?.delta_total ?? 0) || 0;
const codExpected = (row) => Number(row?.cod_expected ?? row?.expected_total ?? 0) || 0;
const codCollected = (row) => Number(row?.cod_collected ?? row?.collected_total ?? 0) || 0;

const resolvePresetRange = (preset) => {
    const now = new Date();
    const end = toDateInputValue(now);

    if (preset === 'all') {
        return { startDate: '', endDate: '' };
    }

    const start = new Date(now);
    if (preset === 'today') {
        // no-op
    } else if (preset === '7d') {
        start.setDate(start.getDate() - 6);
    } else if (preset === '30d') {
        start.setDate(start.getDate() - 29);
    } else {
        // month
        start.setDate(1);
    }

    return {
        startDate: toDateInputValue(start),
        endDate: end,
    };
};

const PERIOD_OPTIONS = [
    { key: 'today', label: 'Astazi' },
    { key: '7d', label: '7 zile' },
    { key: '30d', label: '30 zile' },
    { key: 'month', label: 'Luna curenta' },
    { key: 'all', label: 'Toate' },
];

export default function Finance() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const initialRange = useMemo(() => resolvePresetRange('month'), []);

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('shipments'); // shipments | drivers
    const [search, setSearch] = useState('');
    const [periodPreset, setPeriodPreset] = useState('month');
    const [startDate, setStartDate] = useState(initialRange.startDate);
    const [endDate, setEndDate] = useState(initialRange.endDate);
    const [driverFilter, setDriverFilter] = useState('all');
    const [codStateFilter, setCodStateFilter] = useState('to_collect'); // all | to_collect | collected
    const [shipmentSort, setShipmentSort] = useState('remaining_desc'); // remaining_desc | latest_desc | expected_desc

    const requestParams = useMemo(() => {
        const params = { limit: 2000 };
        if (startDate) params.start_date = `${startDate}T00:00:00`;
        if (endDate) params.end_date = `${endDate}T23:59:59`;
        if (driverFilter && driverFilter !== 'all') params.driver_id = driverFilter;
        return params;
    }, [startDate, endDate, driverFilter]);

    const refresh = useCallback(async ({ quiet = false } = {}) => {
        if (!token) return;
        if (!quiet) setLoading(true);
        setError('');
        try {
            const res = await getCodReport(token, requestParams);
            setData(res || null);
        } catch (e) {
            setData(null);
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load COD report'));
        } finally {
            if (!quiet) setLoading(false);
        }
    }, [requestParams, token]);

    useEffect(() => {
        void refresh({ quiet: false });
        if (!token) return undefined;
        const id = setInterval(() => {
            void refresh({ quiet: true });
        }, 15000);
        return () => clearInterval(id);
    }, [refresh, token]);

    const applyPeriodPreset = (preset) => {
        const next = resolvePresetRange(preset);
        setPeriodPreset(preset);
        setStartDate(next.startDate);
        setEndDate(next.endDate);
    };

    const onChangeStartDate = (value) => {
        setPeriodPreset('custom');
        setStartDate(String(value || ''));
    };

    const onChangeEndDate = (value) => {
        setPeriodPreset('custom');
        setEndDate(String(value || ''));
    };

    const needle = useMemo(() => String(search || '').trim().toLowerCase(), [search]);

    const matchesCodFilter = useCallback((remaining) => {
        const val = Number(remaining || 0);
        if (codStateFilter === 'to_collect') return val > 0.009;
        if (codStateFilter === 'collected') return val <= 0.009;
        return true;
    }, [codStateFilter]);

    const driverOptions = useMemo(() => {
        const list = Array.isArray(data?.by_driver) ? data.by_driver : [];
        return [...list].sort((a, b) => {
            const aLabel = String(a?.name || a?.driver_id || '').toLowerCase();
            const bLabel = String(b?.name || b?.driver_id || '').toLowerCase();
            return aLabel.localeCompare(bLabel);
        });
    }, [data?.by_driver]);

    const drivers = useMemo(() => {
        const list = Array.isArray(data?.by_driver) ? data.by_driver : [];
        return list.filter((d) => {
            const matchesSearch = !needle || (
                String(d?.driver_id || '').toLowerCase().includes(needle)
                || String(d?.name || '').toLowerCase().includes(needle)
                || String(d?.truck_plate || '').toLowerCase().includes(needle)
            );
            if (!matchesSearch) return false;
            return matchesCodFilter(codRemaining(d));
        });
    }, [data?.by_driver, matchesCodFilter, needle]);

    const shipments = useMemo(() => {
        const list = Array.isArray(data?.shipments) ? data.shipments : [];
        const filtered = list.filter((s) => {
            const matchesSearch = !needle || (
                String(s?.awb || '').toLowerCase().includes(needle)
                || String(s?.driver_id || '').toLowerCase().includes(needle)
                || String(s?.recipient_name || '').toLowerCase().includes(needle)
            );
            if (!matchesSearch) return false;
            return matchesCodFilter(codRemaining(s));
        });

        filtered.sort((a, b) => {
            if (shipmentSort === 'expected_desc') {
                return codExpected(b) - codExpected(a);
            }
            if (shipmentSort === 'latest_desc') {
                const aTs = new Date(a?.delivered_at || 0).getTime();
                const bTs = new Date(b?.delivered_at || 0).getTime();
                return bTs - aTs;
            }
            return codRemaining(b) - codRemaining(a);
        });

        return filtered;
    }, [data?.shipments, matchesCodFilter, needle, shipmentSort]);

    const visibleTotals = useMemo(() => {
        const src = tab === 'drivers' ? drivers : shipments;
        const totals = src.reduce((acc, row) => {
            acc.expected += codExpected(row);
            acc.collected += codCollected(row);
            acc.remaining += codRemaining(row);
            return acc;
        }, { expected: 0, collected: 0, remaining: 0 });

        return {
            expected: Number(totals.expected || 0),
            collected: Number(totals.collected || 0),
            remaining: Number(totals.remaining || 0),
            rows: src.length,
        };
    }, [drivers, shipments, tab]);

    const generatedAtLabel = data?.generated_at ? fmtDateTime(data.generated_at) : '--';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-0 right-0 w-[28rem] h-[28rem] bg-amber-500/10 rounded-full blur-3xl animate-float" />
            <div className="absolute bottom-0 left-0 w-[24rem] h-[24rem] bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }} />

            <header className="px-6 py-5 sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="text-xl font-black text-gradient tracking-tight flex items-center gap-2">
                            <DollarSign size={18} className="text-amber-300" />
                            Ramburs de incasat
                        </h1>
                        <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                            Sume COD pe AWB (bani de incasat de la client)
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void refresh({ quiet: false })}
                        className={`w-12 h-12 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
                        disabled={loading}
                        aria-label="Refresh"
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin text-slate-300' : 'text-slate-300'} />
                    </button>
                </div>

                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Randuri vizibile</div>
                        <div className="text-sm font-black text-white mt-1">{visibleTotals.rows}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Total de incasat</div>
                        <div className="text-sm font-black text-white mt-1">{money(visibleTotals.expected)}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Incasat</div>
                        <div className="text-sm font-black text-white mt-1">{money(visibleTotals.collected)}</div>
                    </div>
                    <div className="glass-light p-3 rounded-2xl border border-white/10">
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Ramas de incasat</div>
                        <div className="text-sm font-black text-white mt-1">{money(visibleTotals.remaining)}</div>
                    </div>
                </div>

                <div className="mt-3 glass-light p-3 rounded-2xl border border-amber-500/25 text-[11px] font-bold text-amber-200 flex items-center gap-2">
                    <CalendarDays size={14} className="text-amber-300" />
                    Raport generat: {generatedAtLabel}
                </div>

                <div className="mt-4 glass-light rounded-2xl border border-white/10 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-400 font-black">
                        <SlidersHorizontal size={13} /> Filtre COD
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {PERIOD_OPTIONS.map((opt) => (
                            <button
                                key={opt.key}
                                type="button"
                                onClick={() => applyPeriodPreset(opt.key)}
                                className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${periodPreset === opt.key
                                    ? 'bg-amber-500/20 border border-amber-400/40 text-amber-100'
                                    : 'bg-slate-900/35 border border-white/10 text-slate-300 hover:bg-white/10'
                                    }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            De la
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => onChangeStartDate(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            />
                        </label>
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Pana la
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => onChangeEndDate(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            />
                        </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Sofer
                            <select
                                value={driverFilter}
                                onChange={(e) => setDriverFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="all">Toti soferii</option>
                                {driverOptions.map((d) => (
                                    <option key={d.driver_id || d.name} value={d.driver_id || ''}>
                                        {d.name || d.driver_id || 'Fara nume'}{d.driver_id ? ` (${d.driver_id})` : ''}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Status COD
                            <select
                                value={codStateFilter}
                                onChange={(e) => setCodStateFilter(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                            >
                                <option value="to_collect">Doar de incasat</option>
                                <option value="collected">Doar incasate</option>
                                <option value="all">Toate</option>
                            </select>
                        </label>

                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Sortare AWB
                            <select
                                value={shipmentSort}
                                onChange={(e) => setShipmentSort(e.target.value)}
                                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-sm"
                                disabled={tab !== 'shipments'}
                            >
                                <option value="remaining_desc">Ramas descrescator</option>
                                <option value="latest_desc">Livrare recenta</option>
                                <option value="expected_desc">Suma de incasat descrescator</option>
                            </select>
                        </label>
                    </div>
                </div>

                <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1">
                        <div className="relative">
                            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Cauta sofer, camion, AWB, destinatar..."
                                className="w-full pl-11 pr-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/20 transition-all text-sm font-medium"
                            />
                        </div>
                    </div>
                    <div className="p-1 rounded-2xl bg-slate-900/40 border border-white/10 flex">
                        <button
                            type="button"
                            onClick={() => setTab('shipments')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === 'shipments'
                                ? 'bg-white/10 text-white'
                                : 'text-slate-400 hover:text-slate-200'
                                }`}
                        >
                            AWB
                        </button>
                        <button
                            type="button"
                            onClick={() => setTab('drivers')}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${tab === 'drivers'
                                ? 'bg-white/10 text-white'
                                : 'text-slate-400 hover:text-slate-200'
                                }`}
                        >
                            Soferi
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
                        Se incarca raportul COD...
                    </div>
                ) : tab === 'drivers' ? (
                    <div className="space-y-3">
                        {drivers.map((d) => {
                            const expected = codExpected(d);
                            const collected = codCollected(d);
                            const remaining = codRemaining(d);
                            const collectedPct = expected > 0 ? Math.max(0, Math.min(100, Math.round((collected / expected) * 100))) : 0;

                            return (
                                <div key={`${d.driver_id || d.name}`} className="glass-strong p-5 rounded-3xl border border-white/10">
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
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">AWB</div>
                                            <div className="text-sm font-black text-white mt-1">{Number(d.shipments || 0)}</div>
                                        </div>
                                        <div className="glass-light p-3 rounded-2xl border border-white/10">
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">De incasat</div>
                                            <div className="text-sm font-black text-white mt-1">{money(expected)}</div>
                                        </div>
                                        <div className="glass-light p-3 rounded-2xl border border-white/10">
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Ramas</div>
                                            <div className={`text-sm font-black mt-1 ${remaining > 0.009 ? 'text-amber-200' : 'text-emerald-300'}`}>
                                                {money(remaining)}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-3">
                                        <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                            <span>Incasat</span>
                                            <span>{money(collected)} ({collectedPct}%)</span>
                                        </div>
                                        <div className="mt-1 h-2 rounded-full bg-slate-900/60 overflow-hidden border border-white/10">
                                            <div
                                                className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600"
                                                style={{ width: `${collectedPct}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {drivers.length === 0 ? (
                            <div className="text-slate-500 font-bold">Nu exista date pentru filtrele curente.</div>
                        ) : null}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {shipments.map((s) => {
                            const expected = codExpected(s);
                            const collected = codCollected(s);
                            const remaining = codRemaining(s);
                            const collectedPct = expected > 0 ? Math.max(0, Math.min(100, Math.round((collected / expected) * 100))) : 0;
                            const settled = remaining <= 0.009;

                            return (
                                <div key={s.awb} className="glass-strong p-5 rounded-3xl border border-white/10">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <AwbLink
                                                awb={s.awb}
                                                className="text-sm font-black text-white truncate cursor-pointer hover:text-emerald-300"
                                                title="Deschide detalii AWB"
                                            >
                                                {String(s.awb || '').toUpperCase()}
                                            </AwbLink>
                                            <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                                                {s.driver_id ? `Driver ${s.driver_id}` : 'Driver —'}{s.recipient_name ? ` • ${s.recipient_name}` : ''}
                                            </div>
                                            {s.delivered_at ? (
                                                <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider mt-1">
                                                    Delivered: {fmtDateTime(s.delivered_at)}
                                                </div>
                                            ) : null}
                                        </div>
                                        <div className={`px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest ${settled
                                            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                                            : 'bg-amber-500/15 border-amber-500/30 text-amber-200'
                                            }`}>
                                            {settled ? 'Incasat' : `Ramas ${money(remaining)}`}
                                        </div>
                                    </div>

                                    <div className="mt-3 grid grid-cols-3 gap-3">
                                        <div className="glass-light p-3 rounded-2xl border border-white/10">
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">De incasat</div>
                                            <div className="text-sm font-black text-white mt-1">{money(expected)}</div>
                                        </div>
                                        <div className="glass-light p-3 rounded-2xl border border-white/10">
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Incasat</div>
                                            <div className="text-sm font-black text-white mt-1">{money(collected)}</div>
                                        </div>
                                        <div className="glass-light p-3 rounded-2xl border border-white/10">
                                            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Ramas</div>
                                            <div className={`text-sm font-black mt-1 ${settled ? 'text-emerald-300' : 'text-amber-200'}`}>{money(remaining)}</div>
                                        </div>
                                    </div>

                                    <div className="mt-3">
                                        <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                            <span>Progres incasare</span>
                                            <span>{collectedPct}%</span>
                                        </div>
                                        <div className="mt-1 h-2 rounded-full bg-slate-900/60 overflow-hidden border border-white/10">
                                            <div
                                                className={`h-full ${settled ? 'bg-gradient-to-r from-emerald-400 to-emerald-600' : 'bg-gradient-to-r from-amber-400 to-amber-600'}`}
                                                style={{ width: `${collectedPct}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {shipments.length === 0 ? (
                            <div className="text-slate-500 font-bold">Nu exista AWB-uri pentru filtrele curente.</div>
                        ) : null}
                    </div>
                )}
            </main>
        </motion.div>
    );
}
