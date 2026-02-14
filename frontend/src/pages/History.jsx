import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowLeft, CheckCircle, Clock, RefreshCw, Package, TrendingUp } from 'lucide-react';
import { getQueue } from '../store/queue';
import { getLogs } from '../services/api';
import { useNavigate } from 'react-router-dom';

export default function HistoryPage() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const navigate = useNavigate();

    const fetchItems = async (isRefresh = false) => {
        if (isRefresh) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }

        try {
            const localQueue = await getQueue();

            let serverLogs = [];
            try {
                const token = localStorage.getItem('token');
                const logs = await getLogs(token);
                serverLogs = logs.map((log) => ({
                    ...log,
                    id: log.id,
                    status: 'synced',
                    label: log.event_id
                }));
            } catch {
                console.log('Could not fetch server logs, showing local only');
            }

            const merged = [...localQueue, ...serverLogs]
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            setItems(merged);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        fetchItems();
    }, []);

    const getStatusConfig = (status) => {
        if (status === 'synced') {
            return {
                bg: 'bg-emerald-500/20',
                text: 'text-emerald-400',
                border: 'border-emerald-500/30',
                icon: CheckCircle,
                label: 'Synced'
            };
        }
        return {
            bg: 'bg-violet-500/20',
            text: 'text-violet-400',
            border: 'border-violet-500/30',
            icon: Clock,
            label: 'Pending'
        };
    };

    const syncedCount = items.filter(i => i.status === 'synced').length;
    const pendingCount = items.filter(i => i.status !== 'synced').length;

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, x: -20 },
        visible: { opacity: 1, x: 0 }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-20 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <div className="px-4 py-4 flex items-center justify-between glass-strong sticky top-0 z-30 backdrop-blur-xl border-b border-white/10 animate-slide-down">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => navigate(-1)}
                        className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <div>
                        <h1 className="font-black text-lg text-gradient tracking-tight">Update History</h1>
                        <p className="text-xs text-slate-500 font-medium mt-0.5">Recent activity timeline</p>
                    </div>
                </div>
                <button
                    onClick={() => fetchItems(true)}
                    className={`p-2.5 rounded-xl glass-light hover:bg-violet-500/20 text-violet-400 transition-all border border-white/10 ${refreshing ? 'animate-spin' : ''}`}
                >
                    <RefreshCw size={20} />
                </button>
            </div>

            {/* Stats Banner */}
            <div className="p-4 grid grid-cols-2 gap-3 relative z-10">
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="glass-strong p-4 rounded-2xl border-iridescent"
                >
                    <div className="flex items-center gap-2 mb-2">
                        <div className="p-2 bg-emerald-500/20 rounded-lg">
                            <CheckCircle size={14} className="text-emerald-400" />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Synced</span>
                    </div>
                    <p className="text-2xl font-black text-gradient-blue">{syncedCount}</p>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.1 }}
                    className="glass-strong p-4 rounded-2xl border-iridescent"
                >
                    <div className="flex items-center gap-2 mb-2">
                        <div className="p-2 bg-violet-500/20 rounded-lg">
                            <Clock size={14} className="text-violet-400" />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Pending</span>
                    </div>
                    <p className="text-2xl font-black text-gradient-purple">{pendingCount}</p>
                </motion.div>
            </div>

            {/* Timeline */}
            <div className="flex-1 overflow-y-auto px-4 pb-32 relative z-10">
                {loading ? (
                    <div className="text-center py-20">
                        <div className="relative inline-block">
                            <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                            <Package className="animate-spin relative z-10 text-violet-400 mx-auto" size={48} />
                        </div>
                        <p className="mt-6 text-sm font-bold text-slate-500 uppercase tracking-wide">Loading history...</p>
                    </div>
                ) : items.length === 0 ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-center py-20 text-slate-400"
                    >
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <Clock className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No recent updates</p>
                        <p className="text-sm mt-2 text-slate-500">Your activity will appear here</p>
                    </motion.div>
                ) : (
                    <motion.div
                        variants={containerVariants}
                        initial="hidden"
                        animate="visible"
                        className="space-y-3 py-2"
                    >
                        {items.map((item, idx) => {
                            const config = getStatusConfig(item.status);
                            const StatusIcon = config.icon;

                            return (
                                <motion.div
                                    key={idx}
                                    variants={itemVariants}
                                    className="glass-strong p-5 rounded-2xl border border-white/10 relative overflow-hidden group hover:border-violet-500/30 transition-all"
                                >
                                    {/* Timeline connector */}
                                    {idx < items.length - 1 && (
                                        <div className="absolute left-11 top-full w-0.5 h-3 bg-gradient-to-b from-white/10 to-transparent"></div>
                                    )}

                                    <div className="flex gap-4">
                                        {/* Status Icon */}
                                        <div className={`flex-shrink-0 w-12 h-12 ${config.bg} rounded-2xl flex items-center justify-center border ${config.border}`}>
                                            <StatusIcon size={20} className={config.text} strokeWidth={2.5} />
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start mb-2">
                                                <div>
                                                    <p className="text-xs font-mono text-slate-500 tracking-wider">{item.awb}</p>
                                                    <h3 className="font-bold text-white mt-1">{item.event_id || item.label}</h3>
                                                </div>
                                                <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${config.bg} ${config.text} ${config.border}`}>
                                                    {config.label}
                                                </span>
                                            </div>

                                            <p className="text-[10px] text-slate-400 font-medium flex items-center gap-1.5">
                                                <Clock size={10} />
                                                {new Date(item.timestamp).toLocaleString()}
                                            </p>

                                            {item.error_message && (
                                                <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2">
                                                    <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
                                                    <p className="text-xs text-red-400 font-medium">{item.error_message}</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            );
                        })}
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
}
