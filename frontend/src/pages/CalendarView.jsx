import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Loader2, Package, TrendingUp, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getDashboardOverview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const money = (value) => {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0.00 RON';
    return `${n.toFixed(2)} RON`;
};

const parseIsoDate = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
};

export default function CalendarView() {
    const [currentDate, setCurrentDate] = useState(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    });
    const [dayStats, setDayStats] = useState({});
    const [loading, setLoading] = useState(true);
    const [selectedDay, setSelectedDay] = useState(null);
    const [rangeFrom, setRangeFrom] = useState('');
    const [rangeTo, setRangeTo] = useState('');
    const { user } = useAuth();
    const navigate = useNavigate();
    const { lang } = useLanguage();
    const selectedRef = useRef(null);
    const l = (en, ro) => (lang === 'ro' ? ro : en);

    const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();
    const monthName = currentDate.toLocaleString(lang === 'ro' ? 'ro-RO' : 'en-US', { month: 'long' });
    const year = currentDate.getFullYear();

    const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));

    useEffect(() => {
        const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
        const now = new Date();
        const rangeEnd = (now.getFullYear() === currentDate.getFullYear() && now.getMonth() === currentDate.getMonth()) ? now : end;
        setRangeFrom(start.toISOString().slice(0, 10));
        setRangeTo(rangeEnd.toISOString().slice(0, 10));
    }, [currentDate]);

    useEffect(() => {
        const fetchDeliveries = async () => {
            setLoading(true);
            try {
                const token = user?.token || localStorage.getItem('token');
                const anchor = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
                const data = await getDashboardOverview(token, { period: 'month', scope: 'auto', anchor_date: anchor, awb_limit: 3000 });

                const grouped = {};
                const daily = Array.isArray(data?.selected?.daily) ? data.selected.daily : [];
                for (const row of daily) {
                    const dateIso = String(row?.date || '').trim();
                    const day = Number(dateIso.slice(-2));
                    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
                    grouped[day] = {
                        day,
                        delivered_count: Number(row?.delivered_count || 0),
                        cod_total: 0,
                        payment_total: 0,
                        awbs: [],
                        by_driver: {},
                    };
                }

                const awbs = Array.isArray(data?.selected?.awbs) ? data.selected.awbs : [];
                for (const item of awbs) {
                    const deliveredAt = parseIsoDate(item?.delivered_at);
                    if (!deliveredAt) continue;
                    if (deliveredAt.getFullYear() !== currentDate.getFullYear() || deliveredAt.getMonth() !== currentDate.getMonth()) continue;
                    const day = deliveredAt.getDate();
                    if (!grouped[day]) {
                        grouped[day] = {
                            day,
                            delivered_count: 0,
                            cod_total: 0,
                            payment_total: 0,
                            awbs: [],
                            by_driver: {},
                        };
                    }
                    grouped[day].delivered_count += 1;
                    grouped[day].cod_total += Number(item?.cod_amount || 0);
                    grouped[day].payment_total += Number(item?.payment_amount || 0);
                    grouped[day].awbs.push({
                        awb: String(item?.awb || '').trim().toUpperCase(),
                        driver_id: String(item?.driver_id || '').trim().toUpperCase() || null,
                        delivered_at: item?.delivered_at,
                        payment_amount: Number(item?.payment_amount || 0),
                    });
                    const driverKey = String(item?.driver_id || '').trim().toUpperCase() || 'UNASSIGNED';
                    grouped[day].by_driver[driverKey] = Number(grouped[day].by_driver[driverKey] || 0) + 1;
                }

                setDayStats(grouped);

                const now = new Date();
                const isCurrentMonth = now.getFullYear() === currentDate.getFullYear() && now.getMonth() === currentDate.getMonth();
                const bestDefault = isCurrentMonth && Number(grouped[now.getDate()]?.delivered_count || 0) > 0
                    ? now.getDate()
                    : Number(Object.keys(grouped).map(Number).sort((a, b) => a - b)[0] || 1);
                setSelectedDay(bestDefault);
            } catch (err) {
                console.error('Failed to fetch monthly deliveries', err);
                setDayStats({});
                setSelectedDay(1);
            } finally {
                setLoading(false);
            }
        };

        fetchDeliveries();
    }, [currentDate, user?.token]);

    const handleSelectDay = (day) => {
        setSelectedDay(day);
        setTimeout(() => {
            try {
                const target = selectedRef.current;
                if (!target) return;
                const y = target.getBoundingClientRect().top + window.scrollY - 92;
                window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
            } catch { }
        }, 80);
    };

    const selectedStats = useMemo(() => {
        const day = Number(selectedDay || 0);
        if (!Number.isFinite(day) || day <= 0) return null;
        return dayStats[day] || {
            day,
            delivered_count: 0,
            cod_total: 0,
            payment_total: 0,
            awbs: [],
            by_driver: {},
        };
    }, [dayStats, selectedDay]);

    const totalThisMonth = useMemo(
        () => Object.values(dayStats).reduce((acc, row) => acc + Number(row?.delivered_count || 0), 0),
        [dayStats]
    );
    const avgPerDay = totalThisMonth > 0 ? (totalThisMonth / Math.max(1, daysInMonth)).toFixed(1) : '0.0';

    const openHistoryForSelectedDay = () => {
        if (!selectedStats?.day) return;
        const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), Number(selectedStats.day), 0, 0, 0, 0);
        const end = new Date(currentDate.getFullYear(), currentDate.getMonth(), Number(selectedStats.day) + 1, 0, 0, 0, 0);
        const params = new URLSearchParams();
        params.set('mode', 'delivered');
        params.set('period', 'day');
        params.set('from', start.toISOString());
        params.set('to', end.toISOString());
        navigate(`/history?${params.toString()}`);
    };

    const openHistoryForRange = () => {
        const fromRaw = String(rangeFrom || '').trim();
        const toRaw = String(rangeTo || '').trim();
        if (!fromRaw || !toRaw) return;
        const fromDate = new Date(`${fromRaw}T00:00:00`);
        const toDate = new Date(`${toRaw}T23:59:59`);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate < fromDate) return;
        const params = new URLSearchParams();
        params.set('mode', 'delivered');
        params.set('period', 'range');
        params.set('from', fromDate.toISOString());
        params.set('to', toDate.toISOString());
        navigate(`/history?${params.toString()}`);
    };

    const days = [];
    for (let i = 0; i < firstDayOfMonth; i += 1) {
        days.push(<div key={`empty-${i}`} className="h-24" />);
    }

    const now = new Date();
    for (let d = 1; d <= daysInMonth; d += 1) {
        const dayDeliveries = Number(dayStats[d]?.delivered_count || 0);
        const hasDeliveries = dayDeliveries > 0;
        const isToday = d === now.getDate() && currentDate.getMonth() === now.getMonth() && currentDate.getFullYear() === now.getFullYear();
        const isSelected = Number(selectedDay) === d;

        days.push(
            <button
                type="button"
                key={d}
                onClick={() => handleSelectDay(d)}
                className={`h-24 border-t border-white/5 p-2 relative flex flex-col items-center justify-center gap-1 transition-all duration-300 hover:bg-white/5 ${isSelected ? 'bg-emerald-500/15 border-emerald-500/30' : isToday ? 'bg-violet-500/10 border-violet-500/30' : ''}`}
            >
                <span className={`text-xs font-black absolute top-2 right-2 transition-all ${isSelected ? 'text-emerald-300' : isToday ? 'text-violet-400' : 'text-slate-500'}`}>
                    {d}
                </span>
                {hasDeliveries ? (
                    <div className="flex flex-col items-center animate-scale-in">
                        <div className="p-2 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl text-white shadow-glow-sm">
                            <Package size={16} strokeWidth={2.5} />
                        </div>
                        <span className="text-[9px] font-black text-emerald-400 uppercase mt-1.5 tracking-wide">
                            {dayDeliveries} AWB
                        </span>
                    </div>
                ) : null}
            </button>
        );
    }

    return (
        <div className="min-h-screen flex flex-col relative overflow-hidden">
            <div className="absolute top-0 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => navigate(-1)}
                        className="w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all"
                        aria-label="Back"
                    >
                        <ArrowLeft size={18} className="text-slate-300" />
                    </button>
                    <div>
                        <h1 className="text-xl font-black text-gradient tracking-tight">{l('Delivery Calendar', 'Calendar livrari')}</h1>
                        <p className="text-xs text-slate-400 font-medium mt-1">{l('Daily view + relevant stats', 'Vizualizare zilnica + statistici relevante')}</p>
                    </div>
                </div>
                <div className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10">
                    <CalendarIcon size={20} className="text-violet-400" />
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 space-y-6 relative z-10">
                <div className="glass-strong rounded-[32px] shadow-2xl border-iridescent overflow-hidden animate-scale-in">
                    <div className="p-6 flex items-center justify-between bg-gradient-to-r from-violet-600 via-purple-600 to-violet-700 text-white relative overflow-hidden">
                        <div className="absolute inset-0 shimmer opacity-20"></div>
                        <button onClick={prevMonth} className="p-2.5 hover:bg-white/20 rounded-xl transition-all active:scale-95 relative z-10 magnetic">
                            <ChevronLeft size={20} strokeWidth={2.5} />
                        </button>
                        <h2 className="text-lg font-black uppercase tracking-widest relative z-10">
                            {monthName} {year}
                        </h2>
                        <button onClick={nextMonth} className="p-2.5 hover:bg-white/20 rounded-xl transition-all active:scale-95 relative z-10 magnetic">
                            <ChevronRight size={20} strokeWidth={2.5} />
                        </button>
                    </div>

                    <div className="grid grid-cols-7 text-center py-4 bg-black/20 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                        {lang === 'ro' ? (
                            <>
                                <div>Dum</div><div>Lun</div><div>Mar</div><div>Mie</div><div>Joi</div><div>Vin</div><div>Smb</div>
                            </>
                        ) : (
                            <>
                                <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
                            </>
                        )}
                    </div>

                    <div className="grid grid-cols-7 relative min-h-[400px]">
                        {loading ? (
                            <div className="absolute inset-0 glass-strong z-10 flex items-center justify-center backdrop-blur-sm">
                                <div className="text-center">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                                        <Loader2 className="animate-spin relative z-10 text-violet-400" size={48} />
                                    </div>
                                    <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">{l('Loading...', 'Se incarca...')}</p>
                                </div>
                            </div>
                        ) : null}
                        {days}
                    </div>
                </div>

                <div ref={selectedRef} className="glass-strong p-5 rounded-2xl border-iridescent space-y-3 animate-scale-in">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{l('Selected day', 'Zi selectata')}</p>
                            <p className="text-lg font-black text-white">
                                {selectedStats?.day
                                    ? new Date(currentDate.getFullYear(), currentDate.getMonth(), Number(selectedStats.day)).toLocaleDateString(lang === 'ro' ? 'ro-RO' : 'en-US')
                                    : '--'}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={openHistoryForSelectedDay}
                            disabled={!selectedStats?.day}
                            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {l('Open AWB history', 'AWB in istoric')}
                        </button>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                        <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3">
                            <p className="text-[10px] font-black text-emerald-200 uppercase tracking-wider">{l('Delivered', 'Livrate')}</p>
                            <p className="text-xl font-black text-white mt-1">{Number(selectedStats?.delivered_count || 0)}</p>
                        </div>
                        <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-3">
                            <p className="text-[10px] font-black text-amber-200 uppercase tracking-wider">COD</p>
                            <p className="text-sm font-black text-white mt-1">{money(selectedStats?.cod_total || 0)}</p>
                        </div>
                        <div className="rounded-xl border border-violet-400/25 bg-violet-500/10 p-3">
                            <p className="text-[10px] font-black text-violet-200 uppercase tracking-wider">{l('Payment', 'Incasat')}</p>
                            <p className="text-sm font-black text-white mt-1">{money(selectedStats?.payment_total || 0)}</p>
                        </div>
                    </div>

                    <div className="pt-2 border-t border-white/10">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">{l('Time interval', 'Interval de timp')}</p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                                type="date"
                                value={rangeFrom}
                                onChange={(e) => setRangeFrom(e.target.value)}
                                className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs font-bold"
                            />
                            <input
                                type="date"
                                value={rangeTo}
                                onChange={(e) => setRangeTo(e.target.value)}
                                className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs font-bold"
                            />
                            <button
                                type="button"
                                onClick={openHistoryForRange}
                                disabled={!rangeFrom || !rangeTo}
                                className="px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {l('Open interval', 'Deschide interval')}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="space-y-4">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">{l('Monthly Insights', 'Insight-uri lunare')}</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="glass-strong p-5 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.1s' }}>
                            <div className="flex items-center gap-2 mb-3">
                                <div className="p-2 bg-violet-500/20 rounded-lg">
                                    <Package size={16} className="text-violet-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{l('Total', 'Total')}</span>
                            </div>
                            <p className="text-3xl font-black text-gradient-purple">{totalThisMonth}</p>
                            <p className="text-[10px] text-slate-500 font-medium mt-1">{l('Deliveries', 'Livrari')}</p>
                        </div>

                        <div className="glass-strong p-5 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.2s' }}>
                            <div className="flex items-center gap-2 mb-3">
                                <div className="p-2 bg-emerald-500/20 rounded-lg">
                                    <TrendingUp size={16} className="text-emerald-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{l('Average', 'Medie')}</span>
                            </div>
                            <p className="text-3xl font-black text-gradient-blue">{avgPerDay}</p>
                            <p className="text-[10px] text-slate-500 font-medium mt-1">{l('Per Day', 'Pe zi')}</p>
                        </div>
                    </div>

                    <div className="glass-strong p-5 rounded-2xl border-iridescent flex items-center gap-4 animate-scale-in" style={{ animationDelay: '0.3s' }}>
                        <div className="p-4 bg-gradient-to-br from-amber-500 to-amber-600 rounded-2xl shadow-glow-sm">
                            <Zap size={24} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-black text-white">{l('Active Month', 'Luna activa')}</p>
                            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide mt-1">
                                {totalThisMonth} {l('shipments processed in', 'colete procesate in')} {monthName}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
