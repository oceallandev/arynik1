import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, CalendarDays, Package, RefreshCw, Scale, Tag, Truck, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getShipments, listUsers } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { toUiError } from '../services/uiErrors';

const BUY_BACK_MARKER = 'retur deseu la greenwee buzau';
const HISTORY_PAGE_SIZE = 100;

const normalizeFold = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    } catch {
        return String(value || '').toLowerCase().trim();
    }
};

const PRODUCT_CATEGORY_RULES = [
    {
        id: 'frigidere',
        ro: 'Frigidere',
        en: 'Refrigerators',
        terms: ['frigider', 'fridge', 'refrigerator', 'combina frigorifica', 'lada frigorifica'],
    },
    {
        id: 'masini_spalat',
        ro: 'Masini de spalat',
        en: 'Washing Machines',
        terms: ['masina de spalat', 'washing machine', 'washer', 'masina spalat rufe', 'masina de spalat rufe', 'masina de spalat vase', 'dishwasher'],
    },
    {
        id: 'aragaz_cuptor',
        ro: 'Aragaz / Cuptor',
        en: 'Cookers / Ovens',
        terms: ['aragaz', 'cuptor', 'oven', 'plita', 'hota'],
    },
    {
        id: 'televizoare',
        ro: 'TV / Monitoare',
        en: 'TV / Monitors',
        terms: ['televizor', 'televizoare', 'tv', 'monitor', 'display'],
    },
    {
        id: 'aer_conditionat',
        ro: 'Aer conditionat',
        en: 'Air Conditioners',
        terms: ['aer conditionat', 'ac unit', 'air conditioner', 'climatizare'],
    },
    {
        id: 'boilere',
        ro: 'Boilere',
        en: 'Boilers',
        terms: ['boiler', 'centrala', 'calorifer electric', 'instant apa calda'],
    },
    {
        id: 'electrocasnice_mici',
        ro: 'Electrocasnice mici',
        en: 'Small Appliances',
        terms: ['microunde', 'cuptor cu microunde', 'aspirator', 'fier de calcat', 'cafetera', 'espressor', 'blender', 'mixeur'],
    },
    {
        id: 'it_telefoane',
        ro: 'IT / Telefoane',
        en: 'IT / Phones',
        terms: ['telefon', 'laptop', 'pc', 'calculator', 'tableta', 'router', 'imprimanta'],
    },
];

const instructionFromShipment = (s) => {
    const raw = s?.raw_data || {};
    const info = raw?.info || {};
    const additional = raw?.additionalServices || {};
    const candidates = [
        s?.delivery_instructions,
        raw?.shippingInstruction,
        raw?.shipping_instruction,
        info?.shippingInstruction,
        info?.shipping_instruction,
        additional?.shippingInstruction,
        additional?.shipping_instruction,
    ];
    for (const c of candidates) {
        const text = String(c || '').trim();
        if (text) return text;
    }
    return '';
};

const contentFromShipment = (s) => {
    const raw = s?.raw_data || {};
    const productCategory = raw?.productCategory || {};
    const candidates = [
        s?.content_description,
        raw?.contentDescription,
        raw?.contents,
        raw?.content,
        productCategory?.name,
        productCategory?.label,
        productCategory?.description,
    ];

    for (const c of candidates) {
        const text = String(c || '').trim();
        if (text) return text;
    }
    return '';
};

const looksDelivered = (statusRaw) => {
    const s = normalizeFold(statusRaw);
    return s.includes('livrat') || s.includes('deliver');
};

const num = (value) => {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
};

const parseShipmentDate = (shipment) => {
    const candidates = [shipment?.awb_status_date, shipment?.last_updated, shipment?.created_date];
    for (const raw of candidates) {
        const d = new Date(raw || '');
        if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
};

const categoryForProductText = (value) => {
    const folded = normalizeFold(value);
    if (!folded) {
        return { id: 'necunoscut', ro: 'Necunoscut', en: 'Unknown' };
    }

    for (const rule of PRODUCT_CATEGORY_RULES) {
        if (rule.terms.some((term) => folded.includes(normalizeFold(term)))) {
            return { id: rule.id, ro: rule.ro, en: rule.en };
        }
    }

    return { id: 'altele', ro: 'Altele', en: 'Others' };
};

const fmtDateTime = (value, lang) => {
    const d = new Date(value || '');
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString(lang === 'ro' ? 'ro-RO' : 'en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
};

const normalizeDateInput = (value, isEnd = false) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    const suffix = isEnd ? 'T23:59:59.999' : 'T00:00:00.000';
    const d = new Date(`${trimmed}${suffix}`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
};

export default function BIB() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [shipments, setShipments] = useState([]);
    const [users, setUsers] = useState([]);

    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [historyPage, setHistoryPage] = useState(1);

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const token = user?.token || localStorage.getItem('token');
            const [shipmentsRes, usersRes] = await Promise.all([
                getShipments(token, { limit: 3000 }),
                listUsers(token).catch(() => []),
            ]);
            setShipments(Array.isArray(shipmentsRes) ? shipmentsRes : []);
            setUsers(Array.isArray(usersRes) ? usersRes : []);
        } catch (e) {
            setError(toUiError(e, {
                lang,
                fallbackRo: 'Nu am putut incarca statisticile BIB.',
                fallbackEn: 'Failed to load BIB stats.',
            }));
            setShipments([]);
            setUsers([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.token]);

    const driversById = useMemo(() => {
        const map = new Map();
        (Array.isArray(users) ? users : []).forEach((u) => {
            const did = String(u?.driver_id || '').trim().toUpperCase();
            if (!did) return;
            map.set(did, u);
        });
        return map;
    }, [users]);

    const bibRows = useMemo(() => {
        const rows = [];
        (Array.isArray(shipments) ? shipments : []).forEach((s) => {
            const instruction = instructionFromShipment(s);
            const isBib = normalizeFold(instruction).includes(BUY_BACK_MARKER);
            if (!isBib) return;

            const isUnannouncedBib = normalizeFold(instruction).includes('neanuntat');

            const productText = contentFromShipment(s);
            const category = categoryForProductText(productText);
            const eventDate = parseShipmentDate(s);
            const eventTs = eventDate ? eventDate.getTime() : 0;
            const did = String(s?.driver_id || '').trim().toUpperCase();
            const driver = did ? driversById.get(did) : null;
            const shipmentPlate = String(
                s?.raw_data?.courier?.truckNumber
                || s?.raw_data?.courierData?.truckNumber
                || s?.raw_data?.truckNumber
                || ''
            ).trim().toUpperCase();
            rows.push({
                ...s,
                bib_instruction: instruction,
                bib_is_unannounced: isUnannouncedBib,
                bib_product_text: productText,
                bib_category: category,
                bib_event_date: eventDate ? eventDate.toISOString() : null,
                bib_event_ts: eventTs,
                driver_id_norm: did,
                driver_name: did
                    ? (String(driver?.name || '').trim() || did)
                    : l('Unassigned', 'Nealocat'),
                truck_plate: String(driver?.truck_plate || '').trim().toUpperCase() || shipmentPlate || l('Unassigned', 'Nealocata'),
            });
        });

        rows.sort((a, b) => {
            if (b.bib_event_ts !== a.bib_event_ts) return b.bib_event_ts - a.bib_event_ts;
            return String(b?.awb || '').localeCompare(String(a?.awb || ''));
        });
        return rows;
    }, [shipments, driversById, l]);

    const summary = useMemo(() => {
        const total = bibRows.length;
        const delivered = bibRows.filter((s) => looksDelivered(s?.status)).length;
        const pending = Math.max(0, total - delivered);
        const totalWeightKg = bibRows.reduce((acc, s) => acc + num(s?.weight), 0);
        const totalVolumetricKg = bibRows.reduce((acc, s) => acc + num(s?.volumetric_weight), 0);
        const categoriesCount = new Set(bibRows.map((row) => String(row?.bib_category?.id || 'necunoscut'))).size;
        return { total, delivered, pending, totalWeightKg, totalVolumetricKg, categoriesCount };
    }, [bibRows]);

    const byCategory = useMemo(() => {
        const map = new Map();
        bibRows.forEach((row) => {
            const cat = row?.bib_category || { id: 'necunoscut', ro: 'Necunoscut', en: 'Unknown' };
            const key = String(cat.id || 'necunoscut');
            const curr = map.get(key) || {
                id: key,
                label_ro: String(cat.ro || 'Necunoscut'),
                label_en: String(cat.en || 'Unknown'),
                total: 0,
                delivered: 0,
                pending: 0,
                totalWeightKg: 0,
                totalVolumetricKg: 0,
            };
            curr.total += 1;
            if (looksDelivered(row?.status)) curr.delivered += 1;
            else curr.pending += 1;
            curr.totalWeightKg += num(row?.weight);
            curr.totalVolumetricKg += num(row?.volumetric_weight);
            map.set(key, curr);
        });
        return Array.from(map.values()).sort((a, b) => b.total - a.total || a.label_ro.localeCompare(b.label_ro));
    }, [bibRows]);

    const byDriver = useMemo(() => {
        const map = new Map();
        bibRows.forEach((row) => {
            const key = row.driver_id_norm || 'UNASSIGNED';
            const curr = map.get(key) || {
                driver_id: key,
                driver_name: row.driver_name,
                truck_plate: row.truck_plate,
                total: 0,
                delivered: 0,
                pending: 0,
                totalWeightKg: 0,
                totalVolumetricKg: 0,
            };
            curr.total += 1;
            if (looksDelivered(row?.status)) curr.delivered += 1;
            else curr.pending += 1;
            curr.totalWeightKg += num(row?.weight);
            curr.totalVolumetricKg += num(row?.volumetric_weight);
            map.set(key, curr);
        });
        return Array.from(map.values()).sort((a, b) => b.total - a.total || a.driver_name.localeCompare(b.driver_name));
    }, [bibRows]);

    const byVehicle = useMemo(() => {
        const map = new Map();
        bibRows.forEach((row) => {
            const key = String(row.truck_plate || l('Unassigned', 'Nealocata')).trim().toUpperCase();
            const curr = map.get(key) || {
                plate: key,
                total: 0,
                delivered: 0,
                pending: 0,
                totalWeightKg: 0,
                totalVolumetricKg: 0,
            };
            curr.total += 1;
            if (looksDelivered(row?.status)) curr.delivered += 1;
            else curr.pending += 1;
            curr.totalWeightKg += num(row?.weight);
            curr.totalVolumetricKg += num(row?.volumetric_weight);
            map.set(key, curr);
        });
        return Array.from(map.values()).sort((a, b) => b.total - a.total || a.plate.localeCompare(b.plate));
    }, [bibRows, l]);

    const categoryOptions = useMemo(() => {
        const map = new Map();
        byCategory.forEach((cat) => {
            map.set(cat.id, {
                id: cat.id,
                label: l(cat.label_en, cat.label_ro),
            });
        });
        return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    }, [byCategory, l]);

    const filteredHistory = useMemo(() => {
        const needle = normalizeFold(search);
        const from = normalizeDateInput(dateFrom, false);
        const to = normalizeDateInput(dateTo, true);

        return bibRows.filter((row) => {
            if (statusFilter === 'delivered' && !looksDelivered(row?.status)) return false;
            if (statusFilter === 'pending' && looksDelivered(row?.status)) return false;
            if (categoryFilter !== 'all' && String(row?.bib_category?.id || 'necunoscut') !== categoryFilter) return false;

            if (from || to) {
                const eventDate = parseShipmentDate(row);
                if (!eventDate) return false;
                if (from && eventDate < from) return false;
                if (to && eventDate > to) return false;
            }

            if (!needle) return true;

            const searchable = normalizeFold([
                row?.awb,
                row?.driver_name,
                row?.truck_plate,
                row?.recipient_name,
                row?.delivery_address,
                row?.locality,
                row?.county,
                row?.status,
                row?.bib_instruction,
                row?.bib_product_text,
                row?.bib_category?.ro,
                row?.bib_category?.en,
            ].join(' '));

            return searchable.includes(needle);
        });
    }, [bibRows, search, statusFilter, categoryFilter, dateFrom, dateTo]);

    useEffect(() => {
        setHistoryPage(1);
    }, [search, statusFilter, categoryFilter, dateFrom, dateTo, bibRows.length]);

    const totalHistoryPages = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
    const safeHistoryPage = Math.min(historyPage, totalHistoryPages);
    const historyRows = useMemo(() => {
        const start = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
        return filteredHistory.slice(start, start + HISTORY_PAGE_SIZE);
    }, [filteredHistory, safeHistoryPage]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" />
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }} />

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center gap-3 min-w-0">
                    <button
                        type="button"
                        onClick={() => navigate(-1)}
                        className="w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center hover:bg-white/5 transition-all"
                        aria-label="Back"
                    >
                        <ArrowLeft size={18} className="text-slate-300" />
                    </button>
                    <div className="min-w-0">
                        <h1 className="text-xl font-black text-gradient tracking-tight truncate">BIB</h1>
                        <p className="text-xs text-slate-400 font-medium mt-1 truncate">
                            {l('Buy-back collection history', 'Istoric colectari buy-back')}
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    disabled={loading}
                    className={`w-11 h-11 rounded-2xl glass-light border border-white/10 flex items-center justify-center text-slate-200 hover:bg-white/5 transition-all ${loading ? 'opacity-70 cursor-not-allowed' : ''}`}
                    aria-label="Refresh"
                >
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </header>

            <div className="flex-1 p-4 pb-32 relative z-10 space-y-4">
                {error ? (
                    <div className="glass-strong rounded-2xl border border-rose-500/30 p-4 text-rose-200 text-xs font-bold">
                        {error}
                    </div>
                ) : null}

                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Package size={14} /> BIB total</div>
                        <p className="text-2xl font-black text-white mt-2">{summary.total}</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Package size={14} /> Livrate</div>
                        <p className="text-2xl font-black text-emerald-300 mt-2">{summary.delivered}</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Package size={14} /> In asteptare</div>
                        <p className="text-2xl font-black text-amber-300 mt-2">{summary.pending}</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Scale size={14} /> Greutate totala</div>
                        <p className="text-lg font-black text-white mt-2">{summary.totalWeightKg.toFixed(1)} kg</p>
                        <p className="text-[10px] text-slate-400 font-bold mt-1">Volumetric: {summary.totalVolumetricKg.toFixed(1)} kg</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Tag size={14} /> Categorii</div>
                        <p className="text-2xl font-black text-cyan-300 mt-2">{summary.categoriesCount}</p>
                    </div>
                </div>

                <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                    <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                        <Tag size={14} /> {l('Product Categories', 'Categorii produse preluate')}
                    </p>
                    {byCategory.length === 0 ? (
                        <p className="text-sm text-slate-400 font-bold">{loading ? l('Loading...', 'Se incarca...') : l('No BIB categories found', 'Nu exista categorii BIB')}</p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                            {byCategory.map((row) => (
                                <div key={row.id} className="p-3 rounded-2xl bg-white/5 border border-white/10">
                                    <p className="text-sm font-black text-white truncate">{l(row.label_en, row.label_ro)}</p>
                                    <p className="text-[11px] text-slate-300 font-bold mt-2">
                                        {row.total} total • {row.delivered} livrate • {row.pending} in asteptare
                                    </p>
                                    <p className="text-[10px] text-slate-500 font-bold mt-1">
                                        {row.totalWeightKg.toFixed(1)} kg • volumetric {row.totalVolumetricKg.toFixed(1)} kg
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                            <User size={14} /> {l('By Driver', 'Pe sofer')}
                        </p>
                        {byDriver.length === 0 ? (
                            <p className="text-sm text-slate-400 font-bold">{loading ? l('Loading...', 'Se incarca...') : l('No BIB data', 'Nu exista date BIB')}</p>
                        ) : byDriver.map((row) => (
                            <div key={row.driver_id} className="p-3 rounded-2xl bg-white/5 border border-white/10">
                                <p className="text-sm font-black text-white truncate">{row.driver_name}</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{row.driver_id} • {row.truck_plate}</p>
                                <p className="text-[11px] text-slate-300 font-bold mt-2">
                                    {row.total} total • {row.delivered} livrate • {row.pending} in asteptare • {row.totalWeightKg.toFixed(1)} kg
                                </p>
                            </div>
                        ))}
                    </div>

                    <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                            <Truck size={14} /> {l('By Vehicle', 'Pe masina')}
                        </p>
                        {byVehicle.length === 0 ? (
                            <p className="text-sm text-slate-400 font-bold">{loading ? l('Loading...', 'Se incarca...') : l('No BIB data', 'Nu exista date BIB')}</p>
                        ) : byVehicle.map((row) => (
                            <div key={row.plate} className="p-3 rounded-2xl bg-white/5 border border-white/10">
                                <p className="text-sm font-black text-white truncate">{row.plate}</p>
                                <p className="text-[11px] text-slate-300 font-bold mt-2">
                                    {row.total} total • {row.delivered} livrate • {row.pending} in asteptare • {row.totalWeightKg.toFixed(1)} kg
                                </p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                    <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                            <CalendarDays size={14} /> {l('Complete BIB History', 'Istoric complet BIB')}
                        </p>
                        <p className="text-xs font-bold text-slate-400">
                            {l('Total records', 'Total inregistrari')}: {filteredHistory.length}
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={l('Search AWB / product / driver', 'Cauta AWB / produs / sofer')}
                            className="xl:col-span-2 rounded-2xl border border-white/15 bg-slate-900/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="rounded-2xl border border-white/15 bg-slate-900/40 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-emerald-500/40"
                        >
                            <option value="all">{l('All statuses', 'Toate statusurile')}</option>
                            <option value="delivered">{l('Delivered', 'Livrate')}</option>
                            <option value="pending">{l('Pending', 'In asteptare')}</option>
                        </select>
                        <select
                            value={categoryFilter}
                            onChange={(e) => setCategoryFilter(e.target.value)}
                            className="rounded-2xl border border-white/15 bg-slate-900/40 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-emerald-500/40"
                        >
                            <option value="all">{l('All categories', 'Toate categoriile')}</option>
                            {categoryOptions.map((opt) => (
                                <option key={opt.id} value={opt.id}>{opt.label}</option>
                            ))}
                        </select>
                        <div className="grid grid-cols-2 gap-2">
                            <input
                                type="date"
                                value={dateFrom}
                                onChange={(e) => setDateFrom(e.target.value)}
                                className="rounded-2xl border border-white/15 bg-slate-900/40 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-emerald-500/40"
                            />
                            <input
                                type="date"
                                value={dateTo}
                                onChange={(e) => setDateTo(e.target.value)}
                                className="rounded-2xl border border-white/15 bg-slate-900/40 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-emerald-500/40"
                            />
                        </div>
                    </div>

                    {historyRows.length === 0 ? (
                        <p className="text-sm text-slate-400 font-bold">
                            {loading ? l('Loading...', 'Se incarca...') : l('No BIB records for selected filters', 'Nu exista inregistrari BIB pentru filtrele selectate')}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {historyRows.map((row, idx) => {
                                const awb = String(row?.awb || '').trim().toUpperCase();
                                const statusDelivered = looksDelivered(row?.status);
                                return (
                                    <div key={awb || `bib-history-${idx + 1}`} className="p-3 rounded-2xl bg-slate-900/35 border border-white/10">
                                        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="text-[11px] font-mono font-black text-emerald-300 tracking-wider truncate">{awb || '--'}</p>
                                                <p className="text-[10px] text-slate-400 font-bold mt-1">
                                                    {fmtDateTime(row?.bib_event_date || row?.last_updated || row?.created_date, lang)}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                {row?.bib_is_unannounced && (
                                                    <span className="px-2 py-1 rounded-full text-[10px] font-black bg-purple-500/15 text-purple-300 border border-purple-400/30">
                                                        {l('Unannounced', 'Neanunțat')}
                                                    </span>
                                                )}
                                                <span className="px-2 py-1 rounded-full text-[10px] font-black bg-cyan-500/15 text-cyan-200 border border-cyan-400/30">
                                                    {l(row?.bib_category?.en || 'Unknown', row?.bib_category?.ro || 'Necunoscut')}
                                                </span>
                                                <span className={`px-2 py-1 rounded-full text-[10px] font-black border ${statusDelivered
                                                    ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
                                                    : 'bg-amber-500/15 text-amber-200 border-amber-500/30'}`}
                                                >
                                                    {statusDelivered ? l('Delivered', 'Livrata') : l('Pending', 'In asteptare')}
                                                </span>
                                            </div>
                                        </div>

                                        <p className="text-[10px] text-slate-300 font-bold mt-2">
                                            {row.driver_name} • {String(row.truck_plate || '').toUpperCase() || l('No truck', 'Fara masina')}
                                        </p>
                                        <p className="text-[10px] text-slate-400 font-semibold mt-1">
                                            {l('Product', 'Produs')}: {row?.bib_product_text || l('Not specified', 'Nespecificat')}
                                        </p>
                                        <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                            {row?.bib_instruction || 'Retur deseu la GreenWee Buzau'}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {totalHistoryPages > 1 ? (
                        <div className="pt-1 flex items-center justify-between gap-2">
                            <button
                                type="button"
                                onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
                                disabled={safeHistoryPage <= 1}
                                className={`px-3 py-2 rounded-xl border text-xs font-black transition ${safeHistoryPage <= 1
                                    ? 'border-white/10 text-slate-600 cursor-not-allowed'
                                    : 'border-white/15 text-slate-200 hover:bg-white/5'}`}
                            >
                                {l('Previous', 'Anterior')}
                            </button>

                            <p className="text-[11px] text-slate-400 font-black">
                                {l('Page', 'Pagina')} {safeHistoryPage} / {totalHistoryPages}
                            </p>

                            <button
                                type="button"
                                onClick={() => setHistoryPage((prev) => Math.min(totalHistoryPages, prev + 1))}
                                disabled={safeHistoryPage >= totalHistoryPages}
                                className={`px-3 py-2 rounded-xl border text-xs font-black transition ${safeHistoryPage >= totalHistoryPages
                                    ? 'border-white/10 text-slate-600 cursor-not-allowed'
                                    : 'border-white/15 text-slate-200 hover:bg-white/5'}`}
                            >
                                {l('Next', 'Urmator')}
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        </motion.div>
    );
}
