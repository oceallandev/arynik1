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

const solutionLinks = {
    ro: [
        { key: '3pl', label: '3PL', path: '/curieru/3pl' },
        { key: 'fleet', label: 'Flota proprie', path: '/curieru/fleet' },
        { key: 'postis-sync', label: 'Postis sync', path: '/curieru/postis-sync' },
        { key: 'white-label', label: 'White-label', path: '/curieru/white-label' },
    ],
    en: [
        { key: '3pl', label: '3PL', path: '/curieru/3pl/en' },
        { key: 'fleet', label: 'Own fleet', path: '/curieru/fleet/en' },
        { key: 'postis-sync', label: 'Postis sync', path: '/curieru/postis-sync/en' },
        { key: 'white-label', label: 'White-label', path: '/curieru/white-label/en' },
    ],
};

const icons = {
    courier: Truck,
    warehouse: Warehouse,
    building: Building2,
    scan: ScanLine,
    dispatch: ClipboardCheck,
    route: Route,
    live: Radar,
    finance: CreditCard,
    boxes: Boxes,
    tracking: MapPinned,
    sync: PackageCheck,
    offline: WifiOff,
    shield: ShieldCheck,
};

const content = {
    ro: {
        htmlLang: 'ro',
        nav: {
            homePath: '/curieru',
            alternateSuffix: '/en',
            alternateLabel: 'EN',
            login: 'Login',
            solutionsLabel: 'Solutii',
        },
        home: {
            title: 'Curieru - Platforma last-mile pentru curierat si 3PL',
            pilotSubject: 'Pilot Curieru pentru operatiuni last-mile',
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
            audience: {
                eyebrow: 'Pentru cine este',
                title: 'Curieru este construit pentru echipe care livreaza, nu doar urmaresc colete.',
                cards: [
                    { icon: icons.courier, title: 'Curierat regional', text: 'Pentru operatori care au nevoie de scanare rapida, rute controlate si statusuri trimise corect in teren.' },
                    { icon: icons.warehouse, title: '3PL si depozite', text: 'Pentru echipe care coordoneaza manifest, incarcare, descarcare, flota si exceptii intr-un flux verificabil.' },
                    { icon: icons.building, title: 'Retail cu flota proprie', text: 'Pentru magazine si retele care vor control asupra livrarilor, retururilor, COD si experientei clientului final.' },
                ],
            },
            problems: {
                eyebrow: 'Ce rezolva',
                title: 'Mai putine telefoane, mai putine presupuneri, mai multa executie verificabila.',
                text: 'Curieru strange intr-un flux comun tot ce se pierde de obicei intre depozit, dispecerat, curier si client.',
                items: [
                    'Erori manuale la scanare, status si predare',
                    'Dispecerat fara vizibilitate live asupra rutelor',
                    'COD greu de reconciliat pe curier, zi si AWB',
                    'Manifest si incarcare fara dovada operationala clara',
                    'Statusuri intarziate cand semnalul din teren cade',
                ],
            },
            modules: {
                eyebrow: 'Module',
                title: 'Un sistem operational complet, pornit din realitatea terenului.',
                text: 'Fiecare modul sustine acelasi obiectiv: fluxuri mai rapide si date mai curate pentru decizii zilnice.',
                items: [
                    { icon: icons.scan, label: 'PWA curier', detail: 'scanare AWB, status, GPS, foto, semnatura' },
                    { icon: icons.dispatch, label: 'Dispecerat', detail: 'alocari, exceptii, notificari, control roluri' },
                    { icon: icons.route, label: 'Rutare', detail: 'planuri zilnice, incarcare, sofer, helper, avize' },
                    { icon: icons.live, label: 'Live Ops', detail: 'harta live, curse active, soferi intarziati sau offline' },
                    { icon: icons.finance, label: 'COD / Finance', detail: 'sume asteptate, incasate si ramase de colectat' },
                    { icon: icons.boxes, label: 'Manifest depozit', detail: 'scanare incarcare/descarcare si control colete lipsa' },
                    { icon: icons.courier, label: 'Fleet', detail: 'vehicule, telefoane, documente, service si asigurari' },
                    { icon: icons.tracking, label: 'Tracking client', detail: 'cereri de locatie si comunicare pe AWB' },
                    { icon: icons.sync, label: 'Postis sync', detail: 'sincronizare comenzi, statusuri, etichete si istoric' },
                ],
            },
            proof: {
                eyebrow: 'De ce acum',
                title: 'Last-mile-ul nu mai poate fi condus din Excel, telefoane si statusuri intarziate.',
                cards: [
                    { icon: icons.offline, title: 'Offline-first in teren', text: 'Curierii pot lucra si cand semnalul cade. Actualizarile se pun in coada locala si se sincronizeaza cand conexiunea revine.' },
                    { icon: icons.live, title: 'Operatiuni live', text: 'Dispeceratul vede soferi, curse, progres si intarzieri intr-un singur ecran, fara telefoane repetate pentru status.' },
                    { icon: icons.shield, title: 'Control verificabil', text: 'Roluri, loguri, dovezi foto, COD si istoric AWB reduc discutiile neclare dintre depozit, curier si client.' },
                ],
            },
            tracks: {
                eyebrow: 'Directii comerciale',
                title: 'Aceeasi platforma, patru ambalaje vandabile.',
                text: 'Fiecare varianta vorbeste cu un cumparator diferit si pastreaza oportunitatile deschise fara sa schimbam produsul de baza.',
                cta: 'Vezi pagina',
            },
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
        solutions: {
            '3pl': {
                title: 'Curieru pentru 3PL si depozite',
                pilotSubject: 'Pilot Curieru 3PL pentru un hub operational',
                hero: {
                    eyebrow: 'Solutie pentru 3PL si warehouse operations',
                    title: 'Controleaza hub-ul, clientii si livrarile intr-un flux verificabil.',
                    text: 'Curieru conecteaza manifestul, scanarea din depozit, incarcarile, rutele, clientii multipli si raportarea operationala intr-un singur sistem live.',
                    pilotCta: 'Cere pilot 3PL',
                    appCta: 'Vezi aplicatia',
                    stats: [
                        { value: '1 hub', label: 'start controlat' },
                        { value: '1-2', label: 'clienti pilot' },
                        { value: 'SLA', label: 'raportabil' },
                    ],
                },
                audience: {
                    eyebrow: 'Pentru cine',
                    title: 'Pentru 3PL-uri care trebuie sa dovedeasca executia, nu doar sa promita livrarea.',
                    cards: [
                        { icon: icons.warehouse, title: '3PL regionali', text: 'Operatiuni cu depozit, clienti multipli si rute zilnice care trebuie urmarite fara haos operational.' },
                        { icon: icons.boxes, title: 'Fulfillment ecommerce', text: 'Echipe care au nevoie de scanare, incarcare, exceptii si rapoarte clare pentru fiecare client.' },
                        { icon: icons.dispatch, title: 'Hub-uri cu subcontractori', text: 'Manageri care coordoneaza soferi proprii si parteneri externi, cu acelasi standard de control.' },
                    ],
                },
                problems: {
                    eyebrow: 'Ce rezolva',
                    title: 'Transforma depozitul din zona de presupuneri intr-un centru de control.',
                    text: 'Cand fiecare client are reguli, volume si exceptii diferite, Curieru pune aceeasi ordine peste intregul flux.',
                    items: [
                        'Colete lipsa sau neconfirmate la incarcare',
                        'Statusuri intarziate intre depozit, sofer si client',
                        'Rapoarte greu de separat pe client, hub sau zi',
                        'Exceptii gestionate prin telefoane si mesaje dispersate',
                        'SLA-uri greu de demonstrat dupa incident',
                    ],
                },
                modules: {
                    eyebrow: 'Pachet 3PL',
                    title: 'Modulele care vand Curieru catre un operator 3PL.',
                    text: 'Landing-ul acesta nu promite software generic. Promite control operational pe hub.',
                    items: [
                        { icon: icons.boxes, label: 'Manifest hub', detail: 'scanare intrare, incarcare, descarcare si colete lipsa' },
                        { icon: icons.dispatch, label: 'Client ops', detail: 'filtrare pe client, exceptii si prioritati operationale' },
                        { icon: icons.route, label: 'Route plans', detail: 'curse zilnice cu sofer, helper, vehicul si avize' },
                        { icon: icons.live, label: 'Live hub view', detail: 'progres curieri, intarzieri, offline si statusuri critice' },
                        { icon: icons.finance, label: 'COD reconciliation', detail: 'sume asteptate si incasate pe curier, client si zi' },
                        { icon: icons.shield, label: 'Audit trail', detail: 'loguri, poze, semnaturi si istoric verificabil' },
                    ],
                },
                proof: {
                    eyebrow: 'Model comercial',
                    title: 'Setup initial + abonament pe hub, client sau volum operational.',
                    cards: [
                        { icon: icons.warehouse, title: 'Setup platit', text: 'Configuram primul hub, rolurile, clientii pilot, statusurile si fluxul de scanare.' },
                        { icon: icons.sync, title: 'Integrari optionale', text: 'Postis, fisiere, API-uri sau fluxuri existente pot intra gradual in pilot.' },
                        { icon: icons.shield, title: 'Raport de rezultate', text: 'Masuram colete procesate, exceptii, statusuri intarziate si zonele unde se pierde control.' },
                    ],
                },
                offer: {
                    eyebrow: 'Oferta 3PL',
                    title: 'Pilot 3PL pe un hub si 1-2 clienti operationali.',
                    text: 'O oferta buna pentru 3PL nu vinde feature-uri. Vinde ordine, dovada si raportare pe fluxuri reale.',
                    badge: 'Setup + lunar',
                    cardTitle: 'Pilot 3PL',
                    bullets: [
                        'Configurare hub, clienti pilot, roluri si statusuri.',
                        'Training pentru depozit, dispecerat si curieri.',
                        'Raport final pe colete, exceptii, SLA si COD.',
                    ],
                },
            },
            fleet: {
                title: 'Curieru pentru flote proprii',
                pilotSubject: 'Pilot Curieru pentru flota proprie last-mile',
                hero: {
                    eyebrow: 'Solutie pentru retail si ecommerce cu flota proprie',
                    title: 'Livreaza cu flota ta ca un operator last-mile matur.',
                    text: 'Curieru aduce rute, tracking client, dovada livrarii, COD si vizibilitate live peste echipele care livreaza din magazine, depozite sau dark stores.',
                    pilotCta: 'Cere pilot fleet',
                    appCta: 'Vezi aplicatia',
                    stats: [
                        { value: 'per driver', label: 'model simplu' },
                        { value: 'live ETA', label: 'pentru clienti' },
                        { value: 'POD', label: 'foto si semnatura' },
                    ],
                },
                audience: {
                    eyebrow: 'Pentru cine',
                    title: 'Pentru companii care vor sa pastreze livrarea in controlul propriu.',
                    cards: [
                        { icon: icons.building, title: 'Retail regional', text: 'Magazine care livreaza local si au nevoie de rute clare, statusuri si dovada predarii.' },
                        { icon: icons.courier, title: 'Flote interne', text: 'Echipe cu soferi proprii, vehicule proprii si presiune zilnica pe costul per livrare.' },
                        { icon: icons.tracking, title: 'Ecommerce cu promisiuni rapide', text: 'Branduri care vor tracking, notificari si experienta mai buna pentru clientul final.' },
                    ],
                },
                problems: {
                    eyebrow: 'Ce rezolva',
                    title: 'Flota proprie devine profitabila doar cand este masurata.',
                    text: 'Curieru muta livrarea din apeluri si foi de parcurs intr-un flux vizibil pentru manager, curier si client.',
                    items: [
                        'Rute improvizate si greu de comparat intre soferi',
                        'Clienti care suna pentru status si ETA',
                        'Livrari fara dovada clara de predare',
                        'COD si retururi greu de reconciliat',
                        'Vehicule si telefoane fara evidenta operationala comuna',
                    ],
                },
                modules: {
                    eyebrow: 'Pachet fleet',
                    title: 'Tot ce trebuie pentru o flota proprie last-mile.',
                    text: 'Vanzarea este simpla: mai mult control pe fiecare vehicul si mai putine livrari pierdute in conversatii.',
                    items: [
                        { icon: icons.route, label: 'Route planning', detail: 'planuri zilnice pe sofer, vehicul si zona' },
                        { icon: icons.scan, label: 'Driver PWA', detail: 'scanare, status, foto, semnatura si GPS' },
                        { icon: icons.tracking, label: 'Customer tracking', detail: 'link de tracking si comunicare pe AWB' },
                        { icon: icons.finance, label: 'COD control', detail: 'incasari asteptate, colectate si restante' },
                        { icon: icons.courier, label: 'Fleet records', detail: 'vehicule, telefoane, documente si service' },
                        { icon: icons.live, label: 'Live Ops', detail: 'soferi activi, intarzieri, progres si exceptii' },
                    ],
                },
                proof: {
                    eyebrow: 'Model comercial',
                    title: 'Abonament lunar pe vehicul, sofer sau echipa operationala.',
                    cards: [
                        { icon: icons.courier, title: 'Pret usor de inteles', text: 'Clientul compara direct costul lunar cu numarul de soferi sau vehicule active.' },
                        { icon: icons.tracking, title: 'Valoare vizibila rapid', text: 'Reducem apelurile pentru status si crestem claritatea pentru clientul final.' },
                        { icon: icons.finance, title: 'ROI operational', text: 'Masuram rute, livrari, retururi, COD si timp pierdut in exceptii.' },
                    ],
                },
                offer: {
                    eyebrow: 'Oferta fleet',
                    title: 'Pilot pentru 5-15 soferi si un flux de livrare real.',
                    text: 'Incepem cu o zona sau o echipa, apoi extindem cand datele arata unde se castiga timp si control.',
                    badge: 'per driver / luna',
                    cardTitle: 'Pilot fleet',
                    bullets: [
                        'Configurare flota, soferi, statusuri si rute zilnice.',
                        'Tracking client si dovada livrarii pe comenzi reale.',
                        'Raport pe livrari, intarzieri, retururi si COD.',
                    ],
                },
            },
            'postis-sync': {
                title: 'Curieru ca strat operational peste Postis',
                pilotSubject: 'Pilot Curieru Postis sync pentru operatiuni last-mile',
                hero: {
                    eyebrow: 'Operations layer pentru companii care folosesc Postis',
                    title: 'Pastreaza Postis, dar pune terenul sub control live.',
                    text: 'Curieru poate functiona ca strat operational pentru scanare, rute, statusuri, COD si sincronizare, fara sa forteze schimbarea sistemului principal.',
                    pilotCta: 'Cere pilot Postis',
                    appCta: 'Vezi aplicatia',
                    stats: [
                        { value: 'sync', label: 'comenzi si statusuri' },
                        { value: 'offline', label: 'teren rezilient' },
                        { value: 'API', label: 'integrare v1' },
                    ],
                },
                audience: {
                    eyebrow: 'Pentru cine',
                    title: 'Pentru echipe care au Postis, dar inca pierd controlul intre sistem si teren.',
                    cards: [
                        { icon: icons.sync, title: 'Operatori Postis', text: 'Firme care primesc comenzi si statusuri prin Postis, dar au nevoie de executie mai buna in teren.' },
                        { icon: icons.dispatch, title: 'Dispecerat sub presiune', text: 'Echipe care corecteaza manual statusuri, exceptii si intarzieri dupa ce apar probleme.' },
                        { icon: icons.scan, title: 'Curieri in zone cu semnal slab', text: 'Operatiuni unde offline-first si sincronizarea ulterioara sunt diferentiatori reali.' },
                    ],
                },
                problems: {
                    eyebrow: 'Ce rezolva',
                    title: 'Integrarea nu este suficienta daca executia din teren ramane fragila.',
                    text: 'Curieru ataca exact zona dintre comanda din Postis si livrarea reala confirmata.',
                    items: [
                        'Statusuri trimise tarziu sau incomplet',
                        'Curieri blocati cand semnalul cade',
                        'AWB-uri scanate gresit sau actualizate manual',
                        'COD si dovezi greu de urmarit in acelasi flux',
                        'Dispecerat care nu vede live ce se intampla in teren',
                    ],
                },
                modules: {
                    eyebrow: 'Pachet Postis sync',
                    title: 'Curieru devine executia operationala peste integrarea existenta.',
                    text: 'Vanzarea aici este foarte directa: nu inlocuim sistemul, il facem mai util in teren.',
                    items: [
                        { icon: icons.sync, label: 'Postis import', detail: 'comenzi, AWB-uri, etichete si istoric' },
                        { icon: icons.scan, label: 'Field scanning', detail: 'scanare rapida si confirmari verificate' },
                        { icon: icons.offline, label: 'Background sync', detail: 'coada locala si replay automat cand revine internetul' },
                        { icon: icons.route, label: 'Operational routes', detail: 'planuri si alocari peste comenzile sincronizate' },
                        { icon: icons.finance, label: 'COD layer', detail: 'incasari si reconciliere in acelasi flux' },
                        { icon: icons.shield, label: 'Status audit', detail: 'istoric clar pentru statusuri si exceptii' },
                    ],
                },
                proof: {
                    eyebrow: 'Model comercial',
                    title: 'Integrare platita + abonament lunar pentru stratul operational.',
                    cards: [
                        { icon: icons.sync, title: 'Setup de integrare', text: 'Mapam statusurile, fluxurile si regulile folosite deja in Postis.' },
                        { icon: icons.offline, title: 'Valoare pe teren', text: 'Curierii lucreaza si cand nu exista conexiune stabila, iar statusurile ajung inapoi.' },
                        { icon: icons.live, title: 'Control in dispecerat', text: 'Comenzile sincronizate devin vizibile in rute, live ops, manifest si finance.' },
                    ],
                },
                offer: {
                    eyebrow: 'Oferta Postis',
                    title: 'Pilot de sincronizare pentru un flux Postis real.',
                    text: 'Alegem o zona clara: comenzi, statusuri, curieri si exceptii. Dovedim rapid daca stratul operational reduce munca manuala.',
                    badge: 'setup + lunar',
                    cardTitle: 'Pilot Postis sync',
                    bullets: [
                        'Mapare statusuri si flux operational Postis.',
                        'Activare PWA curier cu offline queue si scanare.',
                        'Raport pe statusuri, erori, intarzieri si sincronizari.',
                    ],
                },
            },
            'white-label': {
                title: 'Curieru white-label pentru firme de curierat',
                pilotSubject: 'Pilot Curieru white-label pentru firma de curierat',
                hero: {
                    eyebrow: 'Platforma white-label pentru curierat regional',
                    title: 'Lanseaza propria aplicatie de curierat fara sa construiesti totul de la zero.',
                    text: 'Curieru poate fi ambalat sub brandul unui operator local: aplicatie curier, dispecerat, tracking client, COD, manifest, flota si sincronizare.',
                    pilotCta: 'Cere oferta white-label',
                    appCta: 'Vezi aplicatia',
                    stats: [
                        { value: 'brand propriu', label: 'pentru operator' },
                        { value: 'setup premium', label: 'configurare' },
                        { value: 'support', label: 'operational' },
                    ],
                },
                audience: {
                    eyebrow: 'Pentru cine',
                    title: 'Pentru operatori care vor control tehnologic sub propriul brand.',
                    cards: [
                        { icon: icons.courier, title: 'Curierat local', text: 'Firme care livreaza regional si vor o platforma moderna fara proiect software de la zero.' },
                        { icon: icons.building, title: 'Branduri cu retea proprie', text: 'Companii care vor o experienta digitala coerenta pentru curier, client si dispecerat.' },
                        { icon: icons.shield, title: 'Parteneri operationali', text: 'Echipe care vor o baza stabila pentru extindere, suport si configurare pe procese proprii.' },
                    ],
                },
                problems: {
                    eyebrow: 'Ce rezolva',
                    title: 'White-label-ul vinde viteza de lansare si diferentiere comerciala.',
                    text: 'In loc sa porneasca un proiect software lung, operatorul primeste o baza functionala care poate fi adaptata.',
                    items: [
                        'Dependenta de tool-uri generice fara identitate proprie',
                        'Cost mare si risc mare pentru dezvoltare custom',
                        'Lipsa unei aplicatii moderne pentru curieri',
                        'Tracking client si COD neintegrate in brand',
                        'Greu de vandut servicii premium fara infrastructura digitala',
                    ],
                },
                modules: {
                    eyebrow: 'Pachet white-label',
                    title: 'O platforma vandabila sub brandul clientului.',
                    text: 'Aici Curieru devine produs premium: configurare, personalizare si suport.',
                    items: [
                        { icon: icons.scan, label: 'Branded courier app', detail: 'PWA curier cu logo, culori si fluxuri adaptate' },
                        { icon: icons.dispatch, label: 'Control center', detail: 'dispecerat, roluri, alocari si exceptii' },
                        { icon: icons.tracking, label: 'Client tracking', detail: 'linkuri si comunicare sub brandul operatorului' },
                        { icon: icons.finance, label: 'COD / Billing hooks', detail: 'date financiare pregatite pentru reconciliere' },
                        { icon: icons.boxes, label: 'Manifest & warehouse', detail: 'scanare depozit si control incarcare' },
                        { icon: icons.sync, label: 'Carrier integrations', detail: 'Postis sau alte conectari unde exista oportunitate' },
                    ],
                },
                proof: {
                    eyebrow: 'Model comercial',
                    title: 'Setup premium + abonament lunar + suport operational.',
                    cards: [
                        { icon: icons.building, title: 'Pozitionare premium', text: 'Clientul cumpara accelerare de produs, nu doar acces la o aplicatie.' },
                        { icon: icons.shield, title: 'Contract mai solid', text: 'White-label-ul justifica onboarding, suport, SLA si fee lunar mai mare.' },
                        { icon: icons.route, title: 'Extindere treptata', text: 'Pornim cu fluxul critic, apoi adaugam module si integrari dupa adoptare.' },
                    ],
                },
                offer: {
                    eyebrow: 'Oferta white-label',
                    title: 'Pilot premium pentru un operator regional.',
                    text: 'Validam brandul, fluxurile critice si modul in care platforma poate deveni infrastructura comerciala a clientului.',
                    badge: 'setup premium',
                    cardTitle: 'White-label pilot',
                    bullets: [
                        'Configurare brand, roluri si fluxuri principale.',
                        'Activare dispecerat, PWA curier si tracking client.',
                        'Roadmap de lansare si oferta lunara dupa pilot.',
                    ],
                },
            },
        },
    },
    en: {
        htmlLang: 'en',
        nav: {
            homePath: '/curieru/en',
            alternateSuffix: '',
            alternateLabel: 'RO',
            login: 'Login',
            solutionsLabel: 'Solutions',
        },
        home: {
            title: 'Curieru - Last-mile platform for couriers and 3PL operations',
            pilotSubject: 'Curieru pilot for last-mile operations',
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
            audience: {
                eyebrow: 'Who it is for',
                title: 'Curieru is built for teams that deliver, not just teams that track parcels.',
                cards: [
                    { icon: icons.courier, title: 'Regional courier operators', text: 'For operators that need fast scanning, controlled routes and field statuses sent correctly every day.' },
                    { icon: icons.warehouse, title: '3PL and warehouse teams', text: 'For teams coordinating manifests, loading, unloading, fleet activity and exceptions through a verifiable workflow.' },
                    { icon: icons.building, title: 'Retailers with own fleets', text: 'For stores and networks that want control over deliveries, returns, COD and the final customer experience.' },
                ],
            },
            problems: {
                eyebrow: 'What it solves',
                title: 'Fewer calls, fewer assumptions, more verifiable execution.',
                text: 'Curieru brings into one workflow the data that usually gets lost between warehouse, dispatch, courier and customer.',
                items: [
                    'Manual errors in scanning, status updates and handover',
                    'Dispatch teams without live visibility over active routes',
                    'COD that is hard to reconcile by driver, day and AWB',
                    'Manifest and loading processes without clear operational proof',
                    'Delayed statuses when field connectivity drops',
                ],
            },
            modules: {
                eyebrow: 'Modules',
                title: 'A complete operating system built from real field workflows.',
                text: 'Each module supports the same goal: faster workflows and cleaner data for daily decisions.',
                items: [
                    { icon: icons.scan, label: 'Courier PWA', detail: 'AWB scanning, status, GPS, photos, signature' },
                    { icon: icons.dispatch, label: 'Dispatch', detail: 'assignments, exceptions, notifications, role control' },
                    { icon: icons.route, label: 'Routing', detail: 'daily plans, loading, driver, helper and waybills' },
                    { icon: icons.live, label: 'Live Ops', detail: 'live map, active runs, delayed or offline drivers' },
                    { icon: icons.finance, label: 'COD / Finance', detail: 'expected, collected and remaining cash amounts' },
                    { icon: icons.boxes, label: 'Warehouse manifest', detail: 'loading/unloading scans and missing parcel control' },
                    { icon: icons.courier, label: 'Fleet', detail: 'vehicles, phones, documents, service and insurance' },
                    { icon: icons.tracking, label: 'Customer tracking', detail: 'location requests and AWB-level communication' },
                    { icon: icons.sync, label: 'Postis sync', detail: 'orders, statuses, labels and history synchronization' },
                ],
            },
            proof: {
                eyebrow: 'Why now',
                title: 'Last-mile can no longer be run from spreadsheets, calls and delayed statuses.',
                cards: [
                    { icon: icons.offline, title: 'Offline-first in the field', text: 'Couriers can keep working when signal drops. Updates are queued locally and synced when connectivity returns.' },
                    { icon: icons.live, title: 'Live operations', text: 'Dispatch sees drivers, runs, progress and delays in one screen, without repeated status calls.' },
                    { icon: icons.shield, title: 'Verifiable control', text: 'Roles, logs, photo proof, COD and AWB history reduce unclear handoffs between warehouse, courier and customer.' },
                ],
            },
            tracks: {
                eyebrow: 'Commercial tracks',
                title: 'One platform, four sellable packages.',
                text: 'Each version speaks to a different buyer while keeping the core product focused and reusable.',
                cta: 'View page',
            },
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
        solutions: {
            '3pl': {
                title: 'Curieru for 3PL and warehouse operations',
                pilotSubject: 'Curieru 3PL pilot for one operational hub',
                hero: {
                    eyebrow: 'Solution for 3PL and warehouse operations',
                    title: 'Control the hub, clients and deliveries through one verifiable workflow.',
                    text: 'Curieru connects manifests, warehouse scanning, loading, routes, multi-client operations and reporting into one live operating system.',
                    pilotCta: 'Request 3PL pilot',
                    appCta: 'View app',
                    stats: [
                        { value: '1 hub', label: 'controlled start' },
                        { value: '1-2', label: 'pilot clients' },
                        { value: 'SLA', label: 'reportable' },
                    ],
                },
                audience: {
                    eyebrow: 'Who it is for',
                    title: 'For 3PLs that need to prove execution, not just promise delivery.',
                    cards: [
                        { icon: icons.warehouse, title: 'Regional 3PLs', text: 'Operations with warehouses, multiple clients and daily routes that must be tracked without operational noise.' },
                        { icon: icons.boxes, title: 'Ecommerce fulfillment', text: 'Teams that need scanning, loading, exceptions and clear reporting for each client.' },
                        { icon: icons.dispatch, title: 'Subcontracted hubs', text: 'Managers coordinating own drivers and external partners under one control standard.' },
                    ],
                },
                problems: {
                    eyebrow: 'What it solves',
                    title: 'Turn the warehouse from an assumption zone into a control center.',
                    text: 'When every client has different rules, volumes and exceptions, Curieru brings order across the full workflow.',
                    items: [
                        'Missing or unconfirmed parcels at loading',
                        'Delayed statuses between warehouse, driver and client',
                        'Reports that are hard to split by client, hub or day',
                        'Exceptions managed through scattered calls and messages',
                        'SLAs that are hard to prove after an incident',
                    ],
                },
                modules: {
                    eyebrow: '3PL package',
                    title: 'The modules that sell Curieru to a 3PL operator.',
                    text: 'This landing page does not sell generic software. It sells operational control over a hub.',
                    items: [
                        { icon: icons.boxes, label: 'Hub manifest', detail: 'inbound scans, loading, unloading and missing parcel control' },
                        { icon: icons.dispatch, label: 'Client ops', detail: 'client filters, exceptions and operational priorities' },
                        { icon: icons.route, label: 'Route plans', detail: 'daily runs with driver, helper, vehicle and waybills' },
                        { icon: icons.live, label: 'Live hub view', detail: 'courier progress, delays, offline drivers and critical statuses' },
                        { icon: icons.finance, label: 'COD reconciliation', detail: 'expected and collected amounts by driver, client and day' },
                        { icon: icons.shield, label: 'Audit trail', detail: 'logs, photos, signatures and verifiable history' },
                    ],
                },
                proof: {
                    eyebrow: 'Commercial model',
                    title: 'Initial setup plus monthly subscription by hub, client or operational volume.',
                    cards: [
                        { icon: icons.warehouse, title: 'Paid setup', text: 'We configure the first hub, roles, pilot clients, statuses and scanning workflow.' },
                        { icon: icons.sync, title: 'Optional integrations', text: 'Postis, files, APIs or existing flows can enter the pilot gradually.' },
                        { icon: icons.shield, title: 'Results report', text: 'We measure processed parcels, exceptions, delayed statuses and the points where control is lost.' },
                    ],
                },
                offer: {
                    eyebrow: '3PL offer',
                    title: '3PL pilot for one hub and 1-2 operational clients.',
                    text: 'A strong 3PL offer does not sell features. It sells order, proof and reporting over real workflows.',
                    badge: 'setup + monthly',
                    cardTitle: '3PL pilot',
                    bullets: [
                        'Hub, pilot clients, roles and statuses configured.',
                        'Training for warehouse, dispatch and couriers.',
                        'Final report on parcels, exceptions, SLA and COD.',
                    ],
                },
            },
            fleet: {
                title: 'Curieru for own fleets',
                pilotSubject: 'Curieru pilot for own last-mile fleet',
                hero: {
                    eyebrow: 'Solution for retail and ecommerce own fleets',
                    title: 'Run your own delivery fleet like a mature last-mile operator.',
                    text: 'Curieru brings routes, customer tracking, proof of delivery, COD and live visibility to teams delivering from stores, warehouses or dark stores.',
                    pilotCta: 'Request fleet pilot',
                    appCta: 'View app',
                    stats: [
                        { value: 'per driver', label: 'simple model' },
                        { value: 'live ETA', label: 'for customers' },
                        { value: 'POD', label: 'photo and signature' },
                    ],
                },
                audience: {
                    eyebrow: 'Who it is for',
                    title: 'For companies that want to keep delivery under their own control.',
                    cards: [
                        { icon: icons.building, title: 'Regional retail', text: 'Stores delivering locally that need clear routes, statuses and proof of handover.' },
                        { icon: icons.courier, title: 'Internal fleets', text: 'Teams with their own drivers, vehicles and daily pressure on delivery cost.' },
                        { icon: icons.tracking, title: 'Fast-promise ecommerce', text: 'Brands that want tracking, notifications and a better final customer experience.' },
                    ],
                },
                problems: {
                    eyebrow: 'What it solves',
                    title: 'An own fleet becomes profitable only when it is measured.',
                    text: 'Curieru moves delivery from calls and paper route sheets into a workflow visible to manager, courier and customer.',
                    items: [
                        'Improvised routes that are hard to compare between drivers',
                        'Customers calling for status and ETA',
                        'Deliveries without clear proof of handover',
                        'COD and returns that are hard to reconcile',
                        'Vehicles and phones without one operational record',
                    ],
                },
                modules: {
                    eyebrow: 'Fleet package',
                    title: 'Everything needed for an own last-mile fleet.',
                    text: 'The sale is simple: more control on every vehicle and fewer deliveries lost in conversations.',
                    items: [
                        { icon: icons.route, label: 'Route planning', detail: 'daily plans by driver, vehicle and area' },
                        { icon: icons.scan, label: 'Driver PWA', detail: 'scanning, status, photos, signature and GPS' },
                        { icon: icons.tracking, label: 'Customer tracking', detail: 'tracking link and AWB-level communication' },
                        { icon: icons.finance, label: 'COD control', detail: 'expected, collected and remaining amounts' },
                        { icon: icons.courier, label: 'Fleet records', detail: 'vehicles, phones, documents and service' },
                        { icon: icons.live, label: 'Live Ops', detail: 'active drivers, delays, progress and exceptions' },
                    ],
                },
                proof: {
                    eyebrow: 'Commercial model',
                    title: 'Monthly subscription per vehicle, driver or operations team.',
                    cards: [
                        { icon: icons.courier, title: 'Easy pricing story', text: 'The buyer compares monthly cost directly with the number of active drivers or vehicles.' },
                        { icon: icons.tracking, title: 'Visible value fast', text: 'We reduce status calls and improve clarity for the final customer.' },
                        { icon: icons.finance, title: 'Operational ROI', text: 'We measure routes, deliveries, returns, COD and time lost in exceptions.' },
                    ],
                },
                offer: {
                    eyebrow: 'Fleet offer',
                    title: 'Pilot for 5-15 drivers and one real delivery flow.',
                    text: 'We start with one zone or team, then expand when the data shows where time and control are gained.',
                    badge: 'per driver / month',
                    cardTitle: 'Fleet pilot',
                    bullets: [
                        'Fleet, drivers, statuses and daily routes configured.',
                        'Customer tracking and proof of delivery on real orders.',
                        'Report on deliveries, delays, returns and COD.',
                    ],
                },
            },
            'postis-sync': {
                title: 'Curieru as the operations layer over Postis',
                pilotSubject: 'Curieru Postis sync pilot for last-mile operations',
                hero: {
                    eyebrow: 'Operations layer for companies using Postis',
                    title: 'Keep Postis, but bring field execution under live control.',
                    text: 'Curieru can act as the operational layer for scanning, routes, statuses, COD and synchronization without forcing a change in the core system.',
                    pilotCta: 'Request Postis pilot',
                    appCta: 'View app',
                    stats: [
                        { value: 'sync', label: 'orders and statuses' },
                        { value: 'offline', label: 'resilient field ops' },
                        { value: 'API', label: 'v1 integration' },
                    ],
                },
                audience: {
                    eyebrow: 'Who it is for',
                    title: 'For teams that have Postis but still lose control between system and field.',
                    cards: [
                        { icon: icons.sync, title: 'Postis operators', text: 'Companies receiving orders and statuses through Postis that need better field execution.' },
                        { icon: icons.dispatch, title: 'Busy dispatch teams', text: 'Teams manually correcting statuses, exceptions and delays after problems appear.' },
                        { icon: icons.scan, title: 'Couriers in weak-signal areas', text: 'Operations where offline-first and later synchronization are real differentiators.' },
                    ],
                },
                problems: {
                    eyebrow: 'What it solves',
                    title: 'Integration is not enough when field execution remains fragile.',
                    text: 'Curieru focuses exactly on the gap between a Postis order and a real confirmed delivery.',
                    items: [
                        'Statuses sent late or incompletely',
                        'Couriers blocked when signal drops',
                        'AWBs scanned incorrectly or updated manually',
                        'COD and proof hard to track in the same workflow',
                        'Dispatch teams without live field visibility',
                    ],
                },
                modules: {
                    eyebrow: 'Postis sync package',
                    title: 'Curieru becomes operational execution over the existing integration.',
                    text: 'The sales message is direct: we do not replace the system, we make it more useful in the field.',
                    items: [
                        { icon: icons.sync, label: 'Postis import', detail: 'orders, AWBs, labels and history' },
                        { icon: icons.scan, label: 'Field scanning', detail: 'fast scans and verified confirmations' },
                        { icon: icons.offline, label: 'Background sync', detail: 'local queue and automatic replay when internet returns' },
                        { icon: icons.route, label: 'Operational routes', detail: 'plans and assignments over synchronized orders' },
                        { icon: icons.finance, label: 'COD layer', detail: 'cash collection and reconciliation in the same workflow' },
                        { icon: icons.shield, label: 'Status audit', detail: 'clear history for statuses and exceptions' },
                    ],
                },
                proof: {
                    eyebrow: 'Commercial model',
                    title: 'Paid integration setup plus monthly subscription for the operations layer.',
                    cards: [
                        { icon: icons.sync, title: 'Integration setup', text: 'We map the statuses, workflows and rules already used in Postis.' },
                        { icon: icons.offline, title: 'Field value', text: 'Couriers keep working without stable connection, and statuses still return.' },
                        { icon: icons.live, title: 'Dispatch control', text: 'Synchronized orders become visible in routes, live ops, manifests and finance.' },
                    ],
                },
                offer: {
                    eyebrow: 'Postis offer',
                    title: 'Synchronization pilot for one real Postis flow.',
                    text: 'We pick a clear lane: orders, statuses, couriers and exceptions. We quickly prove whether the operations layer reduces manual work.',
                    badge: 'setup + monthly',
                    cardTitle: 'Postis sync pilot',
                    bullets: [
                        'Postis statuses and operational flow mapped.',
                        'Courier PWA activated with offline queue and scanning.',
                        'Report on statuses, errors, delays and synchronizations.',
                    ],
                },
            },
            'white-label': {
                title: 'Curieru white-label for courier companies',
                pilotSubject: 'Curieru white-label pilot for courier company',
                hero: {
                    eyebrow: 'White-label platform for regional courier companies',
                    title: 'Launch your own courier platform without building everything from scratch.',
                    text: 'Curieru can be packaged under a local operator brand: courier app, dispatch, customer tracking, COD, manifests, fleet and synchronization.',
                    pilotCta: 'Request white-label offer',
                    appCta: 'View app',
                    stats: [
                        { value: 'own brand', label: 'for operator' },
                        { value: 'premium setup', label: 'configuration' },
                        { value: 'support', label: 'operational' },
                    ],
                },
                audience: {
                    eyebrow: 'Who it is for',
                    title: 'For operators that want technology control under their own brand.',
                    cards: [
                        { icon: icons.courier, title: 'Local courier companies', text: 'Regional delivery companies that want a modern platform without a full software project.' },
                        { icon: icons.building, title: 'Brands with own networks', text: 'Companies that want a consistent digital experience for courier, customer and dispatch.' },
                        { icon: icons.shield, title: 'Operational partners', text: 'Teams that need a stable base for expansion, support and process configuration.' },
                    ],
                },
                problems: {
                    eyebrow: 'What it solves',
                    title: 'White-label sells speed to market and commercial differentiation.',
                    text: 'Instead of starting a long software project, the operator gets a working base that can be adapted.',
                    items: [
                        'Dependency on generic tools with no own identity',
                        'High cost and high risk for custom development',
                        'No modern app experience for couriers',
                        'Customer tracking and COD outside the brand experience',
                        'Hard to sell premium services without digital infrastructure',
                    ],
                },
                modules: {
                    eyebrow: 'White-label package',
                    title: 'A sellable platform under the client brand.',
                    text: 'Here Curieru becomes a premium product: configuration, customization and support.',
                    items: [
                        { icon: icons.scan, label: 'Branded courier app', detail: 'courier PWA with logo, colors and adapted workflows' },
                        { icon: icons.dispatch, label: 'Control center', detail: 'dispatch, roles, assignments and exceptions' },
                        { icon: icons.tracking, label: 'Client tracking', detail: 'links and communication under the operator brand' },
                        { icon: icons.finance, label: 'COD / Billing hooks', detail: 'financial data ready for reconciliation' },
                        { icon: icons.boxes, label: 'Manifest & warehouse', detail: 'warehouse scanning and loading control' },
                        { icon: icons.sync, label: 'Carrier integrations', detail: 'Postis or other connections where opportunity exists' },
                    ],
                },
                proof: {
                    eyebrow: 'Commercial model',
                    title: 'Premium setup plus monthly subscription and operational support.',
                    cards: [
                        { icon: icons.building, title: 'Premium positioning', text: 'The client buys product acceleration, not just access to an app.' },
                        { icon: icons.shield, title: 'Stronger contract', text: 'White-label justifies onboarding, support, SLA and a higher monthly fee.' },
                        { icon: icons.route, title: 'Gradual expansion', text: 'We start with the critical workflow, then add modules and integrations after adoption.' },
                    ],
                },
                offer: {
                    eyebrow: 'White-label offer',
                    title: 'Premium pilot for a regional operator.',
                    text: 'We validate brand, critical workflows and how the platform can become the client commercial infrastructure.',
                    badge: 'premium setup',
                    cardTitle: 'White-label pilot',
                    bullets: [
                        'Brand, roles and core workflows configured.',
                        'Dispatch, courier PWA and customer tracking activated.',
                        'Launch roadmap and monthly offer after pilot.',
                    ],
                },
            },
        },
    },
};

const solutionSlugs = ['3pl', 'fleet', 'postis-sync', 'white-label'];

const parseLandingPath = (pathname) => {
    const parts = String(pathname || '').split('/').filter(Boolean);
    const locale = parts.includes('en') ? 'en' : 'ro';
    const solution = parts.find((part) => solutionSlugs.includes(part)) || 'home';
    return { locale, solution };
};

const getLocalizedPath = (solution, locale) => {
    const suffix = locale === 'en' ? '/en' : '';
    return solution === 'home' ? `/curieru${suffix}` : `/curieru/${solution}${suffix}`;
};

const getAlternatePath = (solution, locale) => getLocalizedPath(solution, locale === 'en' ? 'ro' : 'en');

export default function CurieruLanding() {
    const location = useLocation();
    const { locale, solution } = parseLandingPath(location.pathname);
    const localeContent = content[locale];
    const copy = solution === 'home'
        ? localeContent.home
        : (localeContent.solutions[solution] || localeContent.home);
    const pilotMailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(copy.pilotSubject)}`;
    const isHome = solution === 'home';

    useEffect(() => {
        const previousTitle = document.title;
        const previousLang = document.documentElement.lang;
        document.title = copy.title;
        document.documentElement.lang = localeContent.htmlLang;
        return () => {
            document.title = previousTitle;
            document.documentElement.lang = previousLang;
        };
    }, [copy.title, localeContent.htmlLang]);

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
                        <Link to={localeContent.nav.homePath} className="flex items-center gap-3" aria-label="Curieru">
                            <img src="/logo-horizontal.png" alt="" className="h-9 w-auto max-w-[150px] object-contain" />
                            <span className="border-l border-white/20 pl-3 text-lg font-black tracking-tight">Curieru</span>
                        </Link>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <div className="hidden items-center gap-1 lg:flex">
                                {solutionLinks[locale].map((item) => (
                                    <Link
                                        key={item.key}
                                        to={item.path}
                                        className={`inline-flex min-h-10 items-center justify-center rounded-lg border px-3 text-xs font-black uppercase tracking-wider transition ${solution === item.key ? 'border-cyan-300/50 bg-cyan-300/15 text-cyan-100' : 'border-white/15 text-white hover:bg-white/10'}`}
                                    >
                                        {item.label}
                                    </Link>
                                ))}
                            </div>
                            <Link
                                to={getAlternatePath(solution, locale)}
                                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/20 px-3 text-sm font-black text-white transition hover:bg-white/10"
                            >
                                {localeContent.nav.alternateLabel}
                            </Link>
                            <Link
                                to="/login"
                                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/20 px-4 text-sm font-black text-white transition hover:bg-white/10"
                            >
                                {localeContent.nav.login}
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
                            <div className="mt-5 flex flex-wrap gap-2 lg:hidden">
                                {solutionLinks[locale].map((item) => (
                                    <Link
                                        key={item.key}
                                        to={item.path}
                                        className={`inline-flex min-h-10 items-center justify-center rounded-lg border px-3 text-xs font-black uppercase tracking-wider transition ${solution === item.key ? 'border-cyan-300/50 bg-cyan-300/15 text-cyan-100' : 'border-white/15 text-white hover:bg-white/10'}`}
                                    >
                                        {item.label}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="border-b border-slate-200 bg-white py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="max-w-2xl">
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.audience.eyebrow}</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                            {copy.audience.title}
                        </h2>
                    </div>
                    <div className="mt-8 grid gap-4 md:grid-cols-3">
                        {copy.audience.cards.map(({ icon: Icon, title, text }) => (
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
                        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-300">{copy.problems.eyebrow}</p>
                        <h2 className="mt-3 text-3xl font-black tracking-normal sm:text-4xl">
                            {copy.problems.title}
                        </h2>
                        <p className="mt-5 text-base font-medium leading-8 text-slate-300">
                            {copy.problems.text}
                        </p>
                    </div>
                    <div className="grid gap-3">
                        {copy.problems.items.map((item) => (
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
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.modules.eyebrow}</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                {copy.modules.title}
                            </h2>
                        </div>
                        <p className="max-w-sm text-sm font-semibold leading-6 text-slate-600">
                            {copy.modules.text}
                        </p>
                    </div>
                    <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {copy.modules.items.map(({ icon: Icon, label, detail }) => (
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

            {isHome && copy.tracks ? (
                <section className="bg-white py-16 sm:py-20">
                    <div className="mx-auto max-w-7xl px-5 sm:px-8">
                        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
                            <div className="max-w-2xl">
                                <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.tracks.eyebrow}</p>
                                <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                    {copy.tracks.title}
                                </h2>
                            </div>
                            <p className="max-w-sm text-sm font-semibold leading-6 text-slate-600">{copy.tracks.text}</p>
                        </div>
                        <div className="mt-8 grid gap-4 md:grid-cols-4">
                            {solutionLinks[locale].map((item) => (
                                <Link key={item.key} to={item.path} className="group rounded-lg border border-slate-200 bg-slate-50 p-5 transition hover:border-cyan-300 hover:bg-cyan-50">
                                    <div className="text-xs font-black uppercase tracking-[0.18em] text-cyan-700">{item.label}</div>
                                    <div className="mt-4 inline-flex items-center gap-2 text-sm font-black text-slate-950">
                                        {copy.tracks.cta}
                                        <ArrowRight size={16} className="transition group-hover:translate-x-1" />
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                </section>
            ) : null}

            <section className="bg-white py-16 sm:py-20">
                <div className="mx-auto max-w-7xl px-5 sm:px-8">
                    <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
                        <div>
                            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">{copy.proof.eyebrow}</p>
                            <h2 className="mt-3 text-3xl font-black tracking-normal text-slate-950 sm:text-4xl">
                                {copy.proof.title}
                            </h2>
                        </div>
                        <div className="grid gap-4">
                            {copy.proof.cards.map(({ icon: Icon, title, text }) => (
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
