import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
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
const PILOT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Pilot Curieru pentru operatiuni last-mile')}`;

const audiences = [
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
];

const problems = [
    'Erori manuale la scanare, status si predare',
    'Dispecerat fara vizibilitate live asupra rutelor',
    'COD greu de reconciliat pe curier, zi si AWB',
    'Manifest si incarcare fara dovada operationala clara',
    'Statusuri intarziate cand semnalul din teren cade',
];

const modules = [
    { icon: ScanLine, label: 'PWA curier', detail: 'scanare AWB, status, GPS, foto, semnatura' },
    { icon: ClipboardCheck, label: 'Dispecerat', detail: 'alocari, exceptii, notificari, control roluri' },
    { icon: Route, label: 'Rutare', detail: 'planuri zilnice, incarcare, sofer, helper, avize' },
    { icon: Radar, label: 'Live Ops', detail: 'harta live, curse active, soferi intarziati sau offline' },
    { icon: CreditCard, label: 'COD / Finance', detail: 'sume asteptate, incasate si ramase de colectat' },
    { icon: Boxes, label: 'Manifest depozit', detail: 'scanare incarcare/descarcare si control colete lipsa' },
    { icon: Truck, label: 'Fleet', detail: 'vehicule, telefoane, documente, service si asigurari' },
    { icon: MapPinned, label: 'Tracking client', detail: 'cereri de locatie si comunicare pe AWB' },
    { icon: PackageCheck, label: 'Postis sync', detail: 'sincronizare comenzi, statusuri, etichete si istoric' },
];

const proofPoints = [
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
];

export default function CurieruLanding() {
    useEffect(() => {
        const previousTitle = document.title;
        document.title = 'Curieru - Platforma last-mile pentru curierat si 3PL';
        return () => {
            document.title = previousTitle;
        };
    }, []);

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
                    <nav className="flex items-center justify-between py-5">
                        <Link to="/curieru" className="flex items-center gap-3" aria-label="Curieru">
                            <img src="/logo-horizontal.png" alt="" className="h-9 w-auto max-w-[150px] object-contain" />
                            <span className="border-l border-white/20 pl-3 text-lg font-black tracking-tight">Curieru</span>
                        </Link>
                        <Link
                            to="/login"
                            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/20 px-4 text-sm font-black text-white transition hover:bg-white/10"
                        >
                            Login
                        </Link>
                    </nav>

                    <div className="flex flex-1 items-center pb-12 pt-8">
                        <div className="max-w-3xl">
                            <p className="mb-5 inline-flex max-w-full rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-[10px] font-black uppercase leading-5 tracking-[0.14em] text-cyan-100 sm:text-xs sm:tracking-[0.2em]">
                                Platforma operationala B2B pentru last-mile
                            </p>
                            <h1 className="text-4xl font-black leading-[1.02] tracking-normal text-white sm:text-6xl lg:text-7xl">
                                Curieru transforma operatiunile last-mile intr-un sistem live.
                            </h1>
                            <p className="mt-6 max-w-2xl text-base font-medium leading-8 text-slate-200 sm:text-xl">
                                Scanare, rutare, tracking, COD, manifest, flota si sincronizare Postis intr-un singur loc pentru curierat, 3PL si flote regionale.
                            </p>
                            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                                <a
                                    href={PILOT_MAILTO}
                                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-cyan-300 px-5 text-sm font-black uppercase tracking-wider text-slate-950 transition hover:bg-cyan-200"
                                >
                                    Cere pilot
                                    <ArrowRight size={18} />
                                </a>
                                <Link
                                    to="/login"
                                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-5 text-sm font-black uppercase tracking-wider text-white transition hover:bg-white/15"
                                >
                                    Vezi aplicatia
                                    <ArrowRight size={18} />
                                </Link>
                            </div>
                            <div className="mt-9 grid max-w-2xl grid-cols-1 gap-3 text-sm text-slate-200 sm:grid-cols-3">
                                <div className="rounded-lg border border-white/15 bg-slate-950/45 p-3">
                                    <div className="text-2xl font-black text-white">30-60</div>
                                    <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-300">zile pilot</div>
                                </div>
                                <div className="rounded-lg border border-white/15 bg-slate-950/45 p-3">
                                    <div className="text-2xl font-black text-white">1 hub</div>
                                    <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-300">setup initial</div>
                                </div>
                                <div className="rounded-lg border border-white/15 bg-slate-950/45 p-3">
                                    <div className="text-2xl font-black text-white">live</div>
                                    <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-300">operatiuni teren</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="border-b border-slate-200 bg-white py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="max-w-2xl">
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">Pentru cine este</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                            Curieru este construit pentru echipe care livreaza, nu doar urmaresc colete.
                        </h2>
                    </div>
                    <div className="mt-8 grid gap-4 md:grid-cols-3">
                        {audiences.map(({ icon: Icon, title, text }) => (
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
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-300">Ce rezolva</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal sm:text-4xl">
                            Mai putine telefoane, mai putine presupuneri, mai multa executie verificabila.
                        </h2>
                        <p className="mt-5 text-base font-medium leading-8 text-slate-300">
                            Curieru strange intr-un flux comun tot ce se pierde de obicei intre depozit, dispecerat, curier si client.
                        </p>
                    </div>
                    <div className="grid gap-3">
                        {problems.map((item) => (
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
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">Module</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                Un sistem operational complet, pornit din realitatea terenului.
                            </h2>
                        </div>
                        <p className="max-w-sm text-sm font-semibold leading-6 text-slate-600">
                            Fiecare modul sustine acelasi obiectiv: fluxuri mai rapide si date mai curate pentru decizii zilnice.
                        </p>
                    </div>
                    <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {modules.map(({ icon: Icon, label, detail }) => (
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
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">De ce acum</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                Last-mile-ul nu mai poate fi condus din Excel, telefoane si statusuri intarziate.
                            </h2>
                        </div>
                        <div className="grid gap-4">
                            {proofPoints.map(({ icon: Icon, title, text }) => (
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
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Oferta v1</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal sm:text-4xl">
                                Pilot platit pentru primul hub, cu rezultate masurabile.
                            </h2>
                            <p className="mt-5 max-w-2xl text-base font-medium leading-8 text-cyan-50/85">
                                Incepem controlat: configurare Postis, onboarding pentru echipa, flota sau hub operational si raport la finalul pilotului.
                            </p>
                        </div>
                        <div className="rounded-lg border border-cyan-200/20 bg-white p-5 text-slate-950">
                            <div className="text-sm font-black uppercase tracking-[0.2em] text-cyan-700">30-60 zile</div>
                            <h3 className="mt-3 text-2xl font-black">Pilot Curieru</h3>
                            <ul className="mt-5 space-y-3 text-sm font-semibold leading-6 text-slate-700">
                                <li className="flex gap-3"><CheckCircle2 size={18} className="mt-1 shrink-0 text-cyan-700" /> Setup initial pentru un hub sau o flota.</li>
                                <li className="flex gap-3"><CheckCircle2 size={18} className="mt-1 shrink-0 text-cyan-700" /> Training pentru dispecerat, depozit si curieri.</li>
                                <li className="flex gap-3"><CheckCircle2 size={18} className="mt-1 shrink-0 text-cyan-700" /> Raport de impact: rute, statusuri, COD si exceptii.</li>
                            </ul>
                            <a
                                href={PILOT_MAILTO}
                                className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 text-sm font-black uppercase tracking-wider text-white transition hover:bg-slate-800"
                            >
                                Cere pilot
                                <ArrowRight size={18} />
                            </a>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    );
}
