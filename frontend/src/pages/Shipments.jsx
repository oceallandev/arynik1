import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, Package, RefreshCw, Search, MapPin, Phone, User, List, Map as MapIcon, Navigation, Clock, TrendingUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getShipments } from '../services/api';
import { getRoute } from '../services/mapService';
import MapComponent from '../components/MapComponent';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';

export default function Shipments() {
    const [shipments, setShipments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState(null);
    const [viewMode, setViewMode] = useState('list'); // 'list' or 'map'
    const [routeGeometry, setRouteGeometry] = useState(null);
    const navigate = useNavigate();
    const { user } = useAuth();
    const { location: driverLocation } = useGeolocation();

    const fetchShipments = async () => {
        setLoading(true);
        try {
            const token = user.token; // Use token from AuthContext
            const data = await getShipments(token);
            setShipments(data);
        } catch (error) {
            console.error('Failed to fetch shipments', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchShipments();
    }, []);

    // Format location for MapComponent
    const mapLocation = driverLocation ? {
        lat: driverLocation.latitude,
        lon: driverLocation.longitude
    } : null;

    const handleViewOnMap = async (shipment) => {
        if (mapLocation && shipment.latitude && shipment.longitude) {
            const geometry = await getRoute(mapLocation, {
                lat: shipment.latitude,
                lon: shipment.longitude
            });
            setRouteGeometry(geometry);
        }
        setViewMode('map');
    };

    const filtered = shipments.filter((s) => (
        s.awb?.toLowerCase().includes(search.toLowerCase())
        || (s.recipient_name && s.recipient_name?.toLowerCase().includes(search.toLowerCase()))
    ));

    const getStatusGradient = (status) => {
        if (status === 'Delivered') return 'from-emerald-500 to-emerald-600';
        if (status === 'In Transit') return 'from-blue-500 to-blue-600';
        return 'from-amber-500 to-amber-600';
    };

    const getStatusBg = (status) => {
        if (status === 'Delivered') return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
        if (status === 'In Transit') return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            {/* Background Orbs */}
            <div className="absolute top-20 right-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            {/* Header */}
            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10">
                        <ArrowLeft />
                    </button>
                    <h1 className="flex-1 font-black text-xl text-gradient tracking-tight">Shipments</h1>

                    {/* View Toggle */}
                    <div className="flex glass-strong p-1 rounded-xl border border-white/10">
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p - 2 rounded - lg transition - all ${viewMode === 'list' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'} `}
                        >
                            <List size={20} />
                        </button>
                        <button
                            onClick={() => setViewMode('map')}
                            className={`p - 2 rounded - lg transition - all ${viewMode === 'map' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'} `}
                        >
                            <MapIcon size={20} />
                        </button>
                    </div>

                    <button
                        onClick={fetchShipments}
                        className={`p - 2 rounded - xl glass - light hover: bg - violet - 500 / 20 text - violet - 400 transition - all border border - white / 10 ${loading ? 'animate-spin' : ''} `}
                    >
                        <RefreshCw size={20} />
                    </button>
                </div>

                <div className="px-4 pb-2">
                    <div className="relative group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition-colors z-10" size={18} />
                        <input
                            type="text"
                            placeholder="Search AWB, Client..."
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-violet-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div className="flex-1 p-4 space-y-3 pb-32 relative z-10">
                <AnimatePresence mode="wait">
                    {loading && shipments.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex flex-col items-center justify-center py-20 text-slate-400"
                        >
                            <div className="relative">
                                <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full animate-pulse"></div>
                                <Loader2 className="animate-spin relative z-10 text-violet-400" size={48} />
                            </div>
                            <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">Syncing Data...</p>
                        </motion.div>
                    ) : filtered.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-center py-20 text-slate-400"
                        >
                            <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                <Package className="text-slate-500" size={36} />
                            </div>
                            <p className="font-bold text-slate-300 text-lg">No shipments found</p>
                            <p className="text-sm mt-2 text-slate-500">Try adjusting your search</p>
                        </motion.div>
                    ) : viewMode === 'map' ? (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="h-[70vh] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl"
                        >
                            <MapComponent shipments={filtered} currentLocation={mapLocation} routeGeometry={routeGeometry} />
                        </motion.div>
                    ) : (
                        <div className="space-y-3">
                            {filtered.map((s, idx) => (
                                <motion.div
                                    key={idx}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className={`glass - strong rounded - 3xl overflow - hidden transition - all duration - 300 border border - white / 10 ${expanded === idx ? 'ring-2 ring-violet-500/30 shadow-glow-sm' : ''} `}
                                >
                                    <div
                                        onClick={() => setExpanded(expanded === idx ? null : idx)}
                                        className="p-5 flex items-center gap-4 cursor-pointer relative"
                                    >
                                        <div className={`w - 14 h - 14 rounded - 2xl flex items - center justify - center shadow - sm bg - gradient - to - br ${getStatusGradient(s.status)} `}>
                                            <Package size={24} strokeWidth={2} className="text-white" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-center mb-1.5">
                                                <h3 className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-500">{s.awb}</h3>
                                                <span className={`text - [9px] font - black uppercase px - 2.5 py - 1 rounded - full tracking - wide border ${getStatusBg(s.status)} `}>
                                                    {s.status || 'Active'}
                                                </span>
                                            </div>

                                            <p className="text-sm font-bold text-white truncate leading-tight mb-2">{s.recipient_name}</p>

                                            <div className="flex items-center gap-1.5 text-slate-400">
                                                <MapPin size={11} strokeWidth={2.5} />
                                                <p className="text-[10px] font-medium truncate">{s.delivery_address || s.locality || 'No Address'}</p>
                                            </div>
                                        </div>

                                        <ChevronRight className={`text - slate - 500 transition - transform duration - 300 ${expanded === idx ? 'rotate-90 text-violet-400' : ''} `} size={20} />
                                    </div>

                                    <AnimatePresence>
                                        {expanded === idx && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.3, ease: 'easeInOut' }}
                                            >
                                                <div className="p-5 space-y-4 bg-black/20 border-t border-white/5">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="glass-light p-4 rounded-2xl flex items-center gap-3 border border-white/10">
                                                            <div className="p-2 bg-violet-500/20 rounded-xl">
                                                                <Phone size={16} className="text-violet-400" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">Contact</p>
                                                                <p className="text-xs font-bold text-white truncate">--</p>
                                                            </div>
                                                        </div>

                                                        <div className="glass-light p-4 rounded-2xl flex items-center gap-3 border border-white/10">
                                                            <div className="p-2 bg-emerald-500/20 rounded-xl">
                                                                <User size={16} className="text-emerald-400" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">Client</p>
                                                                <p className="text-xs font-bold text-white truncate">{s.recipient_name}</p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {s.latitude && s.longitude && (
                                                        <button
                                                            onClick={() => handleViewOnMap(s)}
                                                            className="w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                                                        >
                                                            <Navigation size={16} />
                                                            View on Map
                                                        </button>
                                                    )}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </AnimatePresence>
            </div>
        </motion.div>
    );
}
