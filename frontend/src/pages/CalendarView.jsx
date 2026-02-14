import React, { useEffect, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Loader2, Package, TrendingUp, Zap } from 'lucide-react';
import { getLogs } from '../services/api';

export default function CalendarView() {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [deliveries, setDeliveries] = useState({});
    const [loading, setLoading] = useState(true);

    const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();

    const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));

    const monthName = currentDate.toLocaleString('default', { month: 'long' });
    const year = currentDate.getFullYear();

    useEffect(() => {
        const fetchDeliveries = async () => {
            setLoading(true);

            try {
                const token = localStorage.getItem('token');
                const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).toISOString();
                const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59).toISOString();

                const logs = await getLogs(token, {
                    start_date: startOfMonth,
                    end_date: endOfMonth
                });

                const grouped = logs.reduce((acc, log) => {
                    const day = new Date(log.timestamp).getDate();
                    if (!acc[day]) {
                        acc[day] = [];
                    }
                    acc[day].push(log);
                    return acc;
                }, {});

                setDeliveries(grouped);
            } catch (err) {
                console.error('Failed to fetch monthly deliveries', err);
            } finally {
                setLoading(false);
            }
        };

        fetchDeliveries();
    }, [currentDate]);

    const days = [];

    for (let i = 0; i < firstDayOfMonth; i += 1) {
        days.push(<div key={`empty-${i}`} className="h-24" />);
    }

    for (let d = 1; d <= daysInMonth; d += 1) {
        const dayDeliveries = deliveries[d] || [];
        const hasDeliveries = dayDeliveries.length > 0;
        const isToday = d === new Date().getDate()
            && currentDate.getMonth() === new Date().getMonth()
            && currentDate.getFullYear() === new Date().getFullYear();

        days.push(
            <div
                key={d}
                className={`h-24 border-t border-white/5 p-2 relative flex flex-col items-center justify-center gap-1 transition-all duration-300 hover:bg-white/5 cursor-pointer group ${isToday ? 'bg-violet-500/10 border-violet-500/30' : ''
                    }`}
            >
                <span className={`text-xs font-black absolute top-2 right-2 transition-all ${isToday ? 'text-violet-400' : 'text-slate-500 group-hover:text-violet-300'
                    }`}>
                    {d}
                </span>
                {hasDeliveries && (
                    <div className="flex flex-col items-center animate-scale-in">
                        <div className="p-2 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl text-white shadow-glow-sm">
                            <Package size={16} strokeWidth={2.5} />
                        </div>
                        <span className="text-[9px] font-black text-emerald-400 uppercase mt-1.5 tracking-wide">
                            {dayDeliveries.length} AWB
                        </span>
                    </div>
                )}
            </div>
        );
    }

    const totalThisMonth = Object.values(deliveries).flat().length;
    const avgPerDay = totalThisMonth > 0 ? (totalThisMonth / new Date().getDate()).toFixed(1) : 0;

    return (
        <div className="min-h-screen flex flex-col relative overflow-hidden">
            {/* Background Orbs */}
            <div className="absolute top-0 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div>
                    <h1 className="text-xl font-black text-gradient tracking-tight">Delivery Calendar</h1>
                    <p className="text-xs text-slate-400 font-medium mt-1">Track your monthly performance</p>
                </div>
                <div className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10">
                    <CalendarIcon size={20} className="text-violet-400" />
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 space-y-6 relative z-10">
                {/* Calendar Card */}
                <div className="glass-strong rounded-[32px] shadow-2xl border-iridescent overflow-hidden animate-scale-in">
                    {/* Calendar Header */}
                    <div className="p-6 flex items-center justify-between bg-gradient-to-r from-violet-600 via-purple-600 to-violet-700 text-white relative overflow-hidden">
                        <div className="absolute inset-0 shimmer opacity-20"></div>
                        <button
                            onClick={prevMonth}
                            className="p-2.5 hover:bg-white/20 rounded-xl transition-all active:scale-95 relative z-10 magnetic"
                        >
                            <ChevronLeft size={20} strokeWidth={2.5} />
                        </button>
                        <h2 className="text-lg font-black uppercase tracking-widest relative z-10">
                            {monthName} {year}
                        </h2>
                        <button
                            onClick={nextMonth}
                            className="p-2.5 hover:bg-white/20 rounded-xl transition-all active:scale-95 relative z-10 magnetic"
                        >
                            <ChevronRight size={20} strokeWidth={2.5} />
                        </button>
                    </div>

                    {/* Day Labels */}
                    <div className="grid grid-cols-7 text-center py-4 bg-black/20 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                        <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
                    </div>

                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 relative min-h-[400px]">
                        {loading && (
                            <div className="absolute inset-0 glass-strong z-10 flex items-center justify-center backdrop-blur-sm">
                                <div className="text-center">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                                        <Loader2 className="animate-spin relative z-10 text-violet-400" size={48} />
                                    </div>
                                    <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">Loading...</p>
                                </div>
                            </div>
                        )}
                        {days}
                    </div>
                </div>

                {/* Stats Cards */}
                <div className="space-y-4">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Monthly Insights</h3>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="glass-strong p-5 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.1s' }}>
                            <div className="flex items-center gap-2 mb-3">
                                <div className="p-2 bg-violet-500/20 rounded-lg">
                                    <Package size={16} className="text-violet-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Total</span>
                            </div>
                            <p className="text-3xl font-black text-gradient-purple">{totalThisMonth}</p>
                            <p className="text-[10px] text-slate-500 font-medium mt-1">Deliveries</p>
                        </div>

                        <div className="glass-strong p-5 rounded-2xl border-iridescent animate-scale-in" style={{ animationDelay: '0.2s' }}>
                            <div className="flex items-center gap-2 mb-3">
                                <div className="p-2 bg-emerald-500/20 rounded-lg">
                                    <TrendingUp size={16} className="text-emerald-400" />
                                </div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Average</span>
                            </div>
                            <p className="text-3xl font-black text-gradient-blue">{avgPerDay}</p>
                            <p className="text-[10px] text-slate-500 font-medium mt-1">Per Day</p>
                        </div>
                    </div>

                    {/* Performance Card */}
                    <div className="glass-strong p-5 rounded-2xl border-iridescent flex items-center gap-4 animate-scale-in" style={{ animationDelay: '0.3s' }}>
                        <div className="p-4 bg-gradient-to-br from-amber-500 to-amber-600 rounded-2xl shadow-glow-sm">
                            <Zap size={24} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-black text-white">Active Month</p>
                            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide mt-1">
                                {totalThisMonth} shipments processed in {monthName}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
