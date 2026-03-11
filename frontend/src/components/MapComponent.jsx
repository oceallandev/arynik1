import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Navigation } from 'lucide-react';
import { extractShipmentCoords } from '../services/shipmentGeo';

// Fix Leaflet generic marker icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom Icons
const createCustomIcon = (color) => new L.DivIcon({
    className: 'custom-icon',
    html: `<div style="background-color: ${color}; width: 24px; height: 24px; border-radius: 50%; border: 2px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
});

const numberedIconCache = new Map();
const createNumberedIcon = (number, color) => {
    const n = Number(number);
    if (!Number.isFinite(n) || n <= 0) return createCustomIcon(color);

    const key = `${n}:${color}`;
    if (numberedIconCache.has(key)) return numberedIconCache.get(key);

    const icon = new L.DivIcon({
        className: 'stop-number-icon',
        html: `<div style="background-color: ${color}; width: 28px; height: 28px; border-radius: 9999px; border: 2px solid white; box-shadow: 0 6px 10px rgba(0,0,0,0.25); display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 14px; color: white; line-height: 1;">${n}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });

    numberedIconCache.set(key, icon);
    return icon;
};

const truckIcon = new L.DivIcon({
    className: 'truck-icon',
    html: `<div style="background-color: #0052cc; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.2);">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
});

const warehouseIcon = createCustomIcon('#8b5cf6');
const TOMTOM_TRAFFIC_KEY = String(import.meta.env.VITE_TOMTOM_TRAFFIC_KEY || '').trim();
const TRAFFIC_TILE_URL = TOMTOM_TRAFFIC_KEY
    ? `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(TOMTOM_TRAFFIC_KEY)}`
    : '';

function ChangeView({ center }) {
    const map = useMap();
    useEffect(() => {
        if (center) map.setView(center, map.getZoom());
    }, [center, map]);
    return null;
}

function FitBounds({ points }) {
    const map = useMap();
    useEffect(() => {
        if (!map) return;
        const list = Array.isArray(points) ? points.filter(Boolean) : [];
        if (list.length === 0) return;
        try {
            const bounds = L.latLngBounds(list);
            map.fitBounds(bounds, { padding: [30, 30] });
        } catch { }
    }, [points, map]);
    return null;
}

export default function MapComponent({
    shipments,
    routeGeometry,
    currentLocation,
    originLocation,
    showStopNumbers = false,
    currentLocationLabel = 'You are here',
    showTraffic = true,
}) {
    const defaultPosition = [44.4268, 26.1025]; // Bucharest
    const position = currentLocation
        ? [currentLocation.lat, currentLocation.lon]
        : (originLocation ? [originLocation.lat, originLocation.lon] : defaultPosition);

    // Parse OSRM geometry if provided
    const [polypositions, setPolypositions] = useState([]);

    useEffect(() => {
        if (routeGeometry && routeGeometry.coordinates) {
            // OSRM returns [lon, lat], Leaflet needs [lat, lon]
            const coords = routeGeometry.coordinates.map(c => [c[1], c[0]]);
            setPolypositions(coords);
        }
    }, [routeGeometry]);

    const safeShipments = Array.isArray(shipments) ? shipments : [];

    const stopOrderByAwb = useMemo(() => {
        const map = new Map();
        if (!showStopNumbers) return map;
        safeShipments.forEach((s, idx) => {
            const awb = String(s?.awb || '').toUpperCase();
            if (!awb) return;
            map.set(awb, idx + 1);
        });
        return map;
    }, [showStopNumbers, safeShipments]);

    const markerRows = useMemo(() => (
        safeShipments.map((s, idx) => {
            const coords = extractShipmentCoords(s);
            if (!coords) return null;
            const awb = String(s?.awb || '').toUpperCase();
            const isDelivered = String(s?.status || '').trim().toLowerCase() === 'delivered';
            const color = isDelivered ? '#10b981' : '#f59e0b';
            const stopNum = showStopNumbers ? stopOrderByAwb.get(awb) : null;
            return {
                idx,
                awb,
                shipment: s,
                lat: Number(coords.lat),
                lon: Number(coords.lon),
                color,
                isDelivered,
                stopNum,
            };
        }).filter(Boolean)
    ), [safeShipments, showStopNumbers, stopOrderByAwb]);

    const markerRowsWithOffsets = useMemo(() => {
        if (!Array.isArray(markerRows) || markerRows.length === 0) return [];
        const groups = new Map();
        markerRows.forEach((row) => {
            const key = `${row.lat.toFixed(6)},${row.lon.toFixed(6)}`;
            const list = groups.get(key) || [];
            list.push(row);
            groups.set(key, list);
        });

        const out = [];
        groups.forEach((rowsAtSamePoint) => {
            const total = rowsAtSamePoint.length;
            rowsAtSamePoint.forEach((row, idx) => {
                if (total <= 1) {
                    out.push(row);
                    return;
                }
                const angle = (2 * Math.PI * idx) / total;
                // Small deterministic spread so all overlapping stops remain tappable/visible.
                const radius = Math.min(0.00025, 0.00007 * total);
                out.push({
                    ...row,
                    lat: row.lat + (Math.sin(angle) * radius),
                    lon: row.lon + (Math.cos(angle) * radius),
                    stacked: true,
                    stackCount: total,
                });
            });
        });
        return out;
    }, [markerRows]);

    const markerPositions = markerRowsWithOffsets.map((m) => [m.lat, m.lon]);

    const fitPoints = [
        ...(currentLocation ? [[currentLocation.lat, currentLocation.lon]] : []),
        ...(originLocation ? [[originLocation.lat, originLocation.lon]] : []),
        ...markerPositions,
        ...polypositions
    ];

    return (
        <div className="h-[400px] w-full rounded-3xl overflow-hidden shadow-inner border border-white/20 relative z-0">
            <MapContainer center={position} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />
                {showTraffic && TRAFFIC_TILE_URL ? (
                    <TileLayer
                        url={TRAFFIC_TILE_URL}
                        opacity={0.55}
                        zIndex={400}
                        attribution='&copy; <a href="https://www.tomtom.com/">TomTom Traffic</a>'
                    />
                ) : null}

                <ChangeView center={position} />
                <FitBounds points={fitPoints} />

                {/* Current Driver Location */}
                {currentLocation && (
                    <Marker position={[currentLocation.lat, currentLocation.lon]} icon={truckIcon}>
                        <Popup>
                            <div className="font-sans font-bold text-brand-600">{currentLocationLabel || 'You are here'}</div>
                        </Popup>
                    </Marker>
                )}

                {/* Warehouse Origin */}
                {originLocation && (
                    <Marker position={[originLocation.lat, originLocation.lon]} icon={warehouseIcon}>
                        <Popup>
                            <div className="font-sans font-bold text-slate-800">{originLocation.label || 'Warehouse'}</div>
                        </Popup>
                    </Marker>
                )}

                {/* Shipment Markers */}
                {markerRowsWithOffsets.map((row) => {
                    return (
                        <Marker
                            key={`${row.awb || 'stop'}-${row.idx}`}
                            position={[row.lat, row.lon]}
                            icon={showStopNumbers ? createNumberedIcon(row.stopNum, row.color) : createCustomIcon(row.color)}
                        >
                            <Popup className="glass-popup">
                                <div className="p-1 min-w-[150px]">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`w-2 h-2 rounded-full ${row.isDelivered ? 'bg-green-500' : 'bg-amber-500'}`}></span>
                                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">
                                            {showStopNumbers && row.stopNum ? `Stop ${row.stopNum} • ` : ''}{row.awb}
                                        </span>
                                    </div>
                                    <p className="font-bold text-slate-800 text-sm mb-1">{row.shipment?.recipient_name}</p>
                                    <p className="text-xs text-slate-500 truncate">{row.shipment?.delivery_address}</p>
                                    {row.stacked ? (
                                        <p className="text-[10px] text-slate-500 mt-1">
                                            {row.stackCount} stop-uri in aceeasi zona
                                        </p>
                                    ) : null}
                                </div>
                            </Popup>
                        </Marker>
                    )
                })}

                {/* Route Polyline */}
                {polypositions.length > 0 && (
                    <Polyline
                        positions={polypositions}
                        color="#0ea5e9"
                        weight={5}
                        opacity={0.85}
                    />
                )}
            </MapContainer>

            <div className="absolute top-3 left-3 z-[900]">
                <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border backdrop-blur-md ${showTraffic && TRAFFIC_TILE_URL
                    ? 'bg-emerald-500/25 border-emerald-300/40 text-emerald-100'
                    : 'bg-slate-900/60 border-white/15 text-slate-200'
                    }`}>
                    {showTraffic && TRAFFIC_TILE_URL ? 'Traffic live ON' : 'Traffic layer OFF'}
                </span>
            </div>

            {/* Map Controls Overlay (Zoom, Recenter) */}
            <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-[1000]">
                <button
                    className="glass-strong p-3 rounded-xl text-white hover:text-brand-400 hover:border-brand-500/50 transition-all shadow-lg active:scale-95"
                    onClick={(e) => {
                        e.stopPropagation();
                        // Logic to recenter would go here via ref or context
                    }}
                >
                    <Navigation size={20} />
                </button>
            </div>
        </div>
    );
}
