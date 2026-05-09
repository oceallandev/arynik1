export const isValidCoord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) > 0.0001;
};

const toCoord = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).trim().replace(',', '.');
    if (!normalized) return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
};

export const extractShipmentCoords = (shipment) => {
    const raw = shipment?.raw_data || {};
    const pin = shipment?.recipient_pin || raw?.recipientPin || {};
    const loc = raw?.recipientLocation || {};

    const latCandidates = [
        shipment?.latitude,
        shipment?.lat,
        shipment?.location?.latitude,
        shipment?.location?.lat,
        pin?.latitude,
        pin?.lat,
        loc?.latitude,
        loc?.lat,
    ];
    const lonCandidates = [
        shipment?.longitude,
        shipment?.lon,
        shipment?.lng,
        shipment?.location?.longitude,
        shipment?.location?.lon,
        shipment?.location?.lng,
        pin?.longitude,
        pin?.lon,
        pin?.lng,
        loc?.longitude,
        loc?.lon,
        loc?.lng,
    ];

    const lat = latCandidates.map(toCoord).find((v) => Number.isFinite(v));
    const lon = lonCandidates.map(toCoord).find((v) => Number.isFinite(v));
    if (!isValidCoord(lat) || !isValidCoord(lon)) return null;
    return { lat: Number(lat), lon: Number(lon) };
};

const stripDiacritics = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const extractPlaceName = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
        const v =
            value?.name
            || value?.label
            || value?.value
            || value?.countyName
            || value?.localityName
            || value?.cityName
            || value?.regionName
            || value?.county
            || value?.locality
            || value?.city
            || value?.region;
        if (v && (typeof v === 'string' || typeof v === 'number')) return String(v);
        if (v && typeof v === 'object') return extractPlaceName(v);
        return '';
    }
    return String(value);
};

const normalizePlace = (value) => (
    extractPlaceName(value)
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
);

const normalizeHint = (value) => (
    stripDiacritics(normalizePlace(value))
        .toLowerCase()
        .trim()
);

const sanitizeAddressText = (value) => (
    normalizePlace(value)
        .replace(/\b(?:cod\s*postal|postal\s*code|postcode|zip)\s*[:#-]?\s*0{5}\b/ig, ' ')
        .replace(/(^|[^\d])0{5}(?=$|[^\d])/g, '$1 ')
        .replace(/\s*[,;|/]\s*(?=[,;|/]|$)/g, ', ')
        .replace(/^[\s,;|/-]+|[\s,;|/-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
);

const COUNTY_CODE_TO_NAME = {
    AB: 'Alba',
    AR: 'Arad',
    AG: 'Arges',
    BC: 'Bacau',
    BH: 'Bihor',
    BN: 'Bistrita Nasaud',
    BT: 'Botosani',
    BV: 'Brasov',
    BR: 'Braila',
    BZ: 'Buzau',
    CS: 'Caras Severin',
    CL: 'Calarasi',
    CJ: 'Cluj',
    CT: 'Constanta',
    CV: 'Covasna',
    DB: 'Dambovita',
    DJ: 'Dolj',
    GL: 'Galati',
    GR: 'Giurgiu',
    GJ: 'Gorj',
    HR: 'Harghita',
    HD: 'Hunedoara',
    IL: 'Ialomita',
    IS: 'Iasi',
    IF: 'Ilfov',
    MM: 'Maramures',
    MH: 'Mehedinti',
    MS: 'Mures',
    NT: 'Neamt',
    OT: 'Olt',
    PH: 'Prahova',
    SJ: 'Salaj',
    SM: 'Satu Mare',
    SB: 'Sibiu',
    SV: 'Suceava',
    TR: 'Teleorman',
    TM: 'Timis',
    TL: 'Tulcea',
    VL: 'Valcea',
    VS: 'Vaslui',
    VN: 'Vrancea',
    B: 'Bucuresti',
};

const normalizeCountyForGeocode = (value) => {
    const county = normalizePlace(value);
    if (!county) return '';

    const upper = county.toUpperCase().replace(/\s+/g, '');
    if (COUNTY_CODE_TO_NAME[upper]) return COUNTY_CODE_TO_NAME[upper];

    const cleaned = county.replace(/^jud(?:et|etul)?\s+/i, '').trim();
    return cleaned || county;
};

const isLikelyStreetText = (value) => {
    const txt = normalizeHint(value);
    if (!txt) return false;
    if (/\b(str|strada|bd|bulevard|blvd|aleea|nr|bloc|bl|sc|scara|ap)\b/.test(txt)) return true;
    if (/\d/.test(txt)) return true;
    return false;
};

const hasStreetAndNumber = (value) => {
    const txt = normalizeHint(sanitizeAddressText(value));
    if (!txt) return false;
    const hasNumber = Array.from(txt.matchAll(/\b(\d+)[a-z]?\b/g)).some((m) => String(m?.[1] || '').split('').some((ch) => ch !== '0'));
    const hasStreet = /\b(str|strada|bd|bulevard|calea|aleea|sos|soseaua|drum|dn|dj|nr)\b/.test(txt);
    const hasSeparator = txt.includes(',') || txt.includes('/');
    return Boolean(hasNumber && (hasStreet || hasSeparator));
};

const pickLocality = (shipment) => {
    const raw = shipment?.raw_data || {};
    const recipientLocation = raw?.recipientLocation || {};
    const recipientPin = raw?.recipientPin || {};
    const candidates = [
        shipment?.locality,
        recipientPin?.localityName,
        recipientPin?.locality,
        recipientPin?.cityName,
        recipientPin?.city,
        recipientLocation?.localityName,
        recipientLocation?.locality,
        recipientLocation?.cityName,
        recipientLocation?.city,
    ];

    const values = candidates.map((v) => normalizePlace(v)).filter(Boolean);
    const nonStreet = values.find((v) => !isLikelyStreetText(v));
    return nonStreet || values[0] || '';
};

const pickCounty = (shipment) => {
    const raw = shipment?.raw_data || {};
    const recipientLocation = raw?.recipientLocation || {};
    const recipientPin = raw?.recipientPin || {};
    const candidates = [
        shipment?.county,
        recipientPin?.countyName,
        recipientPin?.county,
        recipientPin?.regionName,
        recipientPin?.region,
        recipientPin?.countyCode,
        recipientPin?.county_code,
        recipientLocation?.countyName,
        recipientLocation?.county,
        recipientLocation?.regionName,
        recipientLocation?.region,
        recipientLocation?.countyCode,
        recipientLocation?.county_code,
    ];
    return candidates.map((v) => normalizeCountyForGeocode(v)).find(Boolean) || '';
};

const pickAddress = (shipment) => {
    const raw = shipment?.raw_data || {};
    const recipientLocation = raw?.recipientLocation || {};
    const recipientPin = raw?.recipientPin || {};

    const candidates = [
        shipment?.delivery_address,
        recipientPin?.addressText,
        recipientPin?.address,
        recipientLocation?.addressText,
        recipientLocation?.address,
        recipientLocation?.street,
        recipientLocation?.streetName,
    ];
    const direct = candidates.map((v) => sanitizeAddressText(v)).find(Boolean);
    if (direct) return direct;

    const structuredLocations = [
        shipment?.recipient_location,
        shipment?.recipient_pin,
        recipientLocation,
        recipientPin,
        raw,
    ].filter((v) => v && typeof v === 'object');
    const streetKeys = ['street', 'streetName', 'street_name', 'route', 'road', 'thoroughfare'];
    const numberKeys = ['streetNumber', 'street_number', 'houseNumber', 'house_number', 'buildingNumber', 'building_number', 'number', 'nr', 'no'];
    const extraKeys = ['block', 'bloc', 'building', 'scara', 'staircase', 'floor', 'etaj', 'apartment', 'ap'];

    for (const loc of structuredLocations) {
        const street = streetKeys.map((k) => sanitizeAddressText(loc?.[k])).find(Boolean);
        if (!street) continue;
        const number = numberKeys.map((k) => sanitizeAddressText(loc?.[k])).find(Boolean);
        const parts = [street];
        if (number && !street.includes(number)) parts.push(`nr. ${number}`);
        extraKeys.forEach((k) => {
            const value = sanitizeAddressText(loc?.[k]);
            if (value && !parts.join(' ').includes(value)) parts.push(value);
        });
        return parts.join(', ');
    }

    return '';
};

export const buildGeocodeHints = (shipment) => {
    const locality = pickLocality(shipment);
    const county = pickCounty(shipment);
    return {
        expectedLocality: locality ? normalizeHint(locality) : '',
        expectedCounty: county ? normalizeHint(county) : '',
    };
};

export const buildGeocodeQuery = (shipment) => {
    const addr = pickAddress(shipment);
    const loc = pickLocality(shipment);
    const county = pickCounty(shipment);

    const parts = [];
    if (!hasStreetAndNumber(addr)) {
        if (loc) parts.push(loc);
        if (county && !parts.some((p) => normalizeHint(p).includes(normalizeHint(county)))) parts.push(county);
        parts.push('Romania');
        return parts.filter(Boolean).join(', ');
    }

    if (addr) parts.push(addr);
    if (loc && !normalizeHint(addr).includes(normalizeHint(loc))) parts.push(loc);
    if (county && !parts.some((p) => normalizeHint(p).includes(normalizeHint(county)))) parts.push(county);
    parts.push('Romania');
    return parts.filter(Boolean).join(', ');
};
