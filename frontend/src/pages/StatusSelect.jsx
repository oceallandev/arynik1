import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Loader2, RefreshCw } from 'lucide-react';
import { queueItem } from '../store/queue';
import { getNdrReasons, getShipment, getStatusOptions, updateAwb } from '../services/api';
import { awbCandidatesFromScan, normalizeShipmentIdentifier } from '../services/awbScan';

export default function StatusSelect({ awb, onBack, onComplete }) {
    const [options, setOptions] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [detailsLoading, setDetailsLoading] = useState(true);
    const [shipment, setShipment] = useState(null);
    const [scanNormalized, setScanNormalized] = useState('');
    const [actionAwb, setActionAwb] = useState(null);
    const [parcelIndex, setParcelIndex] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [detailsError, setDetailsError] = useState('');

    const [ndrReasons, setNdrReasons] = useState([]);
    const [reasonCode, setReasonCode] = useState('');
    const [reasonNote, setReasonNote] = useState('');
    const [rescheduleAt, setRescheduleAt] = useState('');

    const [gps, setGps] = useState(null); // { latitude, longitude, accuracy_m, timestamp }
    const [gpsBusy, setGpsBusy] = useState(false);
    const [gpsError, setGpsError] = useState('');

    const [photoDataUrl, setPhotoDataUrl] = useState('');
    const [photoBusy, setPhotoBusy] = useState(false);
    const [photoError, setPhotoError] = useState('');

    const [signatureDataUrl, setSignatureDataUrl] = useState('');

    const [codCollected, setCodCollected] = useState('');
    const [codMethod, setCodMethod] = useState('cash'); // cash | card | transfer | other
    const [codReference, setCodReference] = useState('');

    const parcelsTotal = (() => {
        if (!shipment) return null;
        const n = Number(shipment.number_of_parcels);
        if (Number.isFinite(n) && n > 0) return n;
        const raw = shipment?.raw_data || {};
        const fallback = Number(raw?.numberOfDistinctBarcodes ?? raw?.numberOfParcels ?? 1);
        return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
    })();

    const expectedCod = (() => {
        if (!shipment) return 0;
        const n = Number(shipment.cod_amount);
        return Number.isFinite(n) ? n : 0;
    })();

    const selectedOpt = (Array.isArray(options) ? options : []).find((o) => String(o?.event_id) === String(selectedId)) || null;
    const requirements = Array.isArray(selectedOpt?.requirements) ? selectedOpt.requirements : [];

    useEffect(() => {
        let cancelled = false;

        const token = localStorage.getItem('token');
        const scan = awbCandidatesFromScan(awb);
        setScanNormalized(scan.normalized);
        setActionAwb(scan.normalized || null);
        setParcelIndex(null);
        setReasonCode('');
        setReasonNote('');
        setRescheduleAt('');
        setGps(null);
        setGpsBusy(false);
        setGpsError('');
        setPhotoDataUrl('');
        setPhotoBusy(false);
        setPhotoError('');
        setSignatureDataUrl('');
        setCodCollected('');
        setCodMethod('cash');
        setCodReference('');

        setLoading(true);
        setError('');
        getStatusOptions(token)
            .then((data) => {
                if (cancelled) return;
                setOptions(data);
            })
            .catch(() => {
                if (cancelled) return;
                setError('Failed to load status options');
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });

        // NDR reason codes are optional; failures should not block status updates.
        getNdrReasons(token)
            .then((res) => {
                if (cancelled) return;
                const list = Array.isArray(res?.reasons) ? res.reasons : [];
                setNdrReasons(list);
            })
            .catch(() => {
                if (cancelled) return;
                setNdrReasons([]);
            });

        setDetailsLoading(true);
        setDetailsError('');
        setShipment(null);
        (async () => {
            let lastErr = null;
            for (const cand of scan.candidates) {
                try {
                    const data = await getShipment(token, cand, { refresh: true });
                    if (cancelled) return;

                    setShipment(data);

                    const resolved = normalizeShipmentIdentifier(data?.awb || '') || cand;
                    setActionAwb(resolved || cand);

                    // Only treat the last 3 digits as a parcel index when the scan resolved
                    // to the "core" candidate (i.e. scan = core + suffix).
                    if (
                        scan.coreCandidate
                        && scan.parcelSuffixCandidate
                        && scan.normalized
                        && resolved
                        && scan.normalized === `${scan.coreCandidate}${scan.parcelSuffixCandidate}`
                        && resolved === scan.coreCandidate
                    ) {
                        setParcelIndex(Number(scan.parcelSuffixCandidate));
                    } else {
                        setParcelIndex(null);
                    }
                    return;
                } catch (e) {
                    lastErr = e;
                    continue;
                }
            }

            if (cancelled) return;
            const detail = lastErr?.response?.data?.detail;
            setDetailsError(detail ? String(detail) : 'Failed to load shipment details');
        })()
            .finally(() => {
                if (cancelled) return;
                setDetailsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [awb]);

    const detectGps = async () => {
        setGpsBusy(true);
        setGpsError('');
        try {
            if (!navigator.geolocation) {
                throw new Error('Geolocation is not supported');
            }
            const coords = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                    (p) => resolve(p.coords),
                    (e) => reject(new Error(e?.message || 'GPS error')),
                    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
                );
            });
            const lat = Number(coords?.latitude);
            const lon = Number(coords?.longitude);
            const acc = Number(coords?.accuracy);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new Error('Invalid GPS coordinates');
            }
            setGps({
                latitude: lat,
                longitude: lon,
                accuracy_m: Number.isFinite(acc) ? acc : null,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            setGpsError(String(e?.message || 'Failed to detect GPS'));
        } finally {
            setGpsBusy(false);
        }
    };

    const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        const f = file;
        if (!f) return reject(new Error('Missing file'));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(f);
    });

    const compressImageToJpegDataUrl = async (file, { maxDim = 1280, quality = 0.72 } = {}) => {
        const raw = await readFileAsDataUrl(file);
        const dataUrl = String(raw || '');
        if (!dataUrl.startsWith('data:image/')) {
            throw new Error('Invalid image');
        }
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = () => resolve(true);
            img.onerror = () => reject(new Error('Invalid image'));
            img.src = dataUrl;
        });
        const w = Number(img.width) || 0;
        const h = Number(img.height) || 0;
        if (!w || !h) throw new Error('Invalid image');
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(img, 0, 0, outW, outH);
        return canvas.toDataURL('image/jpeg', quality);
    };

    const onPickPhoto = async (file) => {
        if (!file) return;
        setPhotoBusy(true);
        setPhotoError('');
        try {
            const dataUrl = await compressImageToJpegDataUrl(file);
            setPhotoDataUrl(String(dataUrl || ''));
        } catch (e) {
            setPhotoError(String(e?.message || 'Failed to process photo'));
        } finally {
            setPhotoBusy(false);
        }
    };

    const refreshDetails = async () => {
        setDetailsLoading(true);
        setDetailsError('');
        try {
            const token = localStorage.getItem('token');
            const scan = awbCandidatesFromScan(awb);
            let lastErr = null;
            for (const cand of scan.candidates) {
                try {
                    const details = await getShipment(token, cand, { refresh: true });
                    setShipment(details);

                    const resolved = normalizeShipmentIdentifier(details?.awb || '') || cand;
                    setActionAwb(resolved || cand);

                    if (
                        scan.coreCandidate
                        && scan.parcelSuffixCandidate
                        && scan.normalized
                        && resolved
                        && scan.normalized === `${scan.coreCandidate}${scan.parcelSuffixCandidate}`
                        && resolved === scan.coreCandidate
                    ) {
                        setParcelIndex(Number(scan.parcelSuffixCandidate));
                    } else {
                        setParcelIndex(null);
                    }

                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                }
            }

            if (lastErr) {
                throw lastErr;
            }
        } catch (e) {
            const detail = e?.response?.data?.detail;
            setDetailsError(detail ? String(detail) : 'Failed to load shipment details');
        } finally {
            setDetailsLoading(false);
        }
    };

    const money = (amount, currency = 'RON') => {
        if (amount === null || amount === undefined || amount === '') return '--';
        const n = Number(amount);
        if (!Number.isFinite(n)) return '--';
        return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
    };

    const canSubmit = (() => {
        if (!selectedId) return false;
        // Basic: require shipment details if we need any proof fields tied to it.
        const reqs = Array.isArray(requirements) ? requirements : [];

        const needsGps = reqs.includes('gps');
        const needsPhoto = reqs.includes('photo');
        const needsSignature = reqs.includes('signature');
        const needsReason = reqs.includes('reason');
        const needsRescheduleAt = reqs.includes('reschedule_at');
        const needsCodCollect = reqs.includes('cod_collect') && expectedCod > 0;
        const needsCodTransfer = reqs.includes('cod_transfer');

        if (needsGps && (!gps || !Number.isFinite(Number(gps?.latitude)) || !Number.isFinite(Number(gps?.longitude)))) return false;
        if (needsPhoto && !String(photoDataUrl || '').startsWith('data:image/')) return false;
        if (needsSignature && !String(signatureDataUrl || '').startsWith('data:image/')) return false;

        if (needsReason) {
            const code = String(reasonCode || '').trim();
            if (!code) return false;
            if (code.toUpperCase() === 'OTHER' && !String(reasonNote || '').trim()) return false;
        }
        if (needsRescheduleAt && !String(rescheduleAt || '').trim()) return false;

        if (needsCodCollect) {
            const n = Number(codCollected);
            if (!Number.isFinite(n) || n < 0) return false;
        }
        if (needsCodTransfer) {
            const n = Number(codCollected);
            if (!Number.isFinite(n) || n <= 0) return false;
        }

        return true;
    })();

    const handleSubmit = async () => {
        if (!selectedId) {
            return;
        }

        setSubmitting(true);

        try {
            const token = localStorage.getItem('token');
            const identifier = actionAwb || normalizeShipmentIdentifier(awb);
            const locality =
                shipment?.locality
                || shipment?.raw_data?.recipientLocation?.locality
                || shipment?.raw_data?.recipientLocation?.localityName
                || '';
            const payloadOut = {};
            if (locality) payloadOut.locality = locality;
            if (Number.isInteger(parcelIndex) && parcelIndex > 0) payloadOut.parcel_index = parcelIndex;
            if (Number.isFinite(parcelsTotal) && parcelsTotal > 0) payloadOut.parcels_total = parcelsTotal;
            if (scanNormalized && identifier && scanNormalized !== identifier) payloadOut.scanned_identifier = scanNormalized;

            // Attach business metadata (POD / NDR / COD) into our audit payload.
            if (gps) {
                payloadOut.gps = {
                    latitude: Number(gps.latitude),
                    longitude: Number(gps.longitude),
                    accuracy_m: gps.accuracy_m ?? null,
                    timestamp: gps.timestamp || new Date().toISOString(),
                };
            }

            if (photoDataUrl || signatureDataUrl) {
                payloadOut.pod = {
                    photo: photoDataUrl ? { data_url: String(photoDataUrl), mime: 'image/jpeg' } : null,
                    signature: signatureDataUrl ? { data_url: String(signatureDataUrl), mime: 'image/png' } : null,
                };
            }

            if (reasonCode || reasonNote || rescheduleAt) {
                payloadOut.ndr = {
                    reason_code: reasonCode ? String(reasonCode).trim() : null,
                    note: reasonNote ? String(reasonNote).trim() : null,
                    reschedule_at: rescheduleAt ? String(rescheduleAt).trim() : null,
                };
            }

            if (codCollected !== '' || codMethod || codReference) {
                const n = Number(codCollected);
                payloadOut.cod = {
                    amount_collected: Number.isFinite(n) ? n : null,
                    expected_amount: Number.isFinite(Number(expectedCod)) ? Number(expectedCod) : null,
                    method: String(codMethod || '').trim() || null,
                    reference: String(codReference || '').trim() || null,
                };
            }

            const payload = Object.keys(payloadOut).length ? payloadOut : undefined;
            await updateAwb(token, {
                awb: identifier,
                event_id: selectedId,
                timestamp: new Date().toISOString(),
                payload
            });
            onComplete('SUCCESS', { awb: identifier, event_id: selectedId, parcel_index: payloadOut.parcel_index, parcels_total: payloadOut.parcels_total });
        } catch {
            const locality =
                shipment?.locality
                || shipment?.raw_data?.recipientLocation?.locality
                || shipment?.raw_data?.recipientLocation?.localityName
                || '';
            const identifier = actionAwb || normalizeShipmentIdentifier(awb);
            const payloadOut = {};
            if (locality) payloadOut.locality = locality;
            if (Number.isInteger(parcelIndex) && parcelIndex > 0) payloadOut.parcel_index = parcelIndex;
            if (Number.isFinite(parcelsTotal) && parcelsTotal > 0) payloadOut.parcels_total = parcelsTotal;
            if (scanNormalized && identifier && scanNormalized !== identifier) payloadOut.scanned_identifier = scanNormalized;

            if (gps) {
                payloadOut.gps = {
                    latitude: Number(gps.latitude),
                    longitude: Number(gps.longitude),
                    accuracy_m: gps.accuracy_m ?? null,
                    timestamp: gps.timestamp || new Date().toISOString(),
                };
            }
            if (photoDataUrl || signatureDataUrl) {
                payloadOut.pod = {
                    photo: photoDataUrl ? { data_url: String(photoDataUrl), mime: 'image/jpeg' } : null,
                    signature: signatureDataUrl ? { data_url: String(signatureDataUrl), mime: 'image/png' } : null,
                };
            }
            if (reasonCode || reasonNote || rescheduleAt) {
                payloadOut.ndr = {
                    reason_code: reasonCode ? String(reasonCode).trim() : null,
                    note: reasonNote ? String(reasonNote).trim() : null,
                    reschedule_at: rescheduleAt ? String(rescheduleAt).trim() : null,
                };
            }
            if (codCollected !== '' || codMethod || codReference) {
                const n = Number(codCollected);
                payloadOut.cod = {
                    amount_collected: Number.isFinite(n) ? n : null,
                    expected_amount: Number.isFinite(Number(expectedCod)) ? Number(expectedCod) : null,
                    method: String(codMethod || '').trim() || null,
                    reference: String(codReference || '').trim() || null,
                };
            }

            const payload = Object.keys(payloadOut).length ? payloadOut : undefined;
            await queueItem(identifier, selectedId, payload || {});
            onComplete('QUEUED', { awb: identifier, event_id: selectedId, parcel_index: payloadOut.parcel_index, parcels_total: payloadOut.parcels_total });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
            <div className="p-4 flex items-center gap-4 bg-white dark:bg-gray-800 shadow-sm">
                <button onClick={onBack} className="p-2 -ml-2 text-gray-600"><ArrowLeft /></button>
                <div>
                    <h1 className="font-bold text-gray-900 dark:text-white">Update AWB</h1>
                    <p className="text-xs text-primary-600 font-mono tracking-wider">
                        {actionAwb || scanNormalized || awb}
                        {Number.isInteger(parcelIndex) && parcelIndex > 0 ? (
                            <span className="ml-2 text-[10px] font-black uppercase tracking-widest text-primary-600">
                                Parcel {parcelIndex}{Number.isFinite(parcelsTotal) && parcelsTotal > 0 ? `/${parcelsTotal}` : ''}
                            </span>
                        ) : null}
                    </p>
                    {scanNormalized && actionAwb && scanNormalized !== actionAwb ? (
                        <p className="text-[10px] text-gray-500 dark:text-gray-400 font-mono mt-1">
                            Scanned: {scanNormalized}
                        </p>
                    ) : null}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div className="p-4 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Shipment</p>
                            <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                                {detailsLoading ? 'Loading details...' : (shipment?.recipient_name || '--')}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={refreshDetails}
                            disabled={detailsLoading}
                            className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50"
                            title="Refresh shipment details"
                            aria-label="Refresh shipment details"
                        >
                            <RefreshCw size={16} className={detailsLoading ? 'animate-spin' : ''} />
                        </button>
                    </div>

                    {detailsError ? (
                        <div className="mt-3 p-3 bg-amber-100 text-amber-800 rounded-xl text-xs font-bold">
                            {detailsError}
                        </div>
                    ) : null}

                    {shipment ? (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Address</p>
                                <p className="text-sm text-gray-700 dark:text-gray-200">
                                    {shipment.delivery_address || shipment.locality || '--'}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Phone</p>
                                <p className="text-sm font-mono text-gray-900 dark:text-white truncate">
                                    {shipment.recipient_phone || '--'}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Content</p>
                                <p className="text-sm text-gray-900 dark:text-white truncate">
                                    {shipment.content_description
                                        || shipment?.raw_data?.contentDescription
                                        || shipment?.raw_data?.contents
                                        || shipment?.raw_data?.content
                                        || shipment?.raw_data?.packingList
                                        || shipment?.raw_data?.packingListNumber
                                        || shipment?.raw_data?.packingListId
                                        || shipment?.raw_data?.packing_list
                                        || shipment?.raw_data?.packing_list_number
                                        || shipment?.raw_data?.packing_list_id
                                        || shipment?.raw_data?.packageContent
                                        || shipment?.raw_data?.shipmentContent
                                        || shipment?.raw_data?.goodsDescription
                                        || shipment?.raw_data?.additionalServices?.contentDescription
                                        || shipment?.raw_data?.additionalServices?.contents
                                        || shipment?.raw_data?.additionalServices?.content
                                        || shipment?.raw_data?.additionalServices?.packingList
                                        || shipment?.raw_data?.additionalServices?.packingListNumber
                                        || shipment?.raw_data?.additionalServices?.packingListId
                                        || shipment?.raw_data?.productCategory?.name
                                        || (typeof shipment?.raw_data?.productCategory === 'string' ? shipment.raw_data.productCategory : '')
                                        || '--'}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">COD</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-white">
                                    {money(shipment.cod_amount, shipment.currency || 'RON')}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Parcels</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-white">
                                    {Number.isFinite(Number(shipment.number_of_parcels)) ? Number(shipment.number_of_parcels) : (shipment?.raw_data?.numberOfDistinctBarcodes || shipment?.raw_data?.numberOfParcels || 1)}
                                </p>
                            </div>
                            {Number.isInteger(parcelIndex) && parcelIndex > 0 ? (
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Parcel</p>
                                    <p className="text-sm font-bold text-gray-900 dark:text-white">
                                        {parcelIndex}{Number.isFinite(parcelsTotal) && parcelsTotal > 0 ? `/${parcelsTotal}` : ''}
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                {/* Requirements */}
                {selectedOpt && requirements.length > 0 ? (
                    <div className="p-4 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Requirements</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                                    {selectedOpt.label}
                                </p>
                            </div>
                            <div className="text-[10px] font-mono text-gray-500 dark:text-gray-400">
                                {requirements.join(', ')}
                            </div>
                        </div>

                        {requirements.includes('gps') ? (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">GPS</p>
                                        <p className="text-xs text-gray-700 dark:text-gray-200 font-mono">
                                            {gps ? `${Number(gps.latitude).toFixed(6)}, ${Number(gps.longitude).toFixed(6)}${gps.accuracy_m ? ` (±${Math.round(Number(gps.accuracy_m))}m)` : ''}` : 'Not captured'}
                                        </p>
                                        {gpsError ? (
                                            <p className="text-[10px] text-red-600 font-bold mt-1">{gpsError}</p>
                                        ) : null}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={detectGps}
                                        disabled={gpsBusy}
                                        className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs font-bold bg-gray-50 dark:bg-gray-900/30 disabled:opacity-50"
                                    >
                                        {gpsBusy ? 'Getting…' : 'Get GPS'}
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {requirements.includes('photo') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Photo</p>
                                <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={(e) => onPickPhoto(e.target.files && e.target.files[0])}
                                    disabled={photoBusy}
                                />
                                {photoError ? <p className="text-[10px] text-red-600 font-bold">{photoError}</p> : null}
                                {photoDataUrl ? (
                                    <img src={photoDataUrl} alt="POD" className="w-full rounded-xl border border-gray-200 dark:border-gray-700" />
                                ) : null}
                            </div>
                        ) : null}

                        {requirements.includes('signature') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Signature</p>
                                <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden bg-gray-50 dark:bg-gray-900/30">
                                    <SignaturePad value={signatureDataUrl} onChange={setSignatureDataUrl} />
                                </div>
                            </div>
                        ) : null}

                        {requirements.includes('reason') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Reason</p>
                                <select
                                    value={reasonCode}
                                    onChange={(e) => setReasonCode(e.target.value)}
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                >
                                    <option value="">Select…</option>
                                    {(Array.isArray(ndrReasons) ? ndrReasons : []).map((r) => (
                                        <option key={r.code} value={r.code}>{r.label}</option>
                                    ))}
                                </select>
                                <textarea
                                    value={reasonNote}
                                    onChange={(e) => setReasonNote(e.target.value)}
                                    rows={2}
                                    placeholder="Note (optional)"
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                />
                            </div>
                        ) : null}

                        {requirements.includes('reschedule_at') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Reschedule</p>
                                <input
                                    type="datetime-local"
                                    value={rescheduleAt}
                                    onChange={(e) => setRescheduleAt(e.target.value)}
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                />
                            </div>
                        ) : null}

                        {(requirements.includes('cod_collect') && expectedCod > 0) || requirements.includes('cod_transfer') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">COD</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="col-span-2">
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider">Expected</p>
                                        <p className="text-sm font-bold text-gray-900 dark:text-white">{money(expectedCod, shipment?.currency || 'RON')}</p>
                                    </div>
                                    <input
                                        value={codCollected}
                                        onChange={(e) => setCodCollected(e.target.value)}
                                        inputMode="decimal"
                                        placeholder="Collected amount"
                                        className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                    />
                                    <select
                                        value={codMethod}
                                        onChange={(e) => setCodMethod(e.target.value)}
                                        className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                    >
                                        <option value="cash">Cash</option>
                                        <option value="card">Card</option>
                                        <option value="transfer">Transfer</option>
                                        <option value="other">Other</option>
                                    </select>
                                    <input
                                        value={codReference}
                                        onChange={(e) => setCodReference(e.target.value)}
                                        placeholder="Reference (optional)"
                                        className="col-span-2 w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                    />
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {loading ? (
                    <div className="flex justify-center p-8"><Loader2 className="animate-spin text-primary-500" /></div>
                ) : error ? (
                    <div className="p-4 bg-red-100 text-red-700 rounded-xl flex items-center gap-3">
                        <AlertCircle size={20} /> {error}
                    </div>
                ) : (
                    options.map((opt) => (
                        <button
                            key={opt.event_id}
                            onClick={() => setSelectedId(opt.event_id)}
                            className={`w-full p-4 rounded-2xl text-left border-2 transition-all ${selectedId === opt.event_id
                                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                                : 'border-white dark:border-gray-800 bg-white dark:bg-gray-800'
                                }`}
                        >
                            <div className="flex justify-between items-center mb-1">
                                <span className="font-bold text-gray-900 dark:text-white">{opt.label}</span>
                                {selectedId === opt.event_id && <Check className="text-primary-500" size={20} />}
                            </div>
                            <p className="text-sm text-gray-500">{opt.description}</p>
                        </button>
                    ))
                )}
            </div>

            <div className="p-4 bg-white dark:bg-gray-800 shadow-up">
                <button
                    disabled={!canSubmit || submitting}
                    onClick={handleSubmit}
                    className="w-full py-4 bg-primary-600 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2"
                >
                    {submitting ? <Loader2 className="animate-spin" /> : 'Confirm Status Update'}
                </button>
            </div>
        </div>
    );
}

function SignaturePad({ value, onChange }) {
    const canvasRef = React.useRef(null);
    const drawingRef = React.useRef({ active: false, lastX: 0, lastY: 0 });

    const draw = (x, y) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const st = drawingRef.current;
        ctx.beginPath();
        ctx.moveTo(st.lastX, st.lastY);
        ctx.lineTo(x, y);
        ctx.stroke();
        st.lastX = x;
        st.lastY = y;
    };

    const pointerPos = (e) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        return { x, y };
    };

    const start = (e) => {
        const p = pointerPos(e);
        if (!p) return;
        drawingRef.current = { active: true, lastX: p.x, lastY: p.y };
    };

    const move = (e) => {
        if (!drawingRef.current.active) return;
        const p = pointerPos(e);
        if (!p) return;
        draw(p.x, p.y);
    };

    const end = () => {
        if (!drawingRef.current.active) return;
        drawingRef.current.active = false;
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
            const dataUrl = canvas.toDataURL('image/png');
            onChange?.(dataUrl);
        } catch { }
    };

    const clear = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        onChange?.('');
    };

    useEffect(() => {
        if (!value) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const img = new Image();
        img.onload = () => {
            try {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            } catch { }
        };
        img.src = value;
    }, [value]);

    return (
        <div className="p-3 space-y-2">
            <canvas
                ref={canvasRef}
                width={320}
                height={160}
                className="w-full bg-white rounded-lg"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onPointerLeave={end}
            />
            <div className="flex items-center justify-between">
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Sign above</p>
                <button type="button" onClick={clear} className="text-xs font-bold text-gray-600">
                    Clear
                </button>
            </div>
        </div>
    );
}
