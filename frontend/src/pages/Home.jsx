import { motion } from 'framer-motion';
import React, { useEffect, useState } from 'react';
import { Bell, CheckCircle, ChevronRight, Search, User, UserCog, ScanLine, Zap, TrendingUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import StatsBanner from '../components/StatsBanner';
import Scanner from '../components/Scanner';
import { hasPermission } from '../auth/rbac';
import { PERM_AWB_UPDATE, PERM_NOTIFICATIONS_READ, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import StatusSelect from './StatusSelect';
import { syncQueue } from '../store/queue';
import { normalizeShipmentIdentifier } from '../services/awbScan';

export default function Home() {
    const [showScanner, setShowScanner] = useState(false);
    const [currentAwb, setCurrentAwb] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [greeting, setGreeting] = useState('');
    const navigate = useNavigate();
    const { user } = useAuth();

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (token) {
            syncQueue(token);
        }

        // Dynamic greeting based on time
        const hour = new Date().getHours();
        if (hour < 12) setGreeting('Good Morning');
        else if (hour < 18) setGreeting('Good Afternoon');
        else setGreeting('Good Evening');
    }, []);

    const handleScan = (awb) => {
        const cleaned = normalizeShipmentIdentifier(awb);
        if (!cleaned) return;
        setCurrentAwb(cleaned);
        setShowScanner(false);
    };

    const handleUpdateComplete = (outcome, meta = null) => {
        const shownAwb = String(meta?.awb || currentAwb || '').trim().toUpperCase();
        const parcelIndexN = Number(meta?.parcel_index);
        const parcelIndex = Number.isFinite(parcelIndexN) && parcelIndexN > 0 ? parcelIndexN : null;
        const parcelsTotalN = Number(meta?.parcels_total);
        const parcelsTotal = Number.isFinite(parcelsTotalN) && parcelsTotalN > 0 ? parcelsTotalN : null;
        setLastUpdate({ awb: shownAwb || currentAwb, outcome, parcel_index: parcelIndex, parcels_total: parcelsTotal });
        setCurrentAwb(null);
        setTimeout(() => setLastUpdate(null), 3000);
    };

    if (currentAwb) {
        return (
            <StatusSelect
                awb={currentAwb}
                onBack={() => setCurrentAwb(null)}
                onComplete={handleUpdateComplete}
            />
        );
    }

    const canUpdateAwb = hasPermission(user, PERM_AWB_UPDATE);
    const canReadShipments = hasPermission(user, PERM_SHIPMENTS_READ);
    const canReadUsers = hasPermission(user, PERM_USERS_READ);
    const canReadStats = hasPermission(user, PERM_STATS_READ);
    const canReadNotifications = hasPermission(user, PERM_NOTIFICATIONS_READ);
    const isRecipient = String(user?.role || '') === 'Recipient';

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
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -20 }}
            variants={containerVariants}
            className="flex flex-col min-h-screen relative overflow-hidden"
        >
            {/* Background Gradient Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '0s' }}></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '3s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-glow-md animate-float">
                        <span className="text-white font-black italic tracking-tighter text-xl">AN</span>
                    </div>
                    <div>
                        <h1 className="text-lg font-black text-gradient leading-none">AryNik</h1>
                        <div className="flex items-center gap-1.5 mt-1">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Online</span>
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => navigate('/settings')}
                    className="w-10 h-10 rounded-full glass-light flex items-center justify-center border border-white/10 hover:bg-white/10 transition-colors"
                    aria-label="Account"
                    title="Account"
                >
                    <User size={18} className="text-violet-300" />
                </button>
            </header>

            <main className="flex-1 p-6 space-y-8 pb-32 relative z-10">
                {/* Greeting */}
                <motion.div variants={itemVariants}>
                    <h2 className="text-3xl font-black text-white mb-1">{greeting}</h2>
                    <p className="text-slate-400 font-medium">
                        {(user?.name || user?.username || 'Driver')}
                        {' • '}
                        {isRecipient ? 'Recipient Tracking' : (user?.truck_plate ? `Truck ${String(user.truck_plate).toUpperCase()}` : 'Truck Unassigned')}
                    </p>
                    {!isRecipient && user?.truck_phone ? (
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                            Truck phone: {user.truck_phone}
                        </p>
                    ) : null}
                    {isRecipient ? (
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                            Login: {user?.username || '--'}
                        </p>
                    ) : null}
                </motion.div>

                {canReadStats ? (
                    <motion.div variants={itemVariants}>
                        <StatsBanner />
                    </motion.div>
                ) : null}

                {lastUpdate && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`p-4 rounded-2xl flex items-center gap-4 shadow-lg ${lastUpdate.outcome === 'SUCCESS'
                            ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-emerald-500/20'
                            : 'bg-gradient-to-r from-violet-500 to-purple-600 shadow-violet-500/20'
                            }`}>
                        <div className="p-2 bg-white/20 rounded-xl backdrop-blur-sm">
                            <CheckCircle size={20} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <span className="font-black text-sm uppercase tracking-wide text-white">Update {lastUpdate.outcome === 'SUCCESS' ? 'Confirmed' : 'Queued'}</span>
                            <p className="text-xs font-bold text-white/80">
                                {lastUpdate.awb}
                                {Number.isFinite(lastUpdate.parcel_index) && lastUpdate.parcel_index > 0 ? (
                                    <span className="ml-2 text-[10px] font-black uppercase tracking-widest text-white/80">
                                        Parcel {lastUpdate.parcel_index}{Number.isFinite(lastUpdate.parcels_total) && lastUpdate.parcels_total > 0 ? `/${lastUpdate.parcels_total}` : ''}
                                    </span>
                                ) : null}
                            </p>
                        </div>
                    </motion.div>
                )}

                <motion.div variants={itemVariants} className="space-y-4">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">Quick Actions</h3>

                    {/* Primary Action: Scan AWB */}
                    {canUpdateAwb ? (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => setShowScanner(true)}
                            className="w-full py-12 bg-gradient-to-br from-violet-600 via-purple-600 to-violet-700 rounded-[32px] shadow-glow-lg flex flex-col items-center justify-center text-white space-y-5 relative overflow-hidden group"
                        >
                            <div className="absolute inset-0 shimmer opacity-30"></div>
                            <div className="absolute top-0 right-0 w-40 h-40 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16"></div>
                            <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/10 rounded-full blur-3xl -ml-12 -mb-12"></div>

                            <div className="p-6 bg-white/10 rounded-3xl backdrop-blur-sm border border-white/20 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 shadow-inner-glow">
                                <ScanLine size={52} strokeWidth={1.5} className="animate-glow" />
                            </div>
                            <div className="text-center relative z-10">
                                <h2 className="text-2xl font-black uppercase tracking-tight">Scan Package</h2>
                                <p className="text-violet-100 text-xs font-bold opacity-90 uppercase tracking-widest mt-1 flex items-center justify-center gap-2">
                                    <Zap size={12} />
                                    Tap to open scanner
                                </p>
                            </div>
                        </motion.button>
                    ) : (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/shipments')}
                            className="w-full py-10 bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 rounded-[32px] shadow-glow-lg flex flex-col items-center justify-center text-white space-y-4 relative overflow-hidden group"
                            disabled={!canReadShipments}
                        >
                            <div className="absolute inset-0 shimmer opacity-25"></div>
                            <div className="p-5 bg-white/10 rounded-3xl backdrop-blur-sm border border-white/20 group-hover:scale-110 group-hover:-rotate-2 transition-all duration-500 shadow-inner-glow">
                                <Search size={44} strokeWidth={1.5} />
                            </div>
                            <div className="text-center relative z-10">
                                <h2 className="text-xl font-black uppercase tracking-tight">Browse Shipments</h2>
                                <p className="text-emerald-100 text-xs font-bold opacity-90 uppercase tracking-widest mt-1 flex items-center justify-center gap-2">
                                    <TrendingUp size={12} />
                                    View tracking list
                                </p>
                            </div>
                        </motion.button>
                    )}

                    {/* Secondary Actions */}
                    {canReadShipments && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/shipments')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Search size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    Search Shipments
                                    <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-bold">LIVE</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5 flex items-center gap-1">
                                    <TrendingUp size={10} />
                                    Real-time tracking
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {canReadNotifications && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/notifications')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-amber-500 to-orange-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Bell size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight">
                                    Notifications
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    Allocation updates
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {canReadUsers && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/users')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-violet-500 to-purple-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <UserCog size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    Manage Users
                                    <span className="text-[8px] bg-violet-500/20 text-violet-300 px-2 py-0.5 rounded-full font-bold">RBAC</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    Create accounts and set roles
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}
                </motion.div>
            </main>

            {showScanner && <Scanner onScan={handleScan} onClose={() => setShowScanner(false)} />}
        </motion.div>
    );
}
