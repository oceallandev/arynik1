import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, MapPinned, Plus, RefreshCw, Search, Trash2, List, Map as MapIcon, Wand2, ExternalLink, Truck } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import MapComponent from '../components/MapComponent';
import { useAuth } from '../context/AuthContext';
import useGeolocation from '../hooks/useGeolocation';
import { getShipments } from '../services/api';
import { geocodeAddress } from '../services/geocodeService';
import { getRouteMulti } from '../services/mapService';
import { addAwbToRoute, getRoute, removeAwbFromRoute, setRouteAwbOrder, updateRoute } from '../services/routesStore';

const isValidCoord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) > 0.0001;
};

const haversineKm = (a, b) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
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

export default function RouteDetail() {
    const { routeId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { location: driverLocation } = useGeolocation();

    const [route, setRoute] = useState(null);
    const [shipments, setShipments] = useState([]);
    const [loadingShipments, setLoadingShipments] = useState(true);
    const [search, setSearch] = useState('');
    const [addAwb, setAddAwb] = useState('');
    const [viewMode, setViewMode] = useState('list');
    const [vehiclePlate, setVehiclePlate] = useState('');

    const [coordsByAwb, setCoordsByAwb] = useState({});
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routeGeometry, setRouteGeometry] = useState(null);

    const mapLocation = driverLocation ? { lat: driverLocation.latitude, lon: driverLocation.longitude } : null;

    useEffect(() => {
        const r = getRoute(routeId);
        setRoute(r);
    }, [routeId]);

    useEffect(() => {
        setVehiclePlate(String(route?.vehicle_plate || '').toUpperCase());
    }, [route?.id]);

    const saveVehiclePlate = () => {
        if (!route) return;
        const plate = String(vehiclePlate || '').trim().toUpperCase();
        const updated = updateRoute(route.id, { vehicle_plate: plate || null });
        if (updated) setRoute(updated);
    };

    const refreshShipments = async () => {
        setLoadingShipments(true);
        try {
            const token = user?.token;
            const data = await getShipments(token);
            setShipments(Array.isArray(data) ? data : []);
        } catch (e) {
            console.warn('Failed to load shipments', e);
            setShipments([]);
        } finally {
            setLoadingShipments(false);
        }
    };

    useEffect(() => {
        refreshShipments();
    }, []);

    const shipmentsByAwb = useMemo(() => {
        const map = new Map();
        shipments.forEach((s) => {
            if (s?.awb) map.set(String(s.awb).toUpperCase(), s);
        });
        return map;
    }, [shipments]);

    const routeAwbs = Array.isArray(route?.awbs) ? route.awbs : [];

    const routeStops = useMemo(() => (
        routeAwbs.map((awb) => {
            const s = shipmentsByAwb.get(String(awb).toUpperCase());
            if (s) return s;
            return { awb, status: 'Unknown', recipient_name: 'Unknown', delivery_address: '', locality: '' };
        })
    ), [routeAwbs, shipmentsByAwb]);

    const routeStopsWithCoords = useMemo(() => (
        routeStops.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const cached = coordsByAwb[awb];

            const lat = isValidCoord(s?.latitude) ? Number(s.latitude) : (cached?.lat ?? null);
            const lon = isValidCoord(s?.longitude) ? Number(s.longitude) : (cached?.lon ?? null);

            return {
                ...s,
                latitude: Number.isFinite(lat) ? lat : null,
                longitude: Number.isFinite(lon) ? lon : null
            };
        })
    ), [routeStops, coordsByAwb]);

    const filteredAdd = useMemo(() => {
        const q = String(search || '').trim().toLowerCase();
        if (!q) return [];
        const existing = new Set(routeAwbs.map((x) => String(x).toUpperCase()));
        return shipments
            .filter((s) => {
                const awb = String(s?.awb || '').toLowerCase();
                const name = String(s?.recipient_name || '').toLowerCase();
                return (awb.includes(q) || name.includes(q)) && !existing.has(String(s?.awb || '').toUpperCase());
            })
            .slice(0, 30);
    }, [search, shipments, routeAwbs]);

    const handleAddAwb = (awb) => {
        if (!route) return;
        const updated = addAwbToRoute(route.id, awb);
        setRoute(updated);
        setAddAwb('');
        setSearch('');
    };

    const handleRemoveAwb = (awb) => {
        if (!route) return;
        const updated = removeAwbFromRoute(route.id, awb);
        setRoute(updated);
    };

    const ensureGeocodedStops = async () => {
        if (!routeStops || routeStops.length === 0) return;
        setGeocoding({ active: true, done: 0, total: routeStops.length, current: '' });

        const nextCoords = { ...coordsByAwb };
        let done = 0;

        for (const s of routeStops) {
            const awb = String(s?.awb || '').toUpperCase();
            setGeocoding({ active: true, done, total: routeStops.length, current: awb });

            // Already has coordinates?
            if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                nextCoords[awb] = { lat: Number(s.latitude), lon: Number(s.longitude), ts: Date.now(), source: 'shipment' };
                done += 1;
                continue;
            }

            // Cached in state?
            if (nextCoords[awb] && isValidCoord(nextCoords[awb].lat) && isValidCoord(nextCoords[awb].lon)) {
                done += 1;
                continue;
            }

            const query = buildGeocodeQuery(s);
            const res = await geocodeAddress(query);
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                nextCoords[awb] = { lat: res.lat, lon: res.lon, ts: Date.now(), source: 'geocode' };
            }
            done += 1;
        }

        setCoordsByAwb(nextCoords);
        setGeocoding({ active: false, done: routeStops.length, total: routeStops.length, current: '' });
    };

    const recomputeRouteGeometry = async (stopsWithCoords) => {
        const stops = Array.isArray(stopsWithCoords) ? stopsWithCoords : [];
        const points = [];

        if (mapLocation && isValidCoord(mapLocation.lat) && isValidCoord(mapLocation.lon)) {
            points.push(mapLocation);
        }

        stops.forEach((s) => {
            if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                points.push({ lat: Number(s.latitude), lon: Number(s.longitude) });
            }
        });

        if (points.length < 2) {
            setRouteGeometry(null);
            return;
        }

        const geometry = await getRouteMulti(points);
        setRouteGeometry(geometry);
    };

    useEffect(() => {
        if (viewMode !== 'map') return;
        // If stops change while map view is open (new AWB added), geocode missing ones.
        (async () => {
            await ensureGeocodedStops();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, routeAwbs.join('|')]);

    useEffect(() => {
        if (viewMode !== 'map') return;
        recomputeRouteGeometry(routeStopsWithCoords);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, JSON.stringify(routeStopsWithCoords.map((s) => [s.awb, s.latitude, s.longitude]))]);

    const optimizeOrder = () => {
        if (!route) return;

        const stops = routeStopsWithCoords
            .map((s) => ({
                awb: String(s?.awb || '').toUpperCase(),
                lat: Number(s?.latitude),
                lon: Number(s?.longitude)
            }))
            .filter((s) => s.awb && isValidCoord(s.lat) && isValidCoord(s.lon));

        if (stops.length < 2) return;

        const start = mapLocation && isValidCoord(mapLocation.lat) && isValidCoord(mapLocation.lon)
            ? { lat: Number(mapLocation.lat), lon: Number(mapLocation.lon) }
            : { lat: stops[0].lat, lon: stops[0].lon };

        const remaining = [...stops];
        const ordered = [];
        let current = start;

        while (remaining.length) {
            remaining.sort((a, b) => haversineKm(current, a) - haversineKm(current, b));
            const next = remaining.shift();
            ordered.push(next);
            current = next;
        }

        const orderedAwbs = ordered.map((s) => s.awb);
        const otherAwbs = routeAwbs.filter((awb) => !orderedAwbs.includes(String(awb).toUpperCase()));
        const updated = setRouteAwbOrder(route.id, [...orderedAwbs, ...otherAwbs]);
        setRoute(updated);
    };

    const openGoogleMaps = () => {
        const points = routeStopsWithCoords
            .filter((s) => isValidCoord(s?.latitude) && isValidCoord(s?.longitude))
            .map((s) => `${Number(s.latitude)},${Number(s.longitude)}`);

        if (points.length === 0) return;

        const originIsFirstStop = !mapLocation;
        const origin = mapLocation ? `${mapLocation.lat},${mapLocation.lon}` : points[0];
        const destination = points[points.length - 1];
        const waypoints = (originIsFirstStop ? points.slice(1, -1) : points.slice(0, -1)).join('|');

        const url = new URL('https://www.google.com/maps/dir/');
        url.searchParams.set('api', '1');
        url.searchParams.set('origin', origin);
        url.searchParams.set('destination', destination);
        if (waypoints) url.searchParams.set('waypoints', waypoints);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
    };

    if (!route) {
        return (
            <div className="min-h-screen flex items-center justify-center text-slate-400">
                Route not found.
            </div>
        );
    }

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
            <div className="sticky top-0 z-40 glass-strong backdrop-blur-xl border-b border-white/10 pb-2 shadow-sm">
                <div className="p-4 flex items-center gap-4">
                    <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl glass-light text-slate-300 hover:text-white transition-colors border border-white/10">
                        <ArrowLeft />
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="font-black text-xl text-gradient tracking-tight truncate">{route.name}</h1>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mt-1">
                            {route.date} • {routeAwbs.length} stops{route.vehicle_plate ? ` • ${route.vehicle_plate}` : ''}
                        </p>
                    </div>

                    {/* View Toggle */}
                    <div className="flex glass-strong p-1 rounded-xl border border-white/10">
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <List size={20} />
                        </button>
                        <button
                            onClick={() => setViewMode('map')}
                            className={`p-2 rounded-lg transition-all ${viewMode === 'map' ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-glow-sm' : 'text-slate-400 hover:text-white'}`}
                        >
                            <MapIcon size={20} />
                        </button>
                    </div>
                </div>

                <div className="px-4 pb-2 space-y-3">
                    <div className="glass-strong rounded-2xl border border-white/10 p-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                            <Truck size={18} className="text-emerald-300" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-[9px] uppercase font-black text-slate-500 tracking-[0.2em] mb-1">Vehicle</p>
                            <input
                                value={vehiclePlate}
                                onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
                                onBlur={saveVehiclePlate}
                                placeholder="Truck plate (ex: BC75ARI)"
                                className="w-full bg-transparent outline-none text-white font-mono text-sm tracking-wider placeholder-slate-600"
                            />
                        </div>
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                            Driver <span className="text-slate-300 font-mono">{route.driver_id || 'N/A'}</span>
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        <input
                            value={addAwb}
                            onChange={(e) => setAddAwb(e.target.value)}
                            placeholder="Add AWB..."
                            className="col-span-2 w-full px-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-emerald-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                        />
                        <button
                            onClick={() => handleAddAwb(addAwb)}
                            className="btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                        >
                            <Plus size={18} />
                            Add
                        </button>
                    </div>

                    <div className="relative group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-emerald-400 transition-colors z-10" size={18} />
                        <input
                            type="text"
                            placeholder="Search shipments to add..."
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-emerald-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>

                    {search && filteredAdd.length > 0 && (
                        <div className="glass-strong rounded-2xl border border-white/10 overflow-hidden">
                            {filteredAdd.map((s) => (
                                <button
                                    key={s.awb}
                                    onClick={() => handleAddAwb(s.awb)}
                                    className="w-full p-4 flex items-center gap-3 hover:bg-white/5 transition-all text-left border-b border-white/5 last:border-b-0"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                                        <MapPinned size={16} className="text-emerald-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate">{s.awb}</p>
                                        <p className="text-sm font-bold text-white truncate">{s.recipient_name || 'Unknown'}</p>
                                        <p className="text-[10px] text-slate-500 font-medium truncate">{s.delivery_address || s.locality || ''}</p>
                                    </div>
                                    <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wide">Add</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-1 p-4 space-y-3 pb-32 relative z-10">
                {viewMode === 'map' ? (
                    <div className="space-y-3">
                        <div className="glass-strong rounded-2xl border border-white/10 p-4 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Route Map</p>
                                <p className="text-[10px] text-slate-500 font-medium truncate">
                                    {geocoding.active ? `Geocoding ${geocoding.done}/${geocoding.total} (${geocoding.current})` : 'Tap "Optimize" for a quick route order'}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={ensureGeocodedStops}
                                    className={`p-2 rounded-xl glass-light border border-white/10 text-emerald-400 hover:bg-emerald-500/10 active:scale-95 transition-all ${geocoding.active ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    disabled={geocoding.active}
                                    title="Geocode stops"
                                >
                                    <RefreshCw size={18} className={geocoding.active ? 'animate-spin' : ''} />
                                </button>
                                <button
                                    onClick={optimizeOrder}
                                    className="p-2 rounded-xl glass-light border border-white/10 text-amber-400 hover:bg-amber-500/10 active:scale-95 transition-all"
                                    title="Optimize order"
                                >
                                    <Wand2 size={18} />
                                </button>
                                <button
                                    onClick={openGoogleMaps}
                                    className="p-2 rounded-xl glass-light border border-white/10 text-slate-200 hover:bg-white/10 active:scale-95 transition-all"
                                    title="Open in Google Maps"
                                >
                                    <ExternalLink size={18} />
                                </button>
                            </div>
                        </div>

                        <div className="h-[70vh] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl">
                            <MapComponent shipments={routeStopsWithCoords} currentLocation={mapLocation} routeGeometry={routeGeometry} />
                        </div>
                    </div>
                ) : (
                    <AnimatePresence mode="wait">
                        {routeStops.length === 0 ? (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="text-center py-20 text-slate-400"
                            >
                                <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                    <MapPinned className="text-slate-500" size={36} />
                                </div>
                                <p className="font-bold text-slate-300 text-lg">No stops yet</p>
                                <p className="text-sm mt-2 text-slate-500">Add an AWB above to allocate it to this route</p>
                            </motion.div>
                        ) : (
                            <div className="space-y-3">
                                {routeStops.map((s, idx) => (
                                    <motion.div
                                        key={`${s.awb}-${idx}`}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.02 }}
                                        className="glass-strong p-5 rounded-3xl border border-white/10"
                                    >
                                        <div className="flex items-start gap-4">
                                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-black">
                                                {idx + 1}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest truncate">{s.awb}</p>
                                                <p className="text-sm font-bold text-white truncate mt-1">{s.recipient_name || 'Unknown'}</p>
                                                <p className="text-[10px] text-slate-500 font-medium truncate mt-1">{s.delivery_address || s.locality || ''}</p>
                                            </div>
                                            <button
                                                onClick={() => handleRemoveAwb(s.awb)}
                                                className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                title="Remove from route"
                                            >
                                                <Trash2 size={18} />
                                            </button>
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        )}
                    </AnimatePresence>
                )}
            </div>
        </motion.div>
    );
}
