import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Check, Loader2, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getNotifications, markNotificationRead } from '../services/api';

export default function Notifications() {
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');

    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');

    const unreadCount = useMemo(
        () => (Array.isArray(items) ? items.filter((n) => !n?.read_at).length : 0),
        [items]
    );

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const data = await getNotifications(token, { limit: 100, unread_only: false });
            setItems(Array.isArray(data) ? data : []);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load notifications'));
            setItems([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const markRead = async (id) => {
        const ident = id;
        if (!ident) return;
        setBusyId(ident);
        try {
            const updated = await markNotificationRead(token, ident);
            setItems((prev) => (Array.isArray(prev) ? prev.map((n) => (String(n?.id) === String(ident) ? updated : n)) : prev));
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to mark read'));
        } finally {
            setBusyId(null);
        }
    };

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
                        <Bell size={18} className="text-violet-300" />
                        Notifications
                    </h1>
                    <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                        {unreadCount} unread
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

                {!loading && (!items || items.length === 0) ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <Bell className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No notifications yet</p>
                        <p className="text-sm mt-2 text-slate-500">Allocation updates will appear here</p>
                    </div>
                ) : null}

                {!loading && Array.isArray(items) ? (
                    items.map((n) => {
                        const unread = !n?.read_at;
                        return (
                            <div
                                key={n.id}
                                className={`glass-strong p-5 rounded-3xl border transition-all ${unread ? 'border-emerald-500/30' : 'border-white/10 opacity-90'}`}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-black text-white truncate">{n.title || 'Notification'}</p>
                                        <p className="text-xs text-slate-300 font-medium mt-1 break-words">
                                            {n.body || ''}
                                        </p>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2">
                                            {n.created_at ? new Date(n.created_at).toLocaleString() : ''}
                                            {n.awb ? ` • ${String(n.awb).toUpperCase()}` : ''}
                                        </p>
                                    </div>
                                    {unread ? (
                                        <button
                                            type="button"
                                            onClick={() => markRead(n.id)}
                                            disabled={String(busyId) === String(n.id)}
                                            className={`p-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all ${String(busyId) === String(n.id) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                            title="Mark as read"
                                        >
                                            <Check size={18} />
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })
                ) : null}
            </main>
        </motion.div>
    );
}

