import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useState } from 'react';
import { Bell, CheckCircle, ChevronRight, ClipboardList, Loader2, Search, User, UserCog, ScanLine, Truck, X, Zap, TrendingUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import StatsBanner from '../components/StatsBanner';
import Scanner from '../components/Scanner';
import { hasPermission } from '../auth/rbac';
import { PERM_AWB_UPDATE, PERM_NOTIFICATIONS_READ, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ, ROLE_ADMIN } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import StatusSelect from './StatusSelect';
import { createAdminNote, getStatusOptions, listAdminNotes, updateAwb } from '../services/api';
import { normalizeShipmentIdentifier } from '../services/awbScan';
import { queueItem, syncQueue } from '../store/queue';

const normalizeText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const resolveDepotEventId = (statusOptions) => {
    const list = Array.isArray(statusOptions) ? statusOptions : [];
    if (!list.length) return '';

    const exact = list.find((opt) => normalizeText(opt?.label) === 'intrare in depozit');
    if (exact?.event_id !== undefined && exact?.event_id !== null) return String(exact.event_id);

    const withDepotWords = list.find((opt) => {
        const haystack = [
            opt?.label,
            opt?.description,
            opt?.event_name,
            opt?.event_description,
        ].map((v) => normalizeText(v)).join(' ');
        return haystack.includes('intrare in depozit') || haystack.includes('in depot') || haystack.includes('in depozit');
    });
    if (withDepotWords?.event_id !== undefined && withDepotWords?.event_id !== null) return String(withDepotWords.event_id);

    return '';
};

export default function Home() {
    const [showScanner, setShowScanner] = useState(false);
    const [scannerMode, setScannerMode] = useState('status_update'); // status_update | truck_unload
    const [currentAwb, setCurrentAwb] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [lastTruckUnloadUpdate, setLastTruckUnloadUpdate] = useState(null);
    const [truckUnloadBusy, setTruckUnloadBusy] = useState(false);
    const [depotStatusEventId, setDepotStatusEventId] = useState('');
    const [depotStatusLookupBusy, setDepotStatusLookupBusy] = useState(false);
    const [showAdminNotes, setShowAdminNotes] = useState(false);
    const [adminNotes, setAdminNotes] = useState([]);
    const [adminNotesLoading, setAdminNotesLoading] = useState(false);
    const [adminNoteSaving, setAdminNoteSaving] = useState(false);
    const [adminNoteText, setAdminNoteText] = useState('');
    const [adminNoteMsg, setAdminNoteMsg] = useState('');
    const [greeting, setGreeting] = useState('');
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang, t } = useLanguage();
    const role = String(user?.role || '').trim();
    const canUpdateAwb = hasPermission(user, PERM_AWB_UPDATE);
    const canReadShipments = hasPermission(user, PERM_SHIPMENTS_READ);
    const canReadUsers = hasPermission(user, PERM_USERS_READ);
    const canReadStats = hasPermission(user, PERM_STATS_READ);
    const canReadNotifications = hasPermission(user, PERM_NOTIFICATIONS_READ);
    const isRecipient = role === 'Recipient';
    const isAdmin = role === ROLE_ADMIN;

    useEffect(() => {
        const token = localStorage.getItem('token');
        if (token) {
            syncQueue(token);
        }

        // Dynamic greeting based on time
        const hour = new Date().getHours();
        if (hour < 12) setGreeting(lang === 'ro' ? t('home.gm', 'Buna Dimineata') : 'Good Morning');
        else if (hour < 18) setGreeting(lang === 'ro' ? t('home.ga', 'Buna Ziua') : 'Good Afternoon');
        else setGreeting(lang === 'ro' ? t('home.ge', 'Buna Seara') : 'Good Evening');
    }, []);

    useEffect(() => {
        const hour = new Date().getHours();
        if (hour < 12) setGreeting(lang === 'ro' ? t('home.gm', 'Buna Dimineata') : 'Good Morning');
        else if (hour < 18) setGreeting(lang === 'ro' ? t('home.ga', 'Buna Ziua') : 'Good Afternoon');
        else setGreeting(lang === 'ro' ? t('home.ge', 'Buna Seara') : 'Good Evening');
    }, [lang, t]);

    useEffect(() => {
        let cancelled = false;
        if (!isAdmin || !canUpdateAwb) {
            setDepotStatusEventId('');
            return undefined;
        }
        const token = user?.token || localStorage.getItem('token');
        if (!token) {
            setDepotStatusEventId('');
            return undefined;
        }

        setDepotStatusLookupBusy(true);
        getStatusOptions(token)
            .then((options) => {
                if (cancelled) return;
                setDepotStatusEventId(resolveDepotEventId(options));
            })
            .catch(() => {
                if (cancelled) return;
                setDepotStatusEventId('');
            })
            .finally(() => {
                if (cancelled) return;
                setDepotStatusLookupBusy(false);
            });

        return () => {
            cancelled = true;
        };
    }, [isAdmin, canUpdateAwb, user?.token]);

    const handleScan = (awb) => {
        const cleaned = normalizeShipmentIdentifier(awb);
        if (!cleaned) return;
        setCurrentAwb(cleaned);
        setShowScanner(false);
    };

    const handleUpdateComplete = (outcome, meta = null) => {
        const shownAwb = String(meta?.awb || currentAwb || '').trim().toUpperCase();
        const parcelIndexN = Number(meta?.parcel_index);
        const parcelIndex = Number.isFinite(parcelIndexN) && parcelIndexN > 0 ? parcelIndexN : null;
        const parcelsTotalN = Number(meta?.parcels_total);
        const parcelsTotal = Number.isFinite(parcelsTotalN) && parcelsTotalN > 0 ? parcelsTotalN : null;
        setLastUpdate({ awb: shownAwb || currentAwb, outcome, parcel_index: parcelIndex, parcels_total: parcelsTotal });
        setCurrentAwb(null);
        setTimeout(() => setLastUpdate(null), 3000);
    };

    const handleTruckUnloadScan = async (awb) => {
        if (truckUnloadBusy) return;
        const cleaned = normalizeShipmentIdentifier(awb);
        setShowScanner(false);
        if (!cleaned) {
            setLastTruckUnloadUpdate({
                awb: '',
                outcome: 'ERROR',
                detail: lang === 'ro' ? 'AWB invalid la scanare.' : 'Invalid AWB scanned.',
            });
            setTimeout(() => setLastTruckUnloadUpdate(null), 4000);
            return;
        }

        const token = user?.token || localStorage.getItem('token');
        if (!token) {
            setLastTruckUnloadUpdate({
                awb: cleaned,
                outcome: 'ERROR',
                detail: lang === 'ro' ? 'Nu exista sesiune activa.' : 'No active session token.',
            });
            setTimeout(() => setLastTruckUnloadUpdate(null), 4000);
            return;
        }

        setTruckUnloadBusy(true);
        let eventId = depotStatusEventId;

        try {
            if (!eventId) {
                setDepotStatusLookupBusy(true);
                const options = await getStatusOptions(token);
                eventId = resolveDepotEventId(options);
                setDepotStatusEventId(eventId);
            }

            if (!eventId) {
                throw new Error(lang === 'ro'
                    ? 'Statusul "Intrare in depozit" nu exista in lista Postis.'
                    : 'Status "Intrare in depozit" was not found in Postis options.');
            }

            await updateAwb(token, {
                awb: cleaned,
                event_id: eventId,
                timestamp: new Date().toISOString(),
                payload: {
                    source: 'home_truck_unload_scan',
                    requested_status: 'Intrare in depozit',
                },
            });

            setLastTruckUnloadUpdate({
                awb: cleaned,
                outcome: 'SUCCESS',
                detail: lang === 'ro'
                    ? 'Trimis in Postis cu status Intrare in depozit.'
                    : 'Sent to Postis with In Depot status.',
            });
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            if (eventId) {
                try {
                    await queueItem(cleaned, eventId, {
                        source: 'home_truck_unload_scan',
                        requested_status: 'Intrare in depozit',
                    });
                    setLastTruckUnloadUpdate({
                        awb: cleaned,
                        outcome: 'QUEUED',
                        detail: lang === 'ro'
                            ? 'Conexiune indisponibila. Update-ul a fost pus la coada.'
                            : 'Connection unavailable. Update queued for sync.',
                    });
                } catch {
                    setLastTruckUnloadUpdate({
                        awb: cleaned,
                        outcome: 'ERROR',
                        detail: detail || (lang === 'ro' ? 'Nu am putut trimite statusul.' : 'Failed to send status update.'),
                    });
                }
            } else {
                setLastTruckUnloadUpdate({
                    awb: cleaned,
                    outcome: 'ERROR',
                    detail: detail || (lang === 'ro' ? 'Nu am putut trimite statusul.' : 'Failed to send status update.'),
                });
            }
        } finally {
            setTruckUnloadBusy(false);
            setDepotStatusLookupBusy(false);
            setTimeout(() => setLastTruckUnloadUpdate(null), 4000);
        }
    };

    const openScannerForMode = (mode) => {
        setScannerMode(mode === 'truck_unload' ? 'truck_unload' : 'status_update');
        setShowScanner(true);
    };

    const handleScannerScan = (awb) => {
        if (scannerMode === 'truck_unload') {
            handleTruckUnloadScan(awb);
            return;
        }
        handleScan(awb);
    };

    const loadAdminImprovementNotes = async () => {
        if (!isAdmin) return;
        const token = user?.token || localStorage.getItem('token');
        if (!token) return;
        setAdminNotesLoading(true);
        setAdminNoteMsg('');
        try {
            const rows = await listAdminNotes(token, { limit: 120 });
            setAdminNotes(Array.isArray(rows) ? rows : []);
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setAdminNoteMsg(detail || (lang === 'ro' ? 'Nu am putut incarca notitele.' : 'Failed to load notes.'));
            setAdminNotes([]);
        } finally {
            setAdminNotesLoading(false);
        }
    };

    const saveAdminImprovementNote = async () => {
        if (!isAdmin) return;
        const token = user?.token || localStorage.getItem('token');
        if (!token) return;
        const text = String(adminNoteText || '').trim();
        if (!text) {
            setAdminNoteMsg(lang === 'ro' ? 'Scrie o notita inainte sa salvezi.' : 'Write a note before saving.');
            return;
        }
        setAdminNoteSaving(true);
        setAdminNoteMsg('');
        try {
            const created = await createAdminNote(token, { text });
            setAdminNotes((prev) => [created, ...(Array.isArray(prev) ? prev : [])]);
            setAdminNoteText('');
            setAdminNoteMsg(lang === 'ro' ? 'Notita salvata.' : 'Note saved.');
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setAdminNoteMsg(detail || (lang === 'ro' ? 'Nu am putut salva notita.' : 'Failed to save note.'));
        } finally {
            setAdminNoteSaving(false);
        }
    };

    const formatAdminNoteDate = (value) => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '--';
        const locale = lang === 'ro' ? 'ro-RO' : 'en-US';
        return date.toLocaleString(locale, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    if (currentAwb) {
        return (
            <StatusSelect
                awb={currentAwb}
                onBack={() => setCurrentAwb(null)}
                onComplete={handleUpdateComplete}
            />
        );
    }

    const containerVariants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -20 }}
            variants={containerVariants}
            className="flex flex-col min-h-screen relative overflow-hidden"
        >
            {/* Background Gradient Orbs */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '0s' }}></div>
            <div className="absolute bottom-0 left-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '3s' }}></div>

            {/* Header */}
            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-glow-md animate-float">
                        <span className="text-white font-black italic tracking-tighter text-xl">AN</span>
                    </div>
                    <div>
                        <h1 className="text-lg font-black text-gradient leading-none">AryNik</h1>
                        <div className="flex items-center gap-1.5 mt-1">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Online</span>
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => navigate('/settings')}
                    className="w-10 h-10 rounded-full glass-light flex items-center justify-center border border-white/10 hover:bg-white/10 transition-colors"
                    aria-label="Account"
                    title="Account"
                >
                    <User size={18} className="text-violet-300" />
                </button>
            </header>

            <main className="flex-1 p-6 space-y-8 pb-32 relative z-10">
                {/* Greeting */}
                <motion.div variants={itemVariants}>
                    <h2 className="text-3xl font-black text-white mb-1">{greeting}</h2>
                    <p className="text-slate-400 font-medium">
                        {(user?.name || user?.username || 'Driver')}
                        {' • '}
                        {isRecipient ? (lang === 'ro' ? 'Urmarire Destinatar' : 'Recipient Tracking') : (user?.truck_plate ? `${lang === 'ro' ? 'Camion' : 'Truck'} ${String(user.truck_plate).toUpperCase()}` : (lang === 'ro' ? 'Camion Nealocat' : 'Truck Unassigned'))}
                    </p>
                    {!isRecipient && user?.truck_phone ? (
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                            Truck phone: {user.truck_phone}
                        </p>
                    ) : null}
                    {isRecipient ? (
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                            Login: {user?.username || '--'}
                        </p>
                    ) : null}
                </motion.div>

                {canReadStats ? (
                    <motion.div variants={itemVariants}>
                        <StatsBanner />
                    </motion.div>
                ) : null}

                {lastUpdate && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`p-4 rounded-2xl flex items-center gap-4 shadow-lg ${lastUpdate.outcome === 'SUCCESS'
                            ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-emerald-500/20'
                            : 'bg-gradient-to-r from-violet-500 to-purple-600 shadow-violet-500/20'
                            }`}>
                        <div className="p-2 bg-white/20 rounded-xl backdrop-blur-sm">
                            <CheckCircle size={20} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <span className="font-black text-sm uppercase tracking-wide text-white">Update {lastUpdate.outcome === 'SUCCESS' ? 'Confirmed' : 'Queued'}</span>
                            <p className="text-xs font-bold text-white/80">
                                {lastUpdate.awb}
                                {Number.isFinite(lastUpdate.parcel_index) && lastUpdate.parcel_index > 0 ? (
                                    <span className="ml-2 text-[10px] font-black uppercase tracking-widest text-white/80">
                                        Parcel {lastUpdate.parcel_index}{Number.isFinite(lastUpdate.parcels_total) && lastUpdate.parcels_total > 0 ? `/${lastUpdate.parcels_total}` : ''}
                                    </span>
                                ) : null}
                            </p>
                        </div>
                    </motion.div>
                )}

                {lastTruckUnloadUpdate && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`p-4 rounded-2xl flex items-center gap-4 shadow-lg ${lastTruckUnloadUpdate.outcome === 'SUCCESS'
                            ? 'bg-gradient-to-r from-cyan-500 to-sky-600 shadow-cyan-500/20'
                            : lastTruckUnloadUpdate.outcome === 'QUEUED'
                                ? 'bg-gradient-to-r from-violet-500 to-purple-600 shadow-violet-500/20'
                                : 'bg-gradient-to-r from-rose-500 to-red-600 shadow-rose-500/20'
                            }`}
                    >
                        <div className="p-2 bg-white/20 rounded-xl backdrop-blur-sm">
                            <CheckCircle size={20} className="text-white" />
                        </div>
                        <div className="flex-1">
                            <span className="font-black text-sm uppercase tracking-wide text-white">
                                {lastTruckUnloadUpdate.outcome === 'SUCCESS'
                                    ? (lang === 'ro' ? 'Descarcare Confirmata' : 'Unload Confirmed')
                                    : lastTruckUnloadUpdate.outcome === 'QUEUED'
                                        ? (lang === 'ro' ? 'Descarcare In Coada' : 'Unload Queued')
                                        : (lang === 'ro' ? 'Descarcare Esuata' : 'Unload Failed')}
                            </span>
                            <p className="text-xs font-bold text-white/80">{lastTruckUnloadUpdate.awb || '--'}</p>
                            <p className="text-[11px] font-semibold text-white/85 mt-1">{lastTruckUnloadUpdate.detail}</p>
                        </div>
                    </motion.div>
                )}

                <motion.div variants={itemVariants} className="space-y-4">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">{t('home.quick', 'Quick Actions')}</h3>

                    {/* Primary Action: Scan AWB */}
                    {canUpdateAwb ? (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => openScannerForMode('status_update')}
                            className="w-full py-12 bg-gradient-to-br from-violet-600 via-purple-600 to-violet-700 rounded-[32px] shadow-glow-lg flex flex-col items-center justify-center text-white space-y-5 relative overflow-hidden group"
                        >
                            <div className="absolute inset-0 shimmer opacity-30"></div>
                            <div className="absolute top-0 right-0 w-40 h-40 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16"></div>
                            <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/10 rounded-full blur-3xl -ml-12 -mb-12"></div>

                            <div className="p-6 bg-white/10 rounded-3xl backdrop-blur-sm border border-white/20 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 shadow-inner-glow">
                                <ScanLine size={52} strokeWidth={1.5} className="animate-glow" />
                            </div>
                            <div className="text-center relative z-10">
                                <h2 className="text-2xl font-black uppercase tracking-tight">{t('home.scan_package', 'Scan Package')}</h2>
                                <p className="text-violet-100 text-xs font-bold opacity-90 uppercase tracking-widest mt-1 flex items-center justify-center gap-2">
                                    <Zap size={12} />
                                    {t('home.tap_scanner', 'Tap to open scanner')}
                                </p>
                            </div>
                        </motion.button>
                    ) : (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/shipments')}
                            className="w-full py-10 bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 rounded-[32px] shadow-glow-lg flex flex-col items-center justify-center text-white space-y-4 relative overflow-hidden group"
                            disabled={!canReadShipments}
                        >
                            <div className="absolute inset-0 shimmer opacity-25"></div>
                            <div className="p-5 bg-white/10 rounded-3xl backdrop-blur-sm border border-white/20 group-hover:scale-110 group-hover:-rotate-2 transition-all duration-500 shadow-inner-glow">
                                <Search size={44} strokeWidth={1.5} />
                            </div>
                            <div className="text-center relative z-10">
                                <h2 className="text-xl font-black uppercase tracking-tight">{t('home.browse', 'Browse Shipments')}</h2>
                                <p className="text-emerald-100 text-xs font-bold opacity-90 uppercase tracking-widest mt-1 flex items-center justify-center gap-2">
                                    <TrendingUp size={12} />
                                    View tracking list
                                </p>
                            </div>
                        </motion.button>
                    )}

                    {isAdmin && canUpdateAwb && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => openScannerForMode('truck_unload')}
                            disabled={truckUnloadBusy || depotStatusLookupBusy}
                            className={`w-full p-5 rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent ${truckUnloadBusy || depotStatusLookupBusy
                                ? 'opacity-70 cursor-not-allowed glass-light'
                                : 'glass-strong'
                                }`}
                        >
                            <div className="p-4 bg-gradient-to-br from-cyan-500 to-sky-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Truck size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    Descarcare camion
                                    <span className="text-[8px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded-full font-bold">ADMIN</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    {depotStatusLookupBusy
                                        ? (lang === 'ro' ? 'Se incarca statusurile Postis...' : 'Loading Postis statuses...')
                                        : (lang === 'ro'
                                            ? 'Scaneaza AWB si trimite Intrare in depozit'
                                            : 'Scan AWB and send In Depot status')}
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {isAdmin ? (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => {
                                setShowAdminNotes(true);
                                loadAdminImprovementNotes();
                            }}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-fuchsia-500 to-violet-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <ClipboardList size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    {lang === 'ro' ? 'Notite imbunatatiri' : 'Improvement Notes'}
                                    <span className="text-[8px] bg-fuchsia-500/20 text-fuchsia-300 px-2 py-0.5 rounded-full font-bold">ADMIN</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    {lang === 'ro' ? 'Adauga ce trebuie schimbat sau adaugat' : 'Add what should be changed or added'}
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    ) : null}

                    {/* Secondary Actions */}
                    {canReadShipments && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/shipments')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Search size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    {t('home.search_shipments', 'Search Shipments')}
                                    <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-bold">LIVE</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5 flex items-center gap-1">
                                    <TrendingUp size={10} />
                                    Real-time tracking
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {canReadNotifications && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/notifications')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-amber-500 to-orange-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Bell size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight">
                                    {t('home.notifications', 'Notifications')}
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    Allocation updates
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {canReadUsers && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => navigate('/users')}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-violet-500 to-purple-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <UserCog size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    {t('home.manage_users', 'Manage Users')}
                                    <span className="text-[8px] bg-violet-500/20 text-violet-300 px-2 py-0.5 rounded-full font-bold">RBAC</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    Create accounts and set roles
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}
                </motion.div>
            </main>

            <AnimatePresence>
                {showAdminNotes ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-40 bg-slate-950/75 backdrop-blur-sm px-4 py-6 flex items-end sm:items-center justify-center"
                    >
                        <motion.div
                            initial={{ opacity: 0, y: 24, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 20, scale: 0.98 }}
                            transition={{ duration: 0.2 }}
                            className="w-full max-w-2xl max-h-[88vh] overflow-hidden rounded-[28px] border border-white/10 bg-slate-900/95 shadow-2xl flex flex-col"
                        >
                            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-black uppercase tracking-wide text-white">
                                        {lang === 'ro' ? 'Notite imbunatatiri aplicatie' : 'Application Improvement Notes'}
                                    </h3>
                                    <p className="text-[11px] font-semibold text-slate-400 mt-1">
                                        {lang === 'ro'
                                            ? 'Noteaza rapid ce trebuie schimbat, imbunatatit sau adaugat.'
                                            : 'Capture what should be changed, improved, or added.'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowAdminNotes(false);
                                        setAdminNoteMsg('');
                                    }}
                                    className="w-9 h-9 rounded-full bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors flex items-center justify-center"
                                    aria-label={lang === 'ro' ? 'Inchide notitele' : 'Close notes'}
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="px-5 pt-4 pb-3 border-b border-white/10 space-y-3">
                                <textarea
                                    value={adminNoteText}
                                    onChange={(e) => setAdminNoteText(e.target.value)}
                                    rows={4}
                                    maxLength={4000}
                                    placeholder={lang === 'ro' ? 'Ex: Ajustare ecran chat client...' : 'E.g. Improve recipient chat flow...'}
                                    className="w-full rounded-2xl bg-white/5 border border-white/10 text-white placeholder:text-slate-500 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-fuchsia-500/60"
                                />
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-[11px] font-semibold text-slate-500">
                                        {adminNoteText.length}/4000
                                    </p>
                                    <button
                                        type="button"
                                        onClick={saveAdminImprovementNote}
                                        disabled={adminNoteSaving}
                                        className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider text-white transition-colors ${adminNoteSaving
                                            ? 'bg-fuchsia-700/70 cursor-wait'
                                            : 'bg-fuchsia-600 hover:bg-fuchsia-500'}`}
                                    >
                                        {adminNoteSaving ? (
                                            <span className="inline-flex items-center gap-1.5">
                                                <Loader2 size={14} className="animate-spin" />
                                                {lang === 'ro' ? 'Salvez...' : 'Saving...'}
                                            </span>
                                        ) : (lang === 'ro' ? 'Salveaza notita' : 'Save note')}
                                    </button>
                                </div>
                                {adminNoteMsg ? (
                                    <p className="text-xs font-bold text-fuchsia-300">{adminNoteMsg}</p>
                                ) : null}
                            </div>

                            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                                {adminNotesLoading ? (
                                    <div className="py-8 flex items-center justify-center text-slate-400 gap-2">
                                        <Loader2 size={16} className="animate-spin" />
                                        <span className="text-xs font-bold uppercase tracking-wider">
                                            {lang === 'ro' ? 'Incarcare notite...' : 'Loading notes...'}
                                        </span>
                                    </div>
                                ) : null}

                                {!adminNotesLoading && adminNotes.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-white/15 bg-white/5 p-4 text-center text-slate-400">
                                        <p className="text-xs font-bold uppercase tracking-wider">
                                            {lang === 'ro' ? 'Nu exista notite salvate inca.' : 'No notes saved yet.'}
                                        </p>
                                    </div>
                                ) : null}

                                {!adminNotesLoading && adminNotes.map((note) => (
                                    <div key={note?.id || `${note?.created_at || ''}-${note?.text || ''}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                                        <div className="flex items-center justify-between gap-3 mb-2">
                                            <p className="text-[11px] font-black uppercase tracking-wider text-fuchsia-300">
                                                {note?.created_by_name || note?.created_by_user_id || 'Admin'}
                                            </p>
                                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                                                {formatAdminNoteDate(note?.created_at)}
                                            </p>
                                        </div>
                                        <p className="text-sm font-medium text-slate-100 whitespace-pre-wrap break-words">
                                            {String(note?.text || '')}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            {showScanner && <Scanner onScan={handleScannerScan} onClose={() => setShowScanner(false)} />}
        </motion.div>
    );
}
