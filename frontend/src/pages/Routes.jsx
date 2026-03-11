import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, MapPinned, Plus, RefreshCw, Trash2, Truck, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
    approveRoutePlan,
    assignRoutePlan,
    createManualRoutePlan,
    generateRoutePlans,
    getApiUrl,
    getApiUrlIssue,
    isBackendForcedOnline,
    getShipments,
    getPostisSyncStatus,
    listFleetVehicles,
    listUsers,
    listRoutePlans,
    triggerPostisSync
} from '../services/api';
import {
    createRoute,
    deleteRoute,
    generateDailyMoldovaCountyRoutes,
    listMoldovaCountyRoutesForDateForUser,
    listRoutesForUser,
    resolveRouteDriverIdForUser,
    routeDisplayName,
    setRouteAwbOrder,
    updateRoute
} from '../services/routesStore';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { hasPermission } from '../auth/rbac';
import { normalizeRole, PERM_POSTIS_SYNC, PERM_ROUTE_PLANS_READ, PERM_ROUTE_PLANS_WRITE, ROLE_DRIVER } from '../auth/permissions';
import { toUiError } from '../services/uiErrors';

const MOLDOVA_COUNTIES = [
    { name: 'Bacau', code: 'BC' },
    { name: 'Iasi', code: 'IS' },
    { name: 'Neamt', code: 'NT' },
    { name: 'Vrancea', code: 'VN' },
    { name: 'Botosani', code: 'BT' },
    { name: 'Suceava', code: 'SV' },
    { name: 'Vaslui', code: 'VS' },
];

const countyKey = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    } catch {
        return String(value || '').trim().toLowerCase();
    }
};

const makeEmptyDailyIssues = () => ({
    missing_county_awbs: [],
    outside_region_awbs: [],
    over_capacity_awbs: [],
});

const planStatusClass = (statusRaw) => {
    const status = String(statusRaw || '').trim().toLowerCase();
    if (status === 'assigned') return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200';
    if (status === 'approved') return 'bg-blue-500/15 border-blue-500/30 text-blue-200';
    return 'bg-amber-500/15 border-amber-500/30 text-amber-200';
};

const planCrew = (plan) => {
    const plate = String(plan?.assigned_vehicle_plate || '').trim().toUpperCase();
    const driver = String(plan?.assigned_driver_name || '').trim();
    const helper = String(plan?.assigned_helper_name || '').trim();
    const primary = [plate, driver].filter(Boolean).join(' - ');
    if (!primary && !helper) return '';
    if (!helper) return primary;
    return primary ? `${primary} + ${helper}` : helper;
};

const planLoadSummary = (plan) => {
    const loadVol = Number(plan?.load_volume_m3);
    const capVol = Number(plan?.target_volume_m3 ?? plan?.max_volume_m3);
    const loadKg = Number(plan?.load_weight_kg);
    const capKg = Number(plan?.target_weight_kg ?? plan?.max_weight_kg);

    const volTxt = Number.isFinite(loadVol) && loadVol > 0
        ? (Number.isFinite(capVol) && capVol > 0 ? `${loadVol.toFixed(1)}/${capVol.toFixed(1)} mc` : `${loadVol.toFixed(1)} mc`)
        : (Number.isFinite(capVol) && capVol > 0 ? `0/${capVol.toFixed(1)} mc` : 'vol n/a');
    const kgTxt = Number.isFinite(loadKg) && loadKg > 0
        ? (Number.isFinite(capKg) && capKg > 0 ? `${Math.round(loadKg)}/${Math.round(capKg)} kg` : `${Math.round(loadKg)} kg`)
        : (Number.isFinite(capKg) && capKg > 0 ? `0/${Math.round(capKg)} kg` : 'kg n/a');
    return `${volTxt} • ${kgTxt}`;
};

export default function Routes() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { lang } = useLanguage();
    const l = (en, ro) => (lang === 'ro' ? ro : en);
    const role = normalizeRole(user?.role);
    const isDriver = role === ROLE_DRIVER;
    const currentDriverId = String(resolveRouteDriverIdForUser(user) || '').trim().toUpperCase();
    const currentTruckPlate = String(user?.truck_plate || user?.vehicle_plate || '').trim().toUpperCase();

    const canSyncPostis = hasPermission(user, PERM_POSTIS_SYNC);
    const canReadRoutePlans = hasPermission(user, PERM_ROUTE_PLANS_READ);
    const canWriteRoutePlans = hasPermission(user, PERM_ROUTE_PLANS_WRITE);

    const [routes, setRoutes] = useState([]);
    const [name, setName] = useState('');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [vehiclePlate, setVehiclePlate] = useState(() => {
        try {
            return localStorage.getItem('arynik_last_vehicle_plate_v1') || '';
        } catch {
            return '';
        }
    });

    const [dailyRoutes, setDailyRoutes] = useState([]);
    const [dailyLoading, setDailyLoading] = useState(false);
    const [dailyMsg, setDailyMsg] = useState('');
    const [dailyIssues, setDailyIssues] = useState(() => makeEmptyDailyIssues());
    const [openIssueList, setOpenIssueList] = useState('');
    const [postisBusy, setPostisBusy] = useState(false);
    const [assignPlateByPlanId, setAssignPlateByPlanId] = useState({});
    const [assignDriverByPlanId, setAssignDriverByPlanId] = useState({});
    const [assignHelperByPlanId, setAssignHelperByPlanId] = useState({});
    const [detailsPlan, setDetailsPlan] = useState(null);
    const [publishingRouteId, setPublishingRouteId] = useState('');
    const [drivers, setDrivers] = useState([]);
    const [fleetVehicles, setFleetVehicles] = useState([]);

    const filterRoutePlansForUser = (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        if (!isDriver) return list;

        return list.filter((plan) => {
            const assignedDriverId = String(plan?.assigned_driver_id || plan?.driver_id || '').trim().toUpperCase();
            const assignedPlate = String(plan?.assigned_vehicle_plate || '').trim().toUpperCase();
            if (currentDriverId && assignedDriverId && assignedDriverId === currentDriverId) return true;
            if (currentTruckPlate && assignedPlate && assignedPlate === currentTruckPlate) return true;
            return false;
        });
    };

    const refreshLocalRoutes = () => setRoutes(listRoutesForUser(user));

    const refreshDaily = async () => {
        if (!canReadRoutePlans) {
            setDailyRoutes([]);
            return;
        }
        try {
            const token = user?.token;
            const rows = await listRoutePlans(token, { plan_date: date });
            setDailyRoutes(filterRoutePlansForUser(rows));
        } catch (e) {
            console.warn('Failed to load route plans', e);
            setDailyRoutes([]);
        }
    };

    useEffect(() => {
        refreshLocalRoutes();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.role, user?.driver_id]);

    useEffect(() => {
        setOpenIssueList('');
        setDailyIssues(makeEmptyDailyIssues());
        refreshDaily();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date, canReadRoutePlans, user?.token, currentDriverId, currentTruckPlate, isDriver]);

    useEffect(() => {
        if (!canWriteRoutePlans) return;
        let cancelled = false;
        (async () => {
            try {
                const [rows, fleetRows] = await Promise.all([
                    listUsers(user?.token),
                    listFleetVehicles(user?.token, { include_inactive: false, sync_from_drivers: true }).catch(() => []),
                ]);
                if (!cancelled) {
                    setDrivers(Array.isArray(rows) ? rows : []);
                    setFleetVehicles(Array.isArray(fleetRows) ? fleetRows : []);
                }
            } catch (e) {
                console.warn('Failed to load drivers list for assignment', e);
                if (!cancelled) {
                    setDrivers([]);
                    setFleetVehicles([]);
                }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canWriteRoutePlans, user?.token]);

    const handleCreate = () => {
        const ownerDriverId = resolveRouteDriverIdForUser(user);
        const trimmed = String(name || '').trim();
        const baseName = trimmed || `Route ${new Date().toLocaleDateString()}`;
        const plate = String(vehiclePlate || '').trim().toUpperCase();
        const route = createRoute({
            name: baseName,
            driver_id: ownerDriverId,
            driver_name: user?.name || null,
            helper_name: user?.helper_name || null,
            vehicle_plate: plate || null,
            truck_phone: user?.truck_phone || null,
            vehicle_type_code: user?.vehicle_type_code || null,
            vehicle_has_lift: user?.vehicle_has_lift,
            max_volume_m3: user?.max_volume_m3 ?? null,
            target_volume_m3: user?.target_volume_m3 ?? null,
            max_weight_kg: user?.max_weight_kg ?? null,
            target_weight_kg: user?.target_weight_kg ?? null,
            date
        });
        setName('');
        if (plate) {
            try { localStorage.setItem('arynik_last_vehicle_plate_v1', plate); } catch { }
        }
        refreshLocalRoutes();
        if (route?.id) {
            navigate(`/routes/${route.id}`);
        }
    };

    const generateDaily = async ({ syncPostis = false } = {}) => {
        if (!canWriteRoutePlans) {
            setDailyMsg('Nu ai permisiune sa generezi rute.');
            return;
        }
        setDailyLoading(true);
        setDailyMsg('');
        setOpenIssueList('');
        setDailyIssues(makeEmptyDailyIssues());
        try {
            const token = user?.token;
            const summary = await generateRoutePlans(token, {
                plan_date: date,
                sync_postis: Boolean(syncPostis),
            });

            const missingCountyAwbs = Array.isArray(summary?.missing_county_awbs) ? summary.missing_county_awbs : [];
            const outsideRegionAwbs = Array.isArray(summary?.outside_region_awbs) ? summary.outside_region_awbs : [];
            const overCapacityAwbs = Array.isArray(summary?.over_capacity_awbs) ? summary.over_capacity_awbs : [];

            setDailyIssues({
                missing_county_awbs: missingCountyAwbs,
                outside_region_awbs: outsideRegionAwbs,
                over_capacity_awbs: overCapacityAwbs,
            });

            const syncAttempted = Boolean(summary?.sync_attempted);
            const syncOk = summary?.sync_ok !== false;
            const syncError = String(summary?.sync_error || '').trim();
            const syncSegment = syncAttempted
                ? (syncOk
                    ? l(' • Sync Postis: OK', ' • Sync Postis: OK')
                    : ` • ${l('Sync Postis failed (using cached data)', 'Sync Postis esuat (folosesc datele existente)')}${syncError ? `: ${syncError}` : ''}`)
                : '';

            setDailyMsg(
                `Plan ${summary?.date || date}: ${Number(summary?.created_routes || 0)} create, ${Number(summary?.updated_routes || 0)} update, ${Number(summary?.allocated_awbs || 0)} AWB alocate`
                + ` • livrabile Moldova: ${Number(summary?.deliverable_in_moldova || 0)}`
                + (missingCountyAwbs.length ? ` • Missing county: ${missingCountyAwbs.length}` : '')
                + (outsideRegionAwbs.length ? ` • Outside region: ${outsideRegionAwbs.length}` : '')
                + (overCapacityAwbs.length ? ` • Over capacity: ${overCapacityAwbs.length}` : '')
                + syncSegment
            );

            const plans = Array.isArray(summary?.plans) ? summary.plans : null;
            if (plans) {
                setDailyRoutes(filterRoutePlansForUser(plans));
            } else {
                await refreshDaily();
            }
        } catch (e) {
            console.warn('Daily route generation failed', e);
            let localFallbackUsed = false;
            try {
                const status = Number(e?.response?.status || 0);
                const text = String(e?.response?.data?.detail || e?.message || '').toLowerCase();
                const recoverableOffline = !e?.response || status >= 500 || /network|offline|unreachable|failed to fetch|no reachable backend|method not allowed/i.test(text);
                if (recoverableOffline && !isBackendForcedOnline()) {
                    const token = user?.token;
                    const [shipmentsRows, usersRows] = await Promise.all([
                        getShipments(token).catch(() => []),
                        listUsers(token).catch(() => []),
                    ]);
                    const localSummary = generateDailyMoldovaCountyRoutes({
                        date,
                        shipments: Array.isArray(shipmentsRows) ? shipmentsRows : [],
                        driver_id: resolveRouteDriverIdForUser(user),
                        drivers: Array.isArray(usersRows) ? usersRows : [],
                    });

                    const localPlans = listMoldovaCountyRoutesForDateForUser(date, user).map((r, idx) => {
                        const awbs = Array.isArray(r?.awbs) ? r.awbs : [];
                        const localId = Number(r?.id);
                        return {
                            id: Number.isFinite(localId) ? localId : (-100000 - idx),
                            plan_date: String(r?.date || date),
                            county: String(r?.county || r?.name || ''),
                            route_index: Number(r?.route_index || (idx + 1)),
                            name: String(r?.name || ''),
                            status: 'Local',
                            assigned_vehicle_plate: String(r?.vehicle_plate || '').trim().toUpperCase() || null,
                            assigned_driver_id: String(r?.driver_id || '').trim().toUpperCase() || null,
                            assigned_driver_name: String(r?.driver_name || '').trim() || null,
                            assigned_phone: String(r?.truck_phone || '').trim() || null,
                            vehicle_type_code: String(r?.vehicle_type_code || '').trim().toUpperCase() || null,
                            vehicle_has_lift: Boolean(r?.vehicle_has_lift),
                            max_volume_m3: Number(r?.max_volume_m3 || 0) || null,
                            target_volume_m3: Number(r?.target_volume_m3 || 0) || null,
                            max_weight_kg: Number(r?.max_weight_kg || 0) || null,
                            target_weight_kg: Number(r?.target_weight_kg || 0) || null,
                            awb_count: awbs.length,
                            awbs,
                            over_capacity_awbs: Array.isArray(r?.over_capacity_awbs) ? r.over_capacity_awbs : [],
                            load_volume_m3: Number(r?.load_volume_m3 || 0) || null,
                            load_weight_kg: Number(r?.load_weight_kg || 0) || null,
                            utilization_volume_pct: Number(r?.utilization_volume_pct || 0) || null,
                            utilization_weight_pct: Number(r?.utilization_weight_pct || 0) || null,
                            data: { suggested_vehicle_plate: String(r?.vehicle_plate || '').trim().toUpperCase() || null, local_fallback: true },
                        };
                    });

                    setDailyIssues({
                        missing_county_awbs: Array.isArray(localSummary?.missing_county_awbs) ? localSummary.missing_county_awbs : [],
                        outside_region_awbs: Array.isArray(localSummary?.outside_region_awbs) ? localSummary.outside_region_awbs : [],
                        over_capacity_awbs: Array.isArray(localSummary?.over_capacity_awbs) ? localSummary.over_capacity_awbs : [],
                    });
                    setDailyRoutes(filterRoutePlansForUser(localPlans));
                    setDailyMsg(
                        `Backend indisponibil. Rute generate local: ${Number(localSummary?.created_routes || 0)} create, ${Number(localSummary?.allocated_awbs || 0)} AWB alocate.`
                    );
                    localFallbackUsed = true;
                }
            } catch (fallbackError) {
                console.warn('Local fallback route generation failed', fallbackError);
            }

            if (!localFallbackUsed) {
                setDailyIssues(makeEmptyDailyIssues());
                setDailyMsg(toUiError(e, {
                    lang,
                    fallbackRo: 'Nu am putut genera rutele zilnice.',
                    fallbackEn: 'Failed to generate daily routes.',
                }));
            }
        } finally {
            setDailyLoading(false);
        }
    };

    const syncPostis = async () => {
        if (!canSyncPostis || postisBusy) return;
        const apiUrl = getApiUrl();
        const issue = getApiUrlIssue(apiUrl);
        if (issue) {
            setDailyMsg(`${issue} Current: ${apiUrl}`);
            return;
        }

        // eslint-disable-next-line no-alert
        const ok = window.confirm(
            'Sincronizam acum cu Postis?\\n\\nSe va rula full backfill (cost/content/address/raw payload) si poate dura cateva minute.'
        );
        if (!ok) return;

        const token = user?.token;
        if (!token) {
            setDailyMsg('Nu esti autentificat.');
            return;
        }

        setPostisBusy(true);
        setDailyMsg('');
        try {
            const started = await triggerPostisSync(token, { mode: 'full' });
            const didStart = Boolean(started?.started);
            setDailyMsg(didStart ? 'Postis sync pornit. Astept finalizarea...' : 'Postis sync ruleaza deja. Verific statusul...');

            const deadline = Date.now() + (20 * 1000);
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2500));
                const st = await getPostisSyncStatus(token);
                if (!st?.running) break;
            }
            const st = await getPostisSyncStatus(token);
            if (st?.last_error) {
                setDailyMsg(`Postis sync failed: ${st.last_error}`);
                return;
            }

            setDailyMsg('Postis sync finalizat. Generez automat rutele...');
            await generateDaily({ syncPostis: false });
        } catch (e) {
            setDailyMsg(toUiError(e, {
                lang,
                fallbackRo: 'Nu am putut sincroniza cu Postis.',
                fallbackEn: 'Failed to sync with Postis.',
            }));
        } finally {
            setPostisBusy(false);
        }
    };

    const approvePlan = async (plan) => {
        if (!canWriteRoutePlans) return;
        const sourcePlan = plan && typeof plan === 'object'
            ? plan
            : (Array.isArray(dailyRoutes) ? dailyRoutes.find((r) => Number(r?.id) === Number(plan)) : null);
        const requestedId = Number(sourcePlan?.id ?? plan);

        try {
            // Local/offline synthetic plans cannot be approved server-side directly.
            if (!Number.isFinite(requestedId) || requestedId <= 0 || String(sourcePlan?.status || '').trim().toLowerCase() === 'local') {
                const summary = await generateRoutePlans(user?.token, {
                    plan_date: date,
                    sync_postis: false,
                });
                const serverPlans = Array.isArray(summary?.plans) ? summary.plans : [];
                const wantedCounty = countyKey(sourcePlan?.county || sourcePlan?.name || '');
                const wantedIndex = Number(sourcePlan?.route_index || 1);

                const candidate = serverPlans.find((r) => (
                    String(r?.status || '').trim() === 'Draft'
                    && countyKey(r?.county || r?.name || '') === wantedCounty
                    && Number(r?.route_index || 1) === wantedIndex
                )) || serverPlans.find((r) => (
                    String(r?.status || '').trim() === 'Draft'
                    && countyKey(r?.county || r?.name || '') === wantedCounty
                ));

                if (!candidate?.id) {
                    setDailyMsg('Ruta locala a fost sincronizata, dar nu am gasit un draft online de aprobat.');
                    await refreshDaily();
                    return;
                }

                await approveRoutePlan(user?.token, Number(candidate.id));
                setDailyMsg(`Ruta #${Number(candidate.id)} aprobata.`);
                await refreshDaily();
                return;
            }

            await approveRoutePlan(user?.token, requestedId);
            setDailyMsg(`Ruta #${requestedId} aprobata.`);
            await refreshDaily();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Approve failed.';
            setDailyMsg(String(detail));
        }
    };

    const assignPlan = async (plan) => {
        if (!canWriteRoutePlans) return;
        const id = Number(plan?.id);
        if (!Number.isFinite(id) || id <= 0) return;

        const fallback = String(plan?.assigned_vehicle_plate || plan?.data?.suggested_vehicle_plate || '').trim().toUpperCase();
        const entered = String(assignPlateByPlanId[id] || '').trim().toUpperCase();
        const plate = entered || fallback || null;
        let driverId = String(assignDriverByPlanId[id] || '').trim().toUpperCase() || null;
        const helperName = String(assignHelperByPlanId[id] || '').trim() || null;
        if (!driverId && plate) {
            const fv = fleetByPlate.get(plate);
            const fromFleet = String(fv?.assigned_driver_id || '').trim().toUpperCase();
            if (fromFleet) driverId = fromFleet;
        }
        if (!plate && !driverId) {
            setDailyMsg(`Selecteaza masina din Fleet sau soferul pentru ruta #${id}.`);
            return;
        }

        try {
            const payload = await assignRoutePlan(user?.token, id, plate, {
                driver_id: driverId,
                helper_name: helperName,
            });
            const allocated = Number(payload?.allocated_awbs || 0);
            const assignedPlate = String(payload?.assigned_vehicle_plate || plate || '').trim().toUpperCase();
            const assignedDriverId = String(payload?.assigned_driver_id || driverId || '').trim().toUpperCase();
            const assignedDriverName = assignedDriverId ? (driverNameById.get(assignedDriverId) || assignedDriverId) : '-';
            const assignedHelper = String(payload?.assigned_helper_name || helperName || '').trim();
            setDailyMsg(`Ruta #${id} alocata pe ${assignedPlate || '-'} (${assignedDriverName}${assignedHelper ? ` + ${assignedHelper}` : ''}) • AWB alocate: ${allocated}`);
            setAssignPlateByPlanId((prev) => ({ ...prev, [id]: assignedPlate }));
            setAssignDriverByPlanId((prev) => ({ ...prev, [id]: assignedDriverId || '' }));
            setAssignHelperByPlanId((prev) => ({ ...prev, [id]: assignedHelper }));
            await refreshDaily();
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Assign failed.';
            setDailyMsg(String(detail));
        }
    };

    const openPlannedRoute = (plan) => {
        const pid = Number(plan?.id);
        const planDate = String(plan?.plan_date || date).trim();
        const county = String(plan?.county || '').trim() || null;
        const planAwbs = Array.isArray(plan?.awbs) ? plan.awbs.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean) : [];

        const existing = (Array.isArray(routes) ? routes : []).find((r) => (
            Number(r?.source_plan_id) === pid && String(r?.date || '').trim() === planDate
        ));

        const driverId = String(plan?.assigned_driver_id || '').trim().toUpperCase() || resolveRouteDriverIdForUser(user);
        const seedName = String(plan?.name || plan?.county || 'Route').trim();
        const plate = String(plan?.assigned_vehicle_plate || '').trim().toUpperCase();

        let localRoute = existing;
        if (!localRoute) {
            localRoute = createRoute({
                name: seedName,
                date: planDate,
                county,
                kind: 'county',
                region: 'Moldova',
                driver_id: driverId || null,
                driver_name: String(plan?.assigned_driver_name || '').trim() || null,
                helper_name: String(plan?.assigned_helper_name || '').trim() || null,
                vehicle_plate: plate || null,
                vehicle_type_code: String(plan?.vehicle_type_code || '').trim().toUpperCase() || null,
                vehicle_has_lift: Boolean(plan?.vehicle_has_lift),
                max_volume_m3: Number(plan?.max_volume_m3),
                target_volume_m3: Number(plan?.target_volume_m3),
                max_weight_kg: Number(plan?.max_weight_kg),
                target_weight_kg: Number(plan?.target_weight_kg),
            });
        }

        const patched = updateRoute(localRoute.id, {
            source_plan_id: pid,
            name: seedName,
            date: planDate,
            county,
            kind: 'county',
            region: 'Moldova',
            driver_id: driverId || null,
            driver_name: String(plan?.assigned_driver_name || '').trim() || null,
            helper_name: String(plan?.assigned_helper_name || '').trim() || null,
            vehicle_plate: plate || null,
            vehicle_type_code: String(plan?.vehicle_type_code || '').trim().toUpperCase() || null,
            vehicle_has_lift: Boolean(plan?.vehicle_has_lift),
            max_volume_m3: Number(plan?.max_volume_m3),
            target_volume_m3: Number(plan?.target_volume_m3),
            max_weight_kg: Number(plan?.max_weight_kg),
            target_weight_kg: Number(plan?.target_weight_kg),
            data: (plan?.data && typeof plan.data === 'object') ? plan.data : null,
        }) || localRoute;

        if (planAwbs.length > 0) {
            setRouteAwbOrder(patched.id, planAwbs);
        }

        refreshLocalRoutes();
        navigate(`/routes/${patched.id}`);
    };

    const publishLocalRoute = async (route) => {
        if (!canWriteRoutePlans) return;
        const token = user?.token;
        if (!token) {
            setDailyMsg('Nu esti autentificat.');
            return;
        }

        const awbs = (Array.isArray(route?.awbs) ? route.awbs : [])
            .map((x) => String(x || '').trim().toUpperCase())
            .filter(Boolean);
        if (awbs.length === 0) {
            setDailyMsg('Ruta locala nu are AWB-uri. Adauga opriri inainte de publicare.');
            return;
        }

        const driverId = String(route?.driver_id || '').trim().toUpperCase();
        if (!driverId) {
            setDailyMsg('Selecteaza soferul pe ruta locala inainte de publicare.');
            return;
        }

        const rid = String(route?.id || '');
        setPublishingRouteId(rid);
        try {
            const payload = {
                plan_date: String(route?.date || date || '').trim() || null,
                county: String(route?.county || '').trim() || 'Manual',
                name: String(route?.name || '').trim() || routeDisplayName(route),
                awbs,
                assigned_driver_id: driverId,
                assigned_driver_name: String(route?.driver_name || '').trim() || null,
                assigned_helper_name: String(route?.helper_name || '').trim() || null,
                assigned_phone: String(route?.truck_phone || '').trim() || null,
                assigned_vehicle_plate: String(route?.vehicle_plate || '').trim().toUpperCase() || null,
                vehicle_type_code: String(route?.vehicle_type_code || '').trim().toUpperCase() || null,
                vehicle_has_lift: typeof route?.vehicle_has_lift === 'boolean' ? Boolean(route.vehicle_has_lift) : null,
                max_volume_m3: Number.isFinite(Number(route?.max_volume_m3)) ? Number(route.max_volume_m3) : null,
                target_volume_m3: Number.isFinite(Number(route?.target_volume_m3)) ? Number(route.target_volume_m3) : null,
                max_weight_kg: Number.isFinite(Number(route?.max_weight_kg)) ? Number(route.max_weight_kg) : null,
                target_weight_kg: Number.isFinite(Number(route?.target_weight_kg)) ? Number(route.target_weight_kg) : null,
                data: {
                    source_local_route_id: rid || null,
                    source: 'manual_local_route',
                },
            };

            const created = await createManualRoutePlan(token, payload);
            const pid = Number(created?.id);
            if (Number.isFinite(pid) && pid > 0) {
                updateRoute(route.id, { source_plan_id: pid });
                refreshLocalRoutes();
                await refreshDaily();
                setDailyMsg(`Ruta locala a fost publicata (#${pid}). Apasa Approve pentru confirmare.`);
            } else {
                setDailyMsg('Ruta a fost publicata, dar nu am primit ID-ul planului.');
            }
        } catch (e) {
            const detail = e?.response?.data?.detail || e?.message || 'Publicarea rutei a esuat.';
            setDailyMsg(String(detail));
        } finally {
            setPublishingRouteId('');
        }
    };

    const handleDelete = (routeId) => {
        // eslint-disable-next-line no-alert
        const ok = window.confirm('Delete this local route?');
        if (!ok) return;
        deleteRoute(routeId);
        refreshLocalRoutes();
    };

    const dailyByCounty = useMemo(() => {
        const map = new Map();
        (Array.isArray(dailyRoutes) ? dailyRoutes : []).forEach((r) => {
            const key = countyKey(r?.county || r?.name);
            if (!key) return;
            const arr = map.get(key) || [];
            arr.push(r);
            map.set(key, arr);
        });
        map.forEach((arr, key) => {
            arr.sort((a, b) => {
                const ai = Number(a?.route_index);
                const bi = Number(b?.route_index);
                if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
                return String(a?.name || '').localeCompare(String(b?.name || ''));
            });
            map.set(key, arr);
        });
        return map;
    }, [dailyRoutes]);

    const availableDrivers = useMemo(() => (
        (Array.isArray(drivers) ? drivers : [])
            .filter((d) => normalizeRole(d?.role) === ROLE_DRIVER && d?.active !== false)
            .slice()
            .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
    ), [drivers]);

    const driverNameById = useMemo(() => {
        const map = new Map();
        availableDrivers.forEach((d) => {
            const did = String(d?.driver_id || '').trim().toUpperCase();
            if (!did) return;
            map.set(did, String(d?.name || '').trim() || did);
        });
        return map;
    }, [availableDrivers]);

    const availableFleetVehicles = useMemo(() => (
        (Array.isArray(fleetVehicles) ? fleetVehicles : [])
            .filter((v) => String(v?.plate || '').trim())
            .slice()
            .sort((a, b) => String(a?.plate || '').localeCompare(String(b?.plate || '')))
    ), [fleetVehicles]);

    const fleetByPlate = useMemo(() => {
        const map = new Map();
        availableFleetVehicles.forEach((v) => {
            const plate = String(v?.plate || '').trim().toUpperCase();
            if (!plate) return;
            map.set(plate, v);
        });
        return map;
    }, [availableFleetVehicles]);

    const missingCountyCount = Array.isArray(dailyIssues?.missing_county_awbs) ? dailyIssues.missing_county_awbs.length : 0;
    const outsideRegionCount = Array.isArray(dailyIssues?.outside_region_awbs) ? dailyIssues.outside_region_awbs.length : 0;
    const overCapacityCount = Array.isArray(dailyIssues?.over_capacity_awbs) ? dailyIssues.over_capacity_awbs.length : 0;
    const hasIssueLists = missingCountyCount > 0 || outsideRegionCount > 0 || overCapacityCount > 0;

    const issueListItems = openIssueList === 'outside_region'
        ? (Array.isArray(dailyIssues?.outside_region_awbs) ? dailyIssues.outside_region_awbs : [])
        : (openIssueList === 'over_capacity'
            ? (Array.isArray(dailyIssues?.over_capacity_awbs) ? dailyIssues.over_capacity_awbs : [])
            : (Array.isArray(dailyIssues?.missing_county_awbs) ? dailyIssues.missing_county_awbs : []));

    const issueListTitle = openIssueList === 'outside_region'
        ? 'AWB-uri Outside Region'
        : (openIssueList === 'over_capacity' ? 'AWB-uri Over Capacity' : 'AWB-uri Missing County');

    const countyCards = useMemo(() => {
        const seen = new Set();
        const list = [];
        const addCounty = (nameRaw, codeRaw = '') => {
            const name = String(nameRaw || '').trim();
            const key = countyKey(name);
            if (!name || !key || seen.has(key)) return;
            seen.add(key);
            list.push({
                name,
                code: String(codeRaw || '').trim().toUpperCase() || name.slice(0, 2).toUpperCase() || 'RT',
            });
        };

        if (canWriteRoutePlans) {
            MOLDOVA_COUNTIES.forEach((c) => addCounty(c.name, c.code));
        }

        (Array.isArray(dailyRoutes) ? dailyRoutes : []).forEach((r) => {
            addCounty(String(r?.county || r?.name || '').trim() || 'Manual');
        });

        return list;
    }, [canWriteRoutePlans, dailyRoutes]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="min-h-screen flex flex-col relative overflow-hidden"
        >
            <div className="absolute top-10 right-0 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl animate-float"></div>
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }}></div>

            <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-30 glass-strong rounded-b-[32px] mx-2 mt-2 shadow-lg border-iridescent animate-slide-down">
                <div>
                    <h1 className="text-xl font-black text-gradient tracking-tight">Routes</h1>
                    <p className="text-xs text-slate-400 font-medium mt-1">Route planning, approval and assignment</p>
                </div>
                <div className="w-12 h-12 rounded-2xl glass-light flex items-center justify-center border border-white/10">
                    <MapPinned size={20} className="text-emerald-400" />
                </div>
            </header>

            <div className="flex-1 p-4 pb-32 space-y-6 relative z-10">
                {canReadRoutePlans ? (
                    <div className="glass-strong p-5 rounded-3xl border-iridescent space-y-4">
                        <div className="space-y-3">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[0.16em]">
                                    {canWriteRoutePlans ? 'Rute Zilnice (Moldova)' : 'Rutele Tale Asignate'}
                                </p>
                                {canWriteRoutePlans ? (
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1 break-words">
                                        Bacau, Iasi, Neamt, Vrancea, Botosani, Suceava, Vaslui
                                    </p>
                                ) : null}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    type="date"
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                    className="px-3 py-2 w-full min-[460px]:w-auto min-[460px]:min-w-[170px] bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-xs font-bold"
                                />
                                {canWriteRoutePlans && canSyncPostis ? (
                                    <button
                                        onClick={syncPostis}
                                        disabled={postisBusy}
                                        className={`px-3 py-2 rounded-2xl bg-slate-900/40 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2 ${postisBusy ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5'}`}
                                        title="Sync shipment details from Postis"
                                    >
                                        <RefreshCw size={14} className={postisBusy ? 'animate-spin' : ''} />
                                        Sync
                                    </button>
                                ) : null}
                                {canWriteRoutePlans ? (
                                    <button
                                        onClick={generateDaily}
                                        disabled={dailyLoading}
                                        className={`px-4 py-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-200 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2 ${dailyLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
                                        title="Generate daily route plans from current DB shipments"
                                    >
                                        <RefreshCw size={14} className={dailyLoading ? 'animate-spin' : ''} />
                                        Generate
                                    </button>
                                ) : null}
                            </div>
                        </div>

                        {dailyMsg ? (
                            <div className="glass-light p-4 rounded-2xl border border-emerald-500/20 text-emerald-200 text-xs font-bold">
                                {dailyMsg}
                            </div>
                        ) : null}

                        {hasIssueLists ? (
                            <div className="glass-light p-4 rounded-2xl border border-amber-500/30 space-y-3">
                                <p className="text-[10px] text-amber-200 font-black uppercase tracking-widest">
                                    Erori rutare - apasa pentru lista AWB
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {missingCountyCount > 0 ? (
                                        <button
                                            type="button"
                                            onClick={() => setOpenIssueList('missing_county')}
                                            className="px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/35 text-amber-100 text-[10px] font-black uppercase tracking-widest hover:bg-amber-500/25 transition-all"
                                        >
                                            Missing County ({missingCountyCount})
                                        </button>
                                    ) : null}
                                    {outsideRegionCount > 0 ? (
                                        <button
                                            type="button"
                                            onClick={() => setOpenIssueList('outside_region')}
                                            className="px-3 py-2 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-100 text-[10px] font-black uppercase tracking-widest hover:bg-rose-500/25 transition-all"
                                        >
                                            Outside Region ({outsideRegionCount})
                                        </button>
                                    ) : null}
                                    {overCapacityCount > 0 ? (
                                        <button
                                            type="button"
                                            onClick={() => setOpenIssueList('over_capacity')}
                                            className="px-3 py-2 rounded-xl bg-violet-500/15 border border-violet-500/35 text-violet-100 text-[10px] font-black uppercase tracking-widest hover:bg-violet-500/25 transition-all"
                                        >
                                            Over Capacity ({overCapacityCount})
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {countyCards.length === 0 ? (
                            <div className="p-5 rounded-2xl border border-white/10 bg-slate-900/30 text-slate-400 text-sm font-semibold">
                                Nu exista rute pentru data selectata.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {countyCards.map((c) => {
                                    const countyRoutes = dailyByCounty.get(countyKey(c.name)) || [];
                                    const hasRoutes = countyRoutes.length > 0;
                                    const stops = countyRoutes.reduce((acc, r) => acc + Number(r?.awb_count || (Array.isArray(r?.awbs) ? r.awbs.length : 0) || 0), 0);
                                    return (
                                        <div
                                            key={`${c.code}-${c.name}`}
                                            className={`p-4 rounded-3xl border transition-all text-left ${hasRoutes ? 'glass-strong border-white/10 hover:border-emerald-500/30' : 'bg-slate-900/30 border-slate-800/50 opacity-60'}`}
                                        >
                                            <div className="min-w-0 flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="text-white font-black truncate">{c.name}</p>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                        {date} • {stops} stops • {countyRoutes.length} masini
                                                    </p>
                                                </div>
                                                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center border ${hasRoutes ? 'bg-emerald-500/15 border-emerald-500/20 text-emerald-300' : 'bg-slate-800/30 border-white/5 text-slate-500'}`}>
                                                    <ArrowRight size={18} />
                                                </div>
                                            </div>

                                            {hasRoutes ? (
                                                <div className="mt-3 space-y-3">
                                                    {countyRoutes.map((r) => {
                                                        const crew = planCrew(r);
                                                        const status = String(r?.status || 'Draft').trim();
                                                        const awbCount = Number(r?.awb_count || (Array.isArray(r?.awbs) ? r.awbs.length : 0) || 0);
                                                        const routeIndex = Number(r?.route_index || 1);
                                                        const typeCode = String(r?.vehicle_type_code || '').trim().toUpperCase();
                                                        const loadSummary = planLoadSummary(r);
                                                        const awbPreview = (Array.isArray(r?.awbs) ? r.awbs : [])
                                                            .slice(0, 3)
                                                            .map((awb) => String(awb || '').trim())
                                                            .filter(Boolean)
                                                            .join(' • ');
                                                        const pid = Number(r?.id);
                                                        const assignValue = String(assignPlateByPlanId[pid] ?? r?.assigned_vehicle_plate ?? r?.data?.suggested_vehicle_plate ?? '').trim().toUpperCase();
                                                        const assignDriverValue = String(assignDriverByPlanId[pid] ?? r?.assigned_driver_id ?? '').trim().toUpperCase();
                                                        const assignHelperValue = String(assignHelperByPlanId[pid] ?? r?.assigned_helper_name ?? '').trim();

                                                        return (
                                                            <div key={r.id} className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0">
                                                                        <p className="text-[11px] text-white font-black truncate">
                                                                            {String(r?.name || r?.county || '').trim() || `Ruta #${r?.id}`}
                                                                        </p>
                                                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1 truncate">
                                                                            {awbCount} stops {crew ? `• ${crew}` : ''}
                                                                        </p>
                                                                        <p className="text-[10px] text-slate-500 font-bold mt-1 truncate">
                                                                            Ruta #{Number.isFinite(pid) && pid > 0 ? pid : '-'} • index {routeIndex}
                                                                            {typeCode ? ` • ${typeCode}` : ''} • {loadSummary}
                                                                        </p>
                                                                        {awbPreview ? (
                                                                            <p className="text-[10px] text-emerald-300/90 font-mono font-bold mt-1 truncate">
                                                                                {awbPreview}{awbCount > 3 ? ' • ...' : ''}
                                                                            </p>
                                                                        ) : null}
                                                                    </div>
                                                                    <span className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest ${planStatusClass(status)}`}>
                                                                        {status}
                                                                    </span>
                                                                </div>

                                                                <div className="flex items-center gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setDetailsPlan(r)}
                                                                        className="px-2 py-1.5 rounded-xl bg-slate-900/45 border border-white/10 text-slate-200 text-[10px] font-black uppercase tracking-wider hover:bg-white/10 transition-all"
                                                                    >
                                                                        Detalii
                                                                    </button>

                                                                    {(status === 'Assigned' || status === 'Approved' || canWriteRoutePlans) ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => openPlannedRoute(r)}
                                                                            className="px-2 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-100 text-[10px] font-black uppercase tracking-wider hover:bg-emerald-500/25 transition-all flex items-center gap-1"
                                                                        >
                                                                            <ArrowRight size={12} /> Open
                                                                        </button>
                                                                    ) : null}

                                                                    {canWriteRoutePlans && (status === 'Draft' || status === 'Local') ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => approvePlan(r)}
                                                                            className="px-2 py-1.5 rounded-xl bg-blue-500/15 border border-blue-500/35 text-blue-100 text-[10px] font-black uppercase tracking-wider hover:bg-blue-500/25 transition-all flex items-center gap-1"
                                                                        >
                                                                            <CheckCircle2 size={12} /> Approve
                                                                        </button>
                                                                    ) : null}
                                                                </div>

                                                                {canWriteRoutePlans && (status === 'Approved' || status === 'Assigned') ? (
                                                                    <div className="space-y-2">
                                                                        <div className="flex items-center gap-2">
                                                                            <select
                                                                                value={assignDriverValue}
                                                                                onChange={(e) => setAssignDriverByPlanId((prev) => ({ ...prev, [pid]: e.target.value.toUpperCase() }))}
                                                                                className="flex-1 px-2 py-1.5 bg-slate-900/55 border border-slate-700/50 rounded-xl text-white focus:outline-none focus:border-emerald-500/50 text-[11px] font-mono tracking-wider"
                                                                            >
                                                                                <option value="">Sofer (optional)</option>
                                                                                {availableDrivers.map((d) => {
                                                                                    const did = String(d?.driver_id || '').trim().toUpperCase();
                                                                                    if (!did) return null;
                                                                                    return (
                                                                                        <option key={`${pid}-${did}`} value={did}>
                                                                                            {String(d?.name || '').trim() || 'Unnamed'}
                                                                                        </option>
                                                                                    );
                                                                                })}
                                                                            </select>
                                                                            <input
                                                                                value={assignHelperValue}
                                                                                onChange={(e) => setAssignHelperByPlanId((prev) => ({ ...prev, [pid]: e.target.value }))}
                                                                                placeholder="Manipulant (optional)"
                                                                                className="flex-1 px-2 py-1.5 bg-slate-900/55 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 text-[11px]"
                                                                            />
                                                                        </div>
                                                                        <div className="flex items-center gap-2">
                                                                        <select
                                                                            value={assignValue}
                                                                            onChange={(e) => setAssignPlateByPlanId((prev) => ({ ...prev, [pid]: e.target.value.toUpperCase() }))}
                                                                            className="flex-1 px-2 py-1.5 bg-slate-900/55 border border-slate-700/50 rounded-xl text-white focus:outline-none focus:border-emerald-500/50 text-[11px] font-mono tracking-wider"
                                                                        >
                                                                            <option value="">Masina (optional)</option>
                                                                            {availableFleetVehicles.map((v) => {
                                                                                const plate = String(v?.plate || '').trim().toUpperCase();
                                                                                if (!plate) return null;
                                                                                const drv = String(v?.assigned_driver_name || '').trim();
                                                                                return (
                                                                                    <option key={`${pid}-${plate}`} value={plate}>
                                                                                        {plate}{drv ? ` • ${drv}` : ''}
                                                                                    </option>
                                                                                );
                                                                            })}
                                                                        </select>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => assignPlan(r)}
                                                                            className="px-2 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-100 text-[10px] font-black uppercase tracking-wider hover:bg-emerald-500/25 transition-all flex items-center gap-1"
                                                                        >
                                                                            <Truck size={12} /> {status === 'Assigned' ? 'Reassign' : 'Assign'}
                                                                        </button>
                                                                    </div>
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-3">
                                                    Fara rute
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : null}

                {!isDriver ? (
                    <div className="glass-strong p-5 rounded-3xl border-iridescent space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">Manual Local Route</p>
                        <span className="text-[10px] font-bold text-slate-500">
                            Driver: <span className="text-slate-300 font-mono">{user?.name || 'N/A'}</span>
                        </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Route label (optional)"
                            className="sm:col-span-2 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium"
                        />
                        <input
                            value={vehiclePlate}
                            onChange={(e) => setVehiclePlate(e.target.value)}
                            placeholder="Vehicle plate (ex: BC75ARI)"
                            className="sm:col-span-3 px-4 py-3.5 bg-slate-900/50 border border-slate-700/50 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all duration-300 text-sm font-medium font-mono tracking-wider"
                        />
                    </div>
                    <button
                        onClick={handleCreate}
                        className="w-full btn-premium py-4 bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:shadow-glow-md transition-all flex items-center justify-center gap-2"
                    >
                        <Plus size={18} />
                        Create Local Route
                    </button>
                    </div>
                ) : null}

                {!isDriver ? (
                    routes.length === 0 ? (
                        <div className="text-center py-16 text-slate-400">
                            <div className="w-20 h-20 glass-strong rounded-3xl flex items-center justify-center mx-auto mb-6 border-iridescent">
                                <MapPinned className="text-slate-500" size={36} />
                            </div>
                            <p className="font-bold text-slate-300 text-lg">No local routes yet</p>
                            <p className="text-sm mt-2 text-slate-500">Create your first route above</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-2">
                                Your Local Routes
                            </h3>
                            {routes.map((r) => (
                                <div
                                    key={r.id}
                                    className="glass-strong p-5 rounded-3xl border border-white/10 hover:border-emerald-500/30 transition-all group"
                                >
                                    <div className="flex items-start gap-4">
                                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 flex items-center justify-center shadow-glow-sm">
                                            <MapPinned size={18} className="text-white" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="text-white font-black truncate">{routeDisplayName(r)}</p>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide mt-1">
                                                        {r.date || 'No date'} • {Array.isArray(r.awbs) ? r.awbs.length : 0} stops{r.vehicle_plate ? ` • ${r.vehicle_plate}` : ''}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleDelete(r.id)}
                                                        className="p-2 rounded-xl glass-light border border-white/10 text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all"
                                                        title="Delete route"
                                                    >
                                                        <Trash2 size={18} />
                                                    </button>
                                                    {canWriteRoutePlans ? (
                                                        <button
                                                            onClick={() => publishLocalRoute(r)}
                                                            disabled={publishingRouteId === String(r.id)}
                                                            className={`p-2 rounded-xl glass-light border border-white/10 active:scale-95 transition-all ${publishingRouteId === String(r.id)
                                                                ? 'text-slate-500 cursor-not-allowed'
                                                                : 'text-blue-300 hover:bg-blue-500/10'}`}
                                                            title="Publica pentru aprobare"
                                                        >
                                                            <CheckCircle2 size={18} className={publishingRouteId === String(r.id) ? 'animate-pulse' : ''} />
                                                        </button>
                                                    ) : null}
                                                    <button
                                                        onClick={() => navigate(`/routes/${r.id}`)}
                                                        className="p-2 rounded-xl glass-light border border-white/10 text-emerald-400 hover:bg-emerald-500/10 active:scale-95 transition-all"
                                                        title="Open route"
                                                    >
                                                        <ArrowRight size={18} />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                ) : null}
            </div>

            {openIssueList ? (
                <div
                    className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center"
                    onClick={() => setOpenIssueList('')}
                >
                    <div
                        className="w-full max-w-lg max-h-[80vh] glass-strong rounded-3xl border border-white/15 overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-xs font-black text-white uppercase tracking-widest truncate">{issueListTitle}</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">
                                    {issueListItems.length} AWB-uri
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpenIssueList('')}
                                className="p-2 rounded-xl glass-light border border-white/10 text-slate-300 hover:text-white"
                                aria-label="Inchide"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="p-3 overflow-y-auto max-h-[60vh] space-y-2">
                            {issueListItems.length === 0 ? (
                                <div className="p-3 text-xs font-bold text-slate-400">Niciun AWB in aceasta categorie.</div>
                            ) : issueListItems.map((item, idx) => {
                                const awb = String(item?.awb || '').trim();
                                const recipient = String(item?.recipient_name || '').trim();
                                const locality = String(item?.locality || '').trim();
                                const county = String(item?.county || '').trim();
                                return (
                                    <div key={`${awb || 'awb'}-${idx}`} className="p-3 rounded-2xl border border-white/10 bg-slate-900/35">
                                        <p className="text-[11px] font-mono font-black text-emerald-300 tracking-wider truncate">{awb || 'AWB necunoscut'}</p>
                                        {recipient ? (
                                            <p className="text-xs font-bold text-white mt-1 truncate">{recipient}</p>
                                        ) : null}
                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1 truncate">
                                            {openIssueList === 'outside_region'
                                                ? (county ? `Judet: ${county}` : 'Judet: necunoscut')
                                                : (locality ? `Localitate: ${locality}` : 'Localitate: necunoscuta')}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            ) : null}

            {detailsPlan ? (
                <div
                    className="fixed inset-0 z-[85] bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center"
                    onClick={() => setDetailsPlan(null)}
                >
                    <div
                        className="w-full max-w-xl max-h-[85vh] glass-strong rounded-3xl border border-white/15 overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-4 border-b border-white/10 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-sm font-black text-white truncate">
                                    {String(detailsPlan?.name || detailsPlan?.county || '').trim() || `Route #${detailsPlan?.id}`}
                                </p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-1">
                                    {String(detailsPlan?.plan_date || date)} • {Number(detailsPlan?.awb_count || (Array.isArray(detailsPlan?.awbs) ? detailsPlan.awbs.length : 0) || 0)} AWB
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDetailsPlan(null)}
                                className="p-2 rounded-xl glass-light border border-white/10 text-slate-300 hover:text-white"
                                aria-label="Inchide"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="p-4 space-y-3 overflow-y-auto max-h-[65vh]">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Status</p>
                                    <p className="text-sm text-white font-bold mt-1">{String(detailsPlan?.status || '-')}</p>
                                </div>
                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Masina/Echipaj</p>
                                    <p className="text-sm text-white font-bold mt-1 truncate">{planCrew(detailsPlan) || '-'}</p>
                                </div>
                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Volum</p>
                                    <p className="text-sm text-white font-bold mt-1">
                                        {Number(detailsPlan?.load_volume_m3 || 0).toFixed(2)} / {Number(detailsPlan?.target_volume_m3 || 0).toFixed(2)} m3
                                    </p>
                                </div>
                                <div className="p-3 rounded-2xl bg-slate-900/40 border border-white/10">
                                    <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Greutate</p>
                                    <p className="text-sm text-white font-bold mt-1">
                                        {Number(detailsPlan?.load_weight_kg || 0).toFixed(1)} / {Number(detailsPlan?.target_weight_kg || 0).toFixed(1)} kg
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Lista AWB</p>
                                {Array.isArray(detailsPlan?.awbs) && detailsPlan.awbs.length > 0 ? (
                                    <div className="space-y-2">
                                        {detailsPlan.awbs.map((awb, idx) => (
                                            <div key={`${awb}-${idx}`} className="p-2.5 rounded-xl bg-slate-900/45 border border-white/10 text-[11px] font-mono font-black text-emerald-300 tracking-wider">
                                                {String(awb || '').trim() || `AWB-${idx + 1}`}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="p-3 rounded-2xl bg-slate-900/35 border border-white/10 text-xs font-bold text-slate-400">
                                        Nu exista AWB in aceasta ruta.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </motion.div>
    );
}
