import React, { useEffect } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix Leaflet generic marker icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const createCircleIcon = (label, color) => new L.DivIcon({
    className: 'driver-marker',
    html: `<div style="background:${color}; width:34px; height:34px; border-radius:9999px; border:2px solid rgba(255,255,255,0.9); box-shadow:0 8px 16px rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; font-weight:900; color:white; font-size:12px;">${label}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
});

const FitBounds = ({ points }) => {
    const map = useMap();
    useEffect(() => {
        const list = Array.isArray(points) ? points.filter(Boolean) : [];
        if (!map || list.length === 0) return;
        try {
            const bounds = L.latLngBounds(list);
            map.fitBounds(bounds, { padding: [30, 30] });
        } catch { }
    }, [points, map]);
    return null;
};

export default function DriversMap({ drivers = [] } = {}) {
    const defaultPosition = [44.4268, 26.1025]; // Bucharest fallback

    const points = (Array.isArray(drivers) ? drivers : [])
        .map((d) => {
            const lat = Number(d?.latitude);
            const lon = Number(d?.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            return [lat, lon];
        })
        .filter(Boolean);

    const center = points.length ? points[0] : defaultPosition;

    const toneForAge = (ageSec) => {
        const n = Number(ageSec);
        if (!Number.isFinite(n)) return '#64748b'; // slate
        if (n <= 60) return '#22c55e'; // green
        if (n <= 5 * 60) return '#f59e0b'; // amber
        return '#ef4444'; // red
    };

    const markerLabel = (d) => {
        const plate = String(d?.truck_plate || '').trim().toUpperCase();
        if (plate) return plate.slice(-2);
        const id = String(d?.driver_id || '').trim().toUpperCase();
        return id ? id.slice(-2) : 'D';
    };

    return (
        <div className="h-[70vh] w-full rounded-3xl overflow-hidden shadow-inner border border-white/20 relative z-0">
            <MapContainer center={center} zoom={12} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />
                <FitBounds points={points} />

                {(Array.isArray(drivers) ? drivers : []).map((d) => {
                    const lat = Number(d?.latitude);
                    const lon = Number(d?.longitude);
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

                    const color = toneForAge(d?.age_sec);
                    const label = markerLabel(d);
                    const name = String(d?.name || d?.driver_id || '').trim();
                    const plate = String(d?.truck_plate || '').trim().toUpperCase();
                    const ageSec = Number(d?.age_sec);
                    const ageTxt = Number.isFinite(ageSec) ? `${Math.round(ageSec)}s ago` : '—';

                    return (
                        <Marker
                            key={String(d?.driver_id || `${lat},${lon}`)}
                            position={[lat, lon]}
                            icon={createCircleIcon(label, color)}
                        >
                            <Popup>
                                <div className="min-w-[180px]">
                                    <div className="font-bold text-slate-900">{name || 'Driver'}</div>
                                    <div className="text-xs text-slate-600 mt-1">
                                        {plate ? `Truck ${plate}` : 'Truck unassigned'} • {ageTxt}
                                    </div>
                                    <div className="text-[11px] text-slate-700 font-mono mt-2">
                                        {lat.toFixed(6)}, {lon.toFixed(6)}
                                    </div>
                                </div>
                            </Popup>
                        </Marker>
                    );
                })}
            </MapContainer>
        </div>
    );
}

