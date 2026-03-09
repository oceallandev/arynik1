import React, { useEffect, useMemo, useState } from 'react';
import { Banknote, CalendarDays, CheckCircle2, Gauge, Loader2, Truck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getDashboardOverview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const money = (value) => {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0.00 RON';
    return `${n.toFixed(2)} RON`;
};

export default function StatsBanner() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [period, setPeriod] = useState('today'); // today | week | month
    const [overview, setOverview] = useState(null);
    const { user } = useAuth();
    const { lang } = useLanguage();
    const navigate = useNavigate();
    const l = (en, ro) => (lang === 'ro' ? ro : en);

    useEffect(() => {
        let cancelled = false;
        const run = async ({ quiet = false } = {}) => {
            if (!quiet) setLoading(true);
            try {
                const token = user?.token || localStorage.getItem('token');
                const data = await getDashboardOverview(token, { period, scope: 'auto' });
                if (!cancelled) setOverview(data);
            } catch (e) {
                if (!cancelled) setError(String(e?.response?.data?.detail || e?.message || 'Dashboard unavailable'));
            } finally {
                if (!quiet && !cancelled) setLoading(false);
            }
        };
        run();
        const id = setInterval(() => {
            run({ quiet: true });
        }, 20000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [user?.token, period]);

    const counts = overview?.counts || {};
    const selected = overview?.selected || {};
    const topDrivers = useMemo(
        () => (Array.isArray(selected?.drivers) ? selected.drivers.slice(0, 5) : []),
        [selected?.drivers]
    );

    const openDeliveredPeriod = (key) => {
        const range = overview?.ranges?.[key];
        if (!range?.start_utc || !range?.end_utc) {
            navigate('/shipments?status=delivered');
            return;
        }
        const params = new URLSearchParams();
        params.set('status', 'delivered');
        params.set('period', String(key));
        params.set('from', String(range.start_utc));
        params.set('to', String(range.end_utc));
        navigate(`/shipments?${params.toString()}`);
    };

    if (loading) {
        return (
            <div className="glass-strong rounded-3xl border-iridescent p-6 flex items-center justify-center">
                <Loader2 className="animate-spin text-violet-300" size={20} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="glass-strong rounded-3xl border border-rose-500/25 p-4 text-xs font-bold text-rose-300">
                {error}
            </div>
        );
    }

    const cards = [
        { key: 'today', label: l('Delivered Today', 'Livrate Azi'), value: Number(counts?.today || 0), tone: 'emerald' },
        { key: 'week', label: l('Delivered This Week', 'Livrate Saptamana'), value: Number(counts?.week || 0), tone: 'blue' },
        { key: 'month', label: l('Delivered This Month', 'Livrate Luna'), value: Number(counts?.month || 0), tone: 'violet' },
    ];

    const toneClass = (tone) => {
        if (tone === 'emerald') return 'border-emerald-400/30 bg-emerald-500/15 text-emerald-100';
        if (tone === 'blue') return 'border-blue-400/30 bg-blue-500/15 text-blue-100';
        return 'border-violet-400/30 bg-violet-500/15 text-violet-100';
    };

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {cards.map((c) => (
                    <button
                        key={c.key}
                        type="button"
                        onClick={() => openDeliveredPeriod(c.key)}
                        className={`glass-strong rounded-2xl p-4 border text-left ${toneClass(c.tone)}`}
                        title={l('Open delivered AWBs list', 'Deschide lista AWB livrate')}
                    >
                        <p className="text-[10px] font-black uppercase tracking-wider opacity-85">{c.label}</p>
                        <p className="text-2xl font-black mt-1">{c.value}</p>
                    </button>
                ))}
            </div>

            <div className="glass-strong rounded-2xl border-iridescent p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    {[
                        { key: 'today', label: l('Today', 'Azi') },
                        { key: 'week', label: l('Week', 'Saptamana') },
                        { key: 'month', label: l('Month', 'Luna') },
                    ].map((it) => (
                        <button
                            key={it.key}
                            type="button"
                            onClick={() => setPeriod(it.key)}
                            className={`px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-wider ${period === it.key
                                ? 'bg-violet-500/20 border-violet-400/35 text-violet-100'
                                : 'bg-slate-900/40 border-white/10 text-slate-300'
                                }`}
                        >
                            {it.label}
                        </button>
                    ))}
                    <span className="ml-auto text-[10px] font-black uppercase tracking-wider text-slate-500">
                        {selected?.delivered_count || 0} {l('deliveries', 'livrari')}
                    </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3">
                        <div className="flex items-center gap-2 text-emerald-200">
                            <Banknote size={14} />
                            <span className="text-[10px] font-black uppercase tracking-wider">{l('COD To Collect', 'Ramburs de incasat')}</span>
                        </div>
                        <p className="mt-1 text-sm font-black text-white">{money(selected?.cod_total)}</p>
                    </div>
                    <div className="rounded-xl border border-blue-400/20 bg-blue-500/10 p-3">
                        <div className="flex items-center gap-2 text-blue-200">
                            <Gauge size={14} />
                            <span className="text-[10px] font-black uppercase tracking-wider">{l('KM Traveled', 'KM Parcursi')}</span>
                        </div>
                        <p className="mt-1 text-sm font-black text-white">{Number(selected?.km_total || 0).toFixed(1)} km</p>
                    </div>
                    <div className="rounded-xl border border-violet-400/20 bg-violet-500/10 p-3">
                        <div className="flex items-center gap-2 text-violet-200">
                            <CalendarDays size={14} />
                            <span className="text-[10px] font-black uppercase tracking-wider">{l('Period', 'Perioada')}</span>
                        </div>
                        <p className="mt-1 text-sm font-black text-white">{selected?.start_utc ? `${String(selected.start_utc).slice(0, 10)} → ${String(selected.end_utc || '').slice(0, 10)}` : '--'}</p>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-slate-300">
                        <Truck size={14} />
                        <span className="text-[10px] font-black uppercase tracking-wider">{l('Driver Performance', 'Performanta soferi')}</span>
                    </div>
                    {topDrivers.length === 0 ? (
                        <p className="text-[11px] font-bold text-slate-500">{l('No data for selected period.', 'Nu exista date pentru perioada selectata.')}</p>
                    ) : (
                        <div className="space-y-1.5">
                            {topDrivers.map((d) => (
                                <div key={`${d.driver_id || 'na'}-${d.name}`} className="rounded-xl border border-white/10 bg-slate-900/30 px-3 py-2 flex items-center gap-2">
                                    <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-400/25 flex items-center justify-center text-violet-200">
                                        <CheckCircle2 size={12} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-black text-white truncate">{d.name || d.driver_id || 'Unknown'}</p>
                                        <p className="text-[10px] font-bold text-slate-400">
                                            {(d.deliveries || 0)} {l('deliveries', 'livrari')} • {Number(d.km_total || 0).toFixed(1)} km • {money(d.cod_total)}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
