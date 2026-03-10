import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CarFront, FileText, Gauge, Plus, Save, ShieldCheck, Truck, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../auth/rbac';
import { PERM_SHIPMENTS_READ, PERM_USERS_WRITE } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import {
    createFleetDocument,
    createFleetInsurance,
    createFleetService,
    createFleetVehicle,
    getFleetOverview,
    getVehicleTypes,
    listFleetDocuments,
    listFleetInsurances,
    listFleetServices,
    listFleetVehicles,
    listUsers,
    seedFleetAccounts,
    updateFleetDocument,
    updateFleetInsurance,
    updateFleetService,
    updateFleetVehicle,
} from '../services/api';

const TAB_KEYS = ['vehicle', 'documents', 'service', 'insurance', 'reminders'];

const toNumOrNull = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n;
};

const toDateIsoOrNull = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    return `${raw}T00:00:00`;
};

const fromIsoToDateInput = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
};

const statusColor = (status) => {
    const s = String(status || '').trim().toLowerCase();
    if (s.includes('expired') || s.includes('overdue')) return 'bg-rose-500/15 border-rose-500/30 text-rose-200';
    if (s.includes('expiring') || s.includes('duesoon')) return 'bg-amber-500/15 border-amber-500/30 text-amber-200';
    if (s.includes('valid') || s.includes('active') || s.includes('done')) return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200';
    return 'bg-slate-500/15 border-slate-500/30 text-slate-200';
};

const toUiError = (error, fallback) => {
    const detail = error?.response?.data?.detail || error?.message || fallback;
    if (/network error/i.test(String(detail || ''))) {
        return 'Network error: verifica Menu -> Settings -> API URL backend (HTTPS) si apasa Auto Detect Backend.';
    }
    return String(detail);
};

const emptyVehicleForm = {
    plate: '',
    label: '',
    assigned_driver_id: '',
    assigned_driver_name: '',
    assigned_phone: '',
    helper_name: '',
    vehicle_type_code: 'VAN_35T',
    vehicle_has_lift: false,
    max_volume_m3: '',
    target_volume_m3: '',
    max_weight_kg: '',
    target_weight_kg: '',
    odometer_km: '',
    notes: '',
};

const emptyDocForm = {
    category: 'itp',
    title: '',
    issuer: '',
    issue_date: '',
    expiry_date: '',
    reminder_days_before: '30',
    notes: '',
};

const emptyServiceForm = {
    service_type: 'revision',
    title: '',
    provider: '',
    performed_at: '',
    due_date: '',
    due_km: '',
    next_due_km: '',
    estimated_cost: '',
    actual_cost: '',
    currency: 'RON',
    reminder_days_before: '14',
    notes: '',
};

const emptyInsuranceForm = {
    insurance_type: 'rca',
    provider: '',
    policy_number: '',
    start_date: '',
    expiry_date: '',
    premium_amount: '',
    currency: 'RON',
    deductible: '',
    reminder_days_before: '30',
    notes: '',
};

export default function Fleet() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const token = user?.token || localStorage.getItem('token');
    const canRead = useMemo(() => hasPermission(user, PERM_SHIPMENTS_READ), [user]);
    const canWrite = useMemo(() => hasPermission(user, PERM_USERS_WRITE), [user]);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [msg, setMsg] = useState('');

    const [vehicles, setVehicles] = useState([]);
    const [overview, setOverview] = useState(null);
    const [vehicleTypes, setVehicleTypes] = useState([]);
    const [drivers, setDrivers] = useState([]);

    const [selectedVehicleId, setSelectedVehicleId] = useState(null);
    const [activeTab, setActiveTab] = useState('vehicle');

    const [vehicleForm, setVehicleForm] = useState(emptyVehicleForm);
    const [newVehicleForm, setNewVehicleForm] = useState(emptyVehicleForm);

    const [documents, setDocuments] = useState([]);
    const [services, setServices] = useState([]);
    const [insurances, setInsurances] = useState([]);

    const [editDocumentId, setEditDocumentId] = useState(null);
    const [editServiceId, setEditServiceId] = useState(null);
    const [editInsuranceId, setEditInsuranceId] = useState(null);

    const [docForm, setDocForm] = useState(emptyDocForm);
    const [serviceForm, setServiceForm] = useState(emptyServiceForm);
    const [insuranceForm, setInsuranceForm] = useState(emptyInsuranceForm);

    const vehicleTypesByCode = useMemo(() => {
        const map = new Map();
        (Array.isArray(vehicleTypes) ? vehicleTypes : []).forEach((row) => {
            const code = String(row?.code || '').trim().toUpperCase();
            if (!code) return;
            map.set(code, row);
        });
        return map;
    }, [vehicleTypes]);

    const driversById = useMemo(() => {
        const map = new Map();
        (Array.isArray(drivers) ? drivers : []).forEach((d) => {
            const id = String(d?.driver_id || '').trim().toUpperCase();
            if (!id) return;
            map.set(id, d);
        });
        return map;
    }, [drivers]);

    const selectedVehicle = useMemo(() => (
        (Array.isArray(vehicles) ? vehicles : []).find((v) => Number(v?.id) === Number(selectedVehicleId)) || null
    ), [vehicles, selectedVehicleId]);

    const refreshOverview = async () => {
        const data = await getFleetOverview(token, { days: 45, include_inactive: false });
        setOverview(data || null);
    };

    const refreshVehicles = async ({ keepSelected = true } = {}) => {
        const rows = await listFleetVehicles(token, { include_inactive: false, sync_from_drivers: true });
        const list = Array.isArray(rows) ? rows : [];
        setVehicles(list);

        if (!list.length) {
            setSelectedVehicleId(null);
            return list;
        }

        if (keepSelected && selectedVehicleId) {
            const hasCurrent = list.some((v) => Number(v?.id) === Number(selectedVehicleId));
            if (hasCurrent) return list;
        }

        setSelectedVehicleId(Number(list[0]?.id));
        return list;
    };

    const refreshRecords = async (vehicleId) => {
        const id = Number(vehicleId);
        if (!Number.isFinite(id) || id <= 0) {
            setDocuments([]);
            setServices([]);
            setInsurances([]);
            return;
        }
        const [docsRes, servicesRes, insRes] = await Promise.all([
            listFleetDocuments(token, id),
            listFleetServices(token, id),
            listFleetInsurances(token, id),
        ]);
        setDocuments(Array.isArray(docsRes) ? docsRes : []);
        setServices(Array.isArray(servicesRes) ? servicesRes : []);
        setInsurances(Array.isArray(insRes) ? insRes : []);
    };

    const refreshAll = async () => {
        setLoading(true);
        setError('');
        try {
            const [typesRes, usersRes] = await Promise.all([
                getVehicleTypes(token).catch(() => []),
                listUsers(token).catch(() => []),
            ]);
            setVehicleTypes(Array.isArray(typesRes) ? typesRes : []);
            setDrivers(Array.isArray(usersRes) ? usersRes.filter((u) => String(u?.role || '').trim() === 'Driver') : []);

            const [vehiclesRows] = await Promise.all([
                refreshVehicles({ keepSelected: true }),
                refreshOverview(),
            ]);

            if ((Array.isArray(vehiclesRows) ? vehiclesRows.length : 0) === 0 && canWrite) {
                await seedFleetAccounts(token, { reset_passwords: true }).catch(() => []);
                await Promise.all([
                    refreshVehicles({ keepSelected: true }),
                    refreshOverview(),
                ]);
                setMsg('Am sincronizat conturile si vehiculele flotei.');
            }
        } catch (e) {
            setError(toUiError(e, 'Failed to load fleet'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!canRead) {
            setLoading(false);
            return;
        }
        void refreshAll();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canRead, token]);

    useEffect(() => {
        if (!selectedVehicle) {
            setVehicleForm(emptyVehicleForm);
            return;
        }
        setVehicleForm({
            plate: String(selectedVehicle?.plate || ''),
            label: String(selectedVehicle?.label || ''),
            assigned_driver_id: String(selectedVehicle?.assigned_driver_id || '').toUpperCase(),
            assigned_driver_name: String(selectedVehicle?.assigned_driver_name || ''),
            assigned_phone: String(selectedVehicle?.assigned_phone || ''),
            helper_name: String(selectedVehicle?.helper_name || ''),
            vehicle_type_code: String(selectedVehicle?.vehicle_type_code || 'VAN_35T').toUpperCase(),
            vehicle_has_lift: Boolean(selectedVehicle?.vehicle_has_lift),
            max_volume_m3: selectedVehicle?.max_volume_m3 != null ? String(selectedVehicle.max_volume_m3) : '',
            target_volume_m3: selectedVehicle?.target_volume_m3 != null ? String(selectedVehicle.target_volume_m3) : '',
            max_weight_kg: selectedVehicle?.max_weight_kg != null ? String(selectedVehicle.max_weight_kg) : '',
            target_weight_kg: selectedVehicle?.target_weight_kg != null ? String(selectedVehicle.target_weight_kg) : '',
            odometer_km: selectedVehicle?.odometer_km != null ? String(selectedVehicle.odometer_km) : '',
            notes: String(selectedVehicle?.notes || ''),
        });
    }, [selectedVehicle]);

    useEffect(() => {
        void refreshRecords(selectedVehicleId);
        setEditDocumentId(null);
        setEditServiceId(null);
        setEditInsuranceId(null);
        setDocForm(emptyDocForm);
        setServiceForm(emptyServiceForm);
        setInsuranceForm(emptyInsuranceForm);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedVehicleId]);

    const applyDriverOnForm = (driverId, target = 'vehicle') => {
        const key = String(driverId || '').trim().toUpperCase();
        const d = driversById.get(key);
        if (!d) return;

        const update = (prev) => ({
            ...prev,
            assigned_driver_id: key,
            assigned_driver_name: String(d?.name || '').trim(),
            assigned_phone: String(d?.phone_number || '').trim(),
            helper_name: String(d?.helper_name || '').trim(),
            vehicle_type_code: String(d?.vehicle_type_code || prev.vehicle_type_code || 'VAN_35T').toUpperCase(),
            vehicle_has_lift: typeof d?.vehicle_has_lift === 'boolean' ? Boolean(d.vehicle_has_lift) : Boolean(prev.vehicle_has_lift),
            max_volume_m3: d?.max_volume_m3 != null ? String(d.max_volume_m3) : prev.max_volume_m3,
            target_volume_m3: d?.target_volume_m3 != null ? String(d.target_volume_m3) : prev.target_volume_m3,
            max_weight_kg: d?.max_weight_kg != null ? String(d.max_weight_kg) : prev.max_weight_kg,
            target_weight_kg: d?.target_weight_kg != null ? String(d.target_weight_kg) : prev.target_weight_kg,
            plate: String(d?.truck_plate || prev.plate || '').toUpperCase(),
        });

        if (target === 'new') {
            setNewVehicleForm(update);
        } else {
            setVehicleForm(update);
        }
    };

    const validateCapacity = (payload) => {
        const maxVol = Number(payload.max_volume_m3);
        const targetVol = Number(payload.target_volume_m3);
        const maxKg = Number(payload.max_weight_kg);
        const targetKg = Number(payload.target_weight_kg);

        if (Number.isFinite(maxVol) && Number.isFinite(targetVol) && targetVol > maxVol) {
            throw new Error('Volumul util nu poate depasi volumul maxim.');
        }
        if (Number.isFinite(maxKg) && Number.isFinite(targetKg) && targetKg > maxKg) {
            throw new Error('Greutatea utila nu poate depasi greutatea maxima.');
        }
    };

    const vehiclePayload = (form) => {
        const payload = {
            plate: String(form.plate || '').trim().toUpperCase() || null,
            label: String(form.label || '').trim() || null,
            assigned_driver_id: String(form.assigned_driver_id || '').trim().toUpperCase() || null,
            assigned_driver_name: String(form.assigned_driver_name || '').trim() || null,
            assigned_phone: String(form.assigned_phone || '').trim() || null,
            helper_name: String(form.helper_name || '').trim() || null,
            vehicle_type_code: String(form.vehicle_type_code || '').trim().toUpperCase() || null,
            vehicle_has_lift: Boolean(form.vehicle_has_lift),
            max_volume_m3: toNumOrNull(form.max_volume_m3),
            target_volume_m3: toNumOrNull(form.target_volume_m3),
            max_weight_kg: toNumOrNull(form.max_weight_kg),
            target_weight_kg: toNumOrNull(form.target_weight_kg),
            odometer_km: toNumOrNull(form.odometer_km),
            notes: String(form.notes || '').trim() || null,
            active: true,
        };
        validateCapacity(payload);
        return payload;
    };

    const saveVehicle = async () => {
        if (!canWrite || !selectedVehicle) return;
        setSaving(true);
        setError('');
        setMsg('');
        try {
            await updateFleetVehicle(token, selectedVehicle.id, vehiclePayload(vehicleForm));
            await Promise.all([refreshVehicles({ keepSelected: true }), refreshOverview()]);
            setMsg('Vehicul actualizat.');
        } catch (e) {
            setError(toUiError(e, 'Nu am putut salva vehiculul'));
        } finally {
            setSaving(false);
        }
    };

    const addVehicle = async () => {
        if (!canWrite) return;
        setSaving(true);
        setError('');
        setMsg('');
        try {
            const created = await createFleetVehicle(token, vehiclePayload(newVehicleForm));
            await Promise.all([refreshVehicles({ keepSelected: false }), refreshOverview()]);
            if (created?.id) setSelectedVehicleId(Number(created.id));
            setNewVehicleForm(emptyVehicleForm);
            setMsg('Vehicul nou adaugat.');
        } catch (e) {
            setError(toUiError(e, 'Nu am putut adauga vehiculul'));
        } finally {
            setSaving(false);
        }
    };

    const submitDoc = async () => {
        if (!canWrite || !selectedVehicle) return;
        const payload = {
            category: String(docForm.category || '').trim() || null,
            title: String(docForm.title || '').trim(),
            issuer: String(docForm.issuer || '').trim() || null,
            issue_date: toDateIsoOrNull(docForm.issue_date),
            expiry_date: toDateIsoOrNull(docForm.expiry_date),
            reminder_days_before: Number(docForm.reminder_days_before || 30),
            notes: String(docForm.notes || '').trim() || null,
        };
        if (!payload.title) {
            setError('Titlul documentului este obligatoriu.');
            return;
        }
        setSaving(true);
        setError('');
        setMsg('');
        try {
            if (editDocumentId) {
                await updateFleetDocument(token, selectedVehicle.id, editDocumentId, payload);
            } else {
                await createFleetDocument(token, selectedVehicle.id, payload);
            }
            await Promise.all([refreshRecords(selectedVehicle.id), refreshOverview()]);
            setEditDocumentId(null);
            setDocForm(emptyDocForm);
            setMsg(editDocumentId ? 'Document actualizat.' : 'Document adaugat.');
        } catch (e) {
            setError(toUiError(e, 'Nu am putut salva documentul'));
        } finally {
            setSaving(false);
        }
    };

    const submitService = async () => {
        if (!canWrite || !selectedVehicle) return;
        const payload = {
            service_type: String(serviceForm.service_type || '').trim() || null,
            title: String(serviceForm.title || '').trim(),
            provider: String(serviceForm.provider || '').trim() || null,
            performed_at: toDateIsoOrNull(serviceForm.performed_at),
            due_date: toDateIsoOrNull(serviceForm.due_date),
            due_km: toNumOrNull(serviceForm.due_km),
            next_due_km: toNumOrNull(serviceForm.next_due_km),
            estimated_cost: toNumOrNull(serviceForm.estimated_cost),
            actual_cost: toNumOrNull(serviceForm.actual_cost),
            currency: String(serviceForm.currency || '').trim() || null,
            reminder_days_before: Number(serviceForm.reminder_days_before || 14),
            notes: String(serviceForm.notes || '').trim() || null,
        };
        if (!payload.title) {
            setError('Titlul serviciului este obligatoriu.');
            return;
        }

        setSaving(true);
        setError('');
        setMsg('');
        try {
            if (editServiceId) {
                await updateFleetService(token, selectedVehicle.id, editServiceId, payload);
            } else {
                await createFleetService(token, selectedVehicle.id, payload);
            }
            await Promise.all([refreshRecords(selectedVehicle.id), refreshOverview()]);
            setEditServiceId(null);
            setServiceForm(emptyServiceForm);
            setMsg(editServiceId ? 'Service actualizat.' : 'Service adaugat.');
        } catch (e) {
            setError(toUiError(e, 'Nu am putut salva service-ul'));
        } finally {
            setSaving(false);
        }
    };

    const submitInsurance = async () => {
        if (!canWrite || !selectedVehicle) return;
        const payload = {
            insurance_type: String(insuranceForm.insurance_type || '').trim() || null,
            provider: String(insuranceForm.provider || '').trim() || null,
            policy_number: String(insuranceForm.policy_number || '').trim() || null,
            start_date: toDateIsoOrNull(insuranceForm.start_date),
            expiry_date: toDateIsoOrNull(insuranceForm.expiry_date),
            premium_amount: toNumOrNull(insuranceForm.premium_amount),
            currency: String(insuranceForm.currency || '').trim() || null,
            deductible: toNumOrNull(insuranceForm.deductible),
            reminder_days_before: Number(insuranceForm.reminder_days_before || 30),
            notes: String(insuranceForm.notes || '').trim() || null,
        };

        setSaving(true);
        setError('');
        setMsg('');
        try {
            if (editInsuranceId) {
                await updateFleetInsurance(token, selectedVehicle.id, editInsuranceId, payload);
            } else {
                await createFleetInsurance(token, selectedVehicle.id, payload);
            }
            await Promise.all([refreshRecords(selectedVehicle.id), refreshOverview()]);
            setEditInsuranceId(null);
            setInsuranceForm(emptyInsuranceForm);
            setMsg(editInsuranceId ? 'Asigurare actualizata.' : 'Asigurare adaugata.');
        } catch (e) {
            setError(toUiError(e, 'Nu am putut salva asigurarea'));
        } finally {
            setSaving(false);
        }
    };

    const preloadDoc = (row) => {
        setEditDocumentId(Number(row?.id));
        setDocForm({
            category: String(row?.category || 'itp'),
            title: String(row?.title || ''),
            issuer: String(row?.issuer || ''),
            issue_date: fromIsoToDateInput(row?.issue_date),
            expiry_date: fromIsoToDateInput(row?.expiry_date),
            reminder_days_before: String(row?.reminder_days_before ?? 30),
            notes: String(row?.notes || ''),
        });
    };

    const preloadService = (row) => {
        setEditServiceId(Number(row?.id));
        setServiceForm({
            service_type: String(row?.service_type || 'revision'),
            title: String(row?.title || ''),
            provider: String(row?.provider || ''),
            performed_at: fromIsoToDateInput(row?.performed_at),
            due_date: fromIsoToDateInput(row?.due_date),
            due_km: row?.due_km != null ? String(row.due_km) : '',
            next_due_km: row?.next_due_km != null ? String(row.next_due_km) : '',
            estimated_cost: row?.estimated_cost != null ? String(row.estimated_cost) : '',
            actual_cost: row?.actual_cost != null ? String(row.actual_cost) : '',
            currency: String(row?.currency || 'RON'),
            reminder_days_before: String(row?.reminder_days_before ?? 14),
            notes: String(row?.notes || ''),
        });
    };

    const preloadInsurance = (row) => {
        setEditInsuranceId(Number(row?.id));
        setInsuranceForm({
            insurance_type: String(row?.insurance_type || 'rca'),
            provider: String(row?.provider || ''),
            policy_number: String(row?.policy_number || ''),
            start_date: fromIsoToDateInput(row?.start_date),
            expiry_date: fromIsoToDateInput(row?.expiry_date),
            premium_amount: row?.premium_amount != null ? String(row.premium_amount) : '',
            currency: String(row?.currency || 'RON'),
            deductible: row?.deductible != null ? String(row.deductible) : '',
            reminder_days_before: String(row?.reminder_days_before ?? 30),
            notes: String(row?.notes || ''),
        });
    };

    if (!canRead) {
        return (
            <div className="min-h-screen p-8 text-slate-400 text-sm font-bold uppercase tracking-widest">
                Nu ai permisiune pentru Fleet.
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-8 right-0 w-[26rem] h-[26rem] bg-emerald-500/10 rounded-full blur-3xl animate-float" />
            <div className="absolute bottom-10 left-0 w-80 h-80 bg-cyan-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }} />

            <header className="px-6 py-5 sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-black text-gradient tracking-tight">Fleet Control Center</h1>
                        <p className="text-xs text-slate-400 font-medium mt-1">Vehicule, acte, service, asigurari, reminders</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => navigate('/users')}
                        className="px-3 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500/25 transition-all"
                    >
                        Users
                    </button>
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 relative z-10 space-y-4">
                {error ? <div className="glass-strong rounded-2xl border border-rose-500/30 p-4 text-rose-200 text-xs font-bold">{error}</div> : null}
                {msg ? <div className="glass-strong rounded-2xl border border-emerald-500/30 p-4 text-emerald-200 text-xs font-bold">{msg}</div> : null}

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Truck size={14} /> Vehicule</div>
                        <p className="text-2xl font-black text-white mt-2">{Number(overview?.vehicles_total || 0)}</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><CarFront size={14} /> Cu lift</div>
                        <p className="text-2xl font-black text-white mt-2">{Number(overview?.vehicles_with_lift || 0)}</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><Gauge size={14} /> Volum util total</div>
                        <p className="text-lg font-black text-white mt-2">{Number(overview?.target_volume_m3_total || 0).toFixed(1)} mc</p>
                    </div>
                    <div className="glass-strong rounded-3xl border border-white/10 p-4">
                        <div className="flex items-center gap-2 text-slate-400 text-[10px] font-black uppercase tracking-widest"><ShieldCheck size={14} /> Reminder-uri</div>
                        <p className="text-lg font-black text-white mt-2">{Number(overview?.reminders_due_soon || 0)} due soon / {Number(overview?.reminders_overdue || 0)} overdue</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
                    <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Vehicles</p>
                            <button
                                type="button"
                                onClick={() => void refreshAll()}
                                className="px-2 py-1 rounded-xl border border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white"
                            >
                                Refresh
                            </button>
                        </div>

                        <div className="max-h-[420px] overflow-auto space-y-2 pr-1">
                            {loading ? (
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-widest text-center py-8">Loading...</div>
                            ) : (Array.isArray(vehicles) ? vehicles : []).length === 0 ? (
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-widest text-center py-8">No vehicles</div>
                            ) : (
                                (Array.isArray(vehicles) ? vehicles : []).map((v) => {
                                    const selected = Number(v?.id) === Number(selectedVehicleId);
                                    const typeLabel = vehicleTypesByCode.get(String(v?.vehicle_type_code || '').trim().toUpperCase())?.label || String(v?.vehicle_type_code || 'N/A');
                                    return (
                                        <button
                                            key={v?.id}
                                            type="button"
                                            onClick={() => setSelectedVehicleId(Number(v?.id))}
                                            className={`w-full p-3 rounded-2xl border text-left transition-all ${selected ? 'bg-emerald-500/20 border-emerald-500/35 text-emerald-100' : 'bg-white/5 border-white/10 text-slate-200 hover:border-emerald-500/30'}`}
                                        >
                                            <p className="text-sm font-black truncate">{String(v?.plate || '--')}</p>
                                            <p className="text-[10px] font-bold uppercase tracking-wide mt-1 truncate">{typeLabel} • {String(v?.assigned_driver_name || v?.assigned_driver_id || 'Unassigned')}</p>
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        {canWrite ? (
                            <div className="pt-3 border-t border-white/10 space-y-2">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Add vehicle</p>
                                <div className="grid grid-cols-2 gap-2">
                                    <input value={newVehicleForm.plate} onChange={(e) => setNewVehicleForm((p) => ({ ...p, plate: e.target.value.toUpperCase() }))} placeholder="Plate" className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs font-mono" />
                                    <select value={newVehicleForm.assigned_driver_id} onChange={(e) => { setNewVehicleForm((p) => ({ ...p, assigned_driver_id: e.target.value })); applyDriverOnForm(e.target.value, 'new'); }} className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs">
                                        <option value="">Driver</option>
                                        {(Array.isArray(drivers) ? drivers : []).map((d) => (
                                            <option key={d?.driver_id} value={String(d?.driver_id || '').toUpperCase()}>{String(d?.driver_id || '').toUpperCase()} • {d?.name}</option>
                                        ))}
                                    </select>
                                    <select value={newVehicleForm.vehicle_type_code} onChange={(e) => setNewVehicleForm((p) => ({ ...p, vehicle_type_code: e.target.value.toUpperCase() }))} className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs col-span-2">
                                        {(Array.isArray(vehicleTypes) ? vehicleTypes : []).map((t) => (
                                            <option key={t?.code} value={String(t?.code || '').toUpperCase()}>{t?.label || t?.code}</option>
                                        ))}
                                    </select>
                                </div>
                                <button type="button" onClick={() => void addVehicle()} disabled={saving} className="w-full py-2.5 rounded-xl bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2">
                                    <Plus size={14} /> Add
                                </button>
                            </div>
                        ) : null}
                    </div>

                    <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-4">
                        <div className="flex flex-wrap gap-2">
                            {TAB_KEYS.map((key) => {
                                const active = activeTab === key;
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => setActiveTab(key)}
                                        className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${active ? 'bg-emerald-500/20 border-emerald-500/35 text-emerald-100' : 'bg-slate-900/30 border-white/10 text-slate-400 hover:text-slate-200'}`}
                                    >
                                        {key}
                                    </button>
                                );
                            })}
                        </div>

                        {activeTab === 'vehicle' ? (
                            <div className="space-y-3">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Vehicle Profile</p>
                                {!selectedVehicle ? (
                                    <p className="text-slate-500 text-sm">Selecteaza un vehicul.</p>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={vehicleForm.plate} onChange={(e) => setVehicleForm((p) => ({ ...p, plate: e.target.value.toUpperCase() }))} placeholder="Plate" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white font-mono" />
                                            <input value={vehicleForm.label} onChange={(e) => setVehicleForm((p) => ({ ...p, label: e.target.value }))} placeholder="Label" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <select value={vehicleForm.assigned_driver_id} onChange={(e) => { setVehicleForm((p) => ({ ...p, assigned_driver_id: e.target.value })); applyDriverOnForm(e.target.value, 'vehicle'); }} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                                <option value="">Driver unassigned</option>
                                                {(Array.isArray(drivers) ? drivers : []).map((d) => (
                                                    <option key={d?.driver_id} value={String(d?.driver_id || '').toUpperCase()}>{String(d?.driver_id || '').toUpperCase()} • {d?.name}</option>
                                                ))}
                                            </select>
                                            <input value={vehicleForm.assigned_phone} onChange={(e) => setVehicleForm((p) => ({ ...p, assigned_phone: e.target.value }))} placeholder="Phone" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <select value={vehicleForm.vehicle_type_code} onChange={(e) => setVehicleForm((p) => ({ ...p, vehicle_type_code: e.target.value.toUpperCase() }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                                {(Array.isArray(vehicleTypes) ? vehicleTypes : []).map((t) => (
                                                    <option key={t?.code} value={String(t?.code || '').toUpperCase()}>{t?.label || t?.code}</option>
                                                ))}
                                            </select>
                                            <label className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white flex items-center gap-2 select-none">
                                                <input type="checkbox" checked={Boolean(vehicleForm.vehicle_has_lift)} onChange={(e) => setVehicleForm((p) => ({ ...p, vehicle_has_lift: e.target.checked }))} />
                                                <span className="text-sm font-bold">Lift</span>
                                            </label>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={vehicleForm.max_volume_m3} onChange={(e) => setVehicleForm((p) => ({ ...p, max_volume_m3: e.target.value }))} type="number" step="0.1" min="0" placeholder="Max volume m3" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.target_volume_m3} onChange={(e) => setVehicleForm((p) => ({ ...p, target_volume_m3: e.target.value }))} type="number" step="0.1" min="0" placeholder="Target volume m3" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.max_weight_kg} onChange={(e) => setVehicleForm((p) => ({ ...p, max_weight_kg: e.target.value }))} type="number" step="1" min="0" placeholder="Max weight kg" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.target_weight_kg} onChange={(e) => setVehicleForm((p) => ({ ...p, target_weight_kg: e.target.value }))} type="number" step="1" min="0" placeholder="Target weight kg" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.odometer_km} onChange={(e) => setVehicleForm((p) => ({ ...p, odometer_km: e.target.value }))} type="number" step="1" min="0" placeholder="Odometer km" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.helper_name} onChange={(e) => setVehicleForm((p) => ({ ...p, helper_name: e.target.value }))} placeholder="Helper name" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                        </div>

                                        <textarea value={vehicleForm.notes} onChange={(e) => setVehicleForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Notes" rows={3} className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />

                                        {canWrite ? (
                                            <button type="button" onClick={() => void saveVehicle()} disabled={saving} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all">
                                                <Save size={16} /> Save vehicle
                                            </button>
                                        ) : null}
                                    </>
                                )}
                            </div>
                        ) : null}

                        {activeTab === 'documents' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Documents</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={docForm.category} onChange={(e) => setDocForm((p) => ({ ...p, category: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="itp">ITP</option>
                                        <option value="rovinieta">Rovinieta</option>
                                        <option value="talon">Talon</option>
                                        <option value="license">Licenta</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                    <input value={docForm.title} onChange={(e) => setDocForm((p) => ({ ...p, title: e.target.value }))} placeholder="Title" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.issuer} onChange={(e) => setDocForm((p) => ({ ...p, issuer: e.target.value }))} placeholder="Issuer" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.issue_date} onChange={(e) => setDocForm((p) => ({ ...p, issue_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.expiry_date} onChange={(e) => setDocForm((p) => ({ ...p, expiry_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.reminder_days_before} onChange={(e) => setDocForm((p) => ({ ...p, reminder_days_before: e.target.value }))} type="number" min="0" placeholder="Reminder days" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={docForm.notes} onChange={(e) => setDocForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder="Notes" className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? (
                                    <button type="button" onClick={() => void submitDoc()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editDocumentId ? 'Update document' : 'Add document'}</button>
                                ) : null}

                                <div className="space-y-2">
                                    {(Array.isArray(documents) ? documents : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadDoc(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{row?.title || 'Document'}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || 'Valid'}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{row?.category || 'doc'} • expires {fromIsoToDateInput(row?.expiry_date) || '--'}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'service' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Service & Maintenance</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={serviceForm.service_type} onChange={(e) => setServiceForm((p) => ({ ...p, service_type: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="revision">Revision</option>
                                        <option value="oil">Oil</option>
                                        <option value="tires">Tires</option>
                                        <option value="brakes">Brakes</option>
                                        <option value="repairs">Repairs</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                    <input value={serviceForm.title} onChange={(e) => setServiceForm((p) => ({ ...p, title: e.target.value }))} placeholder="Title" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.provider} onChange={(e) => setServiceForm((p) => ({ ...p, provider: e.target.value }))} placeholder="Provider" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.performed_at} onChange={(e) => setServiceForm((p) => ({ ...p, performed_at: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.due_date} onChange={(e) => setServiceForm((p) => ({ ...p, due_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.due_km} onChange={(e) => setServiceForm((p) => ({ ...p, due_km: e.target.value }))} type="number" min="0" placeholder="Due km" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.next_due_km} onChange={(e) => setServiceForm((p) => ({ ...p, next_due_km: e.target.value }))} type="number" min="0" placeholder="Next due km" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.estimated_cost} onChange={(e) => setServiceForm((p) => ({ ...p, estimated_cost: e.target.value }))} type="number" min="0" step="0.01" placeholder="Estimated cost" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.actual_cost} onChange={(e) => setServiceForm((p) => ({ ...p, actual_cost: e.target.value }))} type="number" min="0" step="0.01" placeholder="Actual cost" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={serviceForm.notes} onChange={(e) => setServiceForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder="Notes" className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? <button type="button" onClick={() => void submitService()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editServiceId ? 'Update service' : 'Add service'}</button> : null}

                                <div className="space-y-2">
                                    {(Array.isArray(services) ? services : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadService(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{row?.title || 'Service'}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || 'Planned'}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{row?.service_type || 'service'} • due {fromIsoToDateInput(row?.due_date) || '--'} • {row?.due_km ?? '--'} km</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'insurance' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Insurance</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={insuranceForm.insurance_type} onChange={(e) => setInsuranceForm((p) => ({ ...p, insurance_type: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="rca">RCA</option>
                                        <option value="casco">CASCO</option>
                                        <option value="cargo">Cargo</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                    <input value={insuranceForm.provider} onChange={(e) => setInsuranceForm((p) => ({ ...p, provider: e.target.value }))} placeholder="Provider" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.policy_number} onChange={(e) => setInsuranceForm((p) => ({ ...p, policy_number: e.target.value }))} placeholder="Policy number" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.start_date} onChange={(e) => setInsuranceForm((p) => ({ ...p, start_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.expiry_date} onChange={(e) => setInsuranceForm((p) => ({ ...p, expiry_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.premium_amount} onChange={(e) => setInsuranceForm((p) => ({ ...p, premium_amount: e.target.value }))} type="number" min="0" step="0.01" placeholder="Premium" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.deductible} onChange={(e) => setInsuranceForm((p) => ({ ...p, deductible: e.target.value }))} type="number" min="0" step="0.01" placeholder="Deductible" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={insuranceForm.notes} onChange={(e) => setInsuranceForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder="Notes" className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? <button type="button" onClick={() => void submitInsurance()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editInsuranceId ? 'Update insurance' : 'Add insurance'}</button> : null}

                                <div className="space-y-2">
                                    {(Array.isArray(insurances) ? insurances : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadInsurance(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{String(row?.insurance_type || 'Insurance').toUpperCase()} • {row?.provider || '--'}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || 'Active'}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">policy {row?.policy_number || '--'} • expires {fromIsoToDateInput(row?.expiry_date) || '--'}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'reminders' ? (
                            <div className="space-y-3">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Reminders (45 days)</p>
                                {Array.isArray(overview?.reminders) && overview.reminders.length > 0 ? (
                                    overview.reminders.map((r) => (
                                        <div key={`${r?.kind}-${r?.id}`} className="p-3 rounded-2xl bg-white/5 border border-white/10">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{String(r?.plate || '--')} • {r?.title || r?.kind}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(r?.status)}`}>{r?.status || '--'}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{r?.kind} • due {fromIsoToDateInput(r?.due_at) || '--'} • {Number(r?.days_left) < 0 ? `${Math.abs(Number(r?.days_left))} zile intarziere` : `${r?.days_left} zile`}</p>
                                        </div>
                                    ))
                                ) : (
                                    <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-200 text-sm font-bold">Niciun reminder critic. Flota este in regula.</div>
                                )}

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
                                    <button type="button" className="w-full p-4 rounded-2xl glass-light border border-white/10 flex items-center justify-between text-left hover:border-emerald-500/30 transition-all">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center"><FileText size={18} className="text-emerald-300" /></div>
                                            <div className="min-w-0"><p className="text-white font-black truncate">Acte administrative</p></div>
                                        </div>
                                        <ArrowRight size={16} className="text-slate-500" />
                                    </button>
                                    <button type="button" className="w-full p-4 rounded-2xl glass-light border border-white/10 flex items-center justify-between text-left hover:border-emerald-500/30 transition-all">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-10 h-10 rounded-2xl bg-cyan-500/15 border border-cyan-500/20 flex items-center justify-center"><Wrench size={18} className="text-cyan-300" /></div>
                                            <div className="min-w-0"><p className="text-white font-black truncate">Service & mentenanta</p></div>
                                        </div>
                                        <ArrowRight size={16} className="text-slate-500" />
                                    </button>
                                    <button type="button" className="w-full p-4 rounded-2xl glass-light border border-white/10 flex items-center justify-between text-left hover:border-emerald-500/30 transition-all">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center"><ShieldCheck size={18} className="text-amber-300" /></div>
                                            <div className="min-w-0"><p className="text-white font-black truncate">Asigurari</p></div>
                                        </div>
                                        <ArrowRight size={16} className="text-slate-500" />
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </motion.div>
    );
}
