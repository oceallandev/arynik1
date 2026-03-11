import React, { useEffect } from 'react';
import { MapContainer, Marker, Popup, TileLayer, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

const RO_LAT_MIN = 43.3;
const RO_LAT_MAX = 48.5;
const RO_LON_MIN = 20.0;
const RO_LON_MAX = 30.0;

const toFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeRomaniaPoint = (latRaw, lonRaw) => {
    const lat = toFinite(latRaw);
    const lon = toFinite(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null;
    if (lat >= RO_LAT_MIN && lat <= RO_LAT_MAX && lon >= RO_LON_MIN && lon <= RO_LON_MAX) {
        return [lat, lon];
    }
    // Attempt recovery when source accidentally sends [lon, lat].
    if (lon >= RO_LAT_MIN && lon <= RO_LAT_MAX && lat >= RO_LON_MIN && lat <= RO_LON_MAX) {
        return [lon, lat];
    }
    return null;
};

// Fix Leaflet generic marker icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const createCircleIcon = (label, color, plateRaw = '') => {
    const plate = String(plateRaw || '').trim().toUpperCase();
    const plateChip = plate
        ? `<div style="margin-left:8px; padding:2px 8px; border-radius:9999px; background:rgba(15,23,42,0.9); border:1px solid rgba(255,255,255,0.35); color:white; font-weight:900; font-size:11px; line-height:1.1; white-space:nowrap;">${escapeHtml(plate)}</div>`
        : '';
    return new L.DivIcon({
    className: 'driver-marker',
    html: `<div style="display:flex; align-items:center;">
        <div style="background:${color}; width:34px; height:34px; border-radius:9999px; border:2px solid rgba(255,255,255,0.9); box-shadow:0 8px 16px rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; font-weight:900; color:white; font-size:12px;">${escapeHtml(label)}</div>
        ${plateChip}
    </div>`,
    iconSize: [plate ? 136 : 34, 36],
    iconAnchor: [17, 17]
});
};

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

    const driverRows = Array.isArray(drivers) ? drivers : [];

    const trailFor = (d) => {
        const raw = Array.isArray(d?.trail) ? d.trail : [];
        const parsed = raw
            .map((p) => {
                return sanitizeRomaniaPoint(p?.latitude, p?.longitude);
            })
            .filter(Boolean);
        if (parsed.length > 0) return parsed;

        const point = sanitizeRomaniaPoint(d?.latitude, d?.longitude);
        if (!point) return [];
        return [point];
    };

    const points = driverRows
        .flatMap((d) => trailFor(d))
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
                    url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />
                <FitBounds points={points} />

                {driverRows.map((d) => {
                    const trail = trailFor(d);
                    const point = sanitizeRomaniaPoint(d?.latitude, d?.longitude) || (trail.length > 0 ? trail[trail.length - 1] : null);
                    if (!point) return null;
                    const lat = Number(point[0]);
                    const lon = Number(point[1]);

                    const color = toneForAge(d?.age_sec);
                    const label = markerLabel(d);
                    const name = String(d?.name || d?.driver_id || '').trim();
                    const plate = String(d?.truck_plate || '').trim().toUpperCase();
                    const ageSec = Number(d?.age_sec);
                    const ageTxt = Number.isFinite(ageSec) ? `${Math.round(ageSec)}s ago` : '—';
                    const speed = Number(d?.speed_kmh);

                    return (
                        <React.Fragment key={String(d?.driver_id || `${lat},${lon}`)}>
                            {trail.length >= 2 ? (
                                <Polyline
                                    positions={trail}
                                    pathOptions={{ color, weight: 4, opacity: 0.6 }}
                                />
                            ) : null}
                            <Marker
                                position={[lat, lon]}
                                icon={createCircleIcon(label, color, plate)}
                            >
                                <Popup>
                                    <div className="min-w-[200px]">
                                        <div className="font-bold text-slate-900">{name || 'Driver'}</div>
                                        <div className="text-xs text-slate-600 mt-1">
                                            {plate ? `Truck ${plate}` : 'Truck unassigned'} • {ageTxt}
                                        </div>
                                        <div className="text-[11px] text-slate-700 mt-1">
                                            {Number.isFinite(speed) ? `Speed ${speed.toFixed(1)} km/h` : 'Speed —'}
                                        </div>
                                        <div className="text-[11px] text-slate-700 font-mono mt-2">
                                            {lat.toFixed(6)}, {lon.toFixed(6)}
                                        </div>
                                    </div>
                                </Popup>
                            </Marker>
                        </React.Fragment>
                    );
                })}
            </MapContainer>
        </div>
    );
}
