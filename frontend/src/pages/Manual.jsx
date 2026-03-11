import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { BookOpenText, DollarSign, Eye, LifeBuoy, ShieldCheck, Truck, User, Users, Warehouse } from 'lucide-react';
import { ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, ROLE_FINANCE, ROLE_MANAGER, ROLE_RECIPIENT, ROLE_SUPPORT, ROLE_VIEWER, ROLE_WAREHOUSE, normalizeRole } from '../auth/permissions';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const ROLE_ORDER = [
    ROLE_ADMIN,
    ROLE_MANAGER,
    ROLE_DISPATCHER,
    ROLE_WAREHOUSE,
    ROLE_DRIVER,
    ROLE_SUPPORT,
    ROLE_FINANCE,
    ROLE_VIEWER,
    ROLE_RECIPIENT,
];

const ROLE_ICON = {
    [ROLE_ADMIN]: ShieldCheck,
    [ROLE_MANAGER]: Users,
    [ROLE_DISPATCHER]: Users,
    [ROLE_WAREHOUSE]: Warehouse,
    [ROLE_DRIVER]: Truck,
    [ROLE_SUPPORT]: LifeBuoy,
    [ROLE_FINANCE]: DollarSign,
    [ROLE_VIEWER]: Eye,
    [ROLE_RECIPIENT]: User,
};

const tx = (lang, en, ro) => (lang === 'ro' ? ro : en);

const COMMON_ROUTING_SECTION = {
    title: { en: 'Routing logic (how it works)', ro: 'Logica rutarii (cum functioneaza)' },
    steps: [
        {
            en: 'Only eligible AWBs enter routing; routes are grouped by county and split by max stops/capacity.',
            ro: 'Doar AWB-urile eligibile intra in rutare; rutele sunt grupate pe judet si impartite dupa stopuri/capacitate maxima.',
        },
        {
            en: 'Statuses flow strictly as Draft -> Approved -> Assigned.',
            ro: 'Fluxul statusurilor este strict Draft -> Approved -> Assigned.',
        },
        {
            en: 'A route becomes visible to the driver only after approval and assignment to vehicle/driver/helper.',
            ro: 'O ruta devine vizibila soferului doar dupa aprobare si alocare pe masina/sofer/manipulant.',
        },
    ],
};

const MANUALS = {
    [ROLE_ADMIN]: {
        title: { en: 'Administrator Manual', ro: 'Manual Administrator' },
        sections: [
            {
                title: { en: 'Daily start (04:00 sync)', ro: 'Pornire zilnica (sync 04:00)' },
                steps: [
                    { en: 'Open Settings and verify Postis sync status.', ro: 'Deschide Setari si verifica statusul sincronizarii Postis.' },
                    { en: 'Run manual sync if needed and check AWB import results.', ro: 'Ruleaza sincronizarea manuala daca este nevoie si verifica rezultatul importului AWB.' },
                    { en: 'Review errors and retry failed sync batches.', ro: 'Revizuieste erorile si relanseaza loturile de sincronizare esuate.' },
                ],
            },
            {
                title: { en: 'Route planning and approval', ro: 'Planificare si aprobare rute' },
                steps: [
                    { en: 'Go to Routes and generate daily route plans.', ro: 'Intra in Rute si genereaza planurile zilnice.' },
                    { en: 'Validate load by volume/weight per vehicle type.', ro: 'Valideaza incarcarea pe volum/greutate pentru fiecare tip de masina.' },
                    { en: 'Approve the route, then assign plate, driver, and helper.', ro: 'Aproba ruta, apoi aloca numar, sofer si manipulant.' },
                ],
            },
            {
                title: { en: 'Users and operations', ro: 'Utilizatori si operatiuni' },
                steps: [
                    { en: 'Manage users/roles from Users page and keep phone numbers updated.', ro: 'Administreaza conturi/roluri din Utilizatori si mentine telefoanele actualizate.' },
                    { en: 'Monitor active runs in Live Ops and delivery logs in History.', ro: 'Monitorizeaza cursele active in Live Ops si logurile in Istoric.' },
                    { en: 'Track COD and BIB KPIs in Finance and BIB pages.', ro: 'Urmareste KPI-urile COD si BIB in paginile Financiar si BIB.' },
                ],
            },
        ],
    },
    [ROLE_MANAGER]: {
        title: { en: 'Manager Manual', ro: 'Manual Manager' },
        sections: [
            {
                title: { en: 'Morning workflow', ro: 'Flux de dimineata' },
                steps: [
                    { en: 'Check synchronized AWBs and route-ready shipments.', ro: 'Verifica AWB-urile sincronizate si coletele pregatite de rutare.' },
                    { en: 'Review fleet capacity and route load utilization.', ro: 'Revizuieste capacitatea flotei si gradul de incarcare pe ruta.' },
                    { en: 'Confirm priorities and delivery windows with dispatcher.', ro: 'Confirma prioritatile si intervalele de livrare cu dispecerul.' },
                ],
            },
            {
                title: { en: 'Execution control', ro: 'Control executie' },
                steps: [
                    { en: 'Follow route progress in Live Ops.', ro: 'Urmarire progres rute in Live Ops.' },
                    { en: 'Resolve escalations (failed delivery, delay, address issue).', ro: 'Rezolva escaladarile (nelivrat, intarziere, adresa).'},
                    { en: 'Coordinate reallocations with admin/dispatcher.', ro: 'Coordoneaza realocarile cu admin/dispecer.' },
                ],
            },
        ],
    },
    [ROLE_DISPATCHER]: {
        title: { en: 'Dispatcher Manual', ro: 'Manual Dispecer' },
        sections: [
            {
                title: { en: 'Plan and assign routes', ro: 'Planificare si alocare rute' },
                steps: [
                    { en: 'Generate manual route plan when needed.', ro: 'Genereaza plan de rute manual atunci cand este nevoie.' },
                    { en: 'Verify stops, route order, and county grouping.', ro: 'Verifica stopurile, ordinea pe ruta si gruparea pe judet.' },
                    { en: 'Assign route to vehicle plate and driver only after approval.', ro: 'Aloca ruta pe numar de inmatriculare si sofer doar dupa aprobare.' },
                ],
            },
            {
                title: { en: 'Operational support', ro: 'Suport operational' },
                steps: [
                    { en: 'Watch notifications and chat for driver requests.', ro: 'Monitorizeaza notificarile si chatul pentru solicitari de la soferi.' },
                    { en: 'Update contacts/phones when route data changes.', ro: 'Actualizeaza contactele/telefoanele cand se modifica datele rutei.' },
                    { en: 'Keep backup route options for overload days.', ro: 'Pastreaza optiuni de backup pentru zilele cu supraincarcare.' },
                ],
            },
        ],
    },
    [ROLE_WAREHOUSE]: {
        title: { en: 'Warehouse Manual', ro: 'Manual Depozit' },
        sections: [
            {
                title: { en: 'Load and unload scans', ro: 'Scanari incarcare/descarcare' },
                steps: [
                    { en: 'Use Manifests for inbound and outbound scan sessions.', ro: 'Foloseste Manifeste pentru sesiuni de scanare la intrare/iesire.' },
                    { en: 'Confirm every scanned AWB before closing manifest.', ro: 'Confirma fiecare AWB scanat inainte de inchiderea manifestului.' },
                    { en: 'Report missing/damaged parcels immediately.', ro: 'Raporteaza imediat coletele lipsa sau deteriorate.' },
                ],
            },
            {
                title: { en: 'Route handover', ro: 'Predare catre rute' },
                steps: [
                    { en: 'Prepare parcels by approved route and assigned vehicle.', ro: 'Pregateste coletele pe ruta aprobata si vehicul alocat.' },
                    { en: 'Validate buy-back returns and label them correctly.', ro: 'Valideaza retururile buy-back si eticheteaza-le corect.' },
                    { en: 'Confirm transfer to driver with final scan proof.', ro: 'Confirma transferul catre sofer cu dovada finala de scanare.' },
                ],
            },
        ],
    },
    [ROLE_DRIVER]: {
        title: { en: 'Driver Manual', ro: 'Manual Sofer' },
        sections: [
            {
                title: { en: 'Before departure', ro: 'Inainte de plecare' },
                steps: [
                    { en: 'Open Routes and check allocated route, vehicle, and helper.', ro: 'Deschide Rute si verifica ruta alocata, masina si manipulantul.' },
                    { en: 'Verify stop order and special delivery notes.', ro: 'Verifica ordinea stopurilor si notele speciale de livrare.' },
                    { en: 'Make sure the route is started only after loading is complete.', ro: 'Porneste cursa doar dupa ce incarcarea este finalizata.' },
                ],
            },
            {
                title: { en: 'At delivery stop', ro: 'La stopul de livrare' },
                steps: [
                    { en: 'Update AWB status only after delivery is completed.', ro: 'Actualizeaza statusul AWB doar dupa finalizarea livrarii.' },
                    { en: 'When COD is required, collect exact amount shown in alert.', ro: 'Cand exista ramburs, incaseaza exact suma afisata in alerta.' },
                    { en: 'Upload receipt photo before final Delivered status.', ro: 'Incarca poza chitantei inainte de statusul final Livrat.' },
                ],
            },
            {
                title: { en: 'Buy-back collection', ro: 'Preluare buy-back' },
                steps: [
                    { en: 'If shipment contains buy-back instruction, collect returned product.', ro: 'Daca AWB are instructiune buy-back, preia produsul returnat.' },
                    { en: 'Take a clear photo of collected product before status change.', ro: 'Fa poza clara produsului preluat inainte de schimbarea statusului.' },
                    { en: 'Deliver collected buy-back items to warehouse at route end.', ro: 'Preda produsele buy-back la depozit la finalul rutei.' },
                ],
            },
        ],
    },
    [ROLE_SUPPORT]: {
        title: { en: 'Support Manual', ro: 'Manual Suport' },
        sections: [
            {
                title: { en: 'Client and driver assistance', ro: 'Asistenta clienti si soferi' },
                steps: [
                    { en: 'Use Tracking and History to validate shipment timeline.', ro: 'Foloseste Tracking si Istoric pentru validarea traseului AWB.' },
                    { en: 'Respond through Chat and Notifications with clear next steps.', ro: 'Raspunde prin Chat si Notificari cu pasi clari de rezolvare.' },
                    { en: 'Escalate operational blockers to dispatcher/admin.', ro: 'Escaladeaza blocajele operationale catre dispecer/admin.' },
                ],
            },
        ],
    },
    [ROLE_FINANCE]: {
        title: { en: 'Finance Manual', ro: 'Manual Financiar' },
        sections: [
            {
                title: { en: 'COD reconciliation', ro: 'Reconciliere ramburs' },
                steps: [
                    { en: 'Review COD totals in Finance by day, route, and driver.', ro: 'Verifica totalurile de ramburs in Financiar pe zi, ruta si sofer.' },
                    { en: 'Match proof photos and collected amounts for each AWB.', ro: 'Coreleaza pozele de dovada si sumele incasate pentru fiecare AWB.' },
                    { en: 'Flag discrepancies and notify admin immediately.', ro: 'Semnaleaza diferentele si notifica adminul imediat.' },
                ],
            },
        ],
    },
    [ROLE_VIEWER]: {
        title: { en: 'Viewer Manual', ro: 'Manual Vizualizare' },
        sections: [
            {
                title: { en: 'Read-only monitoring', ro: 'Monitorizare read-only' },
                steps: [
                    { en: 'Use dashboard, shipments, routes, and analytics in read mode.', ro: 'Foloseste dashboard, colete, rute si analitice in mod doar citire.' },
                    { en: 'Do not perform operational changes in route/awb status.', ro: 'Nu efectua modificari operationale pe statusuri AWB/rute.' },
                    { en: 'Report anomalies to admin/manager with AWB and timestamp.', ro: 'Raporteaza anomaliile catre admin/manager cu AWB si timestamp.' },
                ],
            },
        ],
    },
    [ROLE_RECIPIENT]: {
        title: { en: 'Recipient Manual', ro: 'Manual Destinatar' },
        sections: [
            {
                title: { en: 'Tracking your shipment', ro: 'Urmarirea coletului' },
                steps: [
                    { en: 'Open Shipments to see status and delivery progress.', ro: 'Deschide Colete pentru a vedea statusul si progresul livrarii.' },
                    { en: 'Use Notifications for delivery updates.', ro: 'Foloseste Notificari pentru actualizari de livrare.' },
                    { en: 'Use Chat to contact support when needed.', ro: 'Foloseste Chat pentru suport atunci cand este necesar.' },
                ],
            },
        ],
    },
};

function roleLabel(role, lang) {
    switch (role) {
    case ROLE_ADMIN: return tx(lang, 'Admin', 'Admin');
    case ROLE_MANAGER: return tx(lang, 'Manager', 'Manager');
    case ROLE_DISPATCHER: return tx(lang, 'Dispatcher', 'Dispecer');
    case ROLE_WAREHOUSE: return tx(lang, 'Warehouse', 'Depozit');
    case ROLE_DRIVER: return tx(lang, 'Driver', 'Sofer');
    case ROLE_SUPPORT: return tx(lang, 'Support', 'Suport');
    case ROLE_FINANCE: return tx(lang, 'Finance', 'Financiar');
    case ROLE_VIEWER: return tx(lang, 'Viewer', 'Vizualizare');
    case ROLE_RECIPIENT: return tx(lang, 'Recipient', 'Destinatar');
    default: return String(role || '-');
    }
}

const ManualCard = ({ role, lang }) => {
    const manual = MANUALS[role];
    if (!manual) return null;
    const Icon = ROLE_ICON[role] || BookOpenText;
    const sections = [COMMON_ROUTING_SECTION, ...(Array.isArray(manual.sections) ? manual.sections : [])];

    return (
        <motion.section
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22 }}
            className="glass-light border border-white/10 rounded-3xl p-4 sm:p-5"
        >
            <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500/25 to-cyan-500/20 border border-white/15 flex items-center justify-center">
                    <Icon size={18} className="text-indigo-200" />
                </div>
                <div>
                    <h2 className="text-base sm:text-lg font-black text-white leading-tight">
                        {tx(lang, manual.title.en, manual.title.ro)}
                    </h2>
                    <div className="text-xs text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                        {roleLabel(role, lang)}
                    </div>
                </div>
            </div>

            <div className="mt-4 space-y-4">
                {sections.map((section) => (
                    <div key={tx('en', section.title.en, section.title.ro)} className="rounded-2xl bg-slate-900/35 border border-white/10 p-3.5">
                        <h3 className="text-sm font-black text-white">
                            {tx(lang, section.title.en, section.title.ro)}
                        </h3>
                        <ol className="mt-2 space-y-2">
                            {(Array.isArray(section.steps) ? section.steps : []).map((step, idx) => (
                                <li key={`${tx('en', step.en, step.ro)}-${idx}`} className="flex gap-2.5 text-sm text-slate-200 leading-relaxed">
                                    <span className="mt-0.5 w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-400/30 text-[11px] font-black text-indigo-100 flex items-center justify-center flex-shrink-0">
                                        {idx + 1}
                                    </span>
                                    <span>{tx(lang, step.en, step.ro)}</span>
                                </li>
                            ))}
                        </ol>
                    </div>
                ))}
            </div>
        </motion.section>
    );
};

export default function Manual() {
    const { user } = useAuth();
    const { lang } = useLanguage();
    const role = normalizeRole(user?.role);
    const isAdmin = role === ROLE_ADMIN;
    const [adminFilter, setAdminFilter] = useState('ALL');

    const availableRoles = useMemo(
        () => ROLE_ORDER.filter((r) => Boolean(MANUALS[r])),
        []
    );

    const rolesToShow = useMemo(() => {
        if (isAdmin) {
            if (adminFilter === 'ALL') return availableRoles;
            return availableRoles.includes(adminFilter) ? [adminFilter] : availableRoles;
        }
        if (MANUALS[role]) return [role];
        return [ROLE_DRIVER];
    }, [isAdmin, adminFilter, availableRoles, role]);

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-6 pb-28">
            <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22 }}
                className="glass-strong rounded-3xl border border-white/10 p-5 sm:p-6 mb-5"
            >
                <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center shadow-lg">
                        <BookOpenText size={22} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-xl sm:text-2xl font-black text-white leading-tight">
                            {tx(lang, 'Usage Manual', 'Manual de utilizare')}
                        </h1>
                        <p className="text-sm text-slate-300 mt-1">
                            {isAdmin
                                ? tx(lang, 'Admin can view manuals for all user types.', 'Adminul poate vedea toate manualele de utilizare.')
                                : tx(lang, 'You can view only the manual assigned to your role.', 'Poti vedea doar manualul corespunzator rolului tau.')}
                        </p>
                        <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider mt-2">
                            {tx(lang, 'Current role', 'Rol curent')}: {roleLabel(role, lang)}
                        </div>
                    </div>
                </div>
            </motion.div>

            {isAdmin ? (
                <div className="mb-5 flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => setAdminFilter('ALL')}
                        className={`px-3.5 py-2 rounded-xl text-xs font-black uppercase tracking-wider border transition-all ${adminFilter === 'ALL'
                            ? 'bg-indigo-500/30 border-indigo-400/50 text-indigo-100'
                            : 'bg-slate-900/40 border-white/10 text-slate-300'
                            }`}
                    >
                        {tx(lang, 'All manuals', 'Toate manualele')}
                    </button>
                    {availableRoles.map((r) => (
                        <button
                            key={r}
                            type="button"
                            onClick={() => setAdminFilter(r)}
                            className={`px-3.5 py-2 rounded-xl text-xs font-black uppercase tracking-wider border transition-all ${adminFilter === r
                                ? 'bg-indigo-500/30 border-indigo-400/50 text-indigo-100'
                                : 'bg-slate-900/40 border-white/10 text-slate-300'
                                }`}
                        >
                            {roleLabel(r, lang)}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="grid gap-4 sm:gap-5">
                {rolesToShow.map((r) => (
                    <ManualCard key={r} role={r} lang={lang} />
                ))}
            </div>
        </div>
    );
}
