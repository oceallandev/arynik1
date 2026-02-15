import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, MapPinned, Plus, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createRoute, deleteRoute, listRoutes } from '../services/routesStore';
import { useAuth } from '../context/AuthContext';

export default function Routes() {
    const navigate = useNavigate();
    const { user } = useAuth();

    const [routes, setRoutes] = useState([]);
    const [name, setName] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [vehiclePlate, setVehiclePlate] = useState(() => {
        try {
            return localStorage.getItem('arynik_last_vehicle_plate_v1') || '';
        } catch {
            return '';
        }
    });

    const refresh = () => setRoutes(listRoutes());

    useEffect(() => {
        refresh();
    }, []);

    const handleCreate = () => {
        const trimmed = String(name || '').trim();
        const baseName = trimmed || `Route ${new Date().toLocaleDateString()}`;
        const plate = String(vehiclePlate || '').trim().toUpperCase();
        const route = createRoute({
            name: baseName,
            driver_id: user?.driver_id || null,
            vehicle_plate: plate || null,
            date
        });
        setName('');
        if (plate) {
            try { localStorage.setItem('arynik_last_vehicle_plate_v1', plate); } catch { }
        }
        refresh();
        navigate(`/routes/${route.id}`);
    };

    const handleDelete = (routeId) => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm('Delete this route?');
        if (!ok) return;
        deleteRoute(routeId);
        refresh();
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div>
                    <h1 className="text-xl font-black text-gradient tracking-tight">Routes</h1>
                    <p className="text-xs text-slate-400 font-medium mt-1">Create routes and allocate AWBs</p>
                </div>
                <div className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10">
                    <MapPinned size={20} className="text-emerald-400" />
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 space-y-6 relative z-10">
                {/* Create */}
                <div className="glass-strong p-5 rounded-3xl border-iridescent space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">New Route</p>
                        <span className="text-[10px] font-bold text-slate-500">Driver: <span className="text-slate-300 font-mono">{user?.driver_id || 'N/A'}</span></span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Route name (ex: Bacau AM)"
                            className="col-span-2 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            value={vehiclePlate}
                            onChange={(e) => setVehiclePlate(e.target.value)}
                            placeholder="Vehicle plate (ex: BC75ARI)"
                            className="col-span-3 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono tracking-wider"
                        />
                    </div>
                    <button
                        onClick={handleCreate}
                        className="w-full btn-premium py-4 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                    >
                        <Plus size={18} />
                        Create Route
                    </button>
                </div>

                {/* List */}
                {routes.length === 0 ? (
                    <div className="text-center py-16 text-slate-400">
                        <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                            <MapPinned className="text-slate-500" size={36} />
                        </div>
                        <p className="font-bold text-slate-300 text-lg">No routes yet</p>
                        <p className="text-sm mt-2 text-slate-500">Create your first route above</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                            Your Routes
                        </h3>
                        {routes.map((r) => (
                            <div
                                key={r.id}
                                className="glass-strong p-5 rounded-3xl border border-white/10 hover:border-emerald-500/30 transition-all group"
                            >
                                <div className="flex items-start gap-4">
                                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 flex items-center justify-center shadow-glow-sm">
                                        <MapPinned size={18} className="text-white" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-white font-black truncate">{r.name || 'Route'}</p>
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                    {r.date || 'No date'} • {Array.isArray(r.awbs) ? r.awbs.length : 0} stops{r.vehicle_plate ? ` • ${r.vehicle_plate}` : ''}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => handleDelete(r.id)}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                    title="Delete route"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                                <button
                                                    onClick={() => navigate(`/routes/${r.id}`)}
                                                    className="p-2 rounded-xl glass-light border border-white/10 text-emerald-400 hover:bg-emerald-500/10 active:scale-95 transition-all"
                                                    title="Open route"
                                                >
                                                    <ArrowRight size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
}
