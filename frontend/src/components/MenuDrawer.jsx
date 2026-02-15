import React, { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BarChart3, Bell, Calendar, Home, History, LogOut, MapPinned, Package, Phone, Settings, Truck, User, Users, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../auth/rbac';
import { PERM_LOGS_READ_ALL, PERM_LOGS_READ_SELF, PERM_NOTIFICATIONS_READ, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';

const MenuItem = ({ icon: Icon, label, description, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        className="w-full p-4 glass-light rounded-2xl border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all flex items-center gap-4 text-left"
    >
        <div className="p-3 rounded-xl bg-gradient-to-br from-violet-500/25 to-purple-600/15 border border-white/10">
            <Icon size={20} className="text-violet-300" />
        </div>
        <div className="flex-1">
            <div className="font-black text-white text-sm uppercase tracking-tight">{label}</div>
            {description ? (
                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">{description}</div>
            ) : null}
        </div>
    </button>
);

export default function MenuDrawer({ open, onClose }) {
    const navigate = useNavigate();
    const { user, logout } = useAuth();

    const canAccessShipments = useMemo(() => hasPermission(user, PERM_SHIPMENTS_READ), [user]);
    const canAccessRoutes = useMemo(() => (
        ['Manager', 'Admin', 'Dispatcher', 'Driver'].includes(user?.role)
    ), [user?.role]);
    const canAccessUsers = useMemo(() => hasPermission(user, PERM_USERS_READ), [user]);

    const canViewAllAnalytics = useMemo(() => hasPermission(user, PERM_LOGS_READ_ALL), [user]);
    const canAccessHistory = useMemo(() => hasPermission(user, PERM_LOGS_READ_SELF), [user]);
    const canAccessAnalytics = useMemo(() => hasPermission(user, PERM_STATS_READ), [user]);
    const canAccessNotifications = useMemo(() => hasPermission(user, PERM_NOTIFICATIONS_READ), [user]);

    useEffect(() => {
        if (!open) return;

        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [open]);

    const go = (path) => {
        navigate(path);
        onClose?.();
    };

    const doLogout = () => {
        logout();
        onClose?.();
        navigate('/login', { replace: true });
    };

    const name = user?.name || user?.username || 'Driver';
    const truckPlate = user?.truck_plate ? String(user.truck_plate).toUpperCase() : null;
    const truckPhone = user?.truck_phone || null;
    const isRecipient = String(user?.role || '') === 'Recipient';
    const recipientPhone = isRecipient ? (user?.phone_number || user?.username || null) : null;

    return (
        <AnimatePresence>
            {open ? (
                <>
                    <motion.div
                        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60]"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />
                    <motion.aside
                        className="fixed inset-y-0 right-0 w-full max-w-sm z-[61] p-4"
                        initial={{ x: 60, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: 60, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                        aria-label="App menu"
                        role="dialog"
                        aria-modal="true"
                    >
                        <div className="h-full glass-strong rounded-[32px] border-iridescent shadow-2xl overflow-hidden flex flex-col">
                            <div className="p-5 flex items-center justify-between border-b border-white/10">
                                <div>
                                    <div className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Menu</div>
                                    <div className="text-lg font-black text-white mt-1">Navigation</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all"
                                    aria-label="Close menu"
                                >
                                    <X size={18} className="text-slate-300" />
                                </button>
                            </div>

                            <div className="p-5">
                                <div className="glass-light rounded-3xl border border-white/10 p-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-glow-md">
                                            <User size={22} className="text-white" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-black text-white truncate">{name}</div>
                                            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                                {user?.role || 'Role'} • ID: {user?.driver_id || 'N/A'}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-4 grid grid-cols-2 gap-3">
                                        {isRecipient ? (
                                            <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10 col-span-2">
                                                <div className="flex items-center gap-2 text-slate-400">
                                                    <Phone size={14} />
                                                    <span className="text-[10px] font-black uppercase tracking-widest">Recipient Phone</span>
                                                </div>
                                                <div className="text-sm font-black text-white mt-1 truncate">
                                                    {recipientPhone || '--'}
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                                    <div className="flex items-center gap-2 text-slate-400">
                                                        <Truck size={14} />
                                                        <span className="text-[10px] font-black uppercase tracking-widest">Truck</span>
                                                    </div>
                                                    <div className="text-sm font-black text-white mt-1 truncate">
                                                        {truckPlate || 'Unassigned'}
                                                    </div>
                                                </div>
                                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                                    <div className="flex items-center gap-2 text-slate-400">
                                                        <Phone size={14} />
                                                        <span className="text-[10px] font-black uppercase tracking-widest">Phone</span>
                                                    </div>
                                                    <div className="text-sm font-black text-white mt-1 truncate">
                                                        {truckPhone || '--'}
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                    </div>

                                    {canViewAllAnalytics ? (
                                        <div className="mt-3 text-[10px] text-emerald-400 font-black uppercase tracking-widest">
                                            Analytics: ALL enabled
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="flex-1 px-5 pb-5 overflow-y-auto space-y-3">
                                <MenuItem icon={Home} label="Home" description="Scanner & quick actions" onClick={() => go('/home')} />

                                {canAccessShipments ? (
                                    <>
                                        <MenuItem icon={Package} label="Shipments" description="Track shipments" onClick={() => go('/shipments')} />
                                        {canAccessRoutes ? (
                                            <MenuItem icon={MapPinned} label="Routes" description="Plan deliveries" onClick={() => go('/routes')} />
                                        ) : null}
                                    </>
                                ) : null}

                                {canAccessNotifications ? (
                                    <MenuItem icon={Bell} label="Notifications" description="Allocation updates" onClick={() => go('/notifications')} />
                                ) : null}
                                {canAccessHistory ? (
                                    <MenuItem icon={History} label="History" description="Logs & updates" onClick={() => go('/history')} />
                                ) : null}
                                {canAccessShipments ? (
                                    <MenuItem icon={Calendar} label="Calendar" description="Daily overview" onClick={() => go('/calendar')} />
                                ) : null}
                                {canAccessAnalytics ? (
                                    <MenuItem icon={BarChart3} label="Statistics" description="Trucks, drivers, AWBs, ESCH" onClick={() => go('/analytics')} />
                                ) : null}
                                {canAccessUsers ? (
                                    <MenuItem icon={Users} label="Users" description="Create accounts & roles" onClick={() => go('/users')} />
                                ) : null}
                                <MenuItem icon={Settings} label="Settings" description="Account & API" onClick={() => go('/settings')} />

                                <button
                                    type="button"
                                    onClick={doLogout}
                                    className="w-full p-4 rounded-2xl bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-400 hover:to-rose-500 text-white font-black uppercase tracking-wider shadow-lg flex items-center justify-center gap-3 transition-all"
                                >
                                    <LogOut size={18} />
                                    Sign Out
                                </button>
                            </div>
                        </div>
                    </motion.aside>
                </>
            ) : null}
        </AnimatePresence>
    );
}
