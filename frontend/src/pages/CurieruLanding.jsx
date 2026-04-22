import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
    ArrowRight,
    Boxes,
    Building2,
    CheckCircle2,
    ClipboardCheck,
    CreditCard,
    MapPinned,
    PackageCheck,
    Radar,
    Route,
    ScanLine,
    ShieldCheck,
    Truck,
    Warehouse,
    WifiOff,
} from 'lucide-react';

const CONTACT_EMAIL = 'contact@curieru.com';

const content = {
    ro: {
        htmlLang: 'ro',
        title: 'Curieru - Platforma last-mile pentru curierat si 3PL',
        pilotSubject: 'Pilot Curieru pentru operatiuni last-mile',
        nav: {
            landingPath: '/curieru',
            alternatePath: '/curieru/en',
            alternateLabel: 'EN',
            login: 'Login',
        },
        hero: {
            eyebrow: 'Platforma operationala B2B pentru last-mile',
            title: 'Curieru transforma operatiunile last-mile intr-un sistem live.',
            text: 'Scanare, rutare, tracking, COD, manifest, flota si sincronizare Postis intr-un singur loc pentru curierat, 3PL si flote regionale.',
            pilotCta: 'Cere pilot',
            appCta: 'Vezi aplicatia',
            stats: [
                { value: '30-60', label: 'zile pilot' },
                { value: '1 hub', label: 'setup initial' },
                { value: 'live', label: 'operatiuni teren' },
            ],
        },
        audiencesIntro: {
            eyebrow: 'Pentru cine este',
            title: 'Curieru este construit pentru echipe care livreaza, nu doar urmaresc colete.',
        },
        audiences: [
            {
                icon: Truck,
                title: 'Curierat regional',
                text: 'Pentru operatori care au nevoie de scanare rapida, rute controlate si statusuri trimise corect in teren.',
            },
            {
                icon: Warehouse,
                title: '3PL si depozite',
                text: 'Pentru echipe care coordoneaza manifest, incarcare, descarcare, flota si exceptii intr-un flux verificabil.',
            },
            {
                icon: Building2,
                title: 'Retail cu flota proprie',
                text: 'Pentru magazine si retele care vor control asupra livrarilor, retururilor, COD si experientei clientului final.',
            },
        ],
        problemsIntro: {
            eyebrow: 'Ce rezolva',
            title: 'Mai putine telefoane, mai putine presupuneri, mai multa executie verificabila.',
            text: 'Curieru strange intr-un flux comun tot ce se pierde de obicei intre depozit, dispecerat, curier si client.',
        },
        problems: [
            'Erori manuale la scanare, status si predare',
            'Dispecerat fara vizibilitate live asupra rutelor',
            'COD greu de reconciliat pe curier, zi si AWB',
            'Manifest si incarcare fara dovada operationala clara',
            'Statusuri intarziate cand semnalul din teren cade',
        ],
        modulesIntro: {
            eyebrow: 'Module',
            title: 'Un sistem operational complet, pornit din realitatea terenului.',
            text: 'Fiecare modul sustine acelasi obiectiv: fluxuri mai rapide si date mai curate pentru decizii zilnice.',
        },
        modules: [
            { icon: ScanLine, label: 'PWA curier', detail: 'scanare AWB, status, GPS, foto, semnatura' },
            { icon: ClipboardCheck, label: 'Dispecerat', detail: 'alocari, exceptii, notificari, control roluri' },
            { icon: Route, label: 'Rutare', detail: 'planuri zilnice, incarcare, sofer, helper, avize' },
            { icon: Radar, label: 'Live Ops', detail: 'harta live, curse active, soferi intarziati sau offline' },
            { icon: CreditCard, label: 'COD / Finance', detail: 'sume asteptate, incasate si ramase de colectat' },
            { icon: Boxes, label: 'Manifest depozit', detail: 'scanare incarcare/descarcare si control colete lipsa' },
            { icon: Truck, label: 'Fleet', detail: 'vehicule, telefoane, documente, service si asigurari' },
            { icon: MapPinned, label: 'Tracking client', detail: 'cereri de locatie si comunicare pe AWB' },
            { icon: PackageCheck, label: 'Postis sync', detail: 'sincronizare comenzi, statusuri, etichete si istoric' },
        ],
        proofIntro: {
            eyebrow: 'De ce acum',
            title: 'Last-mile-ul nu mai poate fi condus din Excel, telefoane si statusuri intarziate.',
        },
        proofPoints: [
            {
                icon: WifiOff,
                title: 'Offline-first in teren',
                text: 'Curierii pot lucra si cand semnalul cade. Actualizarile se pun in coada locala si se sincronizeaza cand conexiunea revine.',
            },
            {
                icon: Radar,
                title: 'Operatiuni live',
                text: 'Dispeceratul vede soferi, curse, progres si intarzieri intr-un singur ecran, fara telefoane repetate pentru status.',
            },
            {
                icon: ShieldCheck,
                title: 'Control verificabil',
                text: 'Roluri, loguri, dovezi foto, COD si istoric AWB reduc discutiile neclare dintre depozit, curier si client.',
            },
        ],
        offer: {
            eyebrow: 'Oferta v1',
            title: 'Pilot platit pentru primul hub, cu rezultate masurabile.',
            text: 'Incepem controlat: configurare Postis, onboarding pentru echipa, flota sau hub operational si raport la finalul pilotului.',
            badge: '30-60 zile',
            cardTitle: 'Pilot Curieru',
            bullets: [
                'Setup initial pentru un hub sau o flota.',
                'Training pentru dispecerat, depozit si curieri.',
                'Raport de impact: rute, statusuri, COD si exceptii.',
            ],
        },
    },
    en: {
        htmlLang: 'en',
        title: 'Curieru - Last-mile platform for couriers and 3PL operations',
        pilotSubject: 'Curieru pilot for last-mile operations',
        nav: {
            landingPath: '/curieru/en',
            alternatePath: '/curieru',
            alternateLabel: 'RO',
            login: 'Login',
        },
        hero: {
            eyebrow: 'B2B operations platform for last-mile delivery',
            title: 'Curieru turns last-mile operations into a live operating system.',
            text: 'Scanning, routing, tracking, COD, manifests, fleet control and Postis synchronization in one place for courier companies, 3PLs and regional fleets.',
            pilotCta: 'Request pilot',
            appCta: 'View app',
            stats: [
                { value: '30-60', label: 'day pilot' },
                { value: '1 hub', label: 'initial setup' },
                { value: 'live', label: 'field operations' },
            ],
        },
        audiencesIntro: {
            eyebrow: 'Who it is for',
            title: 'Curieru is built for teams that deliver, not just teams that track parcels.',
        },
        audiences: [
            {
                icon: Truck,
                title: 'Regional courier operators',
                text: 'For operators that need fast scanning, controlled routes and field statuses sent correctly every day.',
            },
            {
                icon: Warehouse,
                title: '3PL and warehouse teams',
                text: 'For teams coordinating manifests, loading, unloading, fleet activity and exceptions through a verifiable workflow.',
            },
            {
                icon: Building2,
                title: 'Retailers with own fleets',
                text: 'For stores and networks that want control over deliveries, returns, COD and the final customer experience.',
            },
        ],
        problemsIntro: {
            eyebrow: 'What it solves',
            title: 'Fewer calls, fewer assumptions, more verifiable execution.',
            text: 'Curieru brings into one workflow the data that usually gets lost between warehouse, dispatch, courier and customer.',
        },
        problems: [
            'Manual errors in scanning, status updates and handover',
            'Dispatch teams without live visibility over active routes',
            'COD that is hard to reconcile by driver, day and AWB',
            'Manifest and loading processes without clear operational proof',
            'Delayed statuses when field connectivity drops',
        ],
        modulesIntro: {
            eyebrow: 'Modules',
            title: 'A complete operating system built from real field workflows.',
            text: 'Each module supports the same goal: faster workflows and cleaner data for daily decisions.',
        },
        modules: [
            { icon: ScanLine, label: 'Courier PWA', detail: 'AWB scanning, status, GPS, photos, signature' },
            { icon: ClipboardCheck, label: 'Dispatch', detail: 'assignments, exceptions, notifications, role control' },
            { icon: Route, label: 'Routing', detail: 'daily plans, loading, driver, helper and waybills' },
            { icon: Radar, label: 'Live Ops', detail: 'live map, active runs, delayed or offline drivers' },
            { icon: CreditCard, label: 'COD / Finance', detail: 'expected, collected and remaining cash amounts' },
            { icon: Boxes, label: 'Warehouse manifest', detail: 'loading/unloading scans and missing parcel control' },
            { icon: Truck, label: 'Fleet', detail: 'vehicles, phones, documents, service and insurance' },
            { icon: MapPinned, label: 'Customer tracking', detail: 'location requests and AWB-level communication' },
            { icon: PackageCheck, label: 'Postis sync', detail: 'orders, statuses, labels and history synchronization' },
        ],
        proofIntro: {
            eyebrow: 'Why now',
            title: 'Last-mile can no longer be run from spreadsheets, calls and delayed statuses.',
        },
        proofPoints: [
            {
                icon: WifiOff,
                title: 'Offline-first in the field',
                text: 'Couriers can keep working when signal drops. Updates are queued locally and synced when connectivity returns.',
            },
            {
                icon: Radar,
                title: 'Live operations',
                text: 'Dispatch sees drivers, runs, progress and delays in one screen, without repeated status calls.',
            },
            {
                icon: ShieldCheck,
                title: 'Verifiable control',
                text: 'Roles, logs, photo proof, COD and AWB history reduce unclear handoffs between warehouse, courier and customer.',
            },
        ],
        offer: {
            eyebrow: 'V1 offer',
            title: 'Paid pilot for the first hub, with measurable results.',
            text: 'We start in a controlled way: Postis configuration, team onboarding, one operational hub or fleet and a results report at the end of the pilot.',
            badge: '30-60 days',
            cardTitle: 'Curieru pilot',
            bullets: [
                'Initial setup for one hub or fleet.',
                'Training for dispatch, warehouse and couriers.',
                'Impact report: routes, statuses, COD and exceptions.',
            ],
        },
    },
};

const getLocaleFromPath = (pathname) => (String(pathname || '').endsWith('/en') ? 'en' : 'ro');

export default function CurieruLanding() {
    const location = useLocation();
    const locale = getLocaleFromPath(location.pathname);
    const copy = content[locale];
    const pilotMailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(copy.pilotSubject)}`;

    useEffect(() => {
        const previousTitle = document.title;
        const previousLang = document.documentElement.lang;
        document.title = copy.title;
        document.documentElement.lang = copy.htmlLang;
        return () => {
            document.title = previousTitle;
            document.documentElement.lang = previousLang;
        };
    }, [copy.htmlLang, copy.title]);

    return (
        <main className="min-h-screen bg-slate-50 text-slate-950">
            <section className="relative min-h-[760px] overflow-hidden bg-slate-950 text-white sm:min-h-[84vh]">
                <img
                    src="/curieru-logistics-architecture.jpg"
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover object-center opacity-0 sm:opacity-40"
                />
                <div className="absolute inset-0 bg-slate-950/84 sm:bg-slate-950/68 lg:bg-gradient-to-r lg:from-slate-950 lg:via-slate-950/88 lg:to-slate-950/36" />
                <div className="relative z-10 mx-auto flex min-h-[760px] w-full max-w-7xl flex-col px-5 sm:min-h-[84vh] sm:px-8">
                    <nav className="flex flex-wrap items-center justify-between gap-3 py-5">
                        <Link to={copy.nav.landingPath} className="flex items-center gap-3" aria-label="Curieru">
                            <img src="/logo-horizontal.png" alt="" className="h-9 w-auto max-w-[150px] object-contain" />
                            <span className="border-l border-white/20 pl-3 text-lg font-black tracking-tight">Curieru</span>
                        </Link>
                        <div className="flex items-center gap-2">
                            <Link
                                to={copy.nav.alternatePath}
                                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/20 px-3 text-sm font-black text-white transition hover:bg-white/10"
                            >
                                {copy.nav.alternateLabel}
                            </Link>
                            <Link
                                to="/login"
                                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/20 px-4 text-sm font-black text-white transition hover:bg-white/10"
                            >
                                {copy.nav.login}
                            </Link>
                        </div>
                    </nav>

                    <div className="flex flex-1 items-center pb-12 pt-8">
                        <div className="max-w-3xl">
                            <p className="mb-5 inline-flex max-w-full rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-[10px] font-black uppercase leading-5 tracking-[0.14em] text-cyan-100 sm:text-xs sm:tracking-[0.2em]">
                                {copy.hero.eyebrow}
                            </p>
                            <h1 className="text-4xl font-black leading-[1.02] tracking-normal text-white sm:text-6xl lg:text-7xl">
                                {copy.hero.title}
                            </h1>
                            <p className="mt-6 max-w-2xl text-base font-medium leading-8 text-slate-200 sm:text-xl">
                                {copy.hero.text}
                            </p>
                            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                                <a
                                    href={pilotMailto}
                                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-cyan-300 px-5 text-sm font-black uppercase tracking-wider text-slate-950 transition hover:bg-cyan-200"
                                >
                                    {copy.hero.pilotCta}
                                    <ArrowRight size={18} />
                                </a>
                                <Link
                                    to="/login"
                                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-5 text-sm font-black uppercase tracking-wider text-white transition hover:bg-white/15"
                                >
                                    {copy.hero.appCta}
                                    <ArrowRight size={18} />
                                </Link>
                            </div>
                            <div className="mt-9 grid max-w-2xl grid-cols-1 gap-3 text-sm text-slate-200 sm:grid-cols-3">
                                {copy.hero.stats.map((item) => (
                                    <div key={item.label} className="rounded-lg border border-white/15 bg-slate-950/45 p-3">
                                        <div className="text-2xl font-black text-white">{item.value}</div>
                                        <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-300">{item.label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="border-b border-slate-200 bg-white py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="max-w-2xl">
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.audiencesIntro.eyebrow}</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                            {copy.audiencesIntro.title}
                        </h2>
                    </div>
                    <div className="mt-8 grid gap-4 md:grid-cols-3">
                        {copy.audiences.map(({ icon: Icon, title, text }) => (
                            <article key={title} className="rounded-lg border border-slate-200 bg-slate-50 p-5">
                                <Icon size={24} className="text-cyan-700" />
                                <h3 className="mt-5 text-lg font-black text-slate-950">{title}</h3>
                                <p className="mt-3 text-sm font-medium leading-6 text-slate-600">{text}</p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section className="bg-slate-950 py-16 text-white sm:py-20">
                <div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
                    <div>
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-300">{copy.problemsIntro.eyebrow}</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal sm:text-4xl">
                            {copy.problemsIntro.title}
                        </h2>
                        <p className="mt-5 text-base font-medium leading-8 text-slate-300">
                            {copy.problemsIntro.text}
                        </p>
                    </div>
                    <div className="grid gap-3">
                        {copy.problems.map((item) => (
                            <div key={item} className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-cyan-300" />
                                <span className="text-sm font-bold leading-6 text-slate-100">{item}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            <section className="bg-slate-100 py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
                        <div className="max-w-2xl">
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.modulesIntro.eyebrow}</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                {copy.modulesIntro.title}
                            </h2>
                        </div>
                        <p className="max-w-sm text-sm font-semibold leading-6 text-slate-600">
                            {copy.modulesIntro.text}
                        </p>
                    </div>
                    <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {copy.modules.map(({ icon: Icon, label, detail }) => (
                            <article key={label} className="rounded-lg border border-slate-200 bg-white p-5">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 text-cyan-700">
                                        <Icon size={20} />
                                    </div>
                                    <h3 className="text-base font-black text-slate-950">{label}</h3>
                                </div>
                                <p className="mt-4 text-sm font-medium leading-6 text-slate-600">{detail}</p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section className="bg-white py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
                        <div>
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.proofIntro.eyebrow}</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                {copy.proofIntro.title}
                            </h2>
                        </div>
                        <div className="grid gap-4">
                            {copy.proofPoints.map(({ icon: Icon, title, text }) => (
                                <article key={title} className="rounded-lg border border-slate-200 bg-slate-50 p-5">
                                    <div className="flex items-center gap-3">
                                        <Icon size={22} className="text-cyan-700" />
                                        <h3 className="text-base font-black text-slate-950">{title}</h3>
                                    </div>
                                    <p className="mt-3 text-sm font-medium leading-6 text-slate-600">{text}</p>
                                </article>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <section className="bg-cyan-950 py-16 text-white sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="grid gap-8 lg:grid-cols-[1fr_0.9fr] lg:items-center">
                        <div>
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">{copy.offer.eyebrow}</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal sm:text-4xl">
                                {copy.offer.title}
                            </h2>
                            <p className="mt-5 max-w-2xl text-base font-medium leading-8 text-cyan-50/85">
                                {copy.offer.text}
                            </p>
                        </div>
                        <div className="rounded-lg border border-cyan-200/20 bg-white p-5 text-slate-950">
                            <div className="text-sm font-black uppercase tracking-[0.2em] text-cyan-700">{copy.offer.badge}</div>
                            <h3 className="mt-3 text-2xl font-black">{copy.offer.cardTitle}</h3>
                            <ul className="mt-5 space-y-3 text-sm font-semibold leading-6 text-slate-700">
                                {copy.offer.bullets.map((item) => (
                                    <li key={item} className="flex gap-3">
                                        <CheckCircle2 size={18} className="mt-1 shrink-0 text-cyan-700" />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                            <a
                                href={pilotMailto}
                                className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 text-sm font-black uppercase tracking-wider text-white transition hover:bg-slate-800"
                            >
                                {copy.hero.pilotCta}
                                <ArrowRight size={18} />
                            </a>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    );
}
