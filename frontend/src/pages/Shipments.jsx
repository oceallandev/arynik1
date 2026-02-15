import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, Package, RefreshCw, Search, MapPin, Phone, User, List, Map as MapIcon, Navigation, Clock, TrendingUp, MapPinned } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getShipments } from '../services/api';
import { geocodeAddress } from '../services/geocodeService';
import { getRoute } from '../services/mapService';
import MapComponent from '../components/MapComponent';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import { addAwbToRoute, createRoute, findRouteForAwb, listRoutes } from '../services/routesStore';

const MAX_MAP_GEOCODE = 200;

const isValidCoord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) > 0.0001;
};

const normalizePlace = (value) => (
    String(value || '')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim()
);

const buildGeocodeQuery = (shipment) => {
    const addr = normalizePlace(shipment?.delivery_address);
    const loc = normalizePlace(shipment?.locality || shipment?.raw_data?.recipientLocation?.locality);
    const county = normalizePlace(shipment?.county || shipment?.raw_data?.recipientLocation?.county || shipment?.raw_data?.recipientLocation?.countyName);

    const parts = [];
    if (addr) parts.push(addr);
    if (loc && !addr.toLowerCase().includes(loc.toLowerCase())) parts.push(loc);
    if (county && !parts.some((p) => p.toLowerCase().includes(county.toLowerCase()))) parts.push(county);
    parts.push('Romania');
    return parts.filter(Boolean).join(', ');
};

export default function Shipments() {
    const [shipments, setShipments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState(null);
    const [viewMode, setViewMode] = useState('list'); // 'list' or 'map'
    const [routeGeometry, setRouteGeometry] = useState(null);
    const [coordsByAwb, setCoordsByAwb] = useState({});
    const coordsByAwbRef = useRef({});
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routePicker, setRoutePicker] = useState({ open: false, awb: null });
    const [routes, setRoutes] = useState([]);
    const [assignMsg, setAssignMsg] = useState('');
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

    useEffect(() => {
        setRoutes(listRoutes());
    }, []);

    // Format location for MapComponent
    const mapLocation = driverLocation ? {
        lat: driverLocation.latitude,
        lon: driverLocation.longitude
    } : null;

    useEffect(() => {
        coordsByAwbRef.current = coordsByAwb;
    }, [coordsByAwb]);

    const handleViewOnMap = async (shipment) => {
        const awb = String(shipment?.awb || '').toUpperCase();
        let lat = Number(shipment?.latitude);
        let lon = Number(shipment?.longitude);

        const cached = coordsByAwbRef.current[awb];
        if ((!isValidCoord(lat) || !isValidCoord(lon)) && cached && isValidCoord(cached.lat) && isValidCoord(cached.lon)) {
            lat = Number(cached.lat);
            lon = Number(cached.lon);
        }

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const query = buildGeocodeQuery(shipment);
            const res = await geocodeAddress(query);
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                lat = Number(res.lat);
                lon = Number(res.lon);
                if (awb) {
                    setCoordsByAwb((prev) => ({ ...prev, [awb]: { lat, lon, ts: Date.now(), source: 'geocode' } }));
                }
            }
        }

        if (mapLocation && isValidCoord(lat) && isValidCoord(lon)) {
            const geometry = await getRoute(mapLocation, { lat, lon });
            setRouteGeometry(geometry);
        } else {
            setRouteGeometry(null);
        }

        setViewMode('map');
    };

    const openRoutePicker = (awb) => {
        setRoutes(listRoutes());
        setRoutePicker({ open: true, awb: String(awb || '').toUpperCase() });
    };

    const assignToRoute = (routeId) => {
        const awb = routePicker.awb;
        if (!awb) return;
        const updated = addAwbToRoute(routeId, awb);
        if (updated) {
            const r = listRoutes().find((x) => x.id === routeId);
            setAssignMsg(`Assigned ${awb} to ${r?.name || 'route'}`);
            setTimeout(() => setAssignMsg(''), 2500);
        }
        setRoutePicker({ open: false, awb: null });
    };

    const createAndAssign = () => {
        const awb = routePicker.awb;
        if (!awb) return;
        const route = createRoute({
            name: `Route ${new Date().toLocaleDateString()}`,
            driver_id: user?.driver_id || null,
            date: new Date().toISOString().slice(0, 10)
        });
        addAwbToRoute(route.id, awb);
        setRoutePicker({ open: false, awb: null });
        setAssignMsg(`Created route and assigned ${awb}`);
        setTimeout(() => setAssignMsg(''), 2500);
        navigate(`/routes/${route.id}`);
    };

    const filtered = shipments.filter((s) => (
        s.awb?.toLowerCase().includes(search.toLowerCase())
        || (s.recipient_name && s.recipient_name?.toLowerCase().includes(search.toLowerCase()))
    ));

    const mapTargets = useMemo(() => filtered.slice(0, MAX_MAP_GEOCODE), [filtered]);
    const mapTargetsKey = useMemo(
        () => mapTargets.map((s) => String(s?.awb || '').toUpperCase()).join('|'),
        [mapTargets]
    );

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (!mapTargets || mapTargets.length === 0) return;

        let cancelled = false;

        (async () => {
            const nextCoords = { ...coordsByAwbRef.current };
            const total = mapTargets.length;
            let done = 0;

            // If everything already has coordinates, skip work.
            const missing = mapTargets.some((s) => {
                const awb = String(s?.awb || '').toUpperCase();
                if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) return false;
                if (nextCoords[awb] && isValidCoord(nextCoords[awb].lat) && isValidCoord(nextCoords[awb].lon)) return false;
                return true;
            });

            if (!missing) {
                setGeocoding({ active: false, done: total, total, current: '' });
                return;
            }

            setGeocoding({ active: true, done: 0, total, current: '' });

            for (const s of mapTargets) {
                if (cancelled) return;
                const awb = String(s?.awb || '').toUpperCase();

                // Already has coordinates?
                if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                    if (awb) nextCoords[awb] = { lat: Number(s.latitude), lon: Number(s.longitude), ts: Date.now(), source: 'shipment' };
                    done += 1;
                    setGeocoding({ active: true, done, total, current: awb });
                    continue;
                }

                // Cached?
                if (awb && nextCoords[awb] && isValidCoord(nextCoords[awb].lat) && isValidCoord(nextCoords[awb].lon)) {
                    done += 1;
                    setGeocoding({ active: true, done, total, current: awb });
                    continue;
                }

                setGeocoding({ active: true, done, total, current: awb });
                const query = buildGeocodeQuery(s);
                const res = await geocodeAddress(query);
                if (res && isValidCoord(res.lat) && isValidCoord(res.lon) && awb) {
                    nextCoords[awb] = { lat: Number(res.lat), lon: Number(res.lon), ts: Date.now(), source: 'geocode' };
                }
                done += 1;
            }

            if (cancelled) return;
            setCoordsByAwb(nextCoords);
            setGeocoding({ active: false, done, total, current: '' });
        })();

        return () => {
            cancelled = true;
        };
    }, [viewMode, mapTargetsKey]);

    const mapShipments = useMemo(() => {
        if (viewMode !== 'map') return filtered;
        const coords = coordsByAwb || {};
        return filtered.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const c = coords[awb];
            if (c && isValidCoord(c.lat) && isValidCoord(c.lon)) {
                return { ...s, latitude: Number(c.lat), longitude: Number(c.lon) };
            }
            return s;
        });
    }, [viewMode, filtered, coordsByAwb]);

    // Pagination
    const itemsPerPage = 20;
    const [currentPage, setCurrentPage] = useState(1);

    useEffect(() => {
        setCurrentPage(1);
    }, [search, viewMode]);

    const totalPages = Math.ceil(filtered.length / itemsPerPage);
    // Only paginate in list mode. Map mode handles all markers (might need clustering eventually)
    const paginatedShipments = viewMode === 'list'
        ? filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
        : filtered;

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
                            className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <List size={20} />
                        </button>
                        <button
                            onClick={() => setViewMode('map')}
                            className={`p-2 rounded-lg transition-all ${viewMode === 'map' ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <MapIcon size={20} />
                        </button>
                    </div>

                    <button
                        onClick={fetchShipments}
                        className={`p-2 rounded-xl glass-light hover:bg-violet-500/20 text-violet-400 transition-all border border-white/10 ${loading ? 'animate-spin' : ''}`}
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
                    {assignMsg && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="glass-strong p-4 rounded-2xl border border-emerald-500/20 text-emerald-300 text-xs font-bold"
                        >
                            {assignMsg}
                        </motion.div>
                    )}
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
                            className="h-[70vh] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl relative"
                        >
                            <MapComponent shipments={mapShipments} currentLocation={mapLocation} routeGeometry={routeGeometry} />
                            {geocoding.active && (
                                <div className="absolute top-4 left-4 glass-strong rounded-2xl border border-white/10 px-4 py-3 text-white text-xs font-bold shadow-lg">
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="animate-spin text-violet-300" size={14} />
                                        <span className="uppercase tracking-widest text-[10px] text-slate-300">Geocoding</span>
                                    </div>
                                    <div className="mt-1 text-[10px] text-slate-400 font-black uppercase tracking-wider">
                                        {geocoding.done}/{geocoding.total} {geocoding.current ? `(${geocoding.current})` : ''}
                                    </div>
                                    <div className="mt-2 h-1.5 w-48 bg-white/10 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-violet-500 to-purple-500"
                                            style={{ width: `${Math.min(100, Math.round((geocoding.done / Math.max(1, geocoding.total)) * 100))}%` }}
                                        />
                                    </div>
                                    <div className="mt-2 text-[9px] text-slate-500 font-bold">
                                        Tip: search a city/awb first to reduce requests.
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    ) : (
                        <div className="space-y-3">
                            {paginatedShipments.map((s, idx) => (
                                <motion.div
                                    key={s.awb || idx} // Use AWB as key for better performance
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className={`glass-strong rounded-3xl overflow-hidden transition-all duration-300 border border-white/10 ${expanded === idx ? 'ring-2 ring-violet-500/30 shadow-glow-sm' : ''}`}
                                >
                                    <div
                                        onClick={() => setExpanded(expanded === idx ? null : idx)}
                                        className="p-5 flex items-center gap-4 cursor-pointer relative"
                                    >
                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm bg-gradient-to-br ${getStatusGradient(s.status)}`}>
                                            <Package size={24} strokeWidth={2} className="text-white" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-center mb-1.5">
                                                <h3 className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-500">{s.awb}</h3>
                                                <div className="flex items-center gap-2">
                                                    {(() => {
                                                        const r = findRouteForAwb(s.awb);
                                                        if (!r) return null;
                                                        return (
                                                            <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border bg-emerald-500/15 text-emerald-300 border-emerald-500/20">
                                                                {r.name || 'Route'}
                                                            </span>
                                                        );
                                                    })()}
                                                    <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${getStatusBg(s.status)}`}>
                                                        {s.status || 'Active'}
                                                    </span>
                                                </div>
                                            </div>

                                            <p className="text-sm font-bold text-white truncate leading-tight mb-2">{s.recipient_name}</p>

                                            <div className="flex items-center gap-1.5 text-slate-400">
                                                <MapPin size={11} strokeWidth={2.5} />
                                                <p className="text-[10px] font-medium truncate">{s.delivery_address || s.locality || 'No Address'}</p>
                                            </div>
                                        </div>

                                        <ChevronRight className={`text-slate-500 transition-transform duration-300 ${expanded === idx ? 'rotate-90 text-violet-400' : ''}`} size={20} />
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

                                                    <button
                                                        onClick={() => handleViewOnMap(s)}
                                                        className="w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                                                    >
                                                        <Navigation size={16} />
                                                        View on Map
                                                    </button>

                                                    <button
                                                        onClick={() => openRoutePicker(s.awb)}
                                                        className="w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                                                    >
                                                        <MapPinned size={16} />
                                                        Assign to Route
                                                    </button>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </motion.div>
                            ))}

                            {/* Pagination Controls */}
                            {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4 glass-strong rounded-2xl p-4 border border-white/10">
                                    <button
                                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                        disabled={currentPage === 1}
                                        className="p-2 rounded-xl hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
                                    >
                                        <ArrowLeft size={20} />
                                    </button>
                                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <button
                                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                        disabled={currentPage === totalPages}
                                        className="p-2 rounded-xl hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
                                    >
                                        <ChevronRight size={20} />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </AnimatePresence>
            </div>

            {/* Route Picker Modal */}
            <AnimatePresence>
                {routePicker.open && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4"
                        onClick={() => setRoutePicker({ open: false, awb: null })}
                    >
                        <motion.div
                            initial={{ y: 30, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: 30, opacity: 0 }}
                            className="w-full max-w-md glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Assign AWB</p>
                                    <p className="text-sm font-bold text-white font-mono mt-1">{routePicker.awb}</p>
                                </div>
                                <button
                                    onClick={createAndAssign}
                                    className="px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                                >
                                    Create Route
                                </button>
                            </div>

                            <div className="space-y-2 max-h-[45vh] overflow-y-auto">
                                {routes.length === 0 ? (
                                    <p className="text-xs text-slate-500">No routes yet. Tap “Create Route”.</p>
                                ) : (
                                    routes.map((r) => (
                                        <button
                                            key={r.id}
                                            onClick={() => assignToRoute(r.id)}
                                            className="w-full p-4 rounded-2xl border border-white/10 hover:border-emerald-500/30 transition-all text-left glass-light flex items-center justify-between gap-3"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{r.name || 'Route'}</p>
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">{r.date} • {Array.isArray(r.awbs) ? r.awbs.length : 0} stops</p>
                                            </div>
                                            <span className="text-[10px] font-black text-emerald-300 uppercase tracking-wide">Select</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
