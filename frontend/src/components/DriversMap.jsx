import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer, Polyline, useMap, ZoomControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { getRouteMultiDetails } from '../services/mapService';

const RO_LAT_MIN = 43.3;
const RO_LAT_MAX = 48.5;
const RO_LON_MIN = 20.0;
const RO_LON_MAX = 30.0;
const ROAD_ROUTE_REFRESH_MS = 15000;
const MAX_ROAD_ROUTES = 60;

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

const roadRouteKey = (driverId, start, end) => {
    if (!start || !end) return '';
    const round = (n) => Number(n).toFixed(4);
    return [
        String(driverId || 'driver').trim() || 'driver',
        round(start[0]),
        round(start[1]),
        round(end[0]),
        round(end[1]),
    ].join('|');
};

const geoJsonLineToPositions = (geometry) => {
    const coords = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
    return coords
        .map((coord) => {
            const lon = Number(coord?.[0]);
            const lat = Number(coord?.[1]);
            return sanitizeRomaniaPoint(lat, lon);
        })
        .filter(Boolean);
};

// Fix Leaflet generic marker icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const createCircleIcon = (label, color, plateRaw = '', speedKmh = null) => {
    const plate = String(plateRaw || '').trim().toUpperCase();
    const speed = Number(speedKmh);
    const plateChip = plate
        ? `<div style="margin-left:8px; padding:2px 8px; border-radius:9999px; background:rgba(15,23,42,0.9); border:1px solid rgba(255,255,255,0.35); color:white; font-weight:900; font-size:11px; line-height:1.1; white-space:nowrap;">${escapeHtml(plate)}</div>`
        : '';
    const speedChip = Number.isFinite(speed)
        ? `<div style="margin-left:6px; padding:2px 8px; border-radius:9999px; background:rgba(2,132,199,0.92); border:1px solid rgba(255,255,255,0.35); color:white; font-weight:900; font-size:11px; line-height:1.1; white-space:nowrap;">${escapeHtml(speed.toFixed(1))} km/h</div>`
        : '';
    return new L.DivIcon({
    className: 'driver-marker',
    html: `<div style="display:flex; align-items:center;">
        <div style="background:${color}; width:34px; height:34px; border-radius:9999px; border:2px solid rgba(255,255,255,0.9); box-shadow:0 8px 16px rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; font-weight:900; color:white; font-size:12px;">${escapeHtml(label)}</div>
        ${plateChip}
        ${speedChip}
    </div>`,
    iconSize: [34 + (plate ? 102 : 0) + (Number.isFinite(speed) ? 88 : 0), 36],
    iconAnchor: [17, 17]
});
};

const stopIcon = new L.DivIcon({
    className: 'next-stop-marker',
    html: `<div style="width:18px; height:18px; border-radius:9999px; background:#0ea5e9; border:2px solid #ffffff; box-shadow:0 4px 10px rgba(2,132,199,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});

const FitBounds = ({ points }) => {
    const map = useMap();
    const didFitRef = useRef(false);
    const userInteractedRef = useRef(false);

    useEffect(() => {
        if (!map) return undefined;
        const markTouched = () => { userInteractedRef.current = true; };
        map.on('dragstart', markTouched);
        map.on('zoomstart', markTouched);
        return () => {
            map.off('dragstart', markTouched);
            map.off('zoomstart', markTouched);
        };
    }, [map]);

    useEffect(() => {
        const list = Array.isArray(points) ? points.filter(Boolean) : [];
        if (!map || list.length === 0) return;
        if (didFitRef.current || userInteractedRef.current) return;
        try {
            const bounds = L.latLngBounds(list);
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
            didFitRef.current = true;
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

    const routeRequests = useMemo(() => {
        const out = [];
        for (const d of driverRows) {
            if (out.length >= MAX_ROAD_ROUTES) break;
            const trail = trailFor(d);
            const point = sanitizeRomaniaPoint(d?.latitude, d?.longitude) || (trail.length > 0 ? trail[trail.length - 1] : null);
            const nextPoint = sanitizeRomaniaPoint(d?.next_stop_latitude, d?.next_stop_longitude);
            if (!point || !nextPoint) continue;
            const driverId = String(d?.driver_id || d?.truck_plate || `${point[0]},${point[1]}`).trim();
            const key = roadRouteKey(driverId, point, nextPoint);
            if (!key) continue;
            out.push({
                key,
                driverId,
                color: toneForAge(d?.age_sec),
                start: point,
                end: nextPoint,
            });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drivers]);

    const [roadRoutes, setRoadRoutes] = useState({});
    const routeCacheRef = useRef(new Map());
    const pendingRef = useRef(new Set());
    const lastRequestAtRef = useRef(new Map());

    useEffect(() => {
        let cancelled = false;
        const requests = Array.isArray(routeRequests) ? routeRequests : [];
        requests.forEach((req) => {
            if (!req?.key || pendingRef.current.has(req.key)) return;
            if (routeCacheRef.current.has(req.key)) {
                const cached = routeCacheRef.current.get(req.key);
                setRoadRoutes((prev) => (prev[req.driverId]?.key === req.key ? prev : {
                    ...prev,
                    [req.driverId]: { key: req.key, positions: cached, color: req.color },
                }));
                return;
            }

            const lastAt = Number(lastRequestAtRef.current.get(req.driverId) || 0);
            if (Date.now() - lastAt < ROAD_ROUTE_REFRESH_MS) return;
            lastRequestAtRef.current.set(req.driverId, Date.now());
            pendingRef.current.add(req.key);

            getRouteMultiDetails(
                [
                    { lat: req.start[0], lon: req.start[1] },
                    { lat: req.end[0], lon: req.end[1] },
                ],
                { requireGoogleTraffic: false }
            )
                .then((details) => {
                    if (cancelled) return;
                    const positions = geoJsonLineToPositions(details?.geometry);
                    if (positions.length < 2) return;
                    routeCacheRef.current.set(req.key, positions);
                    setRoadRoutes((prev) => ({
                        ...prev,
                        [req.driverId]: { key: req.key, positions, color: req.color },
                    }));
                })
                .catch(() => {
                    // Keep the old route/fallback line.
                })
                .finally(() => {
                    pendingRef.current.delete(req.key);
                });
        });

        return () => {
            cancelled = true;
        };
    }, [routeRequests]);

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
                <ZoomControl position="topright" />
                <FitBounds points={points} />

                {driverRows.map((d) => {
                    const trail = trailFor(d);
                    const point = sanitizeRomaniaPoint(d?.latitude, d?.longitude) || (trail.length > 0 ? trail[trail.length - 1] : null);
                    if (!point) return null;
                    const lat = Number(point[0]);
                    const lon = Number(point[1]);
                    const nextPoint = sanitizeRomaniaPoint(d?.next_stop_latitude, d?.next_stop_longitude);

                    const color = toneForAge(d?.age_sec);
                    const label = markerLabel(d);
                    const driverId = String(d?.driver_id || d?.truck_plate || `${lat},${lon}`).trim();
                    const roadRoute = roadRoutes[driverId];
                    const roadPositions = Array.isArray(roadRoute?.positions) ? roadRoute.positions : [];
                    const name = String(d?.name || d?.driver_id || '').trim();
                    const plate = String(d?.truck_plate || '').trim().toUpperCase();
                    const ageSec = Number(d?.age_sec);
                    const ageTxt = Number.isFinite(ageSec) ? `${Math.round(ageSec)}s ago` : '—';
                    const speed = Number(d?.speed_kmh);
                    const status = String(d?.location_status || '').trim().toLowerCase();
                    const statusLabel = status === 'live'
                        ? 'LIVE'
                        : (status === 'stale' ? 'DELAYED' : (status === 'offline' ? 'OFFLINE' : 'UNKNOWN'));
                    const statusColor = status === 'live'
                        ? 'text-emerald-600'
                        : (status === 'stale' ? 'text-amber-600' : (status === 'offline' ? 'text-rose-600' : 'text-slate-600'));
                    const statusHint = String(d?.location_status_hint || '').trim();

                    return (
                        <React.Fragment key={String(d?.driver_id || `${lat},${lon}`)}>
                            {trail.length >= 2 ? (
                                <Polyline
                                    positions={trail}
                                    pathOptions={{ color, weight: 3, opacity: 0.28 }}
                                />
                            ) : null}
                            {roadPositions.length >= 2 ? (
                                <Polyline
                                    positions={roadPositions}
                                    pathOptions={{ color: '#0ea5e9', weight: 7, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }}
                                />
                            ) : nextPoint ? (
                                <Polyline
                                    positions={[[lat, lon], nextPoint]}
                                    pathOptions={{ color: '#0ea5e9', weight: 5, opacity: 0.65, lineCap: 'round', lineJoin: 'round' }}
                                />
                            ) : null}
                            {nextPoint ? (
                                <Marker position={nextPoint} icon={stopIcon}>
                                    <Popup>
                                        <div className="min-w-[200px]">
                                            <div className="font-bold text-slate-900">
                                                Next stop {d?.next_stop_seq ? `#${d.next_stop_seq}` : ''}
                                            </div>
                                            <div className="text-xs text-slate-600 mt-1">
                                                {String(d?.next_stop_awb || '').trim().toUpperCase() || 'AWB'}
                                            </div>
                                            {String(d?.next_stop_recipient_name || '').trim() ? (
                                                <div className="text-[11px] text-slate-700 mt-1">
                                                    {String(d.next_stop_recipient_name).trim()}
                                                </div>
                                            ) : null}
                                            {String(d?.next_stop_locality || d?.next_stop_address || '').trim() ? (
                                                <div className="text-[11px] text-slate-700 mt-1">
                                                    {String(d?.next_stop_locality || d?.next_stop_address || '').trim()}
                                                </div>
                                            ) : null}
                                        </div>
                                    </Popup>
                                </Marker>
                            ) : null}
                            <Marker
                                position={[lat, lon]}
                                icon={createCircleIcon(label, color, plate, speed)}
                            >
                                <Popup>
                                    <div className="min-w-[200px]">
                                        <div className="font-bold text-slate-900">{name || 'Driver'}</div>
                                        <div className="text-xs text-slate-600 mt-1">
                                            {plate ? `Truck ${plate}` : 'Truck unassigned'} • {ageTxt}
                                        </div>
                                        <div className={`text-[11px] font-black uppercase tracking-wider mt-1 ${statusColor}`}>
                                            {statusLabel}
                                        </div>
                                        <div className="text-[11px] text-slate-700 mt-1">
                                            {Number.isFinite(speed) ? `Speed ${speed.toFixed(1)} km/h` : 'Speed —'}
                                        </div>
                                        {nextPoint ? (
                                            <div className="text-[11px] text-sky-700 font-bold mt-1">
                                                Heading to stop {d?.next_stop_seq ? `#${d.next_stop_seq}` : ''} • {String(d?.next_stop_awb || '').trim().toUpperCase() || '--'}
                                            </div>
                                        ) : null}
                                        {Number.isFinite(Number(d?.next_stop_distance_km)) ? (
                                            <div className="text-[11px] text-sky-700 mt-1">
                                                Distance to next stop: {Number(d.next_stop_distance_km).toFixed(2)} km
                                            </div>
                                        ) : null}
                                        {statusHint ? (
                                            <div className="text-[11px] text-slate-600 mt-1">
                                                {statusHint}
                                            </div>
                                        ) : null}
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
