export const haversineKm = (a, b) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(Number(b.lat) - Number(a.lat));
    const dLon = toRad(Number(b.lon) - Number(a.lon));
    const lat1 = toRad(Number(a.lat));
    const lat2 = toRad(Number(b.lat));
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
};

// Compute the cheapest insertion point for `stop` into an existing roundtrip:
// origin -> stops... -> origin
export const bestInsertionIndex = (origin, stops, stop) => {
    const list = Array.isArray(stops) ? stops : [];
    if (!origin || !stop) return { index: list.length, delta_km: Number.POSITIVE_INFINITY };

    let bestIdx = 0;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= list.length; i += 1) {
        const prev = i === 0 ? origin : list[i - 1];
        const next = i === list.length ? origin : list[i];
        const delta = haversineKm(prev, stop) + haversineKm(stop, next) - haversineKm(prev, next);
        if (delta < bestDelta) {
            bestDelta = delta;
            bestIdx = i;
        }
    }

    return { index: bestIdx, delta_km: bestDelta };
};

export const optimizeRoundTripOrder = (origin, stops, { max_passes = 2 } = {}) => {
    const list = Array.isArray(stops) ? stops.filter(Boolean).slice() : [];
    if (!origin || list.length < 2) return list;

    // Nearest-neighbor seed.
    const remaining = list.slice();
    const ordered = [];
    let current = origin;
    while (remaining.length) {
        remaining.sort((a, b) => haversineKm(current, a) - haversineKm(current, b));
        const next = remaining.shift();
        ordered.push(next);
        current = next;
    }

    // 2-opt improvement with fixed origin (roundtrip).
    const eps = 1e-6;
    for (let pass = 0; pass < Math.max(1, Number(max_passes) || 1); pass += 1) {
        let improved = false;
        for (let i = 0; i < ordered.length - 1; i += 1) {
            const prev = i === 0 ? origin : ordered[i - 1];
            for (let k = i + 1; k < ordered.length; k += 1) {
                const next = k === ordered.length - 1 ? origin : ordered[k + 1];
                const a = ordered[i];
                const b = ordered[k];
                const delta = haversineKm(prev, b) + haversineKm(a, next) - haversineKm(prev, a) - haversineKm(b, next);
                if (delta < -eps) {
                    // Reverse segment [i..k].
                    for (let left = i, right = k; left < right; left += 1, right -= 1) {
                        const tmp = ordered[left];
                        ordered[left] = ordered[right];
                        ordered[right] = tmp;
                    }
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }

    return ordered;
};

