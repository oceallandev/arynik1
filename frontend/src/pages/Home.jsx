import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle, ChevronRight, ClipboardList, Loader2, Search, User, UserCog, ScanLine, Truck, X, Zap, TrendingUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AwbLink from '../components/AwbLink';
import StatsBanner from '../components/StatsBanner';
import Scanner from '../components/Scanner';
import TruckLoadPanel from '../components/TruckLoadPanel';
import { hasPermission } from '../auth/rbac';
import { normalizeRole, PERM_AWB_UPDATE, PERM_NOTIFICATIONS_READ, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ, ROLE_ADMIN, ROLE_DRIVER } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import StatusSelect from './StatusSelect';
import {
    approveManifestUnload,
    createAdminNote,
    createManifest,
    getManifest,
    importManifestAwbs,
    listAdminNotes,
    listFleetVehicles,
    listManifests,
    scanManifest,
    updateAdminNote,
} from '../services/api';
import { normalizeShipmentIdentifier } from '../services/awbScan';
import { syncQueue } from '../store/queue';

const normalizePlate = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

const ADMIN_NOTE_STATUS_OPTIONS = [
    { value: 'Not Started', en: 'Not Started', ro: 'Neinceput' },
    { value: 'In Progress', en: 'In Progress', ro: 'In progres' },
    { value: 'Resolved', en: 'Resolved', ro: 'Rezolvat' },
];

export default function Home() {
    const [showScanner, setShowScanner] = useState(false);
    const [scannerMode, setScannerMode] = useState('status_update'); // status_update | truck_unload_manifest
    const [scanFeedback, setScanFeedback] = useState(null);
    const [currentAwb, setCurrentAwb] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [lastTruckUnloadUpdate, setLastTruckUnloadUpdate] = useState(null);

    const [showTruckUnloadPanel, setShowTruckUnloadPanel] = useState(false);
    const [showTruckLoadPanel, setShowTruckLoadPanel] = useState(false);
    const [truckUnloadBusy, setTruckUnloadBusy] = useState(false);
    const [truckUnloadHistoryBusy, setTruckUnloadHistoryBusy] = useState(false);
    const [truckUnloadFleetVehicles, setTruckUnloadFleetVehicles] = useState([]);
    const [truckUnloadHistory, setTruckUnloadHistory] = useState([]);
    const [truckUnloadManifest, setTruckUnloadManifest] = useState(null);
    const [truckUnloadPlateChoice, setTruckUnloadPlateChoice] = useState('');
    const [truckUnloadExternalPlate, setTruckUnloadExternalPlate] = useState('');
    const [truckUnloadManualAwb, setTruckUnloadManualAwb] = useState('');
    const [truckUnloadImportFile, setTruckUnloadImportFile] = useState(null);
    const [truckUnloadImportSheetUrl, setTruckUnloadImportSheetUrl] = useState('');
    const [truckUnloadImportSummary, setTruckUnloadImportSummary] = useState(null);
    const [truckUnloadError, setTruckUnloadError] = useState('');
    const [truckUnloadInfo, setTruckUnloadInfo] = useState('');
    const truckUnloadImportFileRef = useRef(null);

    const [showAdminNotes, setShowAdminNotes] = useState(false);
    const [adminNotes, setAdminNotes] = useState([]);
    const [adminNotesLoading, setAdminNotesLoading] = useState(false);
    const [adminNoteSaving, setAdminNoteSaving] = useState(false);
    const [adminNoteText, setAdminNoteText] = useState('');
    const [adminNoteStatus, setAdminNoteStatus] = useState('In Progress');
    const [adminNoteStatusBusy, setAdminNoteStatusBusy] = useState({});
    const [adminNoteMsg, setAdminNoteMsg] = useState('');
    const [greeting, setGreeting] = useState('');
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang, t } = useLanguage();
    const role = normalizeRole(user?.role);
    const canUpdateAwb = hasPermission(user, PERM_AWB_UPDATE);
    const canReadShipments = hasPermission(user, PERM_SHIPMENTS_READ);
    const canReadUsers = hasPermission(user, PERM_USERS_READ);
    const canReadStats = hasPermission(user, PERM_STATS_READ);
    const canReadNotifications = hasPermission(user, PERM_NOTIFICATIONS_READ);
    const isRecipient = role === 'Recipient';
    const isDriver = role === ROLE_DRIVER;
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

    const showTruckUnloadToast = (payload) => {
        setLastTruckUnloadUpdate(payload || null);
        setTimeout(() => setLastTruckUnloadUpdate(null), 4500);
    };

    const loadTruckUnloadContext = async () => {
        const token = user?.token || localStorage.getItem('token');
        if (!token) {
            setTruckUnloadError(lang === 'ro' ? 'Nu exista sesiune activa.' : 'No active session token.');
            return;
        }

        setTruckUnloadHistoryBusy(true);
        setTruckUnloadError('');
        try {
            const [fleetRows, manifestRows] = await Promise.all([
                listFleetVehicles(token, { include_inactive: false, sync_from_drivers: false }).catch(() => []),
                listManifests(token, { limit: 120 }).catch(() => []),
            ]);

            const fleet = Array.isArray(fleetRows) ? fleetRows : [];
            setTruckUnloadFleetVehicles(fleet);
            if (!truckUnloadPlateChoice && fleet.length > 0) {
                const firstPlate = normalizePlate(fleet[0]?.plate || '');
                if (firstPlate) setTruckUnloadPlateChoice(firstPlate);
            }

            const history = (Array.isArray(manifestRows) ? manifestRows : [])
                .filter((m) => String(m?.kind || '').trim().toLowerCase() === 'unload')
                .slice(0, 20);
            setTruckUnloadHistory(history);
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setTruckUnloadError(detail || (lang === 'ro' ? 'Nu am putut incarca datele de descarcare.' : 'Failed to load unload data.'));
            setTruckUnloadFleetVehicles([]);
            setTruckUnloadHistory([]);
        } finally {
            setTruckUnloadHistoryBusy(false);
        }
    };

    const openTruckUnloadPanel = async () => {
        setShowTruckUnloadPanel(true);
        setTruckUnloadError('');
        setTruckUnloadInfo('');
        setTruckUnloadImportFile(null);
        setTruckUnloadImportSheetUrl('');
        setTruckUnloadImportSummary(null);
        if (truckUnloadImportFileRef.current) {
            truckUnloadImportFileRef.current.value = '';
        }
        await loadTruckUnloadContext();
    };

    const startTruckUnloadSession = async () => {
        if (truckUnloadBusy) return;
        const token = user?.token || localStorage.getItem('token');
        if (!token) {
            setTruckUnloadError(lang === 'ro' ? 'Nu exista sesiune activa.' : 'No active session token.');
            return;
        }

        const externalPlate = normalizePlate(truckUnloadExternalPlate);
        const selectedPlate = normalizePlate(truckUnloadPlateChoice);
        const truckPlate = externalPlate || selectedPlate;
        if (!truckPlate) {
            setTruckUnloadError(lang === 'ro'
                ? 'Selecteaza un camion sau introdu un numar de inmatriculare.'
                : 'Select a truck or enter a plate number.');
            return;
        }

        setTruckUnloadBusy(true);
        setTruckUnloadError('');
        setTruckUnloadInfo('');
        setTruckUnloadImportSummary(null);
        try {
            const created = await createManifest(token, {
                truck_plate: truckPlate,
                date: new Date().toISOString().slice(0, 10),
                kind: 'unload',
                notes: 'home_unload_session',
            });
            const loaded = await getManifest(token, created?.id);
            setTruckUnloadManifest(loaded || created || null);
            setTruckUnloadImportFile(null);
            setTruckUnloadImportSheetUrl('');
            if (truckUnloadImportFileRef.current) {
                truckUnloadImportFileRef.current.value = '';
            }
            setTruckUnloadInfo(lang === 'ro'
                ? `Sesiune de descarcare pornita pentru ${truckPlate}.`
                : `Unload session started for ${truckPlate}.`);
            showTruckUnloadToast({
                awb: truckPlate,
                outcome: 'SUCCESS',
                detail: lang === 'ro' ? 'Camion selectat. Poti incepe scanarea AWB-urilor.' : 'Truck selected. You can start scanning AWBs.',
            });
            await loadTruckUnloadContext();
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setTruckUnloadError(detail || (lang === 'ro' ? 'Nu am putut crea sesiunea de descarcare.' : 'Failed to create unload session.'));
        } finally {
            setTruckUnloadBusy(false);
        }
    };

    const openTruckUnloadManifest = async (manifestId) => {
        const token = user?.token || localStorage.getItem('token');
        if (!token) return;
        setTruckUnloadBusy(true);
        setTruckUnloadError('');
        setTruckUnloadInfo('');
        setTruckUnloadImportFile(null);
        setTruckUnloadImportSheetUrl('');
        setTruckUnloadImportSummary(null);
        if (truckUnloadImportFileRef.current) {
            truckUnloadImportFileRef.current.value = '';
        }
        try {
            const data = await getManifest(token, manifestId);
            setTruckUnloadManifest(data || null);
            setShowTruckUnloadPanel(true);
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setTruckUnloadError(detail || (lang === 'ro' ? 'Nu am putut deschide descarcarea.' : 'Failed to open unload session.'));
        } finally {
            setTruckUnloadBusy(false);
        }
    };

    const refreshTruckUnloadManifest = async () => {
        const token = user?.token || localStorage.getItem('token');
        const manifestId = Number(truckUnloadManifest?.id);
        if (!token || !Number.isFinite(manifestId)) return;
        const updated = await getManifest(token, manifestId);
        setTruckUnloadManifest(updated || truckUnloadManifest);
    };

    const handleTruckUnloadScan = async (awb) => {
        if (truckUnloadBusy) return;
        const cleaned = normalizeShipmentIdentifier(awb);
        setScanFeedback(null);
        if (!cleaned) {
            showTruckUnloadToast({
                awb: '',
                outcome: 'ERROR',
                detail: lang === 'ro' ? 'AWB invalid la scanare.' : 'Invalid AWB scanned.',
            });
            setScanFeedback({ type: 'error', text: lang === 'ro' ? 'AWB INVALID' : 'INVALID AWB' });
            setTimeout(() => setScanFeedback(null), 1500);
            return;
        }

        const token = user?.token || localStorage.getItem('token');
        const manifestId = Number(truckUnloadManifest?.id);
        if (!token || !Number.isFinite(manifestId)) {
            showTruckUnloadToast({
                awb: cleaned,
                outcome: 'ERROR',
                detail: lang === 'ro' ? 'Porneste mai intai o sesiune de descarcare cu camion selectat.' : 'Start an unload session with a selected truck first.',
            });
            setScanFeedback({ type: 'error', text: 'Eroare de Sesiune' });
            setTimeout(() => setScanFeedback(null), 1500);
            return;
        }

        setTruckUnloadBusy(true);
        setTruckUnloadError('');
        try {
            await scanManifest(token, manifestId, {
                identifier: cleaned,
                data: { source: 'home_unload_scan' },
            });
            await refreshTruckUnloadManifest();
            showTruckUnloadToast({
                awb: cleaned,
                outcome: 'SUCCESS',
                detail: lang === 'ro' ? 'AWB adaugat in lista de descarcare.' : 'AWB added to unload list.',
            });
            setScanFeedback({ type: 'success', text: lang === 'ro' ? `${cleaned} DESCARCAT` : `${cleaned} UNLOADED` });
            setTimeout(() => setScanFeedback(null), 1500);
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            showTruckUnloadToast({
                awb: cleaned,
                outcome: 'ERROR',
                detail: detail || (lang === 'ro' ? 'Nu am putut adauga AWB-ul in lista.' : 'Failed to add AWB to unload list.'),
            });
            setScanFeedback({ type: 'error', text: lang === 'ro' ? 'Adaugare Esuata' : 'Failed Unload' });
            setTimeout(() => setScanFeedback(null), 2500);
        } finally {
            setTruckUnloadBusy(false);
        }
    };

    const addTruckUnloadManualAwb = async () => {
        const raw = String(truckUnloadManualAwb || '').trim();
        if (!raw) return;
        setTruckUnloadManualAwb('');
        await handleTruckUnloadScan(raw);
    };

    const importTruckUnloadAwbs = async () => {
        if (truckUnloadBusy) return;
        const token = user?.token || localStorage.getItem('token');
        const manifestId = Number(truckUnloadManifest?.id);
        if (!token || !Number.isFinite(manifestId)) {
            setTruckUnloadError(lang === 'ro' ? 'Nu exista sesiune de descarcare activa.' : 'No active unload session.');
            return;
        }
        if (String(truckUnloadManifest?.status || '').toLowerCase() !== 'open') {
            setTruckUnloadError(lang === 'ro' ? 'Manifestul nu mai este deschis pentru import.' : 'Manifest is no longer open for import.');
            return;
        }

        const file = truckUnloadImportFile || null;
        const sheetUrl = String(truckUnloadImportSheetUrl || '').trim();
        if (!file && !sheetUrl) {
            setTruckUnloadError(lang === 'ro'
                ? 'Incarca un fisier (CSV/Excel) sau adauga URL-ul Google Sheet.'
                : 'Upload a file (CSV/Excel) or provide a Google Sheet URL.');
            return;
        }

        setTruckUnloadBusy(true);
        setTruckUnloadError('');
        setTruckUnloadInfo('');
        try {
            const useFile = Boolean(file);
            const summary = await importManifestAwbs(token, manifestId, {
                file: useFile ? file : null,
                google_sheet_url: useFile ? null : (sheetUrl || null),
            });
            setTruckUnloadImportSummary(summary || null);
            await refreshTruckUnloadManifest();
            await loadTruckUnloadContext();

            const importedCount = Number(summary?.imported_count || 0);
            const duplicateCount = Number(summary?.duplicate_count || 0);
            const invalidCount = Number(summary?.invalid_count || 0);
            const message = lang === 'ro'
                ? `Import finalizat: ${importedCount} adaugate, ${duplicateCount} duplicate, ${invalidCount} invalide.`
                : `Import complete: ${importedCount} added, ${duplicateCount} duplicates, ${invalidCount} invalid.`;
            setTruckUnloadInfo(message);
            showTruckUnloadToast({
                awb: String(truckUnloadManifest?.truck_plate || '--'),
                outcome: invalidCount > 0 ? 'QUEUED' : 'SUCCESS',
                detail: message,
            });

            setTruckUnloadImportFile(null);
            if (truckUnloadImportFileRef.current) {
                truckUnloadImportFileRef.current.value = '';
            }
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setTruckUnloadError(detail || (lang === 'ro' ? 'Nu am putut importa AWB-urile.' : 'Failed to import AWBs.'));
            showTruckUnloadToast({
                awb: String(truckUnloadManifest?.truck_plate || '--'),
                outcome: 'ERROR',
                detail: detail || (lang === 'ro' ? 'Nu am putut importa AWB-urile.' : 'Failed to import AWBs.'),
            });
        } finally {
            setTruckUnloadBusy(false);
        }
    };

    const approveTruckUnloadSession = async () => {
        if (truckUnloadBusy) return;
        const token = user?.token || localStorage.getItem('token');
        const manifestId = Number(truckUnloadManifest?.id);
        const awbCount = Array.isArray(truckUnloadManifest?.items) ? truckUnloadManifest.items.length : 0;
        if (!token || !Number.isFinite(manifestId)) {
            setTruckUnloadError(lang === 'ro' ? 'Nu exista sesiune de descarcare activa.' : 'No active unload session.');
            return;
        }
        if (!awbCount) {
            setTruckUnloadError(lang === 'ro' ? 'Nu ai AWB-uri scanate pentru aprobare.' : 'No scanned AWBs to approve.');
            return;
        }

        setTruckUnloadBusy(true);
        setTruckUnloadError('');
        setTruckUnloadInfo('');
        try {
            const result = await approveManifestUnload(token, manifestId, {
                notes: 'home_unload_approval',
                close_on_success: true,
            });
            const summary = result || {};
            const updatedManifest = summary?.manifest || null;
            if (updatedManifest) setTruckUnloadManifest(updatedManifest);
            await loadTruckUnloadContext();

            const successCount = Number(summary?.success_count || 0);
            const failedCount = Number(summary?.failed_count || 0);
            if (failedCount > 0) {
                const failedRows = (Array.isArray(summary?.results) ? summary.results : []).filter((row) => !row?.ok);
                const firstErr = String(failedRows[0]?.detail || '').trim();
                setTruckUnloadError(firstErr || (lang === 'ro' ? 'Unele AWB-uri nu au putut fi sincronizate in Postis.' : 'Some AWBs failed to sync to Postis.'));
                showTruckUnloadToast({
                    awb: `${successCount}/${successCount + failedCount}`,
                    outcome: 'ERROR',
                    detail: lang === 'ro'
                        ? `Aprobare partiala: ${successCount} reusite, ${failedCount} esuate.`
                        : `Partial approval: ${successCount} succeeded, ${failedCount} failed.`,
                });
            } else {
                const plate = normalizePlate(summary?.manifest?.truck_plate || truckUnloadManifest?.truck_plate || '');
                const txt = lang === 'ro'
                    ? `Descarcare aprobata pentru ${plate || 'camion'}: ${successCount} AWB-uri trimise in Postis cu status Intrare in depozit.`
                    : `Unload approved for ${plate || 'truck'}: ${successCount} AWBs synced to Postis with In Depot status.`;
                setTruckUnloadInfo(txt);
                showTruckUnloadToast({
                    awb: plate || '--',
                    outcome: 'SUCCESS',
                    detail: txt,
                });
            }
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setTruckUnloadError(detail || (lang === 'ro' ? 'Nu am putut aproba descarcarea.' : 'Failed to approve unload.'));
            showTruckUnloadToast({
                awb: String(truckUnloadManifest?.truck_plate || '--'),
                outcome: 'ERROR',
                detail: detail || (lang === 'ro' ? 'Nu am putut aproba descarcarea.' : 'Failed to approve unload.'),
            });
        } finally {
            setTruckUnloadBusy(false);
        }
    };

    const openScannerForMode = (mode) => {
        if (mode === 'truck_unload_manifest') {
            setScannerMode('truck_unload_manifest');
            setShowScanner(true);
            return;
        }
        setScannerMode('status_update');
        setShowScanner(true);
    };

    const handleScannerScan = (awb) => {
        if (scannerMode === 'truck_unload_manifest') {
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
        const statusValue = String(adminNoteStatus || 'In Progress').trim() || 'In Progress';
        if (!text) {
            setAdminNoteMsg(lang === 'ro' ? 'Scrie o notita inainte sa salvezi.' : 'Write a note before saving.');
            return;
        }
        setAdminNoteSaving(true);
        setAdminNoteMsg('');
        try {
            const created = await createAdminNote(token, { text, status: statusValue });
            setAdminNotes((prev) => [created, ...(Array.isArray(prev) ? prev : [])]);
            setAdminNoteText('');
            setAdminNoteStatus('In Progress');
            setAdminNoteMsg(lang === 'ro' ? 'Notita salvata.' : 'Note saved.');
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setAdminNoteMsg(detail || (lang === 'ro' ? 'Nu am putut salva notita.' : 'Failed to save note.'));
        } finally {
            setAdminNoteSaving(false);
        }
    };

    const adminNoteStatusLabel = (statusRaw) => {
        const folded = String(statusRaw || '').trim().toLowerCase();
        if (folded === 'resolved') return lang === 'ro' ? 'Rezolvat' : 'Resolved';
        if (folded === 'not started') return lang === 'ro' ? 'Neinceput' : 'Not Started';
        return lang === 'ro' ? 'In progres' : 'In Progress';
    };

    const adminNoteStatusClass = (statusRaw) => {
        const folded = String(statusRaw || '').trim().toLowerCase();
        if (folded === 'resolved') return 'border-emerald-400/35 bg-emerald-500/20 text-emerald-200';
        if (folded === 'not started') return 'border-amber-400/35 bg-amber-500/20 text-amber-200';
        return 'border-sky-400/35 bg-sky-500/20 text-sky-200';
    };

    const updateAdminImprovementNoteStatus = async (noteId, statusValue) => {
        if (!isAdmin) return;
        const token = user?.token || localStorage.getItem('token');
        if (!token) return;
        const id = Number(noteId);
        if (!Number.isFinite(id) || id <= 0) return;
        const nextStatus = String(statusValue || '').trim();
        if (!nextStatus) return;

        setAdminNoteStatusBusy((prev) => ({ ...(prev || {}), [id]: true }));
        setAdminNoteMsg('');
        try {
            const updated = await updateAdminNote(token, id, { status: nextStatus });
            setAdminNotes((prev) => (Array.isArray(prev)
                ? prev.map((row) => (Number(row?.id) === id ? { ...row, ...updated } : row))
                : []));
        } catch (e) {
            const detail = String(e?.response?.data?.detail || e?.message || '').trim();
            setAdminNoteMsg(detail || (lang === 'ro' ? 'Nu am putut actualiza statusul notitei.' : 'Failed to update note status.'));
        } finally {
            setAdminNoteStatusBusy((prev) => ({ ...(prev || {}), [id]: false }));
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

    const formatDateTime = (value) => {
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

    const truckUnloadItems = Array.isArray(truckUnloadManifest?.items)
        ? truckUnloadManifest.items.slice().sort((a, b) => String(a?.awb || '').localeCompare(String(b?.awb || '')))
        : [];
    const fleetPlateOptions = Array.from(
        new Set(
            (Array.isArray(truckUnloadFleetVehicles) ? truckUnloadFleetVehicles : [])
                .map((row) => normalizePlate(row?.plate || ''))
                .filter(Boolean)
        )
    );

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

                {canReadStats && !isDriver ? (
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
                            onClick={openTruckUnloadPanel}
                            disabled={truckUnloadBusy}
                            className={`w-full p-5 rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent ${truckUnloadBusy
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
                                    {lang === 'ro'
                                        ? 'Selecteaza camionul, scaneaza AWB-uri, apoi aproba Intrare in depozit'
                                        : 'Select truck, scan AWBs, then approve In Depot'}
                                </p>
                            </div>
                            <div className="w-10 h-10 rounded-full glass-light flex items-center justify-center group-hover:translate-x-1 transition-transform border border-white/10">
                                <ChevronRight className="text-slate-400" size={18} />
                            </div>
                        </motion.button>
                    )}

                    {(isAdmin || isDriver) && (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => setShowTruckLoadPanel(true)}
                            className="w-full p-5 glass-strong rounded-[28px] shadow-lg flex items-center gap-4 text-left group border-iridescent"
                        >
                            <div className="p-4 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-[20px] group-hover:shadow-glow-sm transition-all duration-300">
                                <Truck size={24} className="text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-black text-white uppercase text-sm tracking-tight flex items-center gap-2">
                                    {lang === 'ro' ? 'Incarcare camion' : 'Load Truck'}
                                    {!isDriver && <span className="text-[8px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-bold">ADMIN VIEW</span>}
                                </h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                                    {lang === 'ro'
                                        ? 'Incarcati coletele in ordinea strict inversa a livrarilor LIFO'
                                        : 'Load parcels strictly in reverse delivery order LIFO'}
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
                    {!isDriver && canReadShipments && (
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

                    {!isDriver && canReadNotifications && (
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

                    {!isDriver && canReadUsers && (
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
                {showTruckUnloadPanel ? (
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
                            className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-[28px] border border-white/10 bg-slate-900/95 shadow-2xl flex flex-col"
                        >
                            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-4">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-black uppercase tracking-wide text-white">
                                        {lang === 'ro' ? 'Descarcare Camion' : 'Truck Unload'}
                                    </h3>
                                    <p className="text-[11px] font-semibold text-slate-400 mt-1">
                                        {lang === 'ro'
                                            ? 'Selectezi camionul, scanezi AWB-urile, apoi aprobi Intrare in depozit pentru toata lista.'
                                            : 'Select truck, scan AWBs, then approve In Depot for the full list.'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowTruckUnloadPanel(false);
                                        setTruckUnloadImportFile(null);
                                        setTruckUnloadImportSheetUrl('');
                                        setTruckUnloadImportSummary(null);
                                        if (truckUnloadImportFileRef.current) {
                                            truckUnloadImportFileRef.current.value = '';
                                        }
                                        setTruckUnloadError('');
                                        setTruckUnloadInfo('');
                                    }}
                                    className="w-9 h-9 rounded-full bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors flex items-center justify-center"
                                    aria-label={lang === 'ro' ? 'Inchide descarcare' : 'Close unload'}
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                                {truckUnloadError ? (
                                    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-200 text-xs font-bold px-4 py-3">
                                        {truckUnloadError}
                                    </div>
                                ) : null}

                                {truckUnloadInfo ? (
                                    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-xs font-bold px-4 py-3">
                                        {truckUnloadInfo}
                                    </div>
                                ) : null}

                                {!truckUnloadManifest ? (
                                    <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                                        <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                            {lang === 'ro' ? '1. Selectie camion' : '1. Truck selection'}
                                        </p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <select
                                                value={truckUnloadPlateChoice}
                                                onChange={(e) => setTruckUnloadPlateChoice(normalizePlate(e.target.value))}
                                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white outline-none"
                                            >
                                                <option value="">
                                                    {lang === 'ro' ? 'Selecteaza camion din flota' : 'Select truck from fleet'}
                                                </option>
                                                {fleetPlateOptions.map((plate) => (
                                                    <option key={plate} value={plate}>
                                                        {plate}
                                                    </option>
                                                ))}
                                            </select>
                                            <input
                                                value={truckUnloadExternalPlate}
                                                onChange={(e) => setTruckUnloadExternalPlate(normalizePlate(e.target.value))}
                                                placeholder={lang === 'ro' ? 'Sau introdu numar extern (ex: B99XYZ)' : 'Or external plate (e.g. B99XYZ)'}
                                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                            />
                                        </div>
                                        <p className="text-[11px] text-slate-500 font-semibold">
                                            {lang === 'ro'
                                                ? 'Poti selecta din fleet sau adauga un camion extern (alta companie).'
                                                : 'You can select from fleet or enter an external third-party truck.'}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={startTruckUnloadSession}
                                            disabled={truckUnloadBusy}
                                            className={`w-full px-4 py-3 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${truckUnloadBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                        >
                                            {truckUnloadBusy
                                                ? (lang === 'ro' ? 'Se creeaza sesiunea...' : 'Creating session...')
                                                : (lang === 'ro' ? 'Porneste Descarcarea' : 'Start Unload Session')}
                                        </button>
                                    </div>
                                ) : (
                                    <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div>
                                                <p className="text-sm font-black text-white">
                                                    {normalizePlate(truckUnloadManifest?.truck_plate || '--')} • #{truckUnloadManifest?.id}
                                                </p>
                                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                    {(truckUnloadManifest?.status || 'Open')} • {formatDateTime(truckUnloadManifest?.created_at)} • {truckUnloadItems.length} AWB
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setTruckUnloadManifest(null);
                                                    setTruckUnloadManualAwb('');
                                                    setTruckUnloadImportFile(null);
                                                    setTruckUnloadImportSheetUrl('');
                                                    setTruckUnloadImportSummary(null);
                                                    if (truckUnloadImportFileRef.current) {
                                                        truckUnloadImportFileRef.current.value = '';
                                                    }
                                                    setTruckUnloadError('');
                                                    setTruckUnloadInfo('');
                                                }}
                                                className="px-3 py-2 rounded-xl bg-slate-800/60 border border-white/10 text-slate-300 text-[10px] font-black uppercase tracking-widest"
                                            >
                                                {lang === 'ro' ? 'Sesiune Noua' : 'New Session'}
                                            </button>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => openScannerForMode('truck_unload_manifest')}
                                                disabled={truckUnloadBusy || String(truckUnloadManifest?.status || '').toLowerCase() !== 'open'}
                                                className={`px-3 py-3 rounded-2xl bg-violet-500/15 border border-violet-500/20 text-violet-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${truckUnloadBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                            >
                                                {lang === 'ro' ? 'Scaneaza AWB' : 'Scan AWB'}
                                            </button>
                                            <input
                                                value={truckUnloadManualAwb}
                                                onChange={(e) => setTruckUnloadManualAwb(e.target.value)}
                                                placeholder={lang === 'ro' ? 'Introdu AWB manual' : 'Enter AWB manually'}
                                                className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                            />
                                            <button
                                                type="button"
                                                onClick={addTruckUnloadManualAwb}
                                                disabled={truckUnloadBusy || !String(truckUnloadManualAwb || '').trim() || String(truckUnloadManifest?.status || '').toLowerCase() !== 'open'}
                                                className={`px-3 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${truckUnloadBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                            >
                                                {lang === 'ro' ? 'Adauga' : 'Add'}
                                            </button>
                                        </div>

                                        <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-3">
                                            <p className="text-[10px] text-cyan-200 font-black uppercase tracking-widest">
                                                {lang === 'ro'
                                                    ? 'Import AWB bulk (CSV / Excel / Google Sheet)'
                                                    : 'Bulk AWB import (CSV / Excel / Google Sheet)'}
                                            </p>
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                                <input
                                                    ref={truckUnloadImportFileRef}
                                                    type="file"
                                                    accept=".csv,.txt,.xlsx,.xls"
                                                    onChange={(e) => {
                                                        const picked = e?.target?.files?.[0] || null;
                                                        setTruckUnloadImportFile(picked);
                                                    }}
                                                    className="w-full px-3 py-2.5 bg-slate-900/40 border border-white/10 rounded-2xl text-[11px] text-slate-200 file:mr-2 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-2 file:py-1 file:text-[10px] file:font-black file:uppercase file:tracking-wider file:text-cyan-100"
                                                />
                                                <input
                                                    value={truckUnloadImportSheetUrl}
                                                    onChange={(e) => setTruckUnloadImportSheetUrl(e.target.value)}
                                                    placeholder={lang === 'ro' ? 'Sau URL Google Sheet (optional)' : 'Or Google Sheet URL (optional)'}
                                                    className="w-full px-4 py-3 bg-slate-900/40 border border-white/10 rounded-2xl text-white placeholder-slate-600 outline-none"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={importTruckUnloadAwbs}
                                                    disabled={truckUnloadBusy || String(truckUnloadManifest?.status || '').toLowerCase() !== 'open'}
                                                    className={`px-3 py-3 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${truckUnloadBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                                >
                                                    {truckUnloadBusy
                                                        ? (lang === 'ro' ? 'Import in curs...' : 'Importing...')
                                                        : (lang === 'ro' ? 'Importa AWB-uri' : 'Import AWBs')}
                                                </button>
                                            </div>

                                            {truckUnloadImportSummary ? (
                                                <div className="rounded-xl border border-cyan-500/25 bg-slate-900/35 px-3 py-2 text-[11px] text-slate-200 font-semibold">
                                                    <p>
                                                        {lang === 'ro' ? 'Rezumat import' : 'Import summary'}: {Number(truckUnloadImportSummary?.imported_count || 0)} {lang === 'ro' ? 'adaugate' : 'added'}, {Number(truckUnloadImportSummary?.duplicate_count || 0)} {lang === 'ro' ? 'duplicate' : 'duplicates'}, {Number(truckUnloadImportSummary?.invalid_count || 0)} {lang === 'ro' ? 'invalide' : 'invalid'}
                                                    </p>
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                                                        {lang === 'ro' ? 'Sursa' : 'Source'}: {String(truckUnloadImportSummary?.source || '--')}
                                                        {truckUnloadImportSummary?.filename ? ` • ${String(truckUnloadImportSummary?.filename)}` : ''}
                                                        {' • '}
                                                        {Number(truckUnloadImportSummary?.detected_tokens || 0)} {lang === 'ro' ? 'tokenuri detectate' : 'tokens detected'}
                                                    </p>
                                                </div>
                                            ) : null}
                                        </div>

                                        <button
                                            type="button"
                                            onClick={approveTruckUnloadSession}
                                            disabled={truckUnloadBusy || truckUnloadItems.length === 0 || String(truckUnloadManifest?.status || '').toLowerCase() !== 'open'}
                                            className={`w-full px-4 py-3 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 text-xs font-black uppercase tracking-widest active:scale-[0.99] transition-all ${truckUnloadBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                                        >
                                            {truckUnloadBusy
                                                ? (lang === 'ro' ? 'Se aproba descarcarea...' : 'Approving unload...')
                                                : (lang === 'ro' ? 'Aproba Descarcarea (Intrare in depozit)' : 'Approve Unload (In Depot)')}
                                        </button>

                                        <div className="rounded-2xl border border-white/10 bg-white/5 p-3 max-h-56 overflow-y-auto">
                                            {truckUnloadItems.length === 0 ? (
                                                <p className="text-xs font-semibold text-slate-500 text-center py-5">
                                                    {lang === 'ro' ? 'Nu exista AWB-uri scanate in aceasta sesiune.' : 'No scanned AWBs in this session yet.'}
                                                </p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {truckUnloadItems.map((item, idx) => (
                                                        <div key={`${item?.awb || 'awb'}-${idx}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2">
                                                            <AwbLink
                                                                awb={item?.awb}
                                                                className="text-xs font-black tracking-wide text-white cursor-pointer hover:text-emerald-300"
                                                                title="Deschide detalii AWB"
                                                            >
                                                                {String(item?.awb || '').toUpperCase()}
                                                            </AwbLink>
                                                            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                                                {Number(item?.scan_count || 0)} scan
                                                            </p>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                <div className="glass-strong p-5 rounded-3xl border border-white/10 space-y-3">
                                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                                        {lang === 'ro' ? 'Istoric descarcari camion' : 'Truck unload history'}
                                    </p>
                                    {truckUnloadHistoryBusy ? (
                                        <div className="py-6 flex items-center justify-center text-slate-400 gap-2">
                                            <Loader2 size={16} className="animate-spin" />
                                            <span className="text-xs font-bold uppercase tracking-wider">
                                                {lang === 'ro' ? 'Incarcare istoric...' : 'Loading history...'}
                                            </span>
                                        </div>
                                    ) : truckUnloadHistory.length === 0 ? (
                                        <div className="text-xs text-slate-500 font-bold uppercase tracking-wider text-center py-6">
                                            {lang === 'ro' ? 'Nu exista descarcari in istoric.' : 'No unload history yet.'}
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {truckUnloadHistory.map((m) => {
                                                const count = Array.isArray(m?.items) ? m.items.length : 0;
                                                return (
                                                    <button
                                                        key={m?.id || `${m?.truck_plate || ''}-${m?.created_at || ''}`}
                                                        type="button"
                                                        onClick={() => openTruckUnloadManifest(m?.id)}
                                                        className="w-full rounded-2xl border border-white/10 bg-white/5 p-3 text-left hover:bg-white/10 transition-colors"
                                                    >
                                                        <div className="flex items-center justify-between gap-3">
                                                            <p className="text-xs font-black text-white tracking-wide">
                                                                {normalizePlate(m?.truck_plate || '--')} • #{m?.id}
                                                            </p>
                                                            <p className="text-[10px] font-black uppercase tracking-wider text-cyan-300">
                                                                {String(m?.status || 'Open')}
                                                            </p>
                                                        </div>
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">
                                                            {formatDateTime(m?.created_at)} • {count} AWB
                                                        </p>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                ) : null}

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
                                        setAdminNoteStatus('In Progress');
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
                                <div className="flex items-center gap-2">
                                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                                        {lang === 'ro' ? 'Status' : 'Status'}
                                    </label>
                                    <select
                                        value={adminNoteStatus}
                                        onChange={(e) => setAdminNoteStatus(String(e.target.value || 'In Progress'))}
                                        className="rounded-xl bg-white/5 border border-white/10 text-white px-3 py-2 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
                                    >
                                        {ADMIN_NOTE_STATUS_OPTIONS.map((opt) => (
                                            <option key={opt.value} value={opt.value} className="bg-slate-900 text-white">
                                                {lang === 'ro' ? opt.ro : opt.en}
                                            </option>
                                        ))}
                                    </select>
                                </div>
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
                                            <div className="flex items-center gap-2">
                                                <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-full tracking-wide border ${adminNoteStatusClass(note?.status)}`}>
                                                    {adminNoteStatusLabel(note?.status)}
                                                </span>
                                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                                                    {formatAdminNoteDate(note?.created_at)}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-sm font-medium text-slate-100 whitespace-pre-wrap break-words">
                                            {String(note?.text || '')}
                                        </p>
                                        <div className="mt-3 flex items-center justify-end">
                                            <select
                                                value={String(note?.status || 'In Progress')}
                                                onChange={(e) => updateAdminImprovementNoteStatus(note?.id, e.target.value)}
                                                disabled={Boolean(adminNoteStatusBusy?.[Number(note?.id)])}
                                                className={`rounded-xl border px-3 py-1.5 text-[11px] font-black uppercase tracking-wider bg-slate-900/70 text-white ${adminNoteStatusClass(note?.status)} ${Boolean(adminNoteStatusBusy?.[Number(note?.id)]) ? 'opacity-70 cursor-wait' : ''}`}
                                            >
                                                {ADMIN_NOTE_STATUS_OPTIONS.map((opt) => (
                                                    <option key={opt.value} value={opt.value} className="bg-slate-900 text-white">
                                                        {lang === 'ro' ? opt.ro : opt.en}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            {showScanner && <Scanner continuous={scannerMode === 'truck_unload_manifest'} scanFeedback={scanFeedback} onScan={handleScannerScan} onClose={() => setShowScanner(false)} />}

            <TruckLoadPanel
                open={showTruckLoadPanel}
                onClose={() => setShowTruckLoadPanel(false)}
                user={user}
                lang={lang}
            />
        </motion.div>
    );
}
