import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Package, RefreshCw, Scale, Truck, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getShipments, listUsers } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const BUY_BACK_MARKER = 'retur deseu la greenwee buzau';

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

const looksDelivered = (statusRaw) => {
    const s = normalizeFold(statusRaw);
    return s.includes('livrat') || s.includes('deliver');
};

const num = (value) => {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
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

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const token = user?.token || localStorage.getItem('token');
            const [shipmentsRes, usersRes] = await Promise.all([
                getShipments(token),
                listUsers(token).catch(() => []),
            ]);
            setShipments(Array.isArray(shipmentsRes) ? shipmentsRes : []);
            setUsers(Array.isArray(usersRes) ? usersRes : []);
        } catch (e) {
            setError(String(e?.response?.data?.detail || e?.message || l('Failed to load BIB stats', 'Nu am putut incarca statisticile BIB')));
            setShipments([]);
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
        return (Array.isArray(shipments) ? shipments : [])
            .map((s) => {
                const instruction = instructionFromShipment(s);
                const isBib = normalizeFold(instruction).includes(BUY_BACK_MARKER);
                return {
                    ...s,
                    bib_instruction: instruction,
                    bib_required: isBib,
                };
            })
            .filter((s) => s.bib_required);
    }, [shipments]);

    const summary = useMemo(() => {
        const total = bibRows.length;
        const delivered = bibRows.filter((s) => looksDelivered(s?.status)).length;
        const pending = Math.max(0, total - delivered);
        const totalWeightKg = bibRows.reduce((acc, s) => acc + num(s?.weight), 0);
        const totalVolumetricKg = bibRows.reduce((acc, s) => acc + num(s?.volumetric_weight), 0);
        return { total, delivered, pending, totalWeightKg, totalVolumetricKg };
    }, [bibRows]);

    const byDriver = useMemo(() => {
        const map = new Map();
        bibRows.forEach((s) => {
            const did = String(s?.driver_id || '').trim().toUpperCase() || 'UNASSIGNED';
            const driver = driversById.get(did);
            const shipmentPlate = String(
                s?.raw_data?.courier?.truckNumber
                || s?.raw_data?.courierData?.truckNumber
                || s?.raw_data?.truckNumber
                || ''
            ).trim().toUpperCase();
            const row = map.get(did) || {
                driver_id: did,
                driver_name: did === 'UNASSIGNED'
                    ? l('Unassigned', 'Nealocat')
                    : (String(driver?.name || '').trim() || did),
                truck_plate: String(driver?.truck_plate || '').trim().toUpperCase() || shipmentPlate || '--',
                total: 0,
                delivered: 0,
                pending: 0,
                totalWeightKg: 0,
                totalVolumetricKg: 0,
            };
            row.total += 1;
            if (looksDelivered(s?.status)) row.delivered += 1;
            else row.pending += 1;
            row.totalWeightKg += num(s?.weight);
            row.totalVolumetricKg += num(s?.volumetric_weight);
            map.set(did, row);
        });
        return Array.from(map.values()).sort((a, b) => b.total - a.total || a.driver_name.localeCompare(b.driver_name));
    }, [bibRows, driversById, l]);

    const byVehicle = useMemo(() => {
        const map = new Map();
        bibRows.forEach((s) => {
            const did = String(s?.driver_id || '').trim().toUpperCase();
            const driver = did ? driversById.get(did) : null;
            const shipmentPlate = String(
                s?.raw_data?.courier?.truckNumber
                || s?.raw_data?.courierData?.truckNumber
                || s?.raw_data?.truckNumber
                || ''
            ).trim().toUpperCase();
            const plate = String(driver?.truck_plate || '').trim().toUpperCase() || shipmentPlate || l('Unassigned', 'Nealocata');
            const row = map.get(plate) || {
                plate,
                total: 0,
                delivered: 0,
                pending: 0,
                totalWeightKg: 0,
                totalVolumetricKg: 0,
            };
            row.total += 1;
            if (looksDelivered(s?.status)) row.delivered += 1;
            else row.pending += 1;
            row.totalWeightKg += num(s?.weight);
            row.totalVolumetricKg += num(s?.volumetric_weight);
            map.set(plate, row);
        });
        return Array.from(map.values()).sort((a, b) => b.total - a.total || a.plate.localeCompare(b.plate));
    }, [bibRows, driversById, l]);

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
                            {l('Buy-back collection dashboard', 'Dashboard colectari buy-back')}
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

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
                    <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('BIB AWBs', 'AWB-uri BIB')}</p>
                    {bibRows.length === 0 ? (
                        <p className="text-sm text-slate-400 font-bold">{loading ? l('Loading...', 'Se incarca...') : l('No buy-back AWBs found', 'Nu exista AWB-uri buy-back')}</p>
                    ) : (
                        <div className="space-y-2">
                            {bibRows.slice(0, 200).map((s, idx) => {
                                const awb = String(s?.awb || '').trim().toUpperCase();
                                const did = String(s?.driver_id || '').trim().toUpperCase();
                                const driver = driversById.get(did);
                                return (
                                    <div key={awb || `bib-${idx + 1}`} className="p-3 rounded-2xl bg-slate-900/35 border border-white/10">
                                        <p className="text-[11px] font-mono font-black text-emerald-300 tracking-wider truncate">{awb || '--'}</p>
                                        <p className="text-[10px] text-slate-300 font-bold mt-1">
                                            {String(driver?.name || did || l('Unassigned', 'Nealocat'))} • {String(driver?.truck_plate || l('No truck', 'Fara masina')).toUpperCase()}
                                        </p>
                                        <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                            {s?.bib_instruction || 'Retur deseu la GreenWee Buzau'}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
