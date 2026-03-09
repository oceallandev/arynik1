import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Banknote, CheckCircle2, CheckSquare, ChevronRight, FileText, Loader2, MessageCircle, Package, Printer, RefreshCw, Search, MapPin, Phone, Square, User, List, Map as MapIcon, Navigation, MapPinned } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { allocateShipment, createContactAttempt, createTrackingRequest, ensureChatThread, getNdrReasons, getPaymentLink, getShipment, getShipmentLabelPdf, getShipmentLabelsBatchPdf, getShipments, requestReschedule, updateAwb, updateShipmentInstructions } from '../services/api';
import { geocodeAddress, getCachedGeocode } from '../services/geocodeService';
import { getRoute } from '../services/mapService';
import { buildGeocodeHints, buildGeocodeQuery, isValidCoord } from '../services/shipmentGeo';
import { getWarehouseOrigin } from '../services/warehouse';
import MapComponent from '../components/MapComponent';
import { hasPermission } from '../auth/rbac';
import { PERM_AWB_UPDATE, PERM_CHAT_READ, PERM_LABEL_READ, PERM_SHIPMENTS_ASSIGN } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import useGeolocation from '../hooks/useGeolocation';
import { queueItem } from '../store/queue';
import { createRoute, findRouteForAwb, generateDailyMoldovaCountyRoutes, listRoutesForUser, moveAwbToRoute, resolveRouteDriverIdForUser, routeDisplayName } from '../services/routesStore';

const MAX_MAP_GEOCODE = 200;
const ACTIVE_STATUS_KEYS = new Set(['prep_depot', 'picked_up', 'in_depot', 'out_for_delivery', 'rescheduled', 'refused']);
const TRACKING_EVENT_LABELS = {
    '1': 'Expediere preluata de Curier',
    '2': 'Expeditie Livrata',
    '3': 'Refuzare colet',
    '4': 'Expeditie returnata',
    '5': 'Expeditie anulata',
    '6': 'Intrare in depozit',
    '7': 'Livrare reprogramata',
};

const stripDiacritics = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const normalizeStatusText = (value) => stripDiacritics(String(value || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export default function Shipments() {
    const [shipments, setShipments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [expandedAwb, setExpandedAwb] = useState(null);
    const [viewMode, setViewMode] = useState('list'); // 'list' or 'map'
    const [routeGeometry, setRouteGeometry] = useState(null);
    const [coordsByAwb, setCoordsByAwb] = useState({});
    const coordsByAwbRef = useRef({});
    const contentPrefetchRef = useRef(new Set());
    const [geocoding, setGeocoding] = useState({ active: false, done: 0, total: 0, current: '' });
    const [routePicker, setRoutePicker] = useState({ open: false, awb: null });
    const [routes, setRoutes] = useState([]);
    const [assignMsg, setAssignMsg] = useState('');
    const [detailsBusy, setDetailsBusy] = useState({});
    const [deliverBusy, setDeliverBusy] = useState({});
    const [trackBusy, setTrackBusy] = useState({});
    const [chatBusy, setChatBusy] = useState({});
    const [ndrReasons, setNdrReasons] = useState([]);
    const [contactDraft, setContactDraft] = useState({}); // awb -> { outcome, notes }
    const [contactBusy, setContactBusy] = useState({}); // awb -> boolean
    const [instrDraft, setInstrDraft] = useState({}); // awb -> string
    const [instrBusy, setInstrBusy] = useState({}); // awb -> boolean
    const [reschedDraft, setReschedDraft] = useState({}); // awb -> { desired_at, reason_code, note }
    const [reschedBusy, setReschedBusy] = useState({}); // awb -> boolean
    const [payBusy, setPayBusy] = useState({}); // awb -> boolean
    const [labelBusy, setLabelBusy] = useState({}); // awb -> boolean
    const [batchPrintBusy, setBatchPrintBusy] = useState(false);
    const [selectedAwbs, setSelectedAwbs] = useState({}); // awb -> boolean
    const [statusFilter, setStatusFilter] = useState('active');
    const [dateScope, setDateScope] = useState('all');
    const [deliveryWindow, setDeliveryWindow] = useState({ from: null, to: null, period: '' });
    const navigate = useNavigate();
    const location = useLocation();
    const { user } = useAuth();
    const { lang, t } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);
    const { location: driverLocation } = useGeolocation();
    const canUpdateAwb = hasPermission(user, PERM_AWB_UPDATE);
    const canAllocate = hasPermission(user, PERM_SHIPMENTS_ASSIGN);
    const canReadLabel = hasPermission(user, PERM_LABEL_READ);
    const canChat = hasPermission(user, PERM_CHAT_READ);
    const canRoutes = ['Manager', 'Admin', 'Dispatcher', 'Driver'].includes(user?.role);
    const canRequestTracking = ['Admin', 'Manager', 'Dispatcher', 'Support', 'Recipient'].includes(String(user?.role || '').trim());
    const isRecipient = String(user?.role || '') === 'Recipient';
    const isAdmin = String(user?.role || '').trim() === 'Admin';

    const trackingEventStatusText = (ev) => {
        const candidates = [
            ev?.eventDescription,
            ev?.statusDescription,
            ev?.event_description,
            ev?.status_description,
            ev?.eventName,
            ev?.event_name,
            ev?.label,
            ev?.status,
            ev?.description,
            ev?.courierShipmentStatus?.statusDescription,
            ev?.courierShipmentStatus?.statusName,
            ev?.clientShipmentStatus?.statusDescription,
            ev?.clientShipmentStatus?.statusName,
        ];
        for (const c of candidates) {
            const text = String(c || '').trim();
            if (text) return text;
        }
        const eventId = String(ev?.eventId ?? ev?.event_id ?? '').trim();
        if (eventId && TRACKING_EVENT_LABELS[eventId]) return TRACKING_EVENT_LABELS[eventId];
        return '';
    };

    const trackingEventTimeMs = (ev) => {
        const candidates = [
            ev?.eventDate,
            ev?.event_date,
            ev?.timestamp,
            ev?.date,
            ev?.createdDate,
            ev?.created_at,
            ev?.updated_at,
            ev?.updatedAt,
        ];
        for (const c of candidates) {
            const dt = new Date(c);
            const ms = dt.getTime();
            if (Number.isFinite(ms) && !Number.isNaN(ms)) return ms;
        }
        return null;
    };

    const mergeTrackingHistory = (incomingRaw, previousRaw) => {
        const incoming = Array.isArray(incomingRaw) ? incomingRaw : [];
        const previous = Array.isArray(previousRaw) ? previousRaw : [];
        if (!incoming.length) return previous;
        if (!previous.length) return incoming;

        const merged = [];
        const seen = new Set();
        const pushUnique = (ev) => {
            if (!ev || typeof ev !== 'object') return;
            const label = trackingEventStatusText(ev).toLowerCase();
            const ms = trackingEventTimeMs(ev);
            const eventId = String(ev?.eventId ?? ev?.event_id ?? '').trim();
            const key = `${eventId}|${label}|${ms ?? ''}`;
            if (seen.has(key)) return;
            seen.add(key);
            merged.push(ev);
        };

        incoming.forEach(pushUnique);
        previous.forEach(pushUnique);

        merged.sort((a, b) => {
            const ta = trackingEventTimeMs(a) || 0;
            const tb = trackingEventTimeMs(b) || 0;
            return tb - ta;
        });
        return merged;
    };

    const mergeFetchedShipments = (incomingRaw, previousRaw) => {
        const incoming = Array.isArray(incomingRaw) ? incomingRaw : [];
        const previous = Array.isArray(previousRaw) ? previousRaw : [];
        if (!incoming.length) return incoming;
        if (!previous.length) return incoming;

        const prevByAwb = new Map();
        previous.forEach((s) => {
            const awb = String(s?.awb || '').trim().toUpperCase();
            if (awb) prevByAwb.set(awb, s);
        });

        return incoming.map((s) => {
            const awb = String(s?.awb || '').trim().toUpperCase();
            const prev = awb ? prevByAwb.get(awb) : null;
            if (!prev) return s;
            const mergedHistory = mergeTrackingHistory(s?.tracking_history, prev?.tracking_history);
            if (Array.isArray(mergedHistory) && mergedHistory.length) {
                return { ...s, tracking_history: mergedHistory };
            }
            return s;
        });
    };

    const fetchShipments = async ({ quiet = false } = {}) => {
        const token = user?.token || localStorage.getItem('token');
        if (!token) return;
        if (!quiet) setLoading(true);
        try {
            const data = await getShipments(token);
            setShipments((prev) => mergeFetchedShipments(data, prev));
        } catch (error) {
            console.error('Failed to fetch shipments', error);
        } finally {
            if (!quiet) setLoading(false);
        }
    };

    useEffect(() => {
        fetchShipments();
        const token = user?.token || localStorage.getItem('token');
        if (!token) return undefined;
        const id = setInterval(() => {
            fetchShipments({ quiet: true });
        }, 20000);
        return () => clearInterval(id);
    }, [user?.token]);

    useEffect(() => {
        const params = new URLSearchParams(location.search || '');
        const status = String(params.get('status') || '').trim().toLowerCase();
        const fromRaw = String(params.get('from') || '').trim();
        const toRaw = String(params.get('to') || '').trim();
        const periodRaw = String(params.get('period') || '').trim().toLowerCase();
        const dateScopeRaw = String(params.get('date_scope') || '').trim().toLowerCase();

        const fromDate = fromRaw ? new Date(fromRaw) : null;
        const toDate = toRaw ? new Date(toRaw) : null;
        const from = fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : null;
        const to = toDate && !Number.isNaN(toDate.getTime()) ? toDate : null;
        const scope = ['today', 'week'].includes(dateScopeRaw) ? dateScopeRaw : 'all';

        if (status === 'delivered') {
            setStatusFilter('delivered');
        }
        setDateScope(scope);
        setDeliveryWindow({ from, to, period: periodRaw });
    }, [location.search]);

    useEffect(() => {
        setRoutes(listRoutesForUser(user));
    }, [user?.role, user?.driver_id]);

    useEffect(() => {
        const token = user?.token;
        if (!token) return;
        getNdrReasons(token)
            .then((res) => {
                const list = Array.isArray(res?.reasons) ? res.reasons : [];
                setNdrReasons(list);
            })
            .catch(() => setNdrReasons([]));
    }, [user?.token]);

    const money = (amount, currency = 'RON') => {
        const n = Number(amount);
        if (!Number.isFinite(n)) return '--';
        return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
    };

    const openPdfBlob = (blob, filename = 'document.pdf', { autoPrint = false, targetWindow = null } = {}) => {
        if (!(blob instanceof Blob)) {
            throw new Error('Invalid PDF payload.');
        }
        const url = URL.createObjectURL(blob);
        let win = null;
        if (targetWindow && !targetWindow.closed) {
            try {
                targetWindow.location.href = url;
                win = targetWindow;
            } catch {
                win = null;
            }
        }
        if (!win) {
            // Open without noopener so we can trigger print in the new tab when requested.
            win = window.open(url, '_blank');
        }
        if (!win) {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else if (autoPrint) {
            const tryPrint = () => {
                try {
                    win.focus();
                    win.print();
                } catch { }
            };
            // Best-effort retries because browser PDF viewers can initialize with delay.
            window.setTimeout(tryPrint, 900);
            window.setTimeout(tryPrint, 1800);
            window.setTimeout(tryPrint, 3200);
        }
        // Keep URL alive long enough for tab load, then cleanup.
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    };

    const whatsappDigits = (phone) => {
        const digits = String(phone || '').replace(/\\D/g, '');
        if (!digits) return '';
        if (digits.startsWith('00')) return digits.slice(2);
        if (digits.startsWith('0') && digits.length === 10) return `40${digits.slice(1)}`; // Romania local format
        return digits;
    };

    const openWhatsApp = (phone, message = '') => {
        const digits = whatsappDigits(phone);
        if (!digits) return;
        const url = new URL(`https://wa.me/${encodeURIComponent(digits)}`);
        const msg = String(message || '').trim();
        if (msg) url.searchParams.set('text', msg);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
    };

    const logContact = async (awbRaw, channel, toPhone, outcome, notes) => {
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb || !user?.token) return;

        setContactBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        try {
            await createContactAttempt(user.token, {
                awb,
                channel: String(channel || 'call'),
                to_phone: String(toPhone || '').trim() || undefined,
                outcome: String(outcome || '').trim() || undefined,
                notes: String(notes || '').trim() || undefined,
            });
        } catch (e) {
            // Non-blocking; contact logging is best-effort.
            console.warn('Failed to log contact attempt', e);
        } finally {
            setContactBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const carrierLabel = (shipment) => {
        const raw = shipment?.raw_data || {};
        const candidate = raw?.courier ?? raw?.carrier ?? null;

        const asString = (v) => String(v || '').trim();

        if (typeof candidate === 'string') {
            return asString(candidate);
        }

        const obj = (candidate && typeof candidate === 'object') ? candidate : {};
        const code = asString(
            obj?.courierId
            || obj?.carrierId
            || obj?.carrierCode
            || obj?.code
            || obj?.id
            || raw?.courierId
            || raw?.carrierId
            || raw?.carrierCode
        );
        const name = asString(obj?.courierName || obj?.carrierName || obj?.name || obj?.label || raw?.courierName || raw?.carrierName);

        const parts = [];
        if (code) parts.push(code);
        if (name && name.toLowerCase() !== code.toLowerCase()) parts.push(name);
        return parts.join(' ');
    };

    const servicesLabel = (shipment) => {
        const raw = shipment?.raw_data || {};
        const as = raw?.additionalServices || raw?.additional_services || {};
        const truthy = (v) => v === true || v === 1 || v === '1' || String(v || '').trim().toLowerCase() === 'true';

        const tags = [];
        if (truthy(as?.openPackage)) tags.push('Open');
        if (truthy(as?.priority)) tags.push('Priority');
        if (truthy(as?.insurance)) tags.push('Insured');
        if (truthy(as?.oversized)) tags.push('Oversized');
        if (truthy(as?.morning)) tags.push('Morning');
        if (truthy(as?.saturday)) tags.push('Saturday');

        const options = String(as?.options || '').trim();
        if (options) tags.push(options);

        if (!tags.length) return '';
        return `Srv: ${tags.join(', ')}`;
    };

    const parcelBarcodes = (shipment, { max = 3 } = {}) => {
        const raw = shipment?.raw_data || {};
        const candidates = [
            raw?.parcels,
            raw?.Parcels,
            raw?.packages,
            raw?.Packages,
            raw?.shipmentParcels,
            raw?.shipment_parcels,
        ];

        let list = null;
        for (const c of candidates) {
            if (Array.isArray(c) && c.length) {
                list = c;
                break;
            }
        }
        if (!Array.isArray(list)) return [];

        const out = [];
        for (const it of list) {
            if (out.length >= max) break;
            if (typeof it === 'string') {
                const v = it.trim();
                if (v) out.push(v);
                continue;
            }
            if (!it || typeof it !== 'object') continue;
            const v = String(it?.barCode || it?.barcode || it?.bar_code || it?.code || it?.id || '').trim();
            if (v) out.push(v);
        }
        return out;
    };

    const clientName = (shipment) => {
        const raw = shipment?.raw_data || {};
        const client = raw?.client || raw?.clientData || {};
        const senderLoc = raw?.senderLocation || {};
        const name =
            shipment?.sender_shop_name
            || client?.name
            || client?.clientName
            || senderLoc?.name
            || senderLoc?.shopName
            || '';
        return String(name || '').trim();
    };

    const hasMeaningfulRecipient = (value) => {
        const v = String(value || '').trim();
        if (!v) return false;
        const low = v.toLowerCase();
        return !['unknown', 'necunoscut', 'recipient', 'destinatar', 'customer', 'client'].includes(low);
    };

    const displayRecipientName = (shipment) => {
        const recipient = String(shipment?.recipient_name || '').trim();
        if (hasMeaningfulRecipient(recipient)) return recipient;
        const sender = clientName(shipment);
        if (hasMeaningfulRecipient(sender)) return sender;
        return l('Unknown', 'Necunoscut');
    };

    const shipmentContentLabel = (shipment) => {
        const raw = shipment?.raw_data || {};
        const category = raw?.productCategory;
        const parcels = Array.isArray(raw?.shipmentParcels) ? raw.shipmentParcels : [];

        const parcelDescriptions = [];
        for (const it of parcels) {
            if (!it || typeof it !== 'object') continue;
            const d = String(
                it?.itemDescription1
                || it?.itemDescription2
                || it?.itemName
                || it?.productName
                || it?.parcelContent
                || ''
            ).trim();
            if (!d) continue;
            if (!parcelDescriptions.includes(d)) parcelDescriptions.push(d);
            if (parcelDescriptions.length >= 4) break;
        }
        if (parcelDescriptions.length) return parcelDescriptions.join('; ');

        const value =
            shipment?.content_description
            || raw?.contentDescription
            || raw?.contents
            || raw?.content
            || raw?.packageContent
            || raw?.shipmentContent
            || raw?.goodsDescription
            || raw?.additionalServices?.contentDescription
            || raw?.additionalServices?.contents
            || raw?.additionalServices?.content
            || raw?.productCategory?.name
            || raw?.packingList
            || raw?.packingListNumber
            || raw?.packingListId
            || raw?.packing_list
            || raw?.packing_list_number
            || raw?.packing_list_id
            || raw?.additionalServices?.packingList
            || raw?.additionalServices?.packingListNumber
            || raw?.additionalServices?.packingListId
            || (typeof category === 'string' ? category : '');

        return String(value || '').trim();
    };

    const contentTypeMeta = (shipment, label) => {
        const normalizeForMatch = (v) => String(v || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
        const text = normalizeForMatch(label || shipmentContentLabel(shipment) || '');
        const raw = shipment?.raw_data || {};
        const as = raw?.additionalServices || raw?.additional_services || {};
        const isTruthy = (v) => v === true || v === 1 || v === '1' || String(v || '').trim().toLowerCase() === 'true';
        const hasAny = (keywords) => keywords.some((k) => text.includes(k));
        const hasRe = (pattern) => pattern.test(text);

        if (
            hasAny(['uscator', 'uscator rufe', 'pompa de caldura', 'uscator cu pompa', 'dryer', 'tumble dryer', 'heat pump dryer'])
            || hasRe(/\bheat\s*pump\s*dryer\b/i)
        ) {
            return {
                badge: t('shipments.badge.dryer', 'Dryer'),
                box: 'border-indigo-400/45 bg-indigo-500/20',
                title: 'text-indigo-300',
                text: 'text-indigo-100',
                chip: 'border-indigo-300/40 bg-indigo-500/20 text-indigo-200',
            };
        }

        if (
            hasAny(['aragaz', 'aragaz mixt', 'plita', 'cuptor', 'cooker', 'stove', 'oven', 'hob'])
            || hasRe(/\bcook\s*top\b/i)
        ) {
            return {
                badge: t('shipments.badge.cooker', 'Cooker'),
                box: 'border-orange-400/45 bg-orange-500/20',
                title: 'text-orange-300',
                text: 'text-orange-100',
                chip: 'border-orange-300/40 bg-orange-500/20 text-orange-200',
            };
        }

        if (
            hasAny(['masina de spalat', 'masina spalat', 'spalat rufe', 'washer'])
            || hasRe(/\bwashing\s*machine\b/i)
        ) {
            return {
                badge: t('shipments.badge.washer', 'Washing Machine'),
                box: 'border-blue-400/45 bg-blue-500/20',
                title: 'text-blue-300',
                text: 'text-blue-100',
                chip: 'border-blue-300/40 bg-blue-500/20 text-blue-200',
            };
        }

        if (
            hasAny(['frigider', 'combina frigorifica', 'lada frigorifica', 'refrigerator'])
            || hasRe(/\bfridge\b/i)
        ) {
            return {
                badge: t('shipments.badge.fridge', 'Fridge'),
                box: 'border-cyan-400/45 bg-cyan-500/20',
                title: 'text-cyan-300',
                text: 'text-cyan-100',
                chip: 'border-cyan-300/40 bg-cyan-500/20 text-cyan-200',
            };
        }

        if (
            hasAny(['aer conditionat', 'aer condi', 'climatiz'])
            || hasRe(/\bair\s*condition(ing|er)?\b/i)
            || hasRe(/\bac\s*(unit|split|inverter)\b/i)
        ) {
            return {
                badge: t('shipments.badge.ac', 'AC Unit'),
                box: 'border-teal-400/45 bg-teal-500/20',
                title: 'text-teal-300',
                text: 'text-teal-100',
                chip: 'border-teal-300/40 bg-teal-500/20 text-teal-200',
            };
        }

        if (
            isTruthy(as?.fragile)
            || isTruthy(as?.isFragile)
            || isTruthy(raw?.fragile)
            || isTruthy(raw?.isFragile)
            || hasAny(['fragil', 'sticla', 'sticl', 'glass', 'ceramic', 'porcelain', 'monitor'])
        ) {
            return {
                badge: t('shipments.badge.fragile', 'Fragile'),
                box: 'border-rose-400/40 bg-rose-500/20',
                title: 'text-rose-300',
                text: 'text-rose-100',
                chip: 'border-rose-300/40 bg-rose-500/20 text-rose-200',
            };
        }

        if (hasAny(['telefon', 'phone', 'laptop', 'tablet', 'tv', 'televizor', 'electro', 'electron', 'gadget', 'camera'])) {
            return {
                badge: t('shipments.badge.electronics', 'Electronics'),
                box: 'border-cyan-400/40 bg-cyan-500/20',
                title: 'text-cyan-300',
                text: 'text-cyan-100',
                chip: 'border-cyan-300/40 bg-cyan-500/20 text-cyan-200',
            };
        }

        if (hasAny(['mobila', 'mobilier', 'dulap', 'canapea', 'masa', 'scaun', 'furniture', 'desk', 'chair', 'sofa', 'wardrobe'])) {
            return {
                badge: t('shipments.badge.furniture', 'Furniture'),
                box: 'border-amber-400/40 bg-amber-500/20',
                title: 'text-amber-300',
                text: 'text-amber-100',
                chip: 'border-amber-300/40 bg-amber-500/20 text-amber-200',
            };
        }

        if (hasAny(['document', 'plic', 'envelope', 'contract', 'acte', 'invoice', 'factura'])) {
            return {
                badge: t('shipments.badge.documents', 'Documents'),
                box: 'border-sky-400/40 bg-sky-500/20',
                title: 'text-sky-300',
                text: 'text-sky-100',
                chip: 'border-sky-300/40 bg-sky-500/20 text-sky-200',
            };
        }

        if (hasAny(['haine', 'tricou', 'pantofi', 'adid', 'jacket', 'dress', 'fashion', 'clothing', 'incaltaminte'])) {
            return {
                badge: t('shipments.badge.fashion', 'Fashion'),
                box: 'border-fuchsia-400/40 bg-fuchsia-500/20',
                title: 'text-fuchsia-300',
                text: 'text-fuchsia-100',
                chip: 'border-fuchsia-300/40 bg-fuchsia-500/20 text-fuchsia-200',
            };
        }

        if (hasAny(['aliment', 'food', 'mancare', 'dry', 'frozen', 'snack', 'beverage', 'bauturi'])) {
            return {
                badge: t('shipments.badge.food', 'Food'),
                box: 'border-lime-400/40 bg-lime-500/20',
                title: 'text-lime-300',
                text: 'text-lime-100',
                chip: 'border-lime-300/40 bg-lime-500/20 text-lime-200',
            };
        }

        return {
            badge: t('shipments.badge.general', 'General'),
            box: 'border-violet-400/40 bg-violet-500/20',
            title: 'text-violet-300',
            text: 'text-violet-100',
            chip: 'border-violet-300/40 bg-violet-500/20 text-violet-200',
        };
    };

    const contentLooksGeneric = (shipment, label) => {
        const v = String(label || '').trim();
        if (!v) return true;

        const awb = String(shipment?.awb || '').trim().toUpperCase();
        const up = v.toUpperCase();
        if (awb && (up === awb || up.endsWith(`/${awb}`) || up.endsWith(` ${awb}`) || up.includes(`_${awb}`))) {
            return true;
        }

        const tokens = up.split(/[^A-Z0-9]+/).filter(Boolean);
        const hasNaturalWord = tokens.some((t) => /[A-Z]/.test(t) && !/\d/.test(t) && t.length >= 4);
        return !hasNaturalWord;
    };

    const loadDetails = async (awb, { refresh = true } = {}) => {
        const key = String(awb || '').toUpperCase();
        if (!key) return;

        setDetailsBusy((prev) => ({ ...prev, [key]: true }));
        try {
            const token = user?.token;
            const details = await getShipment(token, key, { refresh });
            setShipments((prev) => (
                (Array.isArray(prev) ? prev : []).map((s) => (
                    String(s?.awb || '').toUpperCase() === key
                        ? { ...s, ...details }
                        : s
                ))
            ));
        } catch (e) {
            console.warn('Failed to load shipment details', e);
            setAssignMsg(l(`Failed to load details for ${key}`, `Nu am putut incarca detaliile pentru ${key}`));
            setTimeout(() => setAssignMsg(''), 2500);
        } finally {
            setDetailsBusy((prev) => ({ ...prev, [key]: false }));
        }
    };

    const markDelivered = async (shipment) => {
        if (!canUpdateAwb) return;
        const awb = String(shipment?.awb || '').toUpperCase();
        if (!awb) return;

        const locality = shipment?.locality || shipment?.raw_data?.recipientLocation?.locality || shipment?.raw_data?.recipientLocation?.localityName || '';
        const payload = locality ? { locality } : {};

        setDeliverBusy((prev) => ({ ...prev, [awb]: true }));
        try {
            const token = user?.token;
            await updateAwb(token, {
                awb,
                event_id: '2',
                timestamp: new Date().toISOString(),
                payload
            });

            setShipments((prev) => (
                (Array.isArray(prev) ? prev : []).map((s) => (
                    String(s?.awb || '').toUpperCase() === awb
                        ? { ...s, status: 'Delivered' }
                        : s
                ))
            ));

            setAssignMsg(l(`Marked ${awb} as Delivered`, `AWB ${awb} marcat ca Livrat`));
            setTimeout(() => setAssignMsg(''), 2500);

            // Pull full details + history in the background for reconciliation.
            loadDetails(awb, { refresh: true });
        } catch (e) {
            try {
                await queueItem(awb, '2', payload);
                setAssignMsg(l(`Queued Delivered for ${awb}`, `Livrarea pentru ${awb} a fost pusa in coada`));
                setTimeout(() => setAssignMsg(''), 2500);
            } catch {
                setAssignMsg(l(`Failed to mark Delivered for ${awb}`, `Nu am putut marca ${awb} ca Livrat`));
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } finally {
            setDeliverBusy((prev) => ({ ...prev, [awb]: false }));
        }
    };

    const requestTrackingForAwb = async (awbRaw) => {
        if (!canRequestTracking) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb || !user?.token) return;

        setTrackBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const res = await createTrackingRequest(user.token, { awb, duration_sec: 1800 });
            const id = res?.id;
            if (id) {
                navigate(`/tracking/${encodeURIComponent(String(id))}`);
            } else {
                setAssignMsg(l('Tracking request created.', 'Cererea de urmarire a fost creata.'));
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Failed to request tracking', 'Nu am putut cere urmarirea');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3000);
        } finally {
            setTrackBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const openChatForAwb = async (awbRaw) => {
        if (!canChat) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb || !user?.token) return;

        setChatBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const t = await ensureChatThread(user.token, { awb });
            if (t?.id) {
                navigate(`/chat/${encodeURIComponent(String(t.id))}`);
            } else {
                setAssignMsg(l('Chat unavailable.', 'Chat indisponibil.'));
                setTimeout(() => setAssignMsg(''), 2500);
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Failed to open chat', 'Nu am putut deschide chatul');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3000);
        } finally {
            setChatBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const saveInstructions = async (awbRaw) => {
        if (!isRecipient || !user?.token) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb) return;
        const instructions = String(instrDraft?.[awb] ?? '').trim();

        setInstrBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            await updateShipmentInstructions(user.token, awb, { instructions });
            setAssignMsg(l('Instructions saved.', 'Instructiunile au fost salvate.'));
            setTimeout(() => setAssignMsg(''), 2500);
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Failed to save instructions', 'Nu am putut salva instructiunile');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3000);
        } finally {
            setInstrBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const submitReschedule = async (awbRaw) => {
        if (!isRecipient || !user?.token) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb) return;
        const draft = reschedDraft?.[awb] || {};

        setReschedBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            await requestReschedule(user.token, awb, {
                desired_at: draft?.desired_at || undefined,
                reason_code: draft?.reason_code || undefined,
                note: draft?.note || undefined
            });
            setAssignMsg(l('Reschedule request sent.', 'Cererea de reprogramare a fost trimisa.'));
            setTimeout(() => setAssignMsg(''), 3000);
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Failed to request reschedule', 'Nu am putut trimite cererea de reprogramare');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3500);
        } finally {
            setReschedBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const openPayment = async (awbRaw) => {
        if (!isRecipient || !user?.token) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb) return;

        setPayBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const res = await getPaymentLink(user.token, awb);
            if (res?.url) {
                window.open(String(res.url), '_blank', 'noopener,noreferrer');
            } else {
                setAssignMsg(l('Payment link unavailable.', 'Linkul de plata nu este disponibil.'));
                setTimeout(() => setAssignMsg(''), 3000);
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Payment link unavailable', 'Linkul de plata nu este disponibil');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 3500);
        } finally {
            setPayBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const previewLabelPdf = async (awbRaw) => {
        if (!canReadLabel || !user?.token) return;
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb) return;

        setLabelBusy((prev) => ({ ...(prev || {}), [awb]: true }));
        setAssignMsg('');
        try {
            const res = await getShipmentLabelPdf(user.token, awb);
            openPdfBlob(res?.blob, res?.filename || `label_${awb}.pdf`);
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || l('Label not found.', 'Eticheta nu a fost gasita.');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 4000);
        } finally {
            setLabelBusy((prev) => ({ ...(prev || {}), [awb]: false }));
        }
    };

    const toggleAwbSelected = (awbRaw) => {
        const awb = String(awbRaw || '').trim().toUpperCase();
        if (!awb) return;
        setSelectedAwbs((prev) => {
            const next = { ...(prev || {}) };
            if (next[awb]) delete next[awb];
            else next[awb] = true;
            return next;
        });
    };

    const clearSelection = () => setSelectedAwbs({});

    const selectVisibleAwbs = () => {
        const items = Array.isArray(paginatedShipments) ? paginatedShipments : [];
        setSelectedAwbs((prev) => {
            const next = { ...(prev || {}) };
            for (const s of items) {
                const awb = String(s?.awb || '').trim().toUpperCase();
                if (awb) next[awb] = true;
            }
            return next;
        });
    };

    const selectFilteredAwbs = () => {
        const items = Array.isArray(filteredByWindow) ? filteredByWindow : [];
        setSelectedAwbs((prev) => {
            const next = { ...(prev || {}) };
            for (const s of items) {
                const awb = String(s?.awb || '').trim().toUpperCase();
                if (awb) next[awb] = true;
            }
            return next;
        });
    };

    const printSelectedLabels = async ({ directPrint = false } = {}) => {
        if (!canReadLabel || !user?.token) return;
        const selected = Object.keys(selectedAwbs || {}).filter((k) => Boolean(selectedAwbs[k]));
        if (!selected.length) {
            setAssignMsg(l('Select at least one AWB.', 'Selecteaza cel putin un AWB.'));
            setTimeout(() => setAssignMsg(''), 3000);
            return;
        }
        if (selected.length > 200) {
            setAssignMsg(l('Maximum 200 AWBs per batch print.', 'Maximum 200 AWB-uri per print batch.'));
            setTimeout(() => setAssignMsg(''), 3500);
            return;
        }

        // Open a tab synchronously only for direct print (Safari popup policy).
        let pendingWindow = null;
        if (directPrint) {
            try {
                pendingWindow = window.open('', '_blank');
                if (pendingWindow && !pendingWindow.closed) {
                    pendingWindow.document.write(
                        `<html><head><title>${l('Preparing labels...', 'Pregatire etichete...')}</title></head><body style="font-family: sans-serif; padding: 16px;">${l('Preparing labels PDF...', 'Pregatim PDF-ul etichetelor...')}</body></html>`
                    );
                    pendingWindow.document.close();
                }
            } catch {
                pendingWindow = null;
            }
        }

        setBatchPrintBusy(true);
        setAssignMsg('');
        try {
            const out = await getShipmentLabelsBatchPdf(user.token, selected);
            openPdfBlob(out?.blob, out?.filename || 'labels_batch.pdf', {
                autoPrint: directPrint,
                targetWindow: pendingWindow,
            });

            const missingN = Number(out?.missing || 0);
            if (missingN > 0) {
                const sample = String(out?.missing_awbs || '').trim();
                const suffix = sample ? ` (${sample}${missingN > 25 ? '…' : ''})` : '';
                setAssignMsg(l(
                    `Batch ready. Found ${out?.found || 0}/${out?.requested || selected.length}. Missing ${missingN}${suffix}`,
                    `Batch pregatit. Gasite ${out?.found || 0}/${out?.requested || selected.length}. Lipsa ${missingN}${suffix}`
                ));
            } else {
                setAssignMsg(l(
                    directPrint
                        ? `Batch ready. ${out?.found || selected.length} labels sent to print.`
                        : `Batch ready. ${out?.found || selected.length} labels opened.`,
                    directPrint
                        ? `Batch pregatit. ${out?.found || selected.length} etichete trimise la printare.`
                        : `Batch pregatit. ${out?.found || selected.length} etichete deschise.`
                ));
            }
            setTimeout(() => setAssignMsg(''), 5000);
        } catch (e) {
            if (pendingWindow && !pendingWindow.closed) {
                try { pendingWindow.close(); } catch { }
            }
            const detail = e?.response?.data?.detail || e?.message || l('Batch print failed.', 'Printul batch a esuat.');
            setAssignMsg(String(detail));
            setTimeout(() => setAssignMsg(''), 5000);
        } finally {
            setBatchPrintBusy(false);
        }
    };

    const printDirectSelectedLabels = async () => {
        await printSelectedLabels({ directPrint: true });
    };

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
        const query = buildGeocodeQuery(shipment);
        const hints = buildGeocodeHints(shipment);
        let lat = Number(shipment?.latitude);
        let lon = Number(shipment?.longitude);

        // Show the map immediately; geocoding happens in the background.
        setViewMode('map');
        setRouteGeometry(null);

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const cached = coordsByAwbRef.current?.[awb];
            if (cached && (!cached.q || cached.q === query) && isValidCoord(cached.lat) && isValidCoord(cached.lon)) {
                lat = Number(cached.lat);
                lon = Number(cached.lon);
            }
        }

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const cached = getCachedGeocode(query, hints);
            if (cached && isValidCoord(cached.lat) && isValidCoord(cached.lon)) {
                lat = Number(cached.lat);
                lon = Number(cached.lon);
                if (awb) {
                    setCoordsByAwb((prev) => ({ ...prev, [awb]: { lat, lon, ts: Date.now(), source: 'cache', q: query } }));
                }
            }
        }

        if (!isValidCoord(lat) || !isValidCoord(lon)) {
            const res = await geocodeAddress(query, hints);
            if (res && isValidCoord(res.lat) && isValidCoord(res.lon)) {
                lat = Number(res.lat);
                lon = Number(res.lon);
                if (awb) {
                    setCoordsByAwb((prev) => ({ ...prev, [awb]: { lat, lon, ts: Date.now(), source: 'geocode', q: query } }));
                }
            }
        }

        const origin = getWarehouseOrigin();
        if (origin && isValidCoord(origin.lat) && isValidCoord(origin.lon) && isValidCoord(lat) && isValidCoord(lon)) {
            const geometry = await getRoute({ lat: origin.lat, lon: origin.lon }, { lat, lon });
            setRouteGeometry(geometry);
        } else {
            setRouteGeometry(null);
        }
    };

    const openRoutePicker = (awb) => {
        if (!canRoutes) return;
        try {
            // Ensure today's county routes exist so the dispatcher can allocate immediately.
            generateDailyMoldovaCountyRoutes({
                date: new Date().toISOString().slice(0, 10),
                shipments: [],
                driver_id: resolveRouteDriverIdForUser(user)
            });
        } catch { }
        setRoutes(listRoutesForUser(user));
        setRoutePicker({ open: true, awb: String(awb || '').toUpperCase() });
    };

    const assignToRoute = async (routeId) => {
        const awb = routePicker.awb;
        if (!awb) return;
        const updated = moveAwbToRoute(routeId, awb, { scopeDate: true });
        if (updated) {
            const r = listRoutesForUser(user).find((x) => x.id === routeId);
            setAssignMsg(l(
                `Assigned ${awb} to ${r?.name || 'route'}${r?.vehicle_plate ? ` (${r.vehicle_plate})` : ''}`,
                `AWB ${awb} alocat la ${r?.name || 'ruta'}${r?.vehicle_plate ? ` (${r.vehicle_plate})` : ''}`
            ));
            setTimeout(() => setAssignMsg(''), 2500);

            if (canAllocate) {
                const targetDriverId = String(r?.driver_id || '').trim();
                if (!targetDriverId) {
                    setAssignMsg(l('Route has no driver assigned; allocation not sent.', 'Ruta nu are sofer alocat; alocarea nu a fost trimisa.'));
                    setTimeout(() => setAssignMsg(''), 3000);
                } else {
                    try {
                        await allocateShipment(user?.token, awb, targetDriverId);
                        setAssignMsg(l(
                            `Allocated ${awb} to ${targetDriverId} and notified recipient.`,
                            `AWB ${awb} alocat la ${targetDriverId}; destinatar notificat.`
                        ));
                        setTimeout(() => setAssignMsg(''), 3000);
                    } catch (e) {
                        console.warn('Allocation API failed', e);
                        const detail = e?.response?.data?.detail;
                        setAssignMsg(detail
                            ? l(`Allocation failed: ${detail}`, `Alocare esuata: ${detail}`)
                            : l('Allocated locally only (API failed).', 'Alocat doar local (API esuat).'));
                        setTimeout(() => setAssignMsg(''), 3000);
                    }
                }
            }
        }
        setRoutePicker({ open: false, awb: null });
    };

    const createAndAssign = () => {
        const awb = routePicker.awb;
        if (!awb) return;
        let plate = '';
        try { plate = localStorage.getItem('arynik_last_vehicle_plate_v1') || ''; } catch { }
        const route = createRoute({
            name: `Route ${new Date().toLocaleDateString()}`,
            driver_id: resolveRouteDriverIdForUser(user),
            driver_name: user?.name || null,
            helper_name: user?.helper_name || null,
            vehicle_plate: String(plate || '').trim().toUpperCase() || null,
            date: new Date().toISOString().slice(0, 10)
        });
        moveAwbToRoute(route.id, awb, { scopeDate: true });
        setRoutePicker({ open: false, awb: null });
        setAssignMsg(l(`Created route and assigned ${awb}`, `Ruta creata si AWB ${awb} alocat`));
        setTimeout(() => setAssignMsg(''), 2500);
        navigate(`/routes/${route.id}`);
    };

    const filtered = shipments.filter((s) => {
        const q = String(search || '').toLowerCase();
        const awb = String(s?.awb || '').toLowerCase();
        const recipient = String(displayRecipientName(s) || '').toLowerCase();
        const client = String(clientName(s) || '').toLowerCase();
        return awb.includes(q) || recipient.includes(q) || client.includes(q);
    });

    const canonicalStatusLabel = (status) => {
        const raw = String(status || '').trim();
        const s = normalizeStatusText(raw);
        if (!s) return 'Finalizare pregatire depozit';

        if (s === 'bc93ary 0746984168' || /^[a-z0-9]{5,}\s+[0-9]{6,}$/.test(s)) return 'Status update from Driver App';
        if (s.includes('status update from driver app')) return 'Status update from Driver App';
        if (s.includes('expedierea a fost preluata de curier')) return 'Expedierea a fost preluata de curier';
        if (s.includes('expediere preluata de curier') || s.includes('incarcat la curier') || s === 'in transit' || s === 'in tranzit' || s === 'in_transit') return 'Expediere preluata de Curier';
        if (s.includes('intrare in depozit') || s.includes('in depozitul curierului') || s.includes('courier warehouse') || s === 'in depot') return 'Intrare in depozit';
        if (s.includes('out for delivery') || s.includes('in livrare')) return 'In livrare';
        if (s.includes('livrare reprogramata') || s.includes('reschedule') || s.includes('reprogramat')) return 'Livrare reprogramata';
        if (s.includes('expeditie livrata')) return 'Expeditie Livrata';
        if (s.includes('ramburs transferat')) return 'Expeditie Livrata';
        if (s === 'livrat' || s.includes('delivered')) return 'Livrat';
        if (s.includes('refuz') || s.includes('livrare refuzata') || s.includes('refused')) return 'Refuzare colet';
        if (s.includes('expeditie returnata') || s.includes('returnata') || s.includes('returned')) return 'Expeditie returnata';
        if (s.includes('expeditie anulata') || s.includes('anulata') || s.includes('cancel')) return 'Expeditie anulata';
        if (s === 'pending' || s === 'initial' || s === 'active' || s.includes('in asteptare')) return 'Finalizare pregatire depozit';
        if (s.includes('finalizare pregatire depozit')) return 'Finalizare pregatire depozit';
        return raw || 'Status update from Driver App';
    };

    const statusGroupKey = (status) => {
        const label = canonicalStatusLabel(status);
        if (label === 'Finalizare pregatire depozit') return 'prep_depot';
        if (label === 'Expediere preluata de Curier' || label === 'Expedierea a fost preluata de curier') return 'picked_up';
        if (label === 'Intrare in depozit') return 'in_depot';
        if (label === 'In livrare') return 'out_for_delivery';
        if (label === 'Livrare reprogramata') return 'rescheduled';
        if (label === 'Expeditie Livrata' || label === 'Livrat') return 'delivered';
        if (label === 'Refuzare colet') return 'refused';
        if (label === 'Expeditie returnata') return 'returned';
        if (label === 'Expeditie anulata') return 'cancelled';
        if (label === 'Status update from Driver App') return 'driver_update';
        return 'other';
    };

    const statusGroupOrder = (group) => {
        const order = {
            prep_depot: 0,
            picked_up: 1,
            in_depot: 2,
            out_for_delivery: 3,
            rescheduled: 4,
            delivered: 5,
            refused: 6,
            returned: 7,
            cancelled: 8,
            driver_update: 9,
            other: 10,
        };
        return order[group] ?? 99;
    };

    const statusGroupLabel = (group) => {
        if (group === 'prep_depot') return 'Finalizare pregatire depozit';
        if (group === 'picked_up') return 'Expediere preluata de Curier';
        if (group === 'in_depot') return 'Intrare in depozit';
        if (group === 'out_for_delivery') return 'In livrare';
        if (group === 'rescheduled') return 'Livrare reprogramata';
        if (group === 'delivered') return 'Expeditie Livrata';
        if (group === 'refused') return 'Refuzare colet';
        if (group === 'returned') return 'Expeditie returnata';
        if (group === 'cancelled') return 'Expeditie anulata';
        if (group === 'driver_update') return 'Status update from Driver App';
        return 'Altele';
    };

    const filteredSorted = useMemo(() => {
        const list = Array.isArray(filtered) ? [...filtered] : [];
        list.sort((a, b) => {
            const ga = statusGroupKey(a?.status);
            const gb = statusGroupKey(b?.status);
            const oa = statusGroupOrder(ga);
            const ob = statusGroupOrder(gb);
            if (oa !== ob) return oa - ob;
            return String(a?.awb || '').localeCompare(String(b?.awb || ''), 'ro', { numeric: true, sensitivity: 'base' });
        });
        return list;
    }, [filtered]);

    const statusCounts = useMemo(() => {
        const counts = {
            all: filteredSorted.length,
            active: 0,
            prep_depot: 0,
            picked_up: 0,
            in_depot: 0,
            out_for_delivery: 0,
            rescheduled: 0,
            delivered: 0,
            refused: 0,
            returned: 0,
            cancelled: 0,
            driver_update: 0,
            other: 0,
        };
        for (const s of filteredSorted) {
            const key = statusGroupKey(s?.status);
            counts[key] = (counts[key] || 0) + 1;
        }
        counts.active = [...ACTIVE_STATUS_KEYS].reduce((acc, key) => acc + Number(counts[key] || 0), 0);
        return counts;
    }, [filteredSorted]);

    const statusFilterOptions = useMemo(() => {
        if (isAdmin) {
            return [
                { key: 'all', label: l('All Statuses', 'Toate statusurile') },
                { key: 'prep_depot', label: statusGroupLabel('prep_depot') },
                { key: 'picked_up', label: statusGroupLabel('picked_up') },
                { key: 'in_depot', label: statusGroupLabel('in_depot') },
                { key: 'out_for_delivery', label: statusGroupLabel('out_for_delivery') },
                { key: 'rescheduled', label: statusGroupLabel('rescheduled') },
                { key: 'delivered', label: statusGroupLabel('delivered') },
                { key: 'refused', label: statusGroupLabel('refused') },
                { key: 'returned', label: statusGroupLabel('returned') },
                { key: 'cancelled', label: statusGroupLabel('cancelled') },
                { key: 'driver_update', label: statusGroupLabel('driver_update') },
                { key: 'other', label: statusGroupLabel('other') },
            ];
        }
        return [
            { key: 'active', label: l('Active', 'Active') },
            { key: 'prep_depot', label: statusGroupLabel('prep_depot') },
            { key: 'picked_up', label: statusGroupLabel('picked_up') },
            { key: 'in_depot', label: statusGroupLabel('in_depot') },
            { key: 'out_for_delivery', label: statusGroupLabel('out_for_delivery') },
            { key: 'rescheduled', label: statusGroupLabel('rescheduled') },
            { key: 'refused', label: statusGroupLabel('refused') },
        ];
    }, [isAdmin, lang]);

    useEffect(() => {
        const allowed = new Set((statusFilterOptions || []).map((opt) => opt.key));
        if (allowed.has(statusFilter)) return;
        setStatusFilter(isAdmin ? 'all' : 'active');
    }, [isAdmin, statusFilter, statusFilterOptions]);

    const filteredByStatus = useMemo(() => {
        if (statusFilter === 'all') return filteredSorted;
        if (statusFilter === 'active') {
            return filteredSorted.filter((s) => ACTIVE_STATUS_KEYS.has(statusGroupKey(s?.status)));
        }
        return filteredSorted.filter((s) => statusGroupKey(s?.status) === statusFilter);
    }, [filteredSorted, statusFilter]);

    const shipmentFilterTimestamp = (shipment) => {
        const raw = shipment?.raw_data || {};
        const candidates = [
            shipment?.awb_status_date,
            shipment?.last_updated,
            shipment?.created_date,
            shipment?.created_at,
            shipment?.createdAt,
            raw?.awbStatusDate,
            raw?.statusDate,
            raw?.lastUpdated,
            raw?.updatedAt,
            raw?.createdDate,
            raw?.createdAt,
        ];
        for (const c of candidates) {
            const dt = new Date(c);
            if (!Number.isNaN(dt.getTime())) return dt;
        }
        return null;
    };

    const quickDateWindow = useMemo(() => {
        if (dateScope === 'today') {
            const from = new Date();
            from.setHours(0, 0, 0, 0);
            const to = new Date(from);
            to.setDate(to.getDate() + 1);
            return { from, to };
        }
        if (dateScope === 'week') {
            const from = new Date();
            from.setHours(0, 0, 0, 0);
            const day = from.getDay(); // Sunday 0 ... Saturday 6
            const daysSinceMonday = (day + 6) % 7;
            from.setDate(from.getDate() - daysSinceMonday);
            const to = new Date(from);
            to.setDate(to.getDate() + 7);
            return { from, to };
        }
        return { from: null, to: null };
    }, [dateScope]);

    const filteredByWindow = useMemo(() => {
        const periodFrom = deliveryWindow?.from instanceof Date ? deliveryWindow.from : null;
        const periodTo = deliveryWindow?.to instanceof Date ? deliveryWindow.to : null;
        const quickFrom = quickDateWindow?.from instanceof Date ? quickDateWindow.from : null;
        const quickTo = quickDateWindow?.to instanceof Date ? quickDateWindow.to : null;
        if (!periodFrom && !periodTo && !quickFrom && !quickTo) return filteredByStatus;

        return (Array.isArray(filteredByStatus) ? filteredByStatus : []).filter((s) => {
            const ts = shipmentFilterTimestamp(s);
            if (!ts) return false;
            if (quickFrom && ts < quickFrom) return false;
            if (quickTo && ts >= quickTo) return false;
            if (periodFrom && ts < periodFrom) return false;
            if (periodTo && ts >= periodTo) return false;
            return true;
        });
    }, [filteredByStatus, deliveryWindow, quickDateWindow]);

    const mapTargets = useMemo(() => filteredByWindow.slice(0, MAX_MAP_GEOCODE), [filteredByWindow]);
    const mapTargetsKey = useMemo(
        () => mapTargets.map((s) => String(s?.awb || '').toUpperCase()).join('|'),
        [mapTargets]
    );

    useEffect(() => {
        if (viewMode !== 'map') return;
        if (!mapTargets || mapTargets.length === 0) return;

        let cancelled = false;

        (async () => {
            const total = mapTargets.length;
            const existing = coordsByAwbRef.current || {};
            const preload = {};
            const queue = [];
            let done = 0;

            // First, apply anything we can without network (shipment coords, in-memory state, localStorage cache).
            for (const s of mapTargets) {
                if (cancelled) return;
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) {
                    done += 1;
                    continue;
                }

                const query = buildGeocodeQuery(s);

                // Already has coordinates?
                if (isValidCoord(s?.latitude) && isValidCoord(s?.longitude)) {
                    preload[awb] = { lat: Number(s.latitude), lon: Number(s.longitude), ts: Date.now(), source: 'shipment', q: query };
                    done += 1;
                    continue;
                }

                // Cached in state (only if address hasn't changed).
                const fromState = existing[awb];
                if (fromState && (!fromState.q || fromState.q === query) && isValidCoord(fromState.lat) && isValidCoord(fromState.lon)) {
                    if (!fromState.q) preload[awb] = { ...fromState, q: query };
                    done += 1;
                    continue;
                }

                // Cached in localStorage (fast, no network).
                const fromCache = getCachedGeocode(query);
                if (fromCache) {
                    if (isValidCoord(fromCache.lat) && isValidCoord(fromCache.lon)) {
                        preload[awb] = {
                            lat: Number(fromCache.lat),
                            lon: Number(fromCache.lon),
                            ts: Number(fromCache.ts || Date.now()),
                            source: 'cache',
                            q: query
                        };
                    }
                    // Negative cache counts as "done" (do not retry unless query changes).
                    done += 1;
                    continue;
                }

                queue.push({ awb, query });
            }

            if (cancelled) return;

            if (Object.keys(preload).length > 0) {
                setCoordsByAwb((prev) => ({ ...prev, ...preload }));
            }

            if (queue.length === 0) {
                setGeocoding({ active: false, done: total, total, current: '' });
                return;
            }

            setGeocoding({ active: true, done, total, current: '' });

            let batch = {};
            let batchCount = 0;
            let lastFlushAt = Date.now();

            const flush = () => {
                if (cancelled) return;
                if (Object.keys(batch).length === 0) return;
                const payload = batch;
                batch = {};
                batchCount = 0;
                lastFlushAt = Date.now();
                setCoordsByAwb((prev) => ({ ...prev, ...payload }));
            };

            for (const item of queue) {
                if (cancelled) return;
                const { awb, query } = item;
                setGeocoding({ active: true, done, total, current: awb });

                const res = await geocodeAddress(query);
                if (res && isValidCoord(res.lat) && isValidCoord(res.lon) && awb) {
                    batch[awb] = { lat: Number(res.lat), lon: Number(res.lon), ts: Date.now(), source: 'geocode', q: query };
                    batchCount += 1;
                }

                done += 1;

                const elapsed = Date.now() - lastFlushAt;
                if (batchCount >= 5 || elapsed > 300) flush();
            }

            flush();
            if (cancelled) return;
            setGeocoding({ active: false, done, total, current: '' });
        })();

        return () => {
            cancelled = true;
        };
    }, [viewMode, mapTargetsKey]);

    const mapShipments = useMemo(() => {
        if (viewMode !== 'map') return filteredByWindow;
        const coords = coordsByAwb || {};
        return filteredByWindow.map((s) => {
            const awb = String(s?.awb || '').toUpperCase();
            const c = coords[awb];
            const query = buildGeocodeQuery(s);
            if (c && (!c.q || c.q === query) && isValidCoord(c.lat) && isValidCoord(c.lon)) {
                return { ...s, latitude: Number(c.lat), longitude: Number(c.lon) };
            }
            return s;
        });
    }, [viewMode, filteredByWindow, coordsByAwb]);

    // Pagination
    const itemsPerPage = 20;
    const [currentPage, setCurrentPage] = useState(1);

    useEffect(() => {
        setCurrentPage(1);
    }, [search, viewMode, statusFilter, dateScope, deliveryWindow?.from, deliveryWindow?.to]);

    const totalPages = Math.ceil(filteredByWindow.length / itemsPerPage);
    // Only paginate in list mode. Map mode handles all markers (might need clustering eventually)
    const paginatedShipments = viewMode === 'list'
        ? filteredByWindow.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
        : filteredByWindow;

    const selectedAwbList = useMemo(
        () => Object.keys(selectedAwbs || {}).filter((k) => Boolean(selectedAwbs[k])),
        [selectedAwbs]
    );

    useEffect(() => {
        // Keep selected AWBs only if still present in the current filtered list.
        const allowed = new Set((filteredByWindow || []).map((s) => String(s?.awb || '').trim().toUpperCase()).filter(Boolean));
        setSelectedAwbs((prev) => {
            const next = {};
            let changed = false;
            for (const key of Object.keys(prev || {})) {
                if (prev[key] && allowed.has(key)) {
                    next[key] = true;
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [filteredByWindow]);

    const pageStatusCounts = useMemo(() => {
        const counts = {};
        for (const s of (Array.isArray(paginatedShipments) ? paginatedShipments : [])) {
            const key = statusGroupKey(s?.status);
            counts[key] = (counts[key] || 0) + 1;
        }
        return counts;
    }, [paginatedShipments]);

    useEffect(() => {
        if (viewMode !== 'list') return;
        if (!user?.token) return;

        let cancelled = false;
        const candidates = (Array.isArray(paginatedShipments) ? paginatedShipments : [])
            .filter((s) => {
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) return false;
                if (contentPrefetchRef.current.has(awb)) return false;
                const label = shipmentContentLabel(s);
                return contentLooksGeneric(s, label);
            })
            .slice(0, 6);

        if (!candidates.length) return;

        (async () => {
            for (const s of candidates) {
                if (cancelled) return;
                const awb = String(s?.awb || '').toUpperCase();
                if (!awb) continue;
                contentPrefetchRef.current.add(awb);
                try {
                    await loadDetails(awb, { refresh: false });
                } catch {
                    // Best-effort enrichment only.
                }
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, currentPage, paginatedShipments, user?.token]);

    const getStatusGradient = (status) => {
        const key = statusGroupKey(status);
        if (key === 'delivered') return 'from-emerald-500 to-emerald-600';
        if (key === 'picked_up' || key === 'in_depot') return 'from-blue-500 to-blue-600';
        if (key === 'out_for_delivery') return 'from-teal-500 to-teal-600';
        if (key === 'refused' || key === 'returned' || key === 'cancelled') return 'from-rose-500 to-rose-600';
        return 'from-amber-500 to-amber-600';
    };

    const getStatusBg = (status) => {
        const key = statusGroupKey(status);
        if (key === 'delivered') return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
        if (key === 'picked_up' || key === 'in_depot') return 'bg-blue-500/20 text-blue-300 border-blue-500/30';
        if (key === 'out_for_delivery') return 'bg-teal-500/20 text-teal-200 border-teal-500/30';
        if (key === 'refused' || key === 'returned' || key === 'cancelled') return 'bg-rose-500/20 text-rose-200 border-rose-500/30';
        return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
    };

    const statusLabel = (status) => {
        const canonical = canonicalStatusLabel(status);
        if (lang === 'ro') return canonical;
        const enMap = {
            'Finalizare pregatire depozit': 'Depot Prep Done',
            'Expediere preluata de Curier': 'Picked Up By Courier',
            'Expedierea a fost preluata de curier': 'Picked Up By Courier',
            'Intrare in depozit': 'In Depot',
            'In livrare': 'Out For Delivery',
            'Livrare reprogramata': 'Rescheduled',
            'Expeditie Livrata': 'Delivered Shipment',
            Livrat: 'Delivered',
            'Refuzare colet': 'Refused',
            'Expeditie returnata': 'Returned',
            'Expeditie anulata': 'Cancelled',
            'Status update from Driver App': 'Driver App Update',
        };
        return enMap[canonical] || canonical;
    };

    const statusFilterStyle = (key, active) => {
        const palette = {
            all: {
                onBtn: 'border-violet-400/40 bg-violet-500/20 text-violet-100',
                onCount: 'bg-violet-400/25 text-violet-100 border border-violet-300/40',
            },
            active: {
                onBtn: 'border-violet-300/40 bg-violet-500/25 text-violet-100',
                onCount: 'bg-violet-300/25 text-violet-100 border border-violet-200/40',
            },
            prep_depot: {
                onBtn: 'border-amber-400/40 bg-amber-500/20 text-amber-100',
                onCount: 'bg-amber-400/25 text-amber-100 border border-amber-300/40',
            },
            picked_up: {
                onBtn: 'border-blue-400/40 bg-blue-500/20 text-blue-100',
                onCount: 'bg-blue-400/25 text-blue-100 border border-blue-300/40',
            },
            in_depot: {
                onBtn: 'border-sky-400/40 bg-sky-500/20 text-sky-100',
                onCount: 'bg-sky-400/25 text-sky-100 border border-sky-300/40',
            },
            out_for_delivery: {
                onBtn: 'border-teal-400/40 bg-teal-500/20 text-teal-100',
                onCount: 'bg-teal-400/25 text-teal-100 border border-teal-300/40',
            },
            rescheduled: {
                onBtn: 'border-yellow-300/40 bg-yellow-500/20 text-yellow-100',
                onCount: 'bg-yellow-400/25 text-yellow-100 border border-yellow-300/40',
            },
            refused: {
                onBtn: 'border-rose-400/40 bg-rose-500/20 text-rose-100',
                onCount: 'bg-rose-400/25 text-rose-100 border border-rose-300/40',
            },
            returned: {
                onBtn: 'border-orange-400/40 bg-orange-500/20 text-orange-100',
                onCount: 'bg-orange-400/25 text-orange-100 border border-orange-300/40',
            },
            cancelled: {
                onBtn: 'border-red-400/40 bg-red-500/20 text-red-100',
                onCount: 'bg-red-400/25 text-red-100 border border-red-300/40',
            },
            delivered: {
                onBtn: 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100',
                onCount: 'bg-emerald-400/25 text-emerald-100 border border-emerald-300/40',
            },
            driver_update: {
                onBtn: 'border-fuchsia-400/40 bg-fuchsia-500/20 text-fuchsia-100',
                onCount: 'bg-fuchsia-400/25 text-fuchsia-100 border border-fuchsia-300/40',
            },
            other: {
                onBtn: 'border-slate-300/35 bg-slate-500/20 text-slate-100',
                onCount: 'bg-slate-400/25 text-slate-100 border border-slate-300/35',
            },
        };
        const p = palette[key] || palette.other;
        if (active) {
            return {
                btn: `${p.onBtn} shadow-sm`,
                count: p.onCount,
            };
        }
        return {
            btn: 'border-white/10 bg-slate-900/40 text-slate-300 hover:border-white/20 hover:bg-white/5',
            count: 'bg-white/10 text-slate-300 border border-white/10',
        };
    };

    const dateScopeOptions = [
        { key: 'all', label: l('All dates', 'Toate datele') },
        { key: 'today', label: l('Today', 'Azi') },
        { key: 'week', label: l('This week', 'Saptamana asta') },
    ];

    const dateScopeStyle = (key, active) => {
        if (!active) {
            return 'border-white/10 bg-slate-900/40 text-slate-300 hover:border-white/20 hover:bg-white/5';
        }
        if (key === 'today') return 'border-cyan-400/40 bg-cyan-500/20 text-cyan-100';
        if (key === 'week') return 'border-indigo-400/40 bg-indigo-500/20 text-indigo-100';
        return 'border-violet-400/40 bg-violet-500/20 text-violet-100';
    };

    const handleDateScopeChange = (scope) => {
        const nextScope = ['today', 'week'].includes(String(scope || '')) ? String(scope) : 'all';
        setDateScope(nextScope);
        const params = new URLSearchParams(location.search || '');
        if (nextScope === 'all') params.delete('date_scope');
        else params.set('date_scope', nextScope);
        const q = params.toString();
        navigate(`/shipments${q ? `?${q}` : ''}`, { replace: true });
    };

    const clearAllDateFilters = () => {
        setDateScope('all');
        setDeliveryWindow({ from: null, to: null, period: '' });
        const params = new URLSearchParams(location.search || '');
        params.delete('from');
        params.delete('to');
        params.delete('period');
        params.delete('date_scope');
        const q = params.toString();
        navigate(`/shipments${q ? `?${q}` : ''}`, { replace: true });
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
                    <h1 className="flex-1 font-black text-xl text-gradient tracking-tight">{t('menu.shipments', 'Shipments')}</h1>

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
                            placeholder={t('home.search_shipments', 'Search AWB, Client...')}
                            className="w-full pl-12 pr-4 py-3.5 glass-strong rounded-2xl outline-none focus:ring-2 focus:ring-violet-500/30 border border-white/10 text-sm font-medium text-white placeholder-slate-500 transition-all"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>

                <div className="px-4 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {statusFilterOptions.map((opt) => {
                            const active = statusFilter === opt.key;
                            const style = statusFilterStyle(opt.key, active);
                            const count = statusCounts?.[opt.key] || 0;
                            return (
                                <button
                                    key={opt.key}
                                    type="button"
                                    onClick={() => setStatusFilter(opt.key)}
                                    title={opt.label}
                                    className={`px-3 py-2 rounded-xl border transition-all flex items-center justify-between gap-2 min-w-[126px] max-w-full sm:min-w-[152px] ${style.btn}`}
                                >
                                    <span className="text-[10px] leading-tight font-black tracking-wide whitespace-normal break-words text-left">
                                        {opt.label}
                                    </span>
                                    <span className={`shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-black tracking-wide ${style.count}`}>
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="px-4 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {dateScopeOptions.map((opt) => {
                            const active = dateScope === opt.key;
                            return (
                                <button
                                    key={opt.key}
                                    type="button"
                                    onClick={() => handleDateScopeChange(opt.key)}
                                    className={`px-3 py-2 rounded-xl border transition-all text-[10px] font-black uppercase tracking-wide ${dateScopeStyle(opt.key, active)}`}
                                >
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {(deliveryWindow?.from || deliveryWindow?.to) ? (
                    <div className="px-4 pb-3">
                        <div className="glass-light rounded-2xl border border-violet-400/25 p-3 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[10px] font-black uppercase tracking-wider text-violet-200">
                                {l('Delivered period filter active', 'Filtru perioada livrare activ')}
                                {deliveryWindow?.period ? ` • ${String(deliveryWindow.period).toUpperCase()}` : ''}
                            </p>
                            <button
                                type="button"
                                onClick={() => {
                                    setDeliveryWindow({ from: null, to: null, period: '' });
                                    const params = new URLSearchParams(location.search || '');
                                    params.delete('from');
                                    params.delete('to');
                                    params.delete('period');
                                    const q = params.toString();
                                    navigate(`/shipments${q ? `?${q}` : ''}`, { replace: true });
                                }}
                                className="px-2.5 py-1.5 rounded-xl border border-violet-300/30 bg-violet-500/20 text-violet-100 text-[10px] font-black uppercase tracking-wide"
                            >
                                {l('Clear period', 'Sterge perioada')}
                            </button>
                        </div>
                    </div>
                ) : null}

                {canReadLabel ? (
                    <div className="px-4 pb-3">
                        <div className="glass-light rounded-2xl border border-white/10 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-300">
                                    {l('Batch Label Printing', 'Print batch etichete')}
                                </p>
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                                    {selectedAwbList.length} {l('selected', 'selectate')}
                                </span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={selectVisibleAwbs}
                                    className="px-2.5 py-2 rounded-xl border border-white/10 bg-slate-900/40 text-slate-200 text-[10px] font-black uppercase tracking-wide"
                                >
                                    {l('Select visible', 'Selecteaza vizibile')}
                                </button>
                                <button
                                    type="button"
                                    onClick={selectFilteredAwbs}
                                    className="px-2.5 py-2 rounded-xl border border-white/10 bg-slate-900/40 text-slate-200 text-[10px] font-black uppercase tracking-wide"
                                >
                                    {l('Select filtered', 'Selecteaza filtrate')}
                                </button>
                                <button
                                    type="button"
                                    onClick={clearSelection}
                                    className="px-2.5 py-2 rounded-xl border border-white/10 bg-slate-900/40 text-slate-300 text-[10px] font-black uppercase tracking-wide"
                                >
                                    {l('Clear', 'Goleste')}
                                </button>
                                <button
                                    type="button"
                                    onClick={printSelectedLabels}
                                    disabled={batchPrintBusy || selectedAwbList.length === 0}
                                    className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-wide inline-flex items-center gap-1.5 ${batchPrintBusy || selectedAwbList.length === 0
                                        ? 'border-emerald-500/10 bg-emerald-500/10 text-emerald-200/50 cursor-not-allowed'
                                        : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200'
                                        }`}
                                >
                                    {batchPrintBusy ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                                    {l('Print selected', 'Printeaza selectate')}
                                </button>
                                <button
                                    type="button"
                                    onClick={printDirectSelectedLabels}
                                    disabled={batchPrintBusy || selectedAwbList.length === 0}
                                    className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-wide inline-flex items-center gap-1.5 ${batchPrintBusy || selectedAwbList.length === 0
                                        ? 'border-violet-500/10 bg-violet-500/10 text-violet-200/50 cursor-not-allowed'
                                        : 'border-violet-500/30 bg-violet-500/15 text-violet-200'
                                        }`}
                                    title={l('Open and trigger print dialog automatically', 'Deschide PDF-ul si porneste automat dialogul de print')}
                                >
                                    {batchPrintBusy ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                                    {l('Direct print', 'Print direct')}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : null}
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
                            <p className="mt-6 font-bold text-xs uppercase tracking-widest text-slate-500">{l('Syncing Data...', 'Sincronizare date...')}</p>
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
                            <p className="font-bold text-slate-300 text-lg">{l('No shipments found', 'Nu am gasit colete')}</p>
                            <p className="text-sm mt-2 text-slate-500">{l('Try adjusting your search', 'Incearca alta cautare')}</p>
                        </motion.div>
                    ) : filteredByStatus.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-center py-20 text-slate-400"
                        >
                            <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                <Package className="text-slate-500" size={36} />
                            </div>
                            <p className="font-bold text-slate-300 text-lg">{l('No AWBs for selected status', 'Nu exista AWB-uri pentru statusul selectat')}</p>
                            <p className="text-sm mt-2 text-slate-500">{l('Choose another status filter', 'Alege alt filtru de status')}</p>
                            {statusFilter !== (isAdmin ? 'all' : 'active') ? (
                                <button
                                    type="button"
                                    onClick={() => setStatusFilter(isAdmin ? 'all' : 'active')}
                                    className="mt-4 px-4 py-2 rounded-xl border border-violet-400/35 bg-violet-500/20 text-violet-100 text-xs font-black uppercase tracking-wider"
                                >
                                    {isAdmin ? l('Show all statuses', 'Arata toate statusurile') : l('Show active statuses', 'Arata statusurile active')}
                                </button>
                            ) : null}
                        </motion.div>
                    ) : filteredByWindow.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-center py-20 text-slate-400"
                        >
                            <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                <Package className="text-slate-500" size={36} />
                            </div>
                            <p className="font-bold text-slate-300 text-lg">{l('No AWBs in selected date filter', 'Nu exista AWB-uri pentru filtrul de data selectat')}</p>
                            <p className="text-sm mt-2 text-slate-500">{l('Change date filter or clear period', 'Schimba filtrul de data sau elimina perioada')}</p>
                            <button
                                type="button"
                                onClick={clearAllDateFilters}
                                className="mt-4 px-4 py-2 rounded-xl border border-violet-400/35 bg-violet-500/20 text-violet-100 text-xs font-black uppercase tracking-wider"
                            >
                                {l('Clear date filters', 'Elimina filtrele de data')}
                            </button>
                        </motion.div>
                    ) : viewMode === 'map' ? (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className="h-[70dvh] min-h-[300px] w-full rounded-3xl overflow-hidden border-iridescent shadow-2xl relative"
                        >
                            <MapComponent shipments={mapShipments} currentLocation={mapLocation} originLocation={getWarehouseOrigin()} routeGeometry={routeGeometry} />
                            {geocoding.active && (
                                <div className="absolute top-4 left-4 glass-strong rounded-2xl border border-white/10 px-4 py-3 text-white text-xs font-bold shadow-lg">
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="animate-spin text-violet-300" size={14} />
                                        <span className="uppercase tracking-widest text-[10px] text-slate-300">{l('Geocoding', 'Geocodare')}</span>
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
                                        {l('Tip: search a city/awb first to reduce requests.', 'Sfat: cauta mai intai un oras/AWB pentru a reduce solicitarile.')}
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    ) : (
                        <div className="space-y-3">
                            {paginatedShipments.map((s, idx) => {
                                const currentStatusGroup = statusGroupKey(s?.status);
                                const prevStatusGroup = idx > 0 ? statusGroupKey(paginatedShipments[idx - 1]?.status) : null;
                                const showGroupHeader = currentStatusGroup !== prevStatusGroup;
                                return (
                                    <React.Fragment key={`${String(s?.awb || idx)}-group`}>
                                        {showGroupHeader ? (
                                            <div className="pt-2">
                                                <div className="glass-light rounded-2xl border border-white/10 px-4 py-2 flex items-center justify-between">
                                                    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-violet-300">
                                                        {statusGroupLabel(currentStatusGroup)}
                                                    </p>
                                                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                                                        {pageStatusCounts[currentStatusGroup] || 0} {l('AWBs', 'AWB-uri')}
                                                    </span>
                                                </div>
                                            </div>
                                        ) : null}
                                        <motion.div
                                    key={s.awb || idx} // Use AWB as key for better performance
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className={`glass-strong rounded-3xl overflow-hidden transition-all duration-300 border border-white/10 ${expandedAwb === String(s?.awb || '').toUpperCase() ? 'ring-2 ring-violet-500/30 shadow-glow-sm' : ''}`}
                                >
                                    <div
                                        onClick={() => {
                                            const awbKey = String(s?.awb || '').toUpperCase();
                                            const next = expandedAwb === awbKey ? null : awbKey;
                                            setExpandedAwb(next);
                                            if (next !== null) {
                                                // Fetch cached details (no Postis refresh) so fields populate when available.
                                                loadDetails(s.awb, { refresh: false });
                                            }
                                        }}
                                        className="p-5 flex items-center gap-4 cursor-pointer relative"
                                    >
                                        {canReadLabel ? (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleAwbSelected(s.awb);
                                                }}
                                                className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-all ${selectedAwbs[String(s?.awb || '').toUpperCase()]
                                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                                    : 'bg-slate-900/40 border-white/10 text-slate-500'
                                                    }`}
                                                title={l('Select for batch print', 'Selecteaza pentru print batch')}
                                            >
                                                {selectedAwbs[String(s?.awb || '').toUpperCase()] ? <CheckSquare size={15} /> : <Square size={15} />}
                                            </button>
                                        ) : null}
                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm bg-gradient-to-br ${getStatusGradient(s.status)}`}>
                                            <Package size={24} strokeWidth={2} className="text-white" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-center mb-1.5">
                                                <h3 className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-500">{s.awb}</h3>
                                                <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
                                                    {(() => {
                                                        const label = shipmentContentLabel(s);
                                                        if (!label) return null;
                                                        const meta = contentTypeMeta(s, label);
                                                        return (
                                                            <span className={`shrink-0 text-[12px] font-black uppercase px-4 py-2.5 rounded-2xl tracking-wide border shadow-sm ${meta.chip}`}>
                                                                {meta.badge}
                                                            </span>
                                                        );
                                                    })()}
                                                    {(() => {
                                                        const r = findRouteForAwb(s.awb, user);
                                                        if (!r) return null;
                                                        return (
                                                            <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border bg-emerald-500/15 text-emerald-300 border-emerald-500/20">
                                                                {routeDisplayName(r)}
                                                            </span>
                                                        );
                                                    })()}
                                                    <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full tracking-wide border ${getStatusBg(s.status)}`}>
                                                        <span
                                                            className="inline-block max-w-[40vw] sm:max-w-[13rem] truncate align-bottom"
                                                            title={statusLabel(s.status)}
                                                        >
                                                            {statusLabel(s.status)}
                                                        </span>
                                                    </span>
                                                </div>
                                            </div>

                                            <p className="text-sm font-bold text-white truncate leading-tight mb-2">{displayRecipientName(s)}</p>

                                            <div className="flex items-center gap-1.5 text-slate-400">
                                                <MapPin size={11} strokeWidth={2.5} />
                                                <p className="text-[10px] font-medium truncate">{s.delivery_address || s.locality || l('No Address', 'Fara adresa')}</p>
                                            </div>

                                            {(() => {
                                                const cod = Number(s?.cod_amount);
                                                const hasCod = Number.isFinite(cod) && cod > 0;
                                                return (
                                                    <div className={`mt-2 rounded-2xl border px-3 py-2.5 ${hasCod
                                                        ? 'bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-amber-400/35 shadow-[0_0_18px_rgba(245,158,11,0.2)]'
                                                        : 'bg-slate-900/30 border-white/10'
                                                        }`}>
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="flex items-center gap-1.5 min-w-0">
                                                                <Banknote size={13} className={hasCod ? 'text-amber-200' : 'text-slate-500'} />
                                                                <p className={`text-[9px] font-black uppercase tracking-[0.15em] truncate ${hasCod ? 'text-amber-100' : 'text-slate-500'}`}>
                                                                    {l('Collect from client', 'De incasat client')}
                                                                </p>
                                                            </div>
                                                            <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-full border tracking-wide ${hasCod
                                                                ? 'bg-amber-500/20 border-amber-400/40 text-amber-100'
                                                                : 'bg-slate-800/40 border-white/10 text-slate-400'
                                                                }`}>
                                                                {hasCod ? l('COD', 'Ramburs') : l('No COD', 'Fara ramburs')}
                                                            </span>
                                                        </div>
                                                        <p className={`mt-1.5 text-base font-black ${hasCod ? 'text-amber-100' : 'text-slate-300'}`}>
                                                            {hasCod
                                                                ? money(cod, s.currency || s?.raw_data?.currency || 'RON')
                                                                : l('0.00 RON', '0.00 RON')}
                                                        </p>
                                                    </div>
                                                );
                                            })()}

                                            {(() => {
                                                const label = shipmentContentLabel(s);
                                                if (!label) return null;
                                                const meta = contentTypeMeta(s, label);
                                                return (
                                                    <div className={`mt-2 rounded-xl border px-2.5 py-1.5 ${meta.box}`}>
                                                        <div className="flex items-center justify-between gap-2">
                                                            <p className={`text-[9px] font-black uppercase tracking-[0.16em] ${meta.title}`}>{t('shipments.content', 'Content')}</p>
                                                            <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-md border tracking-[0.12em] ${meta.chip}`}>
                                                                {meta.badge}
                                                            </span>
                                                        </div>
                                                        <p
                                                            className={`text-[12px] font-black leading-tight ${meta.text}`}
                                                            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                                                        >
                                                            {label}
                                                        </p>
                                                    </div>
                                                );
                                            })()}
                                        </div>

                                        <ChevronRight className={`text-slate-500 transition-transform duration-300 ${expandedAwb === String(s?.awb || '').toUpperCase() ? 'rotate-90 text-violet-400' : ''}`} size={20} />
                                    </div>

                                        <AnimatePresence>
                                            {expandedAwb === String(s?.awb || '').toUpperCase() && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.3, ease: 'easeInOut' }}
                                            >
                                                <div className="p-5 space-y-4 bg-black/20 border-t border-white/5">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <div className="flex items-center gap-3">
                                                                <div className="p-2 bg-violet-500/20 rounded-xl">
                                                                    <Phone size={16} className="text-violet-400" />
                                                                </div>
                                                                <div className="flex-1 min-w-0">
                                                                    <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">{l('Contact', 'Contact')}</p>
                                                                    <p className="text-xs font-bold text-white truncate">{s.recipient_phone || '--'}</p>
                                                                </div>
                                                            </div>

                                                            {s.recipient_phone ? (
                                                                <div className="mt-3 grid grid-cols-2 gap-2">
                                                                    <a
                                                                        href={`tel:${String(s.recipient_phone)}`}
                                                                        onClick={() => logContact(s.awb, 'call', s.recipient_phone, 'initiated')}
                                                                        className="min-w-0 px-2 py-2 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest active:scale-[0.99] transition-all inline-flex items-center justify-center gap-1.5"
                                                                    >
                                                                        <Phone size={12} className="shrink-0" />
                                                                        <span className="truncate">{l('Call', 'Apeleaza')}</span>
                                                                    </a>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => { openWhatsApp(s.recipient_phone, `AWB ${String(s.awb || '').toUpperCase()}`); logContact(s.awb, 'whatsapp', s.recipient_phone, 'initiated'); }}
                                                                        className="min-w-0 px-2 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest active:scale-[0.99] transition-all inline-flex items-center justify-center gap-1.5"
                                                                    >
                                                                        <MessageCircle size={12} className="shrink-0" />
                                                                        <span className="truncate">WhatsApp</span>
                                                                    </button>
                                                                </div>
                                                            ) : null}

                                                            <div className="mt-3 space-y-2">
                                                                <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wide">{l('Log outcome', 'Rezultat contact')}</div>
                                                                <select
                                                                    value={contactDraft?.[String(s.awb || '').toUpperCase()]?.outcome || ''}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const next = { ...(contactDraft?.[key] || {}), outcome: e.target.value };
                                                                        setContactDraft((prev) => ({ ...(prev || {}), [key]: next }));
                                                                    }}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold"
                                                                >
                                                                    <option value="">{l('Select...', 'Selecteaza...')}</option>
                                                                    <option value="answered">{l('Answered', 'Raspuns')}</option>
                                                                    <option value="no_answer">{l('No answer', 'Nu raspunde')}</option>
                                                                    <option value="wrong_number">{l('Wrong number', 'Numar gresit')}</option>
                                                                    <option value="rescheduled">{l('Rescheduled', 'Reprogramat')}</option>
                                                                    <option value="other">{l('Other', 'Altul')}</option>
                                                                </select>
                                                                <input
                                                                    value={contactDraft?.[String(s.awb || '').toUpperCase()]?.notes || ''}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const next = { ...(contactDraft?.[key] || {}), notes: e.target.value };
                                                                        setContactDraft((prev) => ({ ...(prev || {}), [key]: next }));
                                                                    }}
                                                                    placeholder={l('Notes (optional)', 'Note (optional)')}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold placeholder:text-slate-600"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const draft = contactDraft?.[key] || {};
                                                                        logContact(s.awb, 'call', s.recipient_phone, draft?.outcome || 'other', draft?.notes || '');
                                                                    }}
                                                                    disabled={Boolean(contactBusy?.[String(s.awb || '').toUpperCase()])}
                                                                    className={`w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all ${Boolean(contactBusy?.[String(s.awb || '').toUpperCase()]) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                                >
                                                                    {Boolean(contactBusy?.[String(s.awb || '').toUpperCase()]) ? l('Saving...', 'Se salveaza...') : l('Save outcome', 'Salveaza rezultatul')}
                                                                </button>
                                                            </div>
                                                        </div>

                                                        <div className="glass-light p-4 rounded-2xl flex items-center gap-3 border border-white/10">
                                                            <div className="p-2 bg-emerald-500/20 rounded-xl">
                                                                <User size={16} className="text-emerald-400" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-0.5">{l('Recipient', 'Destinatar')}</p>
                                                                <p className="text-xs font-bold text-white truncate">{displayRecipientName(s)}</p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">{l('Packages', 'Colete')}</p>
                                                            <p className="text-sm font-black text-white">
                                                                {Number.isFinite(Number(s.number_of_parcels)) ? Number(s.number_of_parcels) : (s?.raw_data?.numberOfDistinctBarcodes || s?.raw_data?.numberOfParcels || 1)}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">{l('Courier Price', 'Cost curier')}</p>
                                                            <p className="text-base font-black text-emerald-300">
                                                                {money(
                                                                    s.payment_amount ?? s.shipping_cost ?? s.estimated_shipping_cost,
                                                                    s.currency || s?.raw_data?.currency || 'RON'
                                                                )}
                                                            </p>
                                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                                {Number.isFinite(Number(s.shipping_cost)) && (
                                                                    <span className="px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-black text-emerald-200">
                                                                        {l('Final', 'Final')}: {money(s.shipping_cost, s.currency || 'RON')}
                                                                    </span>
                                                                )}
                                                                {(() => {
                                                                    if (!Number.isFinite(Number(s.estimated_shipping_cost))) return null;
                                                                    const same = Number(s.shipping_cost) === Number(s.estimated_shipping_cost);
                                                                    if (same) return null;
                                                                    return (
                                                                        <span className="px-2 py-1 rounded-lg border border-slate-400/30 bg-slate-500/10 text-[10px] font-black text-slate-200">
                                                                            {l('Estimated', 'Estimat')}: {money(s.estimated_shipping_cost, s.currency || 'RON')}
                                                                        </span>
                                                                    );
                                                                })()}
                                                                {!Number.isFinite(Number(s.shipping_cost)) && !Number.isFinite(Number(s.estimated_shipping_cost)) && (
                                                                    <span className="px-2 py-1 rounded-lg border border-slate-500/30 bg-slate-700/20 text-[10px] font-black text-slate-300">
                                                                        {l('Not loaded', 'Neloadat')}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="p-4 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 to-orange-500/15 shadow-[0_0_18px_rgba(245,158,11,0.18)]">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <p className="text-[9px] uppercase font-black text-amber-100 tracking-wide mb-1">
                                                                    {l('COD to collect from client', 'Ramburs de incasat client')}
                                                                </p>
                                                                <Banknote size={14} className="text-amber-200" />
                                                            </div>
                                                            <p className="text-lg font-black text-amber-50">
                                                                {money(s.cod_amount, s.currency || s?.raw_data?.currency || 'RON')}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-1">Declared</p>
                                                            <p className="text-sm font-black text-white">
                                                                {money(s.declared_value, s.currency || 'RON')}
                                                            </p>
                                                        </div>
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10 sm:col-span-2">
                                                            {(() => {
                                                                const label = shipmentContentLabel(s);
                                                                const meta = contentTypeMeta(s, label);
                                                                return (
                                                                    <>
                                                                        <div className="flex items-center justify-between gap-2 mb-1">
                                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide">{t('shipments.content', 'Content')}</p>
                                                                            <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-md border tracking-[0.12em] ${meta.chip}`}>
                                                                                {meta.badge}
                                                                            </span>
                                                                        </div>
                                                                        <p className="text-xs font-bold text-white whitespace-normal break-words">
                                                                            {label || '--'}
                                                                        </p>
                                                                    </>
                                                                );
                                                            })()}
                                                            <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                {s.dimensions ? `${l('Dims', 'Dim')}: ${s.dimensions}` : ''}{s.weight ? ` • ${l('W', 'G')}: ${Number(s.weight).toFixed(2)} kg` : ''}{s.volumetric_weight ? ` • ${l('Vol', 'Vol')}: ${Number(s.volumetric_weight).toFixed(2)} kg` : ''}
                                                            </p>
                                                            {(() => {
                                                                const bcs = parcelBarcodes(s, { max: 2 });
                                                                if (!bcs.length) return null;
                                                                return (
                                                                    <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                        {`${l('Barcode', 'Cod bare')}: ${bcs.join(' • ')}`}
                                                                    </p>
                                                                );
                                                            })()}
                                                            {s.delivery_instructions ? (
                                                                <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                    {`${l('Instr', 'Instr')}: ${String(s.delivery_instructions)}`}
                                                                </p>
                                                            ) : null}
                                                            {(s.processing_status || s.send_type) ? (
                                                                <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                    {s.processing_status ? `${l('Proc', 'Procesare')}: ${s.processing_status}` : ''}{s.send_type ? `${s.processing_status ? ' • ' : ''}${l('Type', 'Tip')}: ${s.send_type}` : ''}
                                                                </p>
                                                            ) : null}
                                                            <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                {s.shipment_reference ? `${l('Ref', 'Ref')}: ${s.shipment_reference}` : ''}{s.client_order_id ? ` • ${l('Order', 'Comanda')}: ${s.client_order_id}` : ''}
                                                            </p>
                                                            <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                {clientName(s) ? `${l('Client', 'Client')}: ${clientName(s)}` : ''}
                                                                {s.source_channel ? `${clientName(s) ? ' • ' : ''}${l('Channel', 'Canal')}: ${s.source_channel}` : ''}
                                                            </p>
                                                            {(carrierLabel(s) || servicesLabel(s)) ? (
                                                                <p className="text-[10px] text-slate-600 font-bold mt-1 truncate">
                                                                    {carrierLabel(s) ? `${l('Carrier', 'Curier')}: ${carrierLabel(s)}` : ''}
                                                                    {servicesLabel(s) ? `${carrierLabel(s) ? ' • ' : ''}${servicesLabel(s)}` : ''}
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                    </div>

                                                    {Array.isArray(s.tracking_history) && s.tracking_history.length > 0 && (
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide mb-2">{l('History', 'Istoric')}</p>
                                                            <div className="space-y-2">
                                                                {s.tracking_history.map((ev, i) => {
                                                                    const label = trackingEventStatusText(ev) || l('Update', 'Actualizare');
                                                                    const tsMs = trackingEventTimeMs(ev);
                                                                    return (
                                                                    <div key={i} className="flex items-start justify-between gap-3">
                                                                        <p className="text-[11px] font-bold text-slate-200 truncate">
                                                                            {label}
                                                                        </p>
                                                                        <p className="text-[10px] font-bold text-slate-500 whitespace-nowrap">
                                                                            {Number.isFinite(tsMs) && !Number.isNaN(tsMs) ? new Date(tsMs).toLocaleString() : '--'}
                                                                        </p>
                                                                    </div>
                                                                );
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {isRecipient ? (
                                                        <div className="glass-light p-4 rounded-2xl border border-white/10 space-y-3">
                                                            <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide">{l('Recipient actions', 'Actiuni destinatar')}</p>

                                                            <div className="space-y-2">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide">{l('Delivery instructions', 'Instructiuni livrare')}</p>
                                                                <textarea
                                                                    rows={2}
                                                                    value={(instrDraft?.[String(s.awb || '').toUpperCase()] !== undefined)
                                                                        ? instrDraft[String(s.awb || '').toUpperCase()]
                                                                        : String(s.delivery_instructions || '')}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        setInstrDraft((prev) => ({ ...(prev || {}), [key]: e.target.value }));
                                                                    }}
                                                                    placeholder={l('Gate code, entrance, landmark...', 'Cod poarta, scara, reper...')}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold placeholder:text-slate-600 outline-none"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => saveInstructions(s.awb)}
                                                                    disabled={Boolean(instrBusy?.[String(s.awb || '').toUpperCase()])}
                                                                    className={`w-full px-3 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all ${Boolean(instrBusy?.[String(s.awb || '').toUpperCase()]) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                                >
                                                                    {Boolean(instrBusy?.[String(s.awb || '').toUpperCase()]) ? l('Saving...', 'Se salveaza...') : l('Save instructions', 'Salveaza instructiunile')}
                                                                </button>
                                                            </div>

                                                            <div className="space-y-2">
                                                                <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wide">{l('Reschedule request', 'Cerere reprogramare')}</p>
                                                                <input
                                                                    type="datetime-local"
                                                                    value={reschedDraft?.[String(s.awb || '').toUpperCase()]?.desired_at || ''}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const next = { ...(reschedDraft?.[key] || {}), desired_at: e.target.value };
                                                                        setReschedDraft((prev) => ({ ...(prev || {}), [key]: next }));
                                                                    }}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold outline-none"
                                                                />
                                                                <select
                                                                    value={reschedDraft?.[String(s.awb || '').toUpperCase()]?.reason_code || ''}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const next = { ...(reschedDraft?.[key] || {}), reason_code: e.target.value };
                                                                        setReschedDraft((prev) => ({ ...(prev || {}), [key]: next }));
                                                                    }}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold outline-none"
                                                                >
                                                                    <option value="">{l('Select reason...', 'Selecteaza motiv...')}</option>
                                                                    {(Array.isArray(ndrReasons) ? ndrReasons : []).map((r) => (
                                                                        <option key={r.code} value={r.code}>{r.label}</option>
                                                                    ))}
                                                                </select>
                                                                <input
                                                                    value={reschedDraft?.[String(s.awb || '').toUpperCase()]?.note || ''}
                                                                    onChange={(e) => {
                                                                        const key = String(s.awb || '').toUpperCase();
                                                                        const next = { ...(reschedDraft?.[key] || {}), note: e.target.value };
                                                                        setReschedDraft((prev) => ({ ...(prev || {}), [key]: next }));
                                                                    }}
                                                                    placeholder={l('Note (optional)', 'Nota (optional)')}
                                                                    className="w-full px-3 py-2 rounded-xl bg-slate-900/40 border border-white/10 text-white text-xs font-bold placeholder:text-slate-600 outline-none"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => submitReschedule(s.awb)}
                                                                    disabled={Boolean(reschedBusy?.[String(s.awb || '').toUpperCase()])}
                                                                    className={`w-full px-3 py-2 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all ${Boolean(reschedBusy?.[String(s.awb || '').toUpperCase()]) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                                >
                                                                    {Boolean(reschedBusy?.[String(s.awb || '').toUpperCase()]) ? l('Sending...', 'Se trimite...') : l('Send reschedule request', 'Trimite cererea de reprogramare')}
                                                                </button>
                                                            </div>

                                                            {Number(s.cod_amount) > 0 ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openPayment(s.awb)}
                                                                    disabled={Boolean(payBusy?.[String(s.awb || '').toUpperCase()])}
                                                                    className={`w-full px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/20 text-amber-200 text-[10px] font-black uppercase tracking-wide sm:tracking-widest leading-tight whitespace-normal break-words active:scale-[0.99] transition-all ${Boolean(payBusy?.[String(s.awb || '').toUpperCase()]) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                                >
                                                                    {Boolean(payBusy?.[String(s.awb || '').toUpperCase()]) ? l('Opening...', 'Se deschide...') : l('Pay COD online', 'Plateste COD online')}
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                    ) : null}

                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                        <button
                                                            onClick={() => loadDetails(s.awb, { refresh: true })}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words ${detailsBusy[String(s?.awb || '').toUpperCase()] ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            disabled={detailsBusy[String(s?.awb || '').toUpperCase()]}
                                                            title={l('Fetch full details + history from Postis', 'Preia detalii complete + istoric din Postis')}
                                                        >
                                                            <RefreshCw size={16} className={detailsBusy[String(s?.awb || '').toUpperCase()] ? 'animate-spin' : ''} />
                                                            {l('Details', 'Detalii')}
                                                        </button>
                                                        {canUpdateAwb ? (
                                                            <button
                                                                onClick={() => markDelivered(s)}
                                                                className={`w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words ${deliverBusy[String(s?.awb || '').toUpperCase()] ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                                disabled={deliverBusy[String(s?.awb || '').toUpperCase()] || String(s?.status || '').toLowerCase() === 'delivered'}
                                                                title={l('Mark as Delivered', 'Marcheaza ca Livrat')}
                                                            >
                                                                <CheckCircle2 size={16} />
                                                                {l('Delivered', 'Livrat')}
                                                            </button>
                                                        ) : (
                                                            <div className="w-full glass-light rounded-xl border border-white/10 flex items-center justify-center text-[10px] font-black uppercase tracking-wide sm:tracking-widest text-slate-500 px-2 py-3 text-center">
                                                                {l('Read-only', 'Doar citire')}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {canReadLabel ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => previewLabelPdf(s.awb)}
                                                            disabled={Boolean(labelBusy[String(s?.awb || '').toUpperCase()])}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-emerald-700 to-emerald-800 hover:from-emerald-600 hover:to-emerald-700 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words ${Boolean(labelBusy[String(s?.awb || '').toUpperCase()]) ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            title={l('View/print shipment label PDF', 'Vezi/printeaza eticheta PDF')}
                                                        >
                                                            {Boolean(labelBusy[String(s?.awb || '').toUpperCase()])
                                                                ? <Loader2 size={16} className="animate-spin" />
                                                                : <FileText size={16} />
                                                            }
                                                            {l('Label PDF', 'Eticheta PDF')}
                                                        </button>
                                                    ) : null}

                                                    <button
                                                        onClick={() => handleViewOnMap(s)}
                                                        className="w-full btn-premium py-3 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words"
                                                    >
                                                        <Navigation size={16} />
                                                        {l('View on Map', 'Vezi pe harta')}
                                                    </button>

                                                    {canRequestTracking && String(s?.driver_id || '').trim() ? (
                                                        <button
                                                            onClick={() => requestTrackingForAwb(s.awb)}
                                                            disabled={Boolean(trackBusy[String(s?.awb || '').toUpperCase()])}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-sky-600 to-indigo-700 hover:from-sky-500 hover:to-indigo-600 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words ${Boolean(trackBusy[String(s?.awb || '').toUpperCase()]) ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            title={l('Request driver live location', 'Solicita locatia live a soferului')}
                                                        >
                                                            {Boolean(trackBusy[String(s?.awb || '').toUpperCase()])
                                                                ? <Loader2 size={16} className="animate-spin" />
                                                                : <MapPin size={16} />
                                                            }
                                                            {l('Track Driver', 'Urmareste soferul')}
                                                        </button>
                                                    ) : null}

                                                    {canChat ? (
                                                        <button
                                                            onClick={() => openChatForAwb(s.awb)}
                                                            disabled={Boolean(chatBusy[String(s?.awb || '').toUpperCase()])}
                                                            className={`w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words ${Boolean(chatBusy[String(s?.awb || '').toUpperCase()]) ? 'opacity-70 cursor-not-allowed' : ''}`}
                                                            title={l('Open chat', 'Deschide chat')}
                                                        >
                                                            {Boolean(chatBusy[String(s?.awb || '').toUpperCase()])
                                                                ? <Loader2 size={16} className="animate-spin" />
                                                                : <MessageCircle size={16} />
                                                            }
                                                            {l('Chat', 'Chat')}
                                                        </button>
                                                    ) : null}

                                                    {canRoutes ? (
                                                        <button
                                                            onClick={() => openRoutePicker(s.awb)}
                                                            className="w-full btn-premium py-3 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 text-sm leading-tight whitespace-normal break-words"
                                                        >
                                                            <MapPinned size={16} />
                                                            {canAllocate ? l('Allocate to Truck', 'Aloca la camion') : l('Assign to Route', 'Aloca la ruta')}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                        </motion.div>
                                    </React.Fragment>
                                );
                            })}

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
                                        {l('Page', 'Pagina')} {currentPage} {l('of', 'din')} {totalPages}
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
                                    <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Assign AWB', 'Alocare AWB')}</p>
                                    <p className="text-sm font-bold text-white font-mono mt-1">{routePicker.awb}</p>
                                </div>
                                <button
                                    onClick={createAndAssign}
                                    className="px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-300 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                                >
                                    {l('Create Route', 'Creeaza ruta')}
                                </button>
                            </div>

                            <div className="space-y-2 max-h-[45vh] overflow-y-auto">
                                {routes.length === 0 ? (
                                    <p className="text-xs text-slate-500">{l('No routes yet. Tap "Create Route".', 'Nu exista rute inca. Apasa "Creeaza ruta".')}</p>
                                ) : (
                                    routes.map((r) => (
                                        <button
                                            key={r.id}
                                            onClick={() => assignToRoute(r.id)}
                                            className="w-full p-4 rounded-2xl border border-white/10 hover:border-emerald-500/30 transition-all text-left glass-light flex items-center justify-between gap-3"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{routeDisplayName(r)}</p>
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                    {r.date} • {Array.isArray(r.awbs) ? r.awbs.length : 0} {l('stops', 'opriri')}{r.vehicle_plate ? ` • ${r.vehicle_plate}` : ''}
                                                </p>
                                            </div>
                                            <span className="text-[10px] font-black text-emerald-300 uppercase tracking-wide">{l('Select', 'Selecteaza')}</span>
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
