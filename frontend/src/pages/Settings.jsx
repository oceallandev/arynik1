import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Info, LogOut, ShieldCheck, User, Bell, Globe, Moon, ChevronRight, Sparkles, Users, Trash2, Loader2, RefreshCw, UserCog } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { hasPermission } from '../auth/rbac';
import { PERM_DRIVERS_SYNC, PERM_POSTIS_SYNC, PERM_USERS_READ } from '../auth/permissions';
import { getApiUrl, getHealth, getPostisSyncStatus, setApiUrl, syncDrivers, triggerPostisSync } from '../services/api';
import { getWarehouseOrigin, setWarehouseOrigin } from '../services/warehouse';

export default function Settings() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [apiUrlInput, setApiUrlInput] = useState(getApiUrl());
    const [warehouseForm, setWarehouseForm] = useState(() => {
        const o = getWarehouseOrigin();
        return {
            label: String(o?.label || ''),
            lat: String(o?.lat ?? ''),
            lon: String(o?.lon ?? ''),
        };
    });
    const [warehouseMsg, setWarehouseMsg] = useState('');
    const [cacheBusy, setCacheBusy] = useState(false);
    const [cacheMsg, setCacheMsg] = useState('');
    const [postisBusy, setPostisBusy] = useState(false);
    const [postisMsg, setPostisMsg] = useState('');
    const [postisStatus, setPostisStatus] = useState(null);
    const [driversBusy, setDriversBusy] = useState(false);
    const [driversMsg, setDriversMsg] = useState('');
    const [healthBusy, setHealthBusy] = useState(false);
    const [healthMsg, setHealthMsg] = useState('');
    const [healthData, setHealthData] = useState(null);

    const canReadUsers = hasPermission(user, PERM_USERS_READ);
    const canSyncPostis = hasPermission(user, PERM_POSTIS_SYNC);
    const canSyncDrivers = hasPermission(user, PERM_DRIVERS_SYNC);

    const handleLogout = () => {
        logout();
        navigate('/login', { replace: true });
    };

    const applyApiUrl = () => {
        setApiUrl(apiUrlInput);
        window.location.reload();
    };

    const testConnection = async () => {
        setHealthBusy(true);
        setHealthMsg('');
        setHealthData(null);

        try {
            const data = await getHealth();
            setHealthData(data || null);
            setHealthMsg(data?.ok ? 'Backend reachable.' : 'Backend responded.');
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Backend unreachable.';
            setHealthMsg(String(detail));
        } finally {
            setHealthBusy(false);
            setTimeout(() => setHealthMsg(''), 9000);
        }
    };

    const applyWarehouse = () => {
        const ok = setWarehouseOrigin({
            label: warehouseForm.label,
            lat: warehouseForm.lat,
            lon: warehouseForm.lon,
        });
        setWarehouseMsg(ok ? 'Warehouse origin saved.' : 'Invalid warehouse coordinates.');
        setTimeout(() => setWarehouseMsg(''), 2500);
    };

    const clearCache = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            'Clear cached data on this device?\n\nThis removes:\n- Offline queue (pending updates)\n- Local route allocations\n- Geocode cache\n- Service worker caches\n\nYou will stay signed in.'
        );
        if (!ok) return;

        setCacheBusy(true);
        setCacheMsg('');

        let removedQueue = 0;
        let removedCaches = 0;

        try {
            const { clearQueue } = await import('../store/queue');
            removedQueue = await clearQueue();
        } catch { }

        const localKeys = [
            'arynik_geocode_cache_v1',
            'arynik_routes_v1',
            'arynik_demo_logs_v1',
            'arynik_demo_shipments_v1',
            'arynik_last_vehicle_plate_v1',
            'arynik_warehouse_origin_v1',
        ];
        localKeys.forEach((key) => {
            try { localStorage.removeItem(key); } catch { }
        });

        if (typeof window !== 'undefined' && 'caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
                removedCaches = keys.length;
            } catch { }
        }

        // Best-effort SW unregister, so next reload re-registers cleanly.
        if (navigator?.serviceWorker?.getRegistrations) {
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
            } catch { }
        }

        setCacheMsg(`Cleared ${removedCaches} cache(s) and ${removedQueue} queued update(s). Reloading...`);

        setTimeout(() => {
            window.location.reload();
        }, 600);
    };

    const refreshPostisStatus = async () => {
        const token = user?.token;
        if (!token) return null;
        try {
            const st = await getPostisSyncStatus(token);
            setPostisStatus(st);
            return st;
        } catch {
            return null;
        }
    };

    const syncWithPostis = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            'Sync shipments with Postis now?\n\nThis will run a FULL backfill (cost/content/address/raw payload) into the server database.\nIt may take several minutes.'
        );
        if (!ok) return;

        const token = user?.token;
        if (!token) {
            setPostisMsg('Not signed in.');
            setTimeout(() => setPostisMsg(''), 4000);
            return;
        }

        setPostisBusy(true);
        setPostisMsg('');

        try {
            const started = await triggerPostisSync(token, { mode: 'full' });
            setPostisStatus(started);

            const didStart = Boolean(started?.started);
            setPostisMsg(didStart ? 'Postis sync started.' : 'Postis sync is already running.');

            const deadline = Date.now() + 8 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const st = await refreshPostisStatus();
                if (!st?.running) break;
            }

            const st = await refreshPostisStatus();
            if (st?.running) {
                setPostisMsg('Postis sync is still running in the background.');
            } else if (st?.last_error) {
                setPostisMsg(`Postis sync failed: ${st.last_error}`);
            } else if (st?.last_stats) {
                const s = st.last_stats;
                setPostisMsg(`Postis sync done. List: ${s.upserted_list} • Details: ${s.upserted_details}.`);
            } else {
                setPostisMsg('Postis sync done.');
            }
        } catch (e) {
            if (Number(e?.response?.status) === 405) {
                const api = getApiUrl();
                setPostisMsg(`Sync failed (HTTP 405). Your API URL is not a backend server (likely GitHub Pages). Set Backend API URL above to your FastAPI backend (/docs). Current: ${api}`);
                return;
            }
            const detail = e?.response?.data?.detail || e?.message || 'Failed to sync with Postis.';
            setPostisMsg(String(detail));
        } finally {
            setPostisBusy(false);
            setTimeout(() => setPostisMsg(''), 9000);
        }
    };

    const syncDriversFromSheet = async () => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            'Sync users/drivers from Google Sheet now?\n\nThis updates driver names, roles, trucks, and phones in the server database.'
        );
        if (!ok) return;

        const token = user?.token;
        if (!token) {
            setDriversMsg('Not signed in.');
            setTimeout(() => setDriversMsg(''), 4000);
            return;
        }

        setDriversBusy(true);
        setDriversMsg('');

        try {
            await syncDrivers(token);
            setDriversMsg('Drivers synced.');
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Failed to sync drivers.';
            setDriversMsg(String(detail));
        } finally {
            setDriversBusy(false);
            setTimeout(() => setDriversMsg(''), 9000);
        }
    };

    useEffect(() => {
        let cancelled = false;
        if (!canSyncPostis) return undefined;

        (async () => {
            const st = await refreshPostisStatus();
            if (cancelled || !st?.running) return;

            // If a sync is in progress, keep polling so the UI updates.
            const deadline = Date.now() + 60 * 1000;
            while (!cancelled && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const next = await refreshPostisStatus();
                if (!next?.running) break;
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canSyncPostis]);

    const settingsSections = [
        {
            title: 'Preferences',
            items: [
                { icon: Bell, label: 'Notifications', value: 'Enabled', color: 'violet' },
                { icon: Globe, label: 'Language', value: 'English', color: 'emerald' },
                { icon: Moon, label: 'Dark Mode', value: 'Auto', color: 'amber' }
            ]
        },
        {
            title: 'Account',
            items: [
                { icon: ShieldCheck, label: 'Security', value: null, color: 'violet' },
                ...(canReadUsers ? [{ icon: UserCog, label: 'Manage Users', value: null, color: 'emerald', onClick: () => navigate('/users') }] : []),
                ...(canSyncDrivers ? [{
                    icon: Users,
                    label: 'Sync Drivers',
                    value: driversBusy ? 'Working…' : null,
                    color: 'violet',
                    onClick: () => { if (!driversBusy) syncDriversFromSheet(); },
                    disabled: driversBusy,
                    loading: driversBusy,
                }] : []),
                ...(canSyncPostis ? [{
                    icon: RefreshCw,
                    label: 'Sync with Postis (Full)',
                    value: (postisBusy || postisStatus?.running) ? 'Running…' : null,
                    color: 'emerald',
                    onClick: () => { if (!(postisBusy || postisStatus?.running)) syncWithPostis(); },
                    disabled: (postisBusy || postisStatus?.running),
                    loading: (postisBusy || postisStatus?.running),
                }] : []),
                { icon: Trash2, label: 'Clear Cache', value: cacheBusy ? 'Working…' : null, color: 'slate', onClick: () => { if (!cacheBusy) clearCache(); }, disabled: cacheBusy, loading: cacheBusy },
                { icon: Info, label: 'App Info', value: 'v1.0.0', color: 'slate' }
            ]
        }
    ];

    const getIconBg = (color) => {
        const colors = {
            violet: 'bg-violet-500/20',
            emerald: 'bg-emerald-500/20',
            amber: 'bg-amber-500/20',
            slate: 'bg-slate-500/20'
        };
        return colors[color] || colors.slate;
    };

    const getIconColor = (color) => {
        const colors = {
            violet: 'text-violet-400',
            emerald: 'text-emerald-400',
            amber: 'text-amber-400',
            slate: 'text-slate-400'
        };
        return colors[color] || colors.slate;
    };

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
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Profile Header with Gradient */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-violet-600 via-purple-600 to-violet-700"></div>
                <div className="absolute inset-0 shimmer opacity-20"></div>

                <header className="relative z-10 px-6 pt-6 pb-4">
                    <h1 className="text-xl font-black text-white uppercase tracking-tight mb-1">Settings</h1>
                    <p className="text-sm text-violet-100 font-medium">Manage your preferences</p>
                </header>

                <div className="relative z-10 px-8 pb-8 flex flex-col items-center">
                    <motion.div
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 200, damping: 15 }}
                        className="w-28 h-28 bg-gradient-to-br from-white/20 to-white/10 backdrop-blur-xl rounded-[32px] shadow-2xl flex items-center justify-center text-white mb-5 border-4 border-white/30 animate-float"
                    >
                        <User size={56} strokeWidth={1.5} />
                    </motion.div>
                    <h2 className="text-2xl font-black text-white uppercase tracking-tight mb-2">
                        {user?.username || 'Driver'}
                    </h2>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black bg-white/20 backdrop-blur-sm text-white px-3 py-1.5 rounded-full uppercase tracking-widest border border-white/30">
                            {user?.role || 'Carrier'}
                        </span>
                        <span className="text-[10px] font-bold text-violet-200 uppercase tracking-widest">
                            ID: {user?.driver_id || 'N/A'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Settings Content */}
            <div className="flex-1 p-4 space-y-6 pb-32 relative z-10 -mt-6">
                {/* Connection */}
                <motion.div variants={itemVariants} className="space-y-3">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                        Connection
                    </h3>
                    <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                            API Base URL
                        </label>
                        <input
                            value={apiUrlInput}
                            onChange={(e) => setApiUrlInput(e.target.value)}
                            placeholder="https://YOUR-BACKEND"
                            className="w-full px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                            Tip: on GitHub Pages (HTTPS), your backend must be HTTPS. You can also set via URL: <span className="font-mono text-slate-400">?api=https://YOUR-BACKEND</span>
                        </p>
                        <button
                            onClick={applyApiUrl}
                            className="w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider"
                        >
                            Apply API URL
                        </button>
                        <button
                            type="button"
                            onClick={testConnection}
                            disabled={healthBusy}
                            className="w-full btn-premium py-3 bg-slate-900/50 hover:bg-slate-900/70 text-white rounded-xl font-bold border border-white/10 transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {healthBusy ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
                            Test Connection
                        </button>
                        {healthMsg ? (
                            <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-200 text-xs font-bold">
                                {healthMsg}
                            </div>
                        ) : null}
                        {healthData ? (
                            <div className="glass-light p-3 rounded-xl border border-white/10 text-slate-300 text-[10px] font-bold space-y-1">
                                <div>{healthData?.ok ? 'OK' : 'Response'} • {String(healthData?.time || '')}</div>
                                <div>Postis configured: {healthData?.postis_configured ? 'YES' : 'NO'}</div>
                            </div>
                        ) : null}
                    </div>
                </motion.div>

                {/* Warehouse Origin */}
                <motion.div variants={itemVariants} className="space-y-3">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                        Warehouse
                    </h3>
                    <div className="glass-strong rounded-2xl overflow-hidden border-iridescent p-4 space-y-3">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                            Routing Origin (Used For KM/Routes)
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            <input
                                value={warehouseForm.label}
                                onChange={(e) => setWarehouseForm((prev) => ({ ...prev, label: e.target.value }))}
                                placeholder="Warehouse (Bacau)"
                                className="col-span-3 px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                            />
                            <input
                                value={warehouseForm.lat}
                                onChange={(e) => setWarehouseForm((prev) => ({ ...prev, lat: e.target.value }))}
                                placeholder="Latitude"
                                className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono"
                            />
                            <input
                                value={warehouseForm.lon}
                                onChange={(e) => setWarehouseForm((prev) => ({ ...prev, lon: e.target.value }))}
                                placeholder="Longitude"
                                className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono"
                            />
                            <button
                                onClick={applyWarehouse}
                                className="btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-xl font-bold shadow-lg hover:shadow-glow-md transition-all text-sm uppercase tracking-wider"
                            >
                                Save Warehouse
                            </button>
                        </div>
                        {warehouseMsg && (
                            <div className="glass-light p-3 rounded-xl border border-emerald-500/20 text-emerald-200 text-xs font-bold">
                                {warehouseMsg}
                            </div>
                        )}
                        <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                            Driver GPS is still shown on the map, but routing always starts from this warehouse origin.
                        </p>
                    </div>
                </motion.div>

                {settingsSections.map((section, sIdx) => (
                    <motion.div key={sIdx} variants={itemVariants} className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            {section.title}
                        </h3>
                        <div className="glass-strong rounded-2xl overflow-hidden border-iridescent">
                            {section.items.map((item, iIdx) => {
                                const Icon = item.icon;
                                return (
                                    <button
                                        key={iIdx}
                                        type="button"
                                        onClick={() => item.onClick && item.onClick()}
                                        disabled={Boolean(item.disabled)}
                                        className={`w-full p-4 flex items-center gap-4 hover:bg-white/5 transition-all group ${iIdx < section.items.length - 1 ? 'border-b border-white/5' : ''
                                            }`}
                                    >
                                        <div className={`p-3 ${getIconBg(item.color)} rounded-xl group-hover:scale-110 transition-transform`}>
                                            {item.loading
                                                ? <Loader2 className="animate-spin text-slate-400" size={20} strokeWidth={2} />
                                                : <Icon className={getIconColor(item.color)} size={20} strokeWidth={2} />
                                            }
                                        </div>
                                        <span className="flex-1 text-left font-bold text-white">{item.label}</span>
                                        {item.value && (
                                            <span className="text-xs text-slate-400 font-medium">{item.value}</span>
                                        )}
                                        <ChevronRight className="text-slate-500 group-hover:text-violet-400 group-hover:translate-x-1 transition-all" size={18} />
                                    </button>
                                );
                            })}
                        </div>
                    </motion.div>
                ))}

                {cacheMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {cacheMsg}
                    </motion.div>
                )}

                {postisMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {postisMsg}
                    </motion.div>
                )}

                {driversMsg && (
                    <motion.div
                        variants={itemVariants}
                        className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold"
                    >
                        {driversMsg}
                    </motion.div>
                )}

                {/* Premium Feature Card */}
                <motion.div variants={itemVariants} className="glass-strong p-5 rounded-2xl border-iridescent relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-amber-600/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10 flex items-center gap-4">
                        <div className="p-3 bg-gradient-to-br from-amber-500 to-amber-600 rounded-xl shadow-glow-sm">
                            <Sparkles size={24} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <h3 className="font-black text-white text-sm">Premium Features</h3>
                            <p className="text-[10px] text-slate-400 font-medium mt-1">
                                Unlock advanced analytics & insights
                            </p>
                        </div>
                        <ChevronRight className="text-amber-400" size={20} />
                    </div>
                </motion.div>

                {/* Logout Button */}
                <motion.button
                    variants={itemVariants}
                    onClick={handleLogout}
                    whileTap={{ scale: 0.98 }}
                    className="w-full btn-premium py-4 bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-400 hover:to-rose-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-glow-md transition-all"
                >
                    <LogOut size={20} strokeWidth={2.5} />
                    Sign Out
                </motion.button>
            </div>

            {/* Footer */}
            <motion.div variants={itemVariants} className="p-6 text-center relative z-10">
                <p className="text-[10px] text-slate-500 font-medium">Powered by Postis Bridge</p>
                <p className="text-[9px] text-slate-600 font-medium mt-1">© 2025 AryNik Driver App</p>
            </motion.div>
        </motion.div>
    );
}
