import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'arynik_lang_v1';

const STRINGS = {
    en: {
        'nav.home': 'Home',
        'nav.track': 'Track',
        'nav.routes': 'Routes',
        'nav.menu': 'Menu',

        'menu.title': 'Menu',
        'menu.navigation': 'Navigation',
        'menu.home': 'Home',
        'menu.home_desc': 'Scanner & quick actions',
        'menu.shipments': 'Shipments',
        'menu.shipments_desc': 'Track shipments',
        'menu.routes': 'Routes',
        'menu.routes_desc': 'Plan deliveries',
        'menu.manifests': 'Manifests',
        'menu.manifests_desc': 'Loadout & return scans',
        'menu.live': 'Live Ops',
        'menu.live_desc': 'Drivers & active runs',
        'menu.finance': 'Finance',
        'menu.finance_desc': 'COD to collect from client',
        'menu.notifications': 'Notifications',
        'menu.notifications_desc': 'Allocation updates',
        'menu.chat': 'Chat',
        'menu.chat_desc': 'Recipient messaging',
        'menu.history': 'History',
        'menu.history_desc': 'Logs & updates',
        'menu.calendar': 'Calendar',
        'menu.calendar_desc': 'Daily overview',
        'menu.stats': 'Statistics',
        'menu.stats_desc': 'Trucks, drivers, AWBs, ESCH',
        'menu.users': 'Users',
        'menu.users_desc': 'Create accounts & roles',
        'menu.settings': 'Settings',
        'menu.settings_desc': 'Account & API',
        'menu.signout': 'Sign Out',
        'menu.truck': 'Truck',
        'menu.phone': 'Phone',
        'menu.recipient_phone': 'Recipient Phone',
        'menu.language': 'Language',
        'menu.analytics_all': 'Analytics: ALL enabled',

        'settings.title': 'Settings',
        'settings.subtitle': 'Manage your preferences',
        'settings.language': 'Language',
        'settings.language_hint': 'Change app language for all drivers',
        'settings.lang_en': 'English',
        'settings.lang_ro': 'Romanian',

        'shipments.content': 'Content',
        'shipments.badge.washer': 'Washing Machine',
        'shipments.badge.fridge': 'Fridge',
        'shipments.badge.ac': 'AC Unit',
        'shipments.badge.cooker': 'Cooker',
        'shipments.badge.dryer': 'Dryer',
        'shipments.badge.fragile': 'Fragile',
        'shipments.badge.electronics': 'Electronics',
        'shipments.badge.furniture': 'Furniture',
        'shipments.badge.documents': 'Documents',
        'shipments.badge.fashion': 'Fashion',
        'shipments.badge.food': 'Food',
        'shipments.badge.general': 'General',

        'scanner.title': 'Scan AWB Code',
        'scanner.enter_awb': 'ENTER AWB',
        'scanner.submit_manual': 'Submit Manually',
        'scanner.camera': 'Camera',
        'scanner.manual': 'Manual',
        'scanner.barcode': 'Barcode',
        'scanner.qr': 'QR',
        'scanner.engine_auto': 'Auto Engine',
        'scanner.engine_compat': 'Compat',
        'scanner.hint_barcode': 'Align barcode horizontally inside the scan area.',
        'scanner.hint_qr': 'Center the QR code in the scan area.',
        'scanner.engine_native': 'Native detector',
        'scanner.engine_fallback': 'Compatibility mode',
        'scanner.engine_starting': 'Starting camera',
    },
    ro: {
        'nav.home': 'Acasa',
        'nav.track': 'AWB-uri',
        'nav.routes': 'Rute',
        'nav.menu': 'Meniu',

        'menu.title': 'Meniu',
        'menu.navigation': 'Navigare',
        'menu.home': 'Acasa',
        'menu.home_desc': 'Scanner si actiuni rapide',
        'menu.shipments': 'Colete',
        'menu.shipments_desc': 'Urmarire colete',
        'menu.routes': 'Rute',
        'menu.routes_desc': 'Planificare livrari',
        'menu.manifests': 'Manifeste',
        'menu.manifests_desc': 'Scanare incarcare/retur',
        'menu.live': 'Operatiuni Live',
        'menu.live_desc': 'Soferi si curse active',
        'menu.finance': 'Financiar',
        'menu.finance_desc': 'Ramburs de incasat de la client',
        'menu.notifications': 'Notificari',
        'menu.notifications_desc': 'Actualizari alocari',
        'menu.chat': 'Chat',
        'menu.chat_desc': 'Mesaje destinatar',
        'menu.history': 'Istoric',
        'menu.history_desc': 'Loguri si actualizari',
        'menu.calendar': 'Calendar',
        'menu.calendar_desc': 'Privire zilnica',
        'menu.stats': 'Statistici',
        'menu.stats_desc': 'Camioane, soferi, AWB, ESCH',
        'menu.users': 'Utilizatori',
        'menu.users_desc': 'Conturi si roluri',
        'menu.settings': 'Setari',
        'menu.settings_desc': 'Cont si API',
        'menu.signout': 'Deconectare',
        'menu.truck': 'Camion',
        'menu.phone': 'Telefon',
        'menu.recipient_phone': 'Telefon destinatar',
        'menu.language': 'Limba',
        'menu.analytics_all': 'Analitice: TOT activat',

        'settings.title': 'Setari',
        'settings.subtitle': 'Administrati preferintele',
        'settings.language': 'Limba',
        'settings.language_hint': 'Schimbati limba aplicatiei pentru soferi',
        'settings.lang_en': 'Engleza',
        'settings.lang_ro': 'Romana',

        'shipments.content': 'Continut',
        'shipments.badge.washer': 'Masina de Spalat',
        'shipments.badge.fridge': 'Frigider',
        'shipments.badge.ac': 'Aer Conditionat',
        'shipments.badge.cooker': 'Aragaz',
        'shipments.badge.dryer': 'Uscator',
        'shipments.badge.fragile': 'Fragil',
        'shipments.badge.electronics': 'Electronice',
        'shipments.badge.furniture': 'Mobila',
        'shipments.badge.documents': 'Documente',
        'shipments.badge.fashion': 'Fashion',
        'shipments.badge.food': 'Alimente',
        'shipments.badge.general': 'General',

        'home.gm': 'Buna Dimineata',
        'home.ga': 'Buna Ziua',
        'home.ge': 'Buna Seara',
        'home.quick': 'Actiuni Rapide',
        'home.scan_package': 'Scaneaza Colet',
        'home.tap_scanner': 'Apasa pentru scanner',
        'home.browse': 'Vezi Colete',
        'home.search_shipments': 'Cauta Colete',
        'home.notifications': 'Notificari',
        'home.manage_users': 'Administrare Utilizatori',

        'scanner.title': 'Scaneaza cod AWB',
        'scanner.enter_awb': 'INTRODU AWB',
        'scanner.submit_manual': 'Trimite Manual',
        'scanner.camera': 'Camera',
        'scanner.manual': 'Manual',
        'scanner.barcode': 'Cod de bare',
        'scanner.qr': 'QR',
        'scanner.engine_auto': 'Motor automat',
        'scanner.engine_compat': 'Compatibilitate',
        'scanner.hint_barcode': 'Aliniaza codul de bare orizontal in zona de scanare.',
        'scanner.hint_qr': 'Centreaza codul QR in zona de scanare.',
        'scanner.engine_native': 'Detector nativ',
        'scanner.engine_fallback': 'Mod compatibilitate',
        'scanner.engine_starting': 'Pornire camera',
    },
};

const LanguageContext = createContext({
    lang: 'en',
    setLang: () => { },
    t: (key, fallback = '') => fallback || key,
});

export function LanguageProvider({ children }) {
    const browserDefault = (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('ro')) ? 'ro' : 'en';
    const [lang, setLang] = useState(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored === 'ro' || stored === 'en') return stored;
        } catch { }
        return browserDefault;
    });

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch { }
        try { document.documentElement.setAttribute('lang', lang); } catch { }
    }, [lang]);

    const value = useMemo(() => {
        const t = (key, fallback = '') => STRINGS?.[lang]?.[key] || STRINGS.en?.[key] || fallback || key;
        return { lang, setLang, t };
    }, [lang]);

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    return useContext(LanguageContext);
}
