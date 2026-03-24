import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CarFront, FileText, Gauge, Plus, Save, ShieldCheck, Truck, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../auth/rbac';
import { PERM_SHIPMENTS_READ, PERM_USERS_WRITE } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
    createFleetDocument,
    createFleetAssignment,
    createFleetInsurance,
    createFleetPhone,
    createFleetService,
    createFleetVehicle,
    getFleetOverview,
    getVehicleTypes,
    listFleetActiveAssignments,
    listFleetDocuments,
    listFleetInsurances,
    listFleetPhones,
    listFleetServices,
    listFleetVehicles,
    listUsers,
    seedFleetAccounts,
    updateFleetDocument,
    updateFleetInsurance,
    updateFleetPhone,
    updateFleetService,
    updateFleetVehicle,
    deleteFleetVehicle,
} from '../services/api';
import { toUiError } from '../services/uiErrors';

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

const emptyAssignmentForm = {
    driver_id: '',
    vehicle_id: '',
    phone_id: '',
    phone_label: '',
};

const emptyPhoneForm = {
    phone_number: '',
    label: '',
};

const vehicleFormFromVehicle = (vehicle) => ({
    plate: String(vehicle?.plate || ''),
    label: String(vehicle?.label || ''),
    assigned_driver_id: String(vehicle?.assigned_driver_id || '').toUpperCase(),
    assigned_driver_name: String(vehicle?.assigned_driver_name || ''),
    assigned_phone: String(vehicle?.assigned_phone || ''),
    helper_name: String(vehicle?.helper_name || ''),
    vehicle_type_code: String(vehicle?.vehicle_type_code || 'VAN_35T').toUpperCase(),
    vehicle_has_lift: Boolean(vehicle?.vehicle_has_lift),
    max_volume_m3: vehicle?.max_volume_m3 != null ? String(vehicle.max_volume_m3) : '',
    target_volume_m3: vehicle?.target_volume_m3 != null ? String(vehicle.target_volume_m3) : '',
    max_weight_kg: vehicle?.max_weight_kg != null ? String(vehicle.max_weight_kg) : '',
    target_weight_kg: vehicle?.target_weight_kg != null ? String(vehicle.target_weight_kg) : '',
    odometer_km: vehicle?.odometer_km != null ? String(vehicle.odometer_km) : '',
    notes: String(vehicle?.notes || ''),
});

export default function Fleet() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);
    const tabLabel = (key) => {
        if (key === 'vehicle') return l('Vehicle', 'Vehicul');
        if (key === 'documents') return l('Documents', 'Documente');
        if (key === 'service') return l('Service', 'Service');
        if (key === 'insurance') return l('Insurance', 'Asigurare');
        if (key === 'reminders') return l('Reminders', 'Alerte');
        return key;
    };
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
    const [assignments, setAssignments] = useState([]);
    const [phones, setPhones] = useState([]);

    const [selectedVehicleId, setSelectedVehicleId] = useState(null);
    const [activeTab, setActiveTab] = useState('vehicle');

    const [vehicleForm, setVehicleForm] = useState(emptyVehicleForm);
    const [newVehicleForm, setNewVehicleForm] = useState(emptyVehicleForm);
    const [assignmentForm, setAssignmentForm] = useState(emptyAssignmentForm);
    const [phoneForm, setPhoneForm] = useState(emptyPhoneForm);

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

    const vehiclesById = useMemo(() => {
        const map = new Map();
        (Array.isArray(vehicles) ? vehicles : []).forEach((v) => {
            const id = Number(v?.id);
            if (!Number.isFinite(id) || id <= 0) return;
            map.set(id, v);
        });
        return map;
    }, [vehicles]);

    const selectedVehicle = useMemo(() => (
        (Array.isArray(vehicles) ? vehicles : []).find((v) => Number(v?.id) === Number(selectedVehicleId)) || null
    ), [vehicles, selectedVehicleId]);

    const refreshOverview = async () => {
        const data = await getFleetOverview(token, { days: 45, include_inactive: false });
        setOverview(data || null);
    };

    const refreshVehicles = async ({ keepSelected = true } = {}) => {
        let list = [];
        try {
            const rows = await listFleetVehicles(token, { include_inactive: false, sync_from_drivers: false });
            list = Array.isArray(rows) ? rows : [];
        } catch {
            list = [];
        }
        setVehicles(list);

        if (!list.length) {
            setSelectedVehicleId(null);
            return { list };
        }

        if (keepSelected && selectedVehicleId) {
            const hasCurrent = list.some((v) => Number(v?.id) === Number(selectedVehicleId));
            if (hasCurrent) return { list };
        }

        setSelectedVehicleId(Number(list[0]?.id));
        return { list };
    };

    const refreshAssignments = async () => {
        try {
            const rows = await listFleetActiveAssignments(token, { limit: 200 });
            setAssignments(Array.isArray(rows) ? rows : []);
        } catch {
            setAssignments([]);
        }
    };

    const refreshPhones = async () => {
        try {
            const rows = await listFleetPhones(token, { include_inactive: false });
            setPhones(Array.isArray(rows) ? rows : []);
        } catch {
            setPhones([]);
        }
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
        setMsg('');
        try {
            const [typesRes, usersRes] = await Promise.all([
                getVehicleTypes(token).catch(() => []),
                listUsers(token).catch(() => []),
            ]);
            setVehicleTypes(Array.isArray(typesRes) ? typesRes : []);
            const driverRows = Array.isArray(usersRes) ? usersRes.filter((u) => String(u?.role || '').trim() === 'Driver') : [];
            setDrivers(driverRows);

            const [{ list: vehiclesRows }] = await Promise.all([
                refreshVehicles({ keepSelected: true }),
                refreshAssignments(),
                refreshPhones(),
                refreshOverview().catch(() => {
                    setOverview(null);
                }),
            ]);

            if ((Array.isArray(vehiclesRows) ? vehiclesRows.length : 0) === 0 && canWrite) {
                await seedFleetAccounts(token, { reset_passwords: true }).catch(() => []);
                await Promise.all([
                    refreshVehicles({ keepSelected: true }),
                    refreshAssignments(),
                    refreshPhones(),
                    refreshOverview().catch(() => {
                        setOverview(null);
                    }),
                ]);
                setMsg('Am sincronizat conturile standard pentru flota.');
            }
        } catch (e) {
            setError(toUiError(e, {
                lang,
                fallbackRo: 'Nu am putut incarca datele flotei.',
                fallbackEn: 'Failed to load fleet data.',
            }));
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
        setVehicleForm(vehicleFormFromVehicle(selectedVehicle));
    }, [selectedVehicle]);

    useEffect(() => {
        if (!selectedVehicleId) return;
        setAssignmentForm((prev) => {
            if (String(prev.vehicle_id || '').trim()) return prev;
            return { ...prev, vehicle_id: String(selectedVehicleId) };
        });
    }, [selectedVehicleId]);

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
            helper_name: String(d?.helper_name || '').trim(),
            vehicle_type_code: String(d?.vehicle_type_code || prev.vehicle_type_code || 'VAN_35T').toUpperCase(),
            vehicle_has_lift: typeof d?.vehicle_has_lift === 'boolean' ? Boolean(d.vehicle_has_lift) : Boolean(prev.vehicle_has_lift),
            max_volume_m3: d?.max_volume_m3 != null ? String(d.max_volume_m3) : prev.max_volume_m3,
            target_volume_m3: d?.target_volume_m3 != null ? String(d.target_volume_m3) : prev.target_volume_m3,
            max_weight_kg: d?.max_weight_kg != null ? String(d.max_weight_kg) : prev.max_weight_kg,
            target_weight_kg: d?.target_weight_kg != null ? String(d.target_weight_kg) : prev.target_weight_kg,
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

    const vehiclePayload = (form, { validate = true, includeActive = true } = {}) => {
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
        };
        if (includeActive) payload.active = true;
        if (validate) validateCapacity(payload);
        return payload;
    };

    const saveVehicle = async () => {
        if (!canWrite || !selectedVehicle) return;
        setSaving(true);
        setError('');
        setMsg('');
        try {
            const currentPayload = vehiclePayload(vehicleFormFromVehicle(selectedVehicle), { validate: false, includeActive: false });
            const nextPayload = vehiclePayload(vehicleForm, { validate: false, includeActive: false });
            const patch = {};
            Object.keys(nextPayload).forEach((key) => {
                if (nextPayload[key] !== currentPayload[key]) patch[key] = nextPayload[key];
            });

            if (Object.keys(patch).length === 0) {
                setMsg('Nu exista modificari de salvat.');
                return;
            }

            const merged = { ...currentPayload, ...patch };
            if ('max_volume_m3' in patch || 'target_volume_m3' in patch || 'max_weight_kg' in patch || 'target_weight_kg' in patch) {
                validateCapacity(merged);
            }

            await updateFleetVehicle(token, selectedVehicle.id, patch);
            await Promise.all([refreshVehicles({ keepSelected: true }), refreshAssignments(), refreshOverview()]);
            setMsg('Vehicul actualizat.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva vehiculul.', fallbackEn: 'Failed to save vehicle.' }));
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
            await Promise.all([refreshVehicles({ keepSelected: false }), refreshAssignments(), refreshOverview()]);
            if (created?.id) setSelectedVehicleId(Number(created.id));
            setNewVehicleForm(emptyVehicleForm);
            setMsg('Vehicul nou adaugat.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut adauga vehiculul.', fallbackEn: 'Failed to add vehicle.' }));
        } finally {
            setSaving(false);
        }
    };

    const deleteVehicle = async (targetId) => {
        if (!canWrite) return;
        if (!window.confirm(l('Sigur stergi acest vehicul definitiv? Stergerea include decuplarea instorica a serviciilor, asigurarilor, etc.', 'Are you sure you want to delete this vehicle? Actions cannot be reversed.'))) return;
        setSaving(true);
        setError('');
        setMsg('');
        try {
            await deleteFleetVehicle(token, targetId);
            await Promise.all([refreshVehicles({ keepSelected: false }), refreshAssignments(), refreshOverview()]);
            setMsg('Vehicul sters cu succes din sistem.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut sterge vehiculul.', fallbackEn: 'Failed to delete vehicle.' }));
        } finally {
            setSaving(false);
        }
    };

    const submitAssignment = async () => {
        if (!canWrite) return;
        const driverId = String(assignmentForm.driver_id || '').trim().toUpperCase();
        const vehicleId = Number(assignmentForm.vehicle_id);
        const phoneId = Number(assignmentForm.phone_id);
        const phoneLabel = String(assignmentForm.phone_label || '').trim();
        if (!driverId) {
            setError('Selecteaza un sofer pentru alocare.');
            return;
        }
        if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
            setError('Selecteaza un vehicul pentru alocare.');
            return;
        }

        setSaving(true);
        setError('');
        setMsg('');
        try {
            await createFleetAssignment(token, {
                driver_id: driverId,
                vehicle_id: vehicleId,
                phone_id: Number.isFinite(phoneId) && phoneId > 0 ? phoneId : null,
                phone_label: phoneLabel || null,
                source: 'fleet_ui_manual_assignment',
                notes: 'Manual assignment from Fleet page',
            });
            await Promise.all([refreshVehicles({ keepSelected: true }), refreshAssignments(), refreshPhones()]);
            setSelectedVehicleId(vehicleId);
            setAssignmentForm((prev) => ({ ...emptyAssignmentForm, phone_id: prev.phone_id, phone_label: prev.phone_label }));
            setMsg('Alocare vehicul salvata.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva alocarea.', fallbackEn: 'Failed to save assignment.' }));
        } finally {
            setSaving(false);
        }
    };

    const addPhone = async () => {
        if (!canWrite) return;
        const phoneNumber = String(phoneForm.phone_number || '').trim();
        const label = String(phoneForm.label || '').trim();
        if (!phoneNumber) {
            setError('Numarul de telefon este obligatoriu.');
            return;
        }
        setSaving(true);
        setError('');
        setMsg('');
        try {
            await createFleetPhone(token, {
                phone_number: phoneNumber,
                label: label || null,
                active: true,
            });
            setPhoneForm(emptyPhoneForm);
            await refreshPhones();
            setMsg('Telefon adaugat in pool.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva telefonul.', fallbackEn: 'Failed to save phone.' }));
        } finally {
            setSaving(false);
        }
    };

    const deactivatePhone = async (phoneId) => {
        if (!canWrite) return;
        const id = Number(phoneId);
        if (!Number.isFinite(id) || id <= 0) return;
        setSaving(true);
        setError('');
        setMsg('');
        try {
            await updateFleetPhone(token, id, { active: false });
            await refreshPhones();
            setMsg('Telefon dezactivat.');
        } catch (e) {
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut dezactiva telefonul.', fallbackEn: 'Failed to disable phone.' }));
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
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva documentul.', fallbackEn: 'Failed to save document.' }));
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
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva interventia service.', fallbackEn: 'Failed to save service item.' }));
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
            setError(toUiError(e, { lang, fallbackRo: 'Nu am putut salva asigurarea.', fallbackEn: 'Failed to save insurance.' }));
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
                {l('No permission for Fleet.', 'Nu ai permisiune pentru Flota.')}
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
                        <h1 className="text-xl font-black text-gradient tracking-tight">{l('Fleet Control Center', 'Centru Control Flota')}</h1>
                        <p className="text-xs text-slate-400 font-medium mt-1">{l('Vehicles, documents, service, insurance, reminders', 'Vehicule, documente, service, asigurari, alerte')}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => navigate('/users')}
                        className="px-3 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-200 text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500/25 transition-all"
                    >
                        {l('Users', 'Utilizatori')}
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
                        <p className="text-lg font-black text-white mt-2">{Number(overview?.reminders_due_soon || 0)} {l('soon', 'in curand')} / {Number(overview?.reminders_overdue || 0)} {l('overdue', 'intarziate')}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
                    <div className="glass-strong rounded-3xl border border-white/10 p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Vehicles', 'Vehicule')}</p>
                            <button
                                type="button"
                                onClick={() => void refreshAll()}
                                className="px-2 py-1 rounded-xl border border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white"
                            >
                                {l('Refresh', 'Reincarca')}
                            </button>
                        </div>

                        <div className="max-h-[420px] overflow-auto space-y-2 pr-1">
                            {loading ? (
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-widest text-center py-8">{l('Loading...', 'Se incarca...')}</div>
                            ) : (Array.isArray(vehicles) ? vehicles : []).length === 0 ? (
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-widest text-center py-8">{l('No vehicles', 'Nu exista vehicule')}</div>
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
                                            <p className="text-[10px] font-bold uppercase tracking-wide mt-1 truncate">{typeLabel} • {String(v?.assigned_driver_name || v?.assigned_driver_id || l('Unassigned', 'Nealocat'))}</p>
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        {canWrite ? (
                            <div className="pt-3 border-t border-white/10 space-y-2">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{l('Add vehicle', 'Adauga vehicul')}</p>
                                <div className="grid grid-cols-2 gap-2">
                                    <input value={newVehicleForm.plate} onChange={(e) => setNewVehicleForm((p) => ({ ...p, plate: e.target.value.toUpperCase() }))} placeholder={l('Plate', 'Numar')} className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs font-mono" />
                                    <select value={newVehicleForm.assigned_driver_id} onChange={(e) => { setNewVehicleForm((p) => ({ ...p, assigned_driver_id: e.target.value })); applyDriverOnForm(e.target.value, 'new'); }} className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs">
                                        <option value="">{l('Driver', 'Sofer')}</option>
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
                                    <Plus size={14} /> {l('Add', 'Adauga')}
                                </button>
                                {selectedVehicleId ? (
                                    <button
                                        type="button"
                                        onClick={() => void deleteVehicle(selectedVehicleId)}
                                        disabled={saving}
                                        className="w-full mt-2 py-2 rounded-xl bg-transparent border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 text-[10px] font-black uppercase tracking-widest transition-all"
                                    >
                                        {l('Delete Selected', 'Sterge selectat')}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}

                        <div className="pt-3 border-t border-white/10 space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{l('Current Linked Pool Assignments', 'Alocari Actuale: Soferi pe Masini')}</p>
                            <div className="max-h-36 overflow-auto space-y-1 pr-1">
                                {(Array.isArray(assignments) ? assignments : []).length === 0 ? (
                                    <p className="text-[10px] text-slate-500 font-bold">{l('No active assignment.', 'Nu exista alocari active.')}</p>
                                ) : (
                                    (Array.isArray(assignments) ? assignments : []).map((row) => {
                                        const did = String(row?.driver_id || '').toUpperCase();
                                        const name = String(driversById.get(did)?.name || '').trim();
                                        const vid = Number(row?.vehicle_id);
                                        const plate = String(row?.vehicle_plate || vehiclesById.get(vid)?.plate || '--').trim().toUpperCase();
                                        const pid = Number(row?.phone_id);
                                        const phone = String(
                                            row?.phone_label
                                            || (Number.isFinite(pid) && pid > 0 ? phones.find((p) => Number(p?.id) === pid)?.phone_number : '')
                                            || ''
                                        ).trim();
                                        return (
                                            <div key={row?.id} className="px-2 py-1 rounded-xl bg-white/5 border border-white/10">
                                                <p className="text-[10px] font-black text-white truncate">{did}{name ? ` • ${name}` : ''}</p>
                                                <p className="text-[10px] text-slate-300 truncate">{plate}{phone ? ` • ${phone}` : ''}</p>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                            <div className="space-y-2 pt-2 border-t border-white/10">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{l('Phone Devices Pool', 'Inventar Telefoane de Serviciu')}</p>
                                <div className="max-h-24 overflow-auto space-y-1 pr-1">
                                    {(Array.isArray(phones) ? phones : []).length === 0 ? (
                                        <p className="text-[10px] text-slate-500 font-bold">{l('No phones configured.', 'Nu exista telefoane configurate.')}</p>
                                    ) : (
                                        (Array.isArray(phones) ? phones : []).map((p) => {
                                            const id = Number(p?.id);
                                            const phoneText = String(p?.phone_number || '').trim();
                                            const labelText = String(p?.label || '').trim();
                                            const ownerDriver = String(p?.assigned_driver_id || '').trim().toUpperCase();
                                            const ownerVehicleId = Number(p?.assigned_vehicle_id);
                                            const ownerPlate = Number.isFinite(ownerVehicleId) && ownerVehicleId > 0
                                                ? String(vehiclesById.get(ownerVehicleId)?.plate || '').trim().toUpperCase()
                                                : '';
                                            return (
                                                <div key={id} className="px-2 py-1 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between gap-2">
                                                    <p className="text-[10px] text-slate-200 truncate">
                                                        {labelText || phoneText}
                                                        {labelText && phoneText ? ` • ${phoneText}` : ''}
                                                        {ownerDriver || ownerPlate ? ` • ${ownerDriver || '-'}${ownerPlate ? ` / ${ownerPlate}` : ''}` : ''}
                                                    </p>
                                                    {canWrite ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => void deactivatePhone(id)}
                                                            disabled={saving}
                                                            className="px-2 py-0.5 rounded-lg bg-rose-500/15 border border-rose-500/25 text-rose-200 text-[9px] font-black uppercase tracking-wider"
                                                        >
                                                            Off
                                                        </button>
                                                    ) : null}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                                {canWrite ? (
                                    <div className="grid grid-cols-2 gap-2">
                                        <input
                                            value={phoneForm.phone_number}
                                            onChange={(e) => setPhoneForm((p) => ({ ...p, phone_number: e.target.value }))}
                                            placeholder={l('Phone number', 'Numar telefon')}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        />
                                        <input
                                            value={phoneForm.label}
                                            onChange={(e) => setPhoneForm((p) => ({ ...p, label: e.target.value }))}
                                            placeholder={l('Label (optional)', 'Eticheta (optional)')}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => void addPhone()}
                                            disabled={saving}
                                            className="col-span-2 py-2 rounded-xl bg-emerald-600/70 hover:bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest transition-all"
                                        >
                                            {l('Add phone to pool', 'Adauga telefon in pool')}
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                            {canWrite ? (
                                <>
                                    <div className="grid grid-cols-2 gap-2">
                                        <select
                                            value={assignmentForm.driver_id}
                                            onChange={(e) => setAssignmentForm((p) => ({ ...p, driver_id: e.target.value.toUpperCase() }))}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        >
                                            <option value="">{l('Driver', 'Sofer')}</option>
                                            {(Array.isArray(drivers) ? drivers : []).map((d) => (
                                                <option key={d?.driver_id} value={String(d?.driver_id || '').toUpperCase()}>{String(d?.driver_id || '').toUpperCase()} • {d?.name}</option>
                                            ))}
                                        </select>
                                        <select
                                            value={assignmentForm.vehicle_id}
                                            onChange={(e) => setAssignmentForm((p) => ({ ...p, vehicle_id: e.target.value }))}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        >
                                            <option value="">{l('Vehicle', 'Vehicul')}</option>
                                            {(Array.isArray(vehicles) ? vehicles : []).map((v) => (
                                                <option key={v?.id} value={String(v?.id || '')}>
                                                    {String(v?.plate || '--').toUpperCase()} • {String(v?.assigned_driver_name || '').trim() || l('No driver', 'Fara sofer')}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            value={assignmentForm.phone_id}
                                            onChange={(e) => setAssignmentForm((p) => ({ ...p, phone_id: e.target.value }))}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs"
                                        >
                                            <option value="">{l('Phone from pool (optional)', 'Telefon din pool (optional)')}</option>
                                            {(Array.isArray(phones) ? phones : []).map((p) => (
                                                <option key={p?.id} value={String(p?.id || '')}>
                                                    {String(p?.label || '').trim() || String(p?.phone_number || '').trim()}{String(p?.label || '').trim() && String(p?.phone_number || '').trim() ? ` • ${String(p.phone_number).trim()}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <input
                                            value={assignmentForm.phone_label}
                                            onChange={(e) => setAssignmentForm((p) => ({ ...p, phone_label: e.target.value }))}
                                            placeholder={l('Or type phone manually (optional)', 'Sau scrie telefon manual (optional)')}
                                            className="px-3 py-2 rounded-xl bg-slate-900/50 border border-white/10 text-white text-xs col-span-2"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void submitAssignment()}
                                        disabled={saving}
                                        className="w-full py-2.5 rounded-xl bg-cyan-600/80 hover:bg-cyan-500 text-white text-[11px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                                    >
                                        <ArrowRight size={14} /> {l('Assign', 'Aloca')}
                                    </button>
                                </>
                            ) : null}
                        </div>
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
                                    {tabLabel(key)}
                                </button>
                            );
                        })}
                        </div>

                        {activeTab === 'vehicle' ? (
                            <div className="space-y-3">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Vehicle profile', 'Profil vehicul')}</p>
                                {!selectedVehicle ? (
                                    <p className="text-slate-500 text-sm">{l('Select a vehicle.', 'Selecteaza un vehicul.')}</p>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={vehicleForm.plate} onChange={(e) => setVehicleForm((p) => ({ ...p, plate: e.target.value.toUpperCase() }))} placeholder={l('Plate', 'Numar')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white font-mono" />
                                            <input value={vehicleForm.label} onChange={(e) => setVehicleForm((p) => ({ ...p, label: e.target.value }))} placeholder={l('Label', 'Eticheta')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <select value={vehicleForm.assigned_driver_id} onChange={(e) => { setVehicleForm((p) => ({ ...p, assigned_driver_id: e.target.value })); applyDriverOnForm(e.target.value, 'vehicle'); }} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                                <option value="">{l('Driver unassigned', 'Sofer nealocat')}</option>
                                                {(Array.isArray(drivers) ? drivers : []).map((d) => (
                                                    <option key={d?.driver_id} value={String(d?.driver_id || '').toUpperCase()}>{String(d?.driver_id || '').toUpperCase()} • {d?.name}</option>
                                                ))}
                                            </select>
                                            <input value={vehicleForm.assigned_phone} onChange={(e) => setVehicleForm((p) => ({ ...p, assigned_phone: e.target.value }))} placeholder={l('Phone', 'Telefon')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <select value={vehicleForm.vehicle_type_code} onChange={(e) => setVehicleForm((p) => ({ ...p, vehicle_type_code: e.target.value.toUpperCase() }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                                {(Array.isArray(vehicleTypes) ? vehicleTypes : []).map((t) => (
                                                    <option key={t?.code} value={String(t?.code || '').toUpperCase()}>{t?.label || t?.code}</option>
                                                ))}
                                            </select>
                                            <label className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white flex items-center gap-2 select-none">
                                                <input type="checkbox" checked={Boolean(vehicleForm.vehicle_has_lift)} onChange={(e) => setVehicleForm((p) => ({ ...p, vehicle_has_lift: e.target.checked }))} />
                                                <span className="text-sm font-bold">{l('Liftgate', 'Lift')}</span>
                                            </label>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <input value={vehicleForm.max_volume_m3} onChange={(e) => setVehicleForm((p) => ({ ...p, max_volume_m3: e.target.value }))} type="number" step="0.1" min="0" placeholder={l('Max volume m3', 'Volum maxim m3')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.target_volume_m3} onChange={(e) => setVehicleForm((p) => ({ ...p, target_volume_m3: e.target.value }))} type="number" step="0.1" min="0" placeholder={l('Target volume m3', 'Volum util m3')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.max_weight_kg} onChange={(e) => setVehicleForm((p) => ({ ...p, max_weight_kg: e.target.value }))} type="number" step="1" min="0" placeholder={l('Max weight kg', 'Greutate maxima kg')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.target_weight_kg} onChange={(e) => setVehicleForm((p) => ({ ...p, target_weight_kg: e.target.value }))} type="number" step="1" min="0" placeholder={l('Target weight kg', 'Greutate utila kg')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.odometer_km} onChange={(e) => setVehicleForm((p) => ({ ...p, odometer_km: e.target.value }))} type="number" step="1" min="0" placeholder={l('Odometer km', 'Kilometraj km')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                            <input value={vehicleForm.helper_name} onChange={(e) => setVehicleForm((p) => ({ ...p, helper_name: e.target.value }))} placeholder={l('Helper name', 'Nume manipulant')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                        </div>

                                        <textarea value={vehicleForm.notes} onChange={(e) => setVehicleForm((p) => ({ ...p, notes: e.target.value }))} placeholder={l('Notes', 'Observatii')} rows={3} className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />

                                        {canWrite ? (
                                            <button type="button" onClick={() => void saveVehicle()} disabled={saving} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all">
                                                <Save size={16} /> {l('Save vehicle', 'Salveaza vehicul')}
                                            </button>
                                        ) : null}
                                    </>
                                )}
                            </div>
                        ) : null}

                        {activeTab === 'documents' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Documents', 'Documente')}</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={docForm.category} onChange={(e) => setDocForm((p) => ({ ...p, category: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="itp">ITP</option>
                                        <option value="rovinieta">Rovinieta</option>
                                        <option value="talon">Talon</option>
                                        <option value="license">Licenta</option>
                                        <option value="custom">{l('Custom', 'Personalizat')}</option>
                                    </select>
                                    <input value={docForm.title} onChange={(e) => setDocForm((p) => ({ ...p, title: e.target.value }))} placeholder={l('Title', 'Titlu')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.issuer} onChange={(e) => setDocForm((p) => ({ ...p, issuer: e.target.value }))} placeholder={l('Issuer', 'Emitent')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.issue_date} onChange={(e) => setDocForm((p) => ({ ...p, issue_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.expiry_date} onChange={(e) => setDocForm((p) => ({ ...p, expiry_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={docForm.reminder_days_before} onChange={(e) => setDocForm((p) => ({ ...p, reminder_days_before: e.target.value }))} type="number" min="0" placeholder={l('Reminder days', 'Zile reminder')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={docForm.notes} onChange={(e) => setDocForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder={l('Notes', 'Observatii')} className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? (
                                    <button type="button" onClick={() => void submitDoc()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editDocumentId ? l('Update document', 'Actualizeaza document') : l('Add document', 'Adauga document')}</button>
                                ) : null}

                                <div className="space-y-2">
                                    {(Array.isArray(documents) ? documents : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadDoc(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{row?.title || l('Document', 'Document')}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || l('Valid', 'Valabil')}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{row?.category || 'doc'} • {l('expires', 'expira')} {fromIsoToDateInput(row?.expiry_date) || '--'}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'service' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Service & Maintenance', 'Service si Mentenanta')}</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={serviceForm.service_type} onChange={(e) => setServiceForm((p) => ({ ...p, service_type: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="revision">{l('Revision', 'Revizie')}</option>
                                        <option value="oil">{l('Oil', 'Ulei')}</option>
                                        <option value="tires">{l('Tires', 'Anvelope')}</option>
                                        <option value="brakes">{l('Brakes', 'Frane')}</option>
                                        <option value="repairs">{l('Repairs', 'Reparatii')}</option>
                                        <option value="custom">{l('Custom', 'Personalizat')}</option>
                                    </select>
                                    <input value={serviceForm.title} onChange={(e) => setServiceForm((p) => ({ ...p, title: e.target.value }))} placeholder={l('Title', 'Titlu')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.provider} onChange={(e) => setServiceForm((p) => ({ ...p, provider: e.target.value }))} placeholder={l('Provider', 'Furnizor')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.performed_at} onChange={(e) => setServiceForm((p) => ({ ...p, performed_at: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.due_date} onChange={(e) => setServiceForm((p) => ({ ...p, due_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.due_km} onChange={(e) => setServiceForm((p) => ({ ...p, due_km: e.target.value }))} type="number" min="0" placeholder={l('Due km', 'Scadenta km')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.next_due_km} onChange={(e) => setServiceForm((p) => ({ ...p, next_due_km: e.target.value }))} type="number" min="0" placeholder={l('Next due km', 'Urmatoarea scadenta km')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.estimated_cost} onChange={(e) => setServiceForm((p) => ({ ...p, estimated_cost: e.target.value }))} type="number" min="0" step="0.01" placeholder={l('Estimated cost', 'Cost estimat')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={serviceForm.actual_cost} onChange={(e) => setServiceForm((p) => ({ ...p, actual_cost: e.target.value }))} type="number" min="0" step="0.01" placeholder={l('Actual cost', 'Cost final')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={serviceForm.notes} onChange={(e) => setServiceForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder={l('Notes', 'Observatii')} className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? <button type="button" onClick={() => void submitService()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editServiceId ? l('Update service', 'Actualizeaza service') : l('Add service', 'Adauga service')}</button> : null}

                                <div className="space-y-2">
                                    {(Array.isArray(services) ? services : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadService(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{row?.title || l('Service', 'Service')}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || l('Planned', 'Planificat')}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{row?.service_type || 'service'} • {l('due', 'scadenta')} {fromIsoToDateInput(row?.due_date) || '--'} • {row?.due_km ?? '--'} km</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'insurance' ? (
                            <div className="space-y-4">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Insurance', 'Asigurare')}</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <select value={insuranceForm.insurance_type} onChange={(e) => setInsuranceForm((p) => ({ ...p, insurance_type: e.target.value }))} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white">
                                        <option value="rca">RCA</option>
                                        <option value="casco">CASCO</option>
                                        <option value="cargo">Cargo</option>
                                        <option value="custom">{l('Custom', 'Personalizat')}</option>
                                    </select>
                                    <input value={insuranceForm.provider} onChange={(e) => setInsuranceForm((p) => ({ ...p, provider: e.target.value }))} placeholder={l('Provider', 'Furnizor')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.policy_number} onChange={(e) => setInsuranceForm((p) => ({ ...p, policy_number: e.target.value }))} placeholder={l('Policy number', 'Numar polita')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.start_date} onChange={(e) => setInsuranceForm((p) => ({ ...p, start_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.expiry_date} onChange={(e) => setInsuranceForm((p) => ({ ...p, expiry_date: e.target.value }))} type="date" className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.premium_amount} onChange={(e) => setInsuranceForm((p) => ({ ...p, premium_amount: e.target.value }))} type="number" min="0" step="0.01" placeholder={l('Premium', 'Prima')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                    <input value={insuranceForm.deductible} onChange={(e) => setInsuranceForm((p) => ({ ...p, deductible: e.target.value }))} type="number" min="0" step="0.01" placeholder={l('Deductible', 'Fransiza')} className="px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                </div>
                                <textarea value={insuranceForm.notes} onChange={(e) => setInsuranceForm((p) => ({ ...p, notes: e.target.value }))} rows={2} placeholder={l('Notes', 'Observatii')} className="w-full px-4 py-3 rounded-2xl bg-slate-900/50 border border-white/10 text-white" />
                                {canWrite ? <button type="button" onClick={() => void submitInsurance()} disabled={saving || !selectedVehicle} className="w-full py-3 rounded-2xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-black uppercase tracking-widest">{editInsuranceId ? l('Update insurance', 'Actualizeaza asigurarea') : l('Add insurance', 'Adauga asigurare')}</button> : null}

                                <div className="space-y-2">
                                    {(Array.isArray(insurances) ? insurances : []).map((row) => (
                                        <button key={row?.id} type="button" onClick={() => preloadInsurance(row)} className="w-full p-3 text-left rounded-2xl bg-white/5 border border-white/10 hover:border-emerald-500/30 transition-all">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{String(row?.insurance_type || l('Insurance', 'Asigurare')).toUpperCase()} • {row?.provider || '--'}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(row?.status)}`}>{row?.status || l('Active', 'Activa')}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{l('policy', 'polita')} {row?.policy_number || '--'} • {l('expires', 'expira')} {fromIsoToDateInput(row?.expiry_date) || '--'}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {activeTab === 'reminders' ? (
                            <div className="space-y-3">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">{l('Reminders (45 days)', 'Alerte (45 zile)')}</p>
                                {Array.isArray(overview?.reminders) && overview.reminders.length > 0 ? (
                                    overview.reminders.map((r) => (
                                        <div key={`${r?.kind}-${r?.id}`} className="p-3 rounded-2xl bg-white/5 border border-white/10">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-sm font-black text-white truncate">{String(r?.plate || '--')} • {r?.title || r?.kind}</p>
                                                <span className={`px-2 py-1 rounded-xl text-[10px] font-black uppercase border ${statusColor(r?.status)}`}>{r?.status || '--'}</span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">{r?.kind} • {l('due', 'scadenta')} {fromIsoToDateInput(r?.due_at) || '--'} • {Number(r?.days_left) < 0 ? `${Math.abs(Number(r?.days_left))} zile intarziere` : `${r?.days_left} zile`}</p>
                                        </div>
                                    ))
                                ) : (
                                    <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-200 text-sm font-bold">{l('No critical reminders. Fleet is OK.', 'Niciun reminder critic. Flota este in regula.')}</div>
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
