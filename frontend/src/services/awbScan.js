// Helpers for dealing with scanned AWB/QR payloads.
//
// Some parcel labels append a 3-digit parcel sequence suffix to the AWB
// (e.g. AWB...001, AWB...002). We keep the scan normalized and provide a
// safe "core candidate" (scan minus last 3 digits) that callers can try if
// the full scan doesn't resolve.

export const normalizeShipmentIdentifier = (value) => {
    const raw = String(value || '').trim().toUpperCase();
    // Remove all whitespace and keep only A-Z0-9 to match backend normalization.
    return raw
        .replace(/\s+/g, '')
        .replace(/[^A-Z0-9]/g, '');
};

export const awbCandidatesFromScan = (value) => {
    const normalized = normalizeShipmentIdentifier(value);
    if (!normalized) {
        return {
            normalized: '',
            candidates: [],
            coreCandidate: null,
            parcelSuffixCandidate: null
        };
    }

    const candidates = [normalized];

    // Parcel suffix candidate: 3 digits at the end, typically 001, 002, ...
    const suffix = normalized.slice(-3);
    const core = normalized.slice(0, -3);

    const hasLetters = /[A-Z]/.test(normalized);
    const looksLikeParcelSuffix =
        hasLetters
        && normalized.length >= 11 // core at least 8 chars
        && /^\d{3}$/.test(suffix)
        && suffix !== '000'
        && core
        && core !== normalized;

    if (looksLikeParcelSuffix) {
        candidates.push(core);
        return {
            normalized,
            candidates,
            coreCandidate: core,
            parcelSuffixCandidate: suffix
        };
    }

    return {
        normalized,
        candidates,
        coreCandidate: null,
        parcelSuffixCandidate: null
    };
};

