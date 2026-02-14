import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Navigation, Package, Truck, MapPin } from 'lucide-react';

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

const truckIcon = new L.DivIcon({
    className: 'truck-icon',
    html: `<div style="background-color: #0052cc; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.2);">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
});

function ChangeView({ center }) {
    const map = useMap();
    useEffect(() => {
        if (center) map.setView(center, map.getZoom());
    }, [center, map]);
    return null;
}

export default function MapComponent({ shipments, routeGeometry, currentLocation }) {
    const defaultPosition = [44.4268, 26.1025]; // Bucharest
    const position = currentLocation ? [currentLocation.lat, currentLocation.lon] : defaultPosition;

    // Parse OSRM geometry if provided
    const [polypositions, setPolypositions] = useState([]);

    useEffect(() => {
        if (routeGeometry && routeGeometry.coordinates) {
            // OSRM returns [lon, lat], Leaflet needs [lat, lon]
            const coords = routeGeometry.coordinates.map(c => [c[1], c[0]]);
            setPolypositions(coords);
        }
    }, [routeGeometry]);

    return (
        <div className="h-[400px] w-full rounded-3xl overflow-hidden shadow-inner border border-white/20 relative z-0">
            <MapContainer center={position} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />

                <ChangeView center={position} />

                {/* Current Driver Location */}
                {currentLocation && (
                    <Marker position={[currentLocation.lat, currentLocation.lon]} icon={truckIcon}>
                        <Popup>
                            <div className="font-sans font-bold text-brand-600">You are here</div>
                        </Popup>
                    </Marker>
                )}

                {/* Shipment Markers */}
                {shipments.map((s) => {
                    const lat = s.latitude || (s.raw_data?.recipientLocation?.latitude);
                    const lon = s.longitude || (s.raw_data?.recipientLocation?.longitude);

                    // Skip if no coordinates (or add random jitter for demo if needed)
                    if (!lat || !lon) return null;

                    return (
                        <Marker
                            key={s.awb}
                            position={[lat, lon]}
                            icon={createCustomIcon(s.status === 'Delivered' ? '#22c55e' : '#f59e0b')}
                        >
                            <Popup className="glass-popup">
                                <div className="p-1 min-w-[150px]">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`w-2 h-2 rounded-full ${s.status === 'Delivered' ? 'bg-green-500' : 'bg-amber-500'}`}></span>
                                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">{s.awb}</span>
                                    </div>
                                    <p className="font-bold text-slate-800 text-sm mb-1">{s.recipient_name}</p>
                                    <p className="text-xs text-slate-500 truncate">{s.delivery_address}</p>
                                </div>
                            </Popup>
                        </Marker>
                    )
                })}

                {/* Route Polyline */}
                {polypositions.length > 0 && (
                    <Polyline
                        positions={polypositions}
                        color="#4c9aff"
                        weight={4}
                        opacity={0.8}
                        dashArray="10, 10"
                    />
                )}
            </MapContainer>

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
