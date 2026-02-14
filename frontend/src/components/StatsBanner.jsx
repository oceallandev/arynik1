import React, { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Package, TrendingUp } from 'lucide-react';
import { getStats } from '../services/api';

export default function StatsBanner() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const token = localStorage.getItem('token');
                const data = await getStats(token);
                setStats(data);
            } catch (err) {
                console.error('Failed to fetch stats', err);
            } finally {
                setLoading(false);
            }
        };

        fetchStats();
    }, []);

    // Custom hook for counting up
    const useCountUp = (end, duration = 2000) => {
        const [count, setCount] = useState(0);
        useEffect(() => {
            let start = 0;
            const increment = end / (duration / 16);
            const timer = setInterval(() => {
                start += increment;
                if (start >= end) {
                    setCount(end);
                    clearInterval(timer);
                } else {
                    setCount(Math.floor(start));
                }
            }, 16);
            return () => clearInterval(timer);
        }, [end, duration]);
        return count;
    };

    const todayCount = useCountUp(stats?.today_count || 0);
    const totalCount = useCountUp(stats?.total_count || 0);

    if (loading) {
        return (
            <div className="grid grid-cols-2 gap-4 animate-pulse">
                <div className="h-24 glass-strong rounded-3xl border-iridescent opacity-50"></div>
                <div className="h-24 glass-strong rounded-3xl border-iridescent opacity-50"></div>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-4">
            <div className="glass-strong p-5 rounded-3xl shadow-xl shadow-brand-blue/20 border-iridescent flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute inset-0 bg-gradient-to-br from-brand-blue/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div className="absolute -right-4 -top-4 opacity-10 scale-150 group-hover:rotate-12 transition-transform duration-500">
                    <CheckCircle2 size={80} className="text-brand-blue" />
                </div>
                <div className="relative z-10 flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-brand-blue/20 rounded-lg">
                        <TrendingUp size={16} className="text-brand-blue" />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Today</span>
                </div>
                <div className="relative z-10">
                    <span className="text-3xl font-black text-white">{todayCount}</span>
                    <p className="text-[10px] font-bold text-slate-400">Success Syncs</p>
                </div>
            </div>

            <div className="glass-strong p-5 rounded-3xl shadow-sm border-iridescent flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute -right-4 -top-4 opacity-5 scale-150 text-slate-400 group-hover:rotate-12 transition-transform duration-500">
                    <Activity size={80} />
                </div>
                <div className="flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-slate-700/50 rounded-lg text-slate-400">
                        <Package size={16} />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">All Time</span>
                </div>
                <div>
                    <span className="text-3xl font-black text-white">{totalCount}</span>
                    <p className="text-[10px] font-bold text-slate-400">Total Updates</p>
                </div>
            </div>
        </div>
    );
}
