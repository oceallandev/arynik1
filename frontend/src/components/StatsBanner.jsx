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

    if (loading) {
        return (
            <div className="grid grid-cols-2 gap-4 animate-pulse">
                <div className="h-24 bg-gray-200 dark:bg-gray-800 rounded-3xl"></div>
                <div className="h-24 bg-gray-200 dark:bg-gray-800 rounded-3xl"></div>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-4">
            <div className="p-5 bg-primary-600 rounded-3xl shadow-xl shadow-primary-500/20 text-white flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute -right-4 -top-4 opacity-10 scale-150 group-hover:rotate-12 transition-transform">
                    <CheckCircle2 size={80} />
                </div>
                <div className="flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-white/20 rounded-lg">
                        <TrendingUp size={16} />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest opacity-80">Today</span>
                </div>
                <div>
                    <span className="text-3xl font-black">{stats?.today_count || 0}</span>
                    <p className="text-[10px] font-bold opacity-60">Success Syncs</p>
                </div>
            </div>

            <div className="p-5 bg-white dark:bg-gray-800 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-700 flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute -right-4 -top-4 opacity-5 scale-150 text-gray-400 group-hover:rotate-12 transition-transform">
                    <Activity size={80} />
                </div>
                <div className="flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-gray-100 dark:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400">
                        <Package size={16} />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">All Time</span>
                </div>
                <div>
                    <span className="text-3xl font-black text-gray-900 dark:text-white">{stats?.total_count || 0}</span>
                    <p className="text-[10px] font-bold text-gray-400">Total Updates</p>
                </div>
            </div>
        </div>
    );
}
