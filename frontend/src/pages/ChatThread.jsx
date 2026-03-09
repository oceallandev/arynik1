import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Crosshair, Loader2, MapPin, Search, Send, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { normalizeRole } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { geocodeAddress } from '../services/geocodeService';
import { buildGeocodeQuery, isValidCoord } from '../services/shipmentGeo';
import { getChatThread, getShipment, listChatMessages, markChatRead, sendChatMessage } from '../services/api';
import { getCurrentPositionRobust, normalizeGeoErrorMessage } from '../services/location';

// Fix Leaflet generic marker icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const fmtTime = (iso) => {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
};

const fmtDate = (iso) => {
    try {
        return new Date(iso).toLocaleDateString();
    } catch {
        return '';
    }
};

const dayKey = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return 'unknown';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
        return 'unknown';
    }
};

const fmtDayLabel = (iso) => {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return 'Unknown day';
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diffDays = Math.round((today - target) / (24 * 60 * 60 * 1000));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return 'Unknown day';
    }
};

const senderGroupKey = (m) => `${String(m?.sender_user_id || '').trim().toUpperCase()}|${String(m?.sender_role || '').trim().toLowerCase()}`;

const senderTone = (key) => {
    const tones = [
        { chip: 'bg-violet-500/20 text-violet-200 border-violet-400/30', dot: 'bg-violet-400' },
        { chip: 'bg-sky-500/20 text-sky-200 border-sky-400/30', dot: 'bg-sky-400' },
        { chip: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30', dot: 'bg-emerald-400' },
        { chip: 'bg-amber-500/20 text-amber-200 border-amber-400/30', dot: 'bg-amber-400' },
        { chip: 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/30', dot: 'bg-fuchsia-400' },
    ];
    const value = String(key || '');
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return tones[Math.abs(hash) % tones.length];
};

const osmLink = (lat, lon) => {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(String(la))}&mlon=${encodeURIComponent(String(lo))}#map=18/${encodeURIComponent(String(la))}/${encodeURIComponent(String(lo))}`;
};

const ClickToSet = ({ onPick }) => {
    useMapEvents({
        click(e) {
            onPick?.({ lat: e.latlng.lat, lon: e.latlng.lng, source: 'map' });
        }
    });
    return null;
};

const ChangeView = ({ center }) => {
    const map = useMap();
    useEffect(() => {
        if (!center) return;
        try {
            map.setView(center, map.getZoom());
        } catch { }
    }, [center, map]);
    return null;
};

function LocationPickerModal({ open, onClose, shipment, onConfirm }) {
    const [query, setQuery] = useState('');
    const [note, setNote] = useState('');
    const [pos, setPos] = useState(null);
    const [source, setSource] = useState('manual');
    const [busyGps, setBusyGps] = useState(false);
    const [busySearch, setBusySearch] = useState(false);
    const [error, setError] = useState('');

    const defaultQuery = useMemo(() => buildGeocodeQuery(shipment), [shipment]);

    const initialPos = useMemo(() => {
        const pin = shipment?.recipient_pin || shipment?.raw_data?.recipientPin || null;
        const pinLat = Number(pin?.latitude ?? pin?.lat);
        const pinLon = Number(pin?.longitude ?? pin?.lon ?? pin?.lng);
        if (isValidCoord(pinLat) && isValidCoord(pinLon)) return { lat: pinLat, lon: pinLon };

        const lat = Number(shipment?.latitude);
        const lon = Number(shipment?.longitude);
        if (isValidCoord(lat) && isValidCoord(lon)) return { lat, lon };

        return { lat: 44.4268, lon: 26.1025 }; // Bucharest fallback
    }, [shipment]);

    useEffect(() => {
        if (!open) return;
        setQuery(defaultQuery);
        setNote('');
        setPos(initialPos);
        setSource('extracted');
        setError('');
    }, [open, defaultQuery, initialPos]);

    const detectGps = async () => {
        setBusyGps(true);
        setError('');
        try {
            const coords = await getCurrentPositionRobust();
            const lat = Number(coords?.latitude);
            const lon = Number(coords?.longitude);
            if (!isValidCoord(lat) || !isValidCoord(lon)) throw new Error('Invalid GPS coordinates');
            setPos({ lat, lon });
            setSource('gps');
        } catch (e) {
            setError(String(normalizeGeoErrorMessage(e) || 'Failed to detect GPS'));
        } finally {
            setBusyGps(false);
        }
    };

    const doSearch = async () => {
        const q = String(query || '').trim();
        if (!q) return;
        setBusySearch(true);
        setError('');
        try {
            const res = await geocodeAddress(q);
            if (!res || !isValidCoord(res.lat) || !isValidCoord(res.lon)) {
                throw new Error('Address not found');
            }
            setPos({ lat: Number(res.lat), lon: Number(res.lon) });
            setSource('geocode');
        } catch (e) {
            setError(String(e?.message || 'Search failed'));
        } finally {
            setBusySearch(false);
        }
    };

    const confirm = () => {
        if (!pos || !isValidCoord(pos.lat) || !isValidCoord(pos.lon)) {
            setError('Pick a valid location');
            return;
        }
        onConfirm?.({
            latitude: Number(pos.lat),
            longitude: Number(pos.lon),
            source: source || 'manual',
            address: String(query || '').trim() || null,
            note: String(note || '').trim() || null
        });
    };

    return (
        <AnimatePresence>
            {open ? (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ y: 30, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 30, opacity: 0 }}
                        className="w-full max-w-md glass-strong rounded-3xl border-iridescent p-5 space-y-4"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Pin delivery location</p>
                                <p className="text-sm font-black text-white truncate">{shipment?.awb ? String(shipment.awb).toUpperCase() : 'Shipment'}</p>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                className="w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all"
                                aria-label="Close"
                            >
                                <X size={18} className="text-slate-300" />
                            </button>
                        </div>

                        {error ? (
                            <div className="glass-light p-3 rounded-2xl border border-rose-500/30 text-rose-200 text-xs font-bold">
                                {error}
                            </div>
                        ) : null}

                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <div className="flex-1 flex items-center gap-2 glass-light rounded-2xl border border-white/10 px-3 py-3">
                                    <Search size={16} className="text-slate-500" />
                                    <input
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder="Search address"
                                        className="w-full bg-transparent outline-none text-sm font-bold text-white placeholder:text-slate-600"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={doSearch}
                                    disabled={busySearch}
                                    className={`w-12 h-12 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 hover:bg-violet-500/20 active:scale-95 transition-all flex items-center justify-center ${busySearch ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    title="Search"
                                >
                                    {busySearch ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
                                </button>
                                <button
                                    type="button"
                                    onClick={detectGps}
                                    disabled={busyGps}
                                    className={`w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all flex items-center justify-center ${busyGps ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    title="Use GPS"
                                >
                                    {busyGps ? <Loader2 size={18} className="animate-spin" /> : <Crosshair size={18} />}
                                </button>
                            </div>
                            <div className="text-[11px] font-bold text-slate-400">
                                Move the marker to the exact place where the truck should deliver.
                            </div>
                        </div>

                        <div className="h-[260px] w-full rounded-3xl overflow-hidden shadow-inner border border-white/20">
                            <MapContainer center={[pos?.lat || initialPos.lat, pos?.lon || initialPos.lon]} zoom={16} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                                <TileLayer
                                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                                />
                                <ChangeView center={[pos?.lat || initialPos.lat, pos?.lon || initialPos.lon]} />
                                <ClickToSet onPick={(p) => { setPos({ lat: p.lat, lon: p.lon }); setSource(p.source || 'map'); }} />
                                {pos ? (
                                    <Marker
                                        position={[pos.lat, pos.lon]}
                                        draggable
                                        eventHandlers={{
                                            dragend: (e) => {
                                                try {
                                                    const latlng = e?.target?.getLatLng?.();
                                                    const lat = Number(latlng?.lat);
                                                    const lon = Number(latlng?.lng);
                                                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
                                                    setPos({ lat, lon });
                                                    setSource('drag');
                                                } catch { }
                                            }
                                        }}
                                    />
                                ) : null}
                            </MapContainer>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="glass-light p-3 rounded-2xl border border-white/10">
                                <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Latitude</div>
                                <div className="text-sm font-black text-white font-mono truncate">{pos ? String(Number(pos.lat).toFixed(6)) : '--'}</div>
                            </div>
                            <div className="glass-light p-3 rounded-2xl border border-white/10">
                                <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Longitude</div>
                                <div className="text-sm font-black text-white font-mono truncate">{pos ? String(Number(pos.lon).toFixed(6)) : '--'}</div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Note (optional)</div>
                            <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                rows={2}
                                placeholder="Gate code, building entrance, landmark..."
                                className="w-full glass-light rounded-2xl border border-white/10 p-3 text-sm font-bold text-white placeholder:text-slate-600 outline-none"
                            />
                        </div>

                        <button
                            type="button"
                            onClick={confirm}
                            className="w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm"
                        >
                            <MapPin size={16} />
                            Send pinned location
                        </button>

                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                            Source: {String(source || 'manual')}
                        </div>
                    </motion.div>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}

export default function ChatThread() {
    const navigate = useNavigate();
    const { threadId } = useParams();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const myId = String(user?.driver_id || '').trim().toUpperCase();
    const isRecipient = normalizeRole(user?.role) === 'Recipient';

    const [thread, setThread] = useState(null);
    const [shipment, setShipment] = useState(null);
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [pinOpen, setPinOpen] = useState(false);
    const [quickLocBusy, setQuickLocBusy] = useState(false);

    const bottomRef = useRef(null);
    const lastMsgId = useMemo(() => {
        const list = Array.isArray(messages) ? messages : [];
        const last = list.length ? list[list.length - 1] : null;
        return last?.id ? Number(last.id) : 0;
    }, [messages]);

    const feedRows = useMemo(() => {
        const list = Array.isArray(messages) ? messages : [];
        const rows = [];
        const gapMs = 5 * 60 * 1000;
        for (let i = 0; i < list.length; i += 1) {
            const m = list[i];
            const prev = i > 0 ? list[i - 1] : null;
            const next = i < list.length - 1 ? list[i + 1] : null;

            const dk = dayKey(m?.created_at);
            const prevDk = prev ? dayKey(prev?.created_at) : null;
            const nextDk = next ? dayKey(next?.created_at) : null;

            if (i === 0 || dk !== prevDk) {
                rows.push({ kind: 'day', key: `day-${dk}-${i}`, iso: m?.created_at });
            }

            const mine = String(m?.sender_user_id || '').trim().toUpperCase() === myId;
            const sk = senderGroupKey(m);
            const prevSk = prev ? senderGroupKey(prev) : null;
            const nextSk = next ? senderGroupKey(next) : null;

            const curMs = new Date(m?.created_at || 0).getTime();
            const prevMs = prev ? new Date(prev?.created_at || 0).getTime() : 0;
            const nextMs = next ? new Date(next?.created_at || 0).getTime() : 0;

            const startGroup = !prev || dk !== prevDk || sk !== prevSk || !Number.isFinite(curMs - prevMs) || (curMs - prevMs) > gapMs;
            const endGroup = !next || dk !== nextDk || sk !== nextSk || !Number.isFinite(nextMs - curMs) || (nextMs - curMs) > gapMs;

            rows.push({
                kind: 'message',
                key: `msg-${m?.id || i}`,
                message: m,
                mine,
                startGroup,
                endGroup,
                senderKey: sk,
            });
        }
        return rows;
    }, [messages, myId]);

    const scrollToBottom = () => {
        try {
            bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
        } catch { }
    };

    const refresh = async ({ withThread = false } = {}) => {
        if (!token) return;
        setError('');
        try {
            if (withThread) {
                const t = await getChatThread(token, threadId);
                setThread(t);
                if (t?.awb) {
                    try {
                        const ship = await getShipment(token, t.awb, { refresh: false });
                        setShipment(ship || null);
                    } catch {
                        setShipment(null);
                    }
                } else {
                    setShipment(null);
                }
            }

            const data = await listChatMessages(token, threadId, { limit: 80 });
            const list = Array.isArray(data) ? data : [];
            setMessages(list);

            // Mark as read to clear unread counts.
            const last = list.length ? list[list.length - 1] : null;
            if (last?.id) {
                await markChatRead(token, threadId, { last_read_message_id: Number(last.id) }).catch(() => { });
            }
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to load chat'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        refresh({ withThread: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [threadId, token]);

    useEffect(() => {
        if (!token) return;
        const id = setInterval(() => refresh({ withThread: false }), 5000);
        const detailsId = setInterval(() => refresh({ withThread: true }), 30000);
        return () => {
            clearInterval(id);
            clearInterval(detailsId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [threadId, token]);

    useEffect(() => {
        scrollToBottom();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastMsgId]);

    const doSend = async () => {
        if (!token) return;
        const msg = String(text || '').trim();
        if (!msg) return;
        setSending(true);
        setError('');
        try {
            const created = await sendChatMessage(token, threadId, { message_type: 'text', text: msg });
            setText('');
            setMessages((prev) => ([...(Array.isArray(prev) ? prev : []), created].filter(Boolean)));
            scrollToBottom();
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to send'));
        } finally {
            setSending(false);
        }
    };

    const sendLocationMessage = async ({ latitude, longitude, source, address, note }, { closePicker = false } = {}) => {
        if (!token) return;
        setSending(true);
        setError('');
        try {
            const created = await sendChatMessage(token, threadId, {
                message_type: 'location',
                text: null,
                data: { latitude, longitude, source, address, note }
            });
            if (closePicker) setPinOpen(false);
            setMessages((prev) => ([...(Array.isArray(prev) ? prev : []), created].filter(Boolean)));
            scrollToBottom();
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || 'Failed to send location'));
        } finally {
            setSending(false);
        }
    };

    const doSendPin = async ({ latitude, longitude, source, address, note }) => {
        await sendLocationMessage({ latitude, longitude, source, address, note }, { closePicker: true });
    };

    const doSendCurrentLocation = async () => {
        if (!isRecipient || !token) return;
        setQuickLocBusy(true);
        setError('');
        try {
            const coords = await getCurrentPositionRobust();
            const lat = Number(coords?.latitude);
            const lon = Number(coords?.longitude);
            if (!isValidCoord(lat) || !isValidCoord(lon)) {
                throw new Error('Invalid GPS coordinates');
            }
            await sendLocationMessage(
                { latitude: lat, longitude: lon, source: 'gps', address: null, note: null },
                { closePicker: false }
            );
        } catch (e) {
            setError(String(normalizeGeoErrorMessage(e) || e?.message || 'Failed to send location'));
        } finally {
            setQuickLocBusy(false);
        }
    };

    const awbLabel = thread?.awb ? String(thread.awb).toUpperCase() : `Thread #${String(threadId)}`;
    const pin = shipment?.recipient_pin || shipment?.raw_data?.recipientPin || null;
    const pinLat = Number(pin?.latitude ?? pin?.lat);
    const pinLon = Number(pin?.longitude ?? pin?.lon ?? pin?.lng);
    const pinHref = (isValidCoord(pinLat) && isValidCoord(pinLon)) ? osmLink(pinLat, pinLon) : null;

    const senderRoleLabel = (roleRaw) => {
        const role = normalizeRole(roleRaw);
        if (role === 'Driver') return 'Driver';
        if (role === 'Recipient') return 'Recipient';
        if (role === 'Admin') return 'Admin';
        if (role === 'Manager') return 'Manager';
        if (role === 'Dispatcher') return 'Dispatcher';
        if (role === 'Support') return 'Support';
        if (role === 'Warehouse') return 'Warehouse';
        if (role === 'Finance') return 'Finance';
        return role || 'User';
    };

    const senderPrimaryLabel = (m, mine) => {
        if (mine) return 'You';
        const byName = String(m?.sender_name || '').trim();
        if (byName) return byName;
        return senderRoleLabel(m?.sender_role);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-violet-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="min-w-0 flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => navigate(-1)}
                        className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10 text-slate-200 hover:bg-white/5 active:scale-95 transition-all"
                        aria-label="Back"
                    >
                        <ArrowLeft size={18} />
                    </button>
                    <div className="min-w-0">
                        <h1 className="text-lg font-black text-white truncate">{awbLabel}</h1>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1 truncate">
                            {thread?.last_message_at ? `Last message ${fmtTime(thread.last_message_at)}` : (thread?.created_at ? `Created ${fmtDate(thread.created_at)}` : '')}
                        </p>
                    </div>
                </div>

                {isRecipient ? (
                    <button
                        type="button"
                        onClick={doSendCurrentLocation}
                        disabled={sending || quickLocBusy}
                        className="px-4 h-11 rounded-2xl border text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all bg-emerald-500/15 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95"
                        title="Send exact current location"
                    >
                        {(sending || quickLocBusy) ? <Loader2 size={16} className="animate-spin" /> : <Crosshair size={16} />}
                        Locate
                    </button>
                ) : null}
            </header>

            <main className="flex-1 p-4 pb-32 space-y-3 relative z-10">
                {error ? (
                    <div className="glass-strong p-4 rounded-2xl border border-rose-500/30 text-rose-300 text-sm font-bold">
                        {error}
                    </div>
                ) : null}

                {isRecipient ? (
                    <div className="glass-strong p-4 rounded-3xl border border-violet-500/20">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-violet-200">Delivery Location</p>
                                <p className="text-xs font-bold text-slate-300 mt-1">
                                    Send your exact location quickly, or adjust pin on map.
                                </p>
                            </div>
                            <MapPin size={16} className="text-violet-300 mt-0.5" />
                        </div>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={doSendCurrentLocation}
                                disabled={sending || quickLocBusy}
                                className={`w-full px-3 py-2.5 rounded-2xl border text-[11px] font-black uppercase tracking-wide flex items-center justify-center gap-2 transition-all ${sending || quickLocBusy
                                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200/60 cursor-not-allowed'
                                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/20'
                                    }`}
                            >
                                {(sending || quickLocBusy) ? <Loader2 size={14} className="animate-spin" /> : <Crosshair size={14} />}
                                Send Exact Location
                            </button>
                            <button
                                type="button"
                                onClick={() => setPinOpen(true)}
                                disabled={sending}
                                className={`w-full px-3 py-2.5 rounded-2xl border text-[11px] font-black uppercase tracking-wide flex items-center justify-center gap-2 transition-all ${sending
                                    ? 'bg-violet-500/10 border-violet-500/20 text-violet-200/60 cursor-not-allowed'
                                    : 'bg-violet-500/15 border-violet-500/30 text-violet-200 hover:bg-violet-500/20'
                                    }`}
                            >
                                <MapPin size={14} />
                                Pin On Map
                            </button>
                        </div>
                    </div>
                ) : null}

                {pinHref ? (
                    <div className="glass-strong p-4 rounded-3xl border border-emerald-500/20">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Current pinned location</div>
                                <div className="text-sm font-black text-white font-mono truncate">
                                    {Number(pinLat).toFixed(6)}, {Number(pinLon).toFixed(6)}
                                </div>
                                {pin?.note ? (
                                    <div className="text-xs font-bold text-slate-300 mt-1 break-words">{String(pin.note)}</div>
                                ) : null}
                                {pin?.updated_at ? (
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-2">
                                        Updated {fmtTime(pin.updated_at)} {fmtDate(pin.updated_at)}
                                    </div>
                                ) : null}
                            </div>
                            <a
                                href={pinHref}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500/20 active:scale-95 transition-all whitespace-nowrap"
                                title="Open in OpenStreetMap"
                            >
                                Open map
                            </a>
                        </div>
                    </div>
                ) : null}

                {loading ? (
                    <div className="glass-strong p-6 rounded-3xl border border-white/10 flex items-center gap-3 text-slate-300">
                        <Loader2 className="animate-spin" size={18} />
                        <span className="text-sm font-bold">Loading...</span>
                    </div>
                ) : null}

                <div className="space-y-1">
                    {feedRows.map((row) => {
                        if (row.kind === 'day') {
                            return (
                                <div key={row.key} className="py-2 flex items-center justify-center">
                                    <span className="px-3 py-1 rounded-full border border-white/15 bg-slate-900/60 text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">
                                        {fmtDayLabel(row.iso)}
                                    </span>
                                </div>
                            );
                        }

                        const m = row.message;
                        const mine = row.mine;
                        const mtype = String(m?.message_type || 'text').toLowerCase();
                        const data = m?.data && typeof m.data === 'object' ? m.data : null;
                        const lat = Number(data?.latitude ?? data?.lat);
                        const lon = Number(data?.longitude ?? data?.lon ?? data?.lng);
                        const href = (mtype === 'location' && isValidCoord(lat) && isValidCoord(lon)) ? osmLink(lat, lon) : null;
                        const tone = senderTone(row.senderKey);
                        const senderId = String(m?.sender_user_id || '').trim().toUpperCase();

                        return (
                            <div
                                key={row.key}
                                className={`flex ${mine ? 'justify-end' : 'justify-start'} ${row.startGroup ? 'mt-2' : 'mt-0.5'}`}
                            >
                                <div className={`max-w-[88%] sm:max-w-[78%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                                    {!mine && row.startGroup ? (
                                        <div className={`mb-1 inline-flex items-center gap-2 px-2 py-1 rounded-full border text-[9px] font-black uppercase tracking-[0.14em] ${tone.chip}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                                            <span className="truncate">{senderPrimaryLabel(m, mine)}</span>
                                            <span className="opacity-80">{senderRoleLabel(m?.sender_role)}</span>
                                            {senderId ? <span className="opacity-80">{senderId}</span> : null}
                                        </div>
                                    ) : null}

                                    <div
                                        className={`border px-4 py-2.5 ${mine
                                            ? 'bg-sky-500/15 border-sky-500/25 text-white'
                                            : 'glass-strong border-white/10 text-slate-100'
                                            } ${row.startGroup ? (mine ? 'rounded-tl-3xl rounded-tr-3xl rounded-bl-3xl rounded-br-lg' : 'rounded-tl-3xl rounded-tr-3xl rounded-br-3xl rounded-bl-lg') : (mine ? 'rounded-l-3xl rounded-r-lg' : 'rounded-r-3xl rounded-l-lg')} ${row.endGroup ? 'mb-1' : ''}`}
                                    >
                                        {mtype === 'location' ? (
                                            <div className="space-y-2">
                                                <div className="text-sm font-black flex items-center gap-2">
                                                    <MapPin size={16} className="text-emerald-300" />
                                                    Pinned location
                                                </div>
                                                {href ? (
                                                    <a
                                                        href={href}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500/20 active:scale-95 transition-all"
                                                    >
                                                        Open map
                                                    </a>
                                                ) : null}
                                                <div className="text-xs font-bold text-slate-200 font-mono">
                                                    {isValidCoord(lat) && isValidCoord(lon) ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : 'Coordinates unavailable'}
                                                </div>
                                                {data?.note ? (
                                                    <div className="text-xs font-bold text-slate-200 break-words">{String(data.note)}</div>
                                                ) : null}
                                            </div>
                                        ) : (
                                            <div className="text-sm font-bold break-words whitespace-pre-wrap">
                                                {String(m?.text || '')}
                                            </div>
                                        )}
                                        <div className={`mt-1.5 text-[10px] font-bold ${mine ? 'text-sky-200' : 'text-slate-400'} text-right`}>
                                            {m?.created_at ? fmtTime(m.created_at) : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    <div ref={bottomRef} />
                </div>
            </main>

            <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-0 right-0 z-[70] px-4">
                <div className="max-w-xl mx-auto">
                    <div className="glass-strong rounded-3xl border-iridescent p-3 shadow-2xl flex items-center gap-2">
                        {isRecipient ? (
                            <>
                                <button
                                    type="button"
                                    onClick={doSendCurrentLocation}
                                    disabled={sending || quickLocBusy}
                                    className={`w-12 h-12 rounded-2xl border flex items-center justify-center transition-all ${sending || quickLocBusy
                                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200/60 cursor-not-allowed'
                                        : 'bg-emerald-500/15 border-emerald-500/25 text-emerald-200 hover:bg-emerald-500/20 active:scale-95'
                                        }`}
                                    title="Send exact location"
                                >
                                    {(sending || quickLocBusy) ? <Loader2 size={18} className="animate-spin" /> : <Crosshair size={18} />}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPinOpen(true)}
                                    disabled={sending}
                                    className={`w-12 h-12 rounded-2xl border flex items-center justify-center transition-all ${sending
                                        ? 'bg-violet-500/10 border-violet-500/20 text-violet-200/60 cursor-not-allowed'
                                        : 'bg-violet-500/15 border-violet-500/25 text-violet-200 hover:bg-violet-500/20 active:scale-95'
                                        }`}
                                    title="Pin location on map"
                                >
                                    <MapPin size={18} />
                                </button>
                            </>
                        ) : null}
                        <input
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="Type a message..."
                            className="flex-1 bg-transparent outline-none text-sm font-bold text-white placeholder:text-slate-600 px-3 py-3"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    doSend();
                                }
                            }}
                        />
                        <button
                            type="button"
                            onClick={doSend}
                            disabled={sending}
                            className={`w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20 active:scale-95 transition-all flex items-center justify-center ${sending ? 'opacity-60 cursor-not-allowed' : ''}`}
                            title="Send"
                        >
                            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                        </button>
                    </div>
                </div>
            </div>

            <LocationPickerModal
                open={pinOpen}
                onClose={() => setPinOpen(false)}
                shipment={shipment || { awb: thread?.awb }}
                onConfirm={doSendPin}
            />
        </motion.div>
    );
}
