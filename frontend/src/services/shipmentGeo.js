export const isValidCoord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) > 0.0001;
};

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
        // Keep behavior stable (legacy code used /\\s+/g which only matches the literal "\s").
        .replace(/\\s+/g, ' ')
        .trim()
);

export const buildGeocodeQuery = (shipment) => {
    const addr = normalizePlace(shipment?.delivery_address);
    const loc = normalizePlace(shipment?.locality || shipment?.raw_data?.recipientLocation?.locality);
    const county = normalizePlace(shipment?.county || shipment?.raw_data?.recipientLocation?.county || shipment?.raw_data?.recipientLocation?.countyName);

    const parts = [];
    if (addr) parts.push(addr);
    if (loc && !addr.toLowerCase().includes(loc.toLowerCase())) parts.push(loc);
    if (county && !parts.some((p) => p.toLowerCase().includes(county.toLowerCase()))) parts.push(county);
    parts.push('Romania');
    return parts.filter(Boolean).join(', ');
};
