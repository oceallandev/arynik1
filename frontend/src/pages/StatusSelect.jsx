import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Loader2, RefreshCw, Camera, Package, Box, Plus } from 'lucide-react';
import { queueItem } from '../store/queue';
import { getNdrReasons, getShipment, getStatusOptions, updateAwb } from '../services/api';
import { awbCandidatesFromScan, normalizeShipmentIdentifier } from '../services/awbScan';
import { useLanguage } from '../context/LanguageContext';
import { getCurrentPositionRobust, normalizeGeoErrorMessage } from '../services/location';

const BUY_BACK_MARKER = 'retur deseu la greenwee buzau';
const REFUSAL_ACTIONS_FALLBACK = [
    { code: 'RETURN_TO_SENDER', label: 'Return to sender', kind: 'return' },
    { code: 'REDIRECT_TO_FLANCO', label: 'Redirect to Flanco store', kind: 'redirect' },
    { code: 'REDIRECT_TO_NEW_RECIPIENT', label: 'Redirect to new recipient', kind: 'redirect' },
    { code: 'RESCHEDULE_DELIVERY', label: 'Reschedule delivery', kind: 'reschedule' },
];

const normalizeFold = (value) => {
    try {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    } catch {
        return String(value || '').toLowerCase().trim();
    }
};

const shippingInstructionText = (shipment) => {
    if (!shipment || typeof shipment !== 'object') return '';
    const raw = shipment?.raw_data || {};
    const additional = raw?.additionalServices || {};
    const candidates = [
        shipment?.delivery_instructions,
        raw?.shippingInstruction,
        raw?.shipping_instruction,
        raw?.info?.shippingInstruction,
        raw?.info?.shipping_instruction,
        additional?.shippingInstruction,
        additional?.shipping_instruction,
    ];
    for (const c of candidates) {
        const text = String(c || '').trim();
        if (text) return text;
    }
    return '';
};

export default function StatusSelect({ awb, onBack, onComplete }) {
    const { lang } = useLanguage();
    const tr = (en, ro) => (lang === 'ro' ? ro : en);

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
    const [submitError, setSubmitError] = useState('');

    const [ndrReasons, setNdrReasons] = useState([]);
    const [reasonCode, setReasonCode] = useState('');
    const [reasonNote, setReasonNote] = useState('');
    const [rescheduleAt, setRescheduleAt] = useState('');
    const [refusalActions, setRefusalActions] = useState([]);
    const [flancoDestinations, setFlancoDestinations] = useState([]);
    const [refusalActionCode, setRefusalActionCode] = useState('');
    const [selectedFlancoDestinationId, setSelectedFlancoDestinationId] = useState('');
    const [showAllFlancoDestinations, setShowAllFlancoDestinations] = useState(false);
    const [customRecipientName, setCustomRecipientName] = useState('');
    const [customRecipientPhone, setCustomRecipientPhone] = useState('');
    const [customRecipientLocality, setCustomRecipientLocality] = useState('');
    const [customRecipientAddress, setCustomRecipientAddress] = useState('');

    const [gps, setGps] = useState(null); // { latitude, longitude, accuracy_m, timestamp }
    const [gpsBusy, setGpsBusy] = useState(false);
    const [gpsError, setGpsError] = useState('');

    const [photoDataUrl, setPhotoDataUrl] = useState('');
    const [photoBusy, setPhotoBusy] = useState(false);
    const [photoError, setPhotoError] = useState('');

    const [podPhotos, setPodPhotos] = useState({ box1: '', box2: '', box3: '', box4: '', unwrapped: '', packaging: '', extra: '' });
    const [podPhotosBusy, setPodPhotosBusy] = useState({ box1: false, box2: false, box3: false, box4: false, unwrapped: false, packaging: false, extra: false });
    const [podPhotosError, setPodPhotosError] = useState({ box1: '', box2: '', box3: '', box4: '', unwrapped: '', packaging: '', extra: '' });
    const [receiptPhotoDataUrl, setReceiptPhotoDataUrl] = useState('');
    const [receiptPhotoBusy, setReceiptPhotoBusy] = useState(false);
    const [receiptPhotoError, setReceiptPhotoError] = useState('');
    const [buyBackPhotoDataUrl, setBuyBackPhotoDataUrl] = useState('');
    const [buyBackPhotoBusy, setBuyBackPhotoBusy] = useState(false);
    const [buyBackPhotoError, setBuyBackPhotoError] = useState('');

    const [signatureDataUrl, setSignatureDataUrl] = useState('');

    const [codCollected, setCodCollected] = useState('');
    const [codMethod, setCodMethod] = useState('cash'); // cash | card | transfer | other
    const [codReference, setCodReference] = useState('');
    const [codWarningAccepted, setCodWarningAccepted] = useState(false);
    const [codWarningShown, setCodWarningShown] = useState(false);

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
    const isDeliveredEvent = String(selectedId) === '2';
    const isRefusalEvent = String(selectedId) === '3' || String(selectedId) === '4';
    const instructionText = shippingInstructionText(shipment);
    const isBuyBackShipment = normalizeFold(instructionText).includes(BUY_BACK_MARKER);
    const refusalActionOptions = (Array.isArray(refusalActions) && refusalActions.length > 0)
        ? refusalActions
        : REFUSAL_ACTIONS_FALLBACK;
    const selectedRefusalAction = refusalActionOptions.find((a) => String(a?.code || '').trim().toUpperCase() === String(refusalActionCode || '').trim().toUpperCase()) || null;
    const selectedFlancoDestination = (Array.isArray(flancoDestinations) ? flancoDestinations : []).find(
        (d) => String(d?.id || '').trim() === String(selectedFlancoDestinationId || '').trim()
    ) || null;
    const shipmentLocalityHint = String(
        shipment?.locality
        || shipment?.raw_data?.recipientLocation?.locality
        || shipment?.raw_data?.recipientLocation?.localityName
        || ''
    ).trim();
    const shipmentCountyHint = String(
        shipment?.county
        || shipment?.raw_data?.recipientLocation?.county
        || shipment?.raw_data?.recipientLocation?.countyName
        || ''
    ).trim();
    const foldedLocalityHint = normalizeFold(shipmentLocalityHint);
    const foldedCountyHint = normalizeFold(shipmentCountyHint);
    const flancoDestinationsWithScore = (Array.isArray(flancoDestinations) ? flancoDestinations : [])
        .map((dest) => {
            const foldedDestLocality = normalizeFold(dest?.locality);
            const foldedDestCounty = normalizeFold(dest?.county);
            let score = 0;
            if (foldedLocalityHint && foldedDestLocality && foldedLocalityHint === foldedDestLocality) score += 6;
            if (foldedCountyHint && foldedDestCounty && foldedCountyHint === foldedDestCounty) score += 4;
            return { ...(dest || {}), _score: score };
        })
        .sort((a, b) => {
            const scoreDiff = Number(b?._score || 0) - Number(a?._score || 0);
            if (scoreDiff !== 0) return scoreDiff;
            const countDiff = Number(b?.source_count || 0) - Number(a?.source_count || 0);
            if (countDiff !== 0) return countDiff;
            return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
    const matchingFlancoDestinations = flancoDestinationsWithScore.filter((dest) => Number(dest?._score || 0) > 0);
    const displayedFlancoDestinations = (
        !showAllFlancoDestinations && matchingFlancoDestinations.length > 0
    ) ? matchingFlancoDestinations : flancoDestinationsWithScore;

    const actionLabel = (code, fallback = '') => {
        const normalized = String(code || '').trim().toUpperCase();
        if (normalized === 'RETURN_TO_SENDER') return tr('Return to sender', 'Returneaza la expeditor');
        if (normalized === 'REDIRECT_TO_FLANCO') return tr('Redirect to Flanco store', 'Redirectioneaza catre magazin Flanco');
        if (normalized === 'REDIRECT_TO_NEW_RECIPIENT') return tr('Redirect to new recipient', 'Redirectioneaza catre destinatar nou');
        if (normalized === 'RESCHEDULE_DELIVERY') return tr('Reschedule delivery', 'Reprogrameaza livrarea');
        return String(fallback || code || '').trim();
    };

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
        setRefusalActionCode('');
        setSelectedFlancoDestinationId('');
        setShowAllFlancoDestinations(false);
        setCustomRecipientName('');
        setCustomRecipientPhone('');
        setCustomRecipientLocality('');
        setCustomRecipientAddress('');
        setRefusalActions([]);
        setFlancoDestinations([]);
        setGps(null);
        setGpsBusy(false);
        setGpsError('');
        setPhotoDataUrl('');
        setPhotoBusy(false);
        setPhotoError('');
        setPodPhotos({ box1: '', box2: '', box3: '', box4: '', unwrapped: '', packaging: '', extra: '' });
        setPodPhotosBusy({ box1: false, box2: false, box3: false, box4: false, unwrapped: false, packaging: false, extra: false });
        setPodPhotosError({ box1: '', box2: '', box3: '', box4: '', unwrapped: '', packaging: '', extra: '' });
        setReceiptPhotoDataUrl('');
        setReceiptPhotoBusy(false);
        setReceiptPhotoError('');
        setBuyBackPhotoDataUrl('');
        setBuyBackPhotoBusy(false);
        setBuyBackPhotoError('');
        setSignatureDataUrl('');
        setCodCollected('');
        setCodMethod('cash');
        setCodReference('');
        setCodWarningAccepted(false);
        setCodWarningShown(false);

        setLoading(true);
        setError('');
        setSubmitError('');
        getStatusOptions(token)
            .then((data) => {
                if (cancelled) return;
                setOptions(data);
            })
            .catch(() => {
                if (cancelled) return;
                setError(tr('Failed to load status options', 'Nu am putut incarca optiunile de status'));
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
                const actions = Array.isArray(res?.actions) ? res.actions : [];
                const destinations = Array.isArray(res?.flanco_destinations) ? res.flanco_destinations : [];
                setRefusalActions(actions);
                setFlancoDestinations(destinations);
            })
            .catch(() => {
                if (cancelled) return;
                setNdrReasons([]);
                setRefusalActions([]);
                setFlancoDestinations([]);
            });

        setDetailsLoading(true);
        setDetailsError('');
        setShipment(null);
        (async () => {
            const applyDetails = (data, cand) => {
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
            };

            let lastErr = null;

            // Fast path: query local backend DB/cache first (no forced Postis call).
            for (const cand of scan.candidates) {
                try {
                    const data = await getShipment(token, cand, { refresh: false });
                    if (cancelled) return;
                    applyDetails(data, cand);
                    return;
                } catch (e) {
                    lastErr = e;
                }
            }

            // Slow path only if not found locally: force a live Postis refresh.
            for (const cand of scan.candidates) {
                try {
                    const data = await getShipment(token, cand, { refresh: true });
                    if (cancelled) return;
                    applyDetails(data, cand);
                    return;
                } catch (e) {
                    lastErr = e;
                }
            }

            if (cancelled) return;
            const detail = lastErr?.response?.data?.detail;
            setDetailsError(detail ? String(detail) : tr('Failed to load shipment details', 'Nu am putut incarca detaliile coletului'));
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
            const coords = await getCurrentPositionRobust();
            const lat = Number(coords?.latitude);
            const lon = Number(coords?.longitude);
            const acc = Number(coords?.accuracy_m);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new Error(tr('Invalid GPS coordinates', 'Coordonate GPS invalide'));
            }
            setGps({
                latitude: lat,
                longitude: lon,
                accuracy_m: Number.isFinite(acc) ? acc : null,
                timestamp: String(coords?.timestamp || new Date().toISOString())
            });
        } catch (e) {
            const base = normalizeGeoErrorMessage(e);
            setGpsError(base ? String(base) : tr('Failed to detect GPS', 'Nu am putut detecta GPS-ul'));
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

    const onPickImage = async ({ file, setBusy, setErrorText, setDataUrl }) => {
        if (!file) return;
        setBusy(true);
        setErrorText('');
        try {
            const dataUrl = await compressImageToJpegDataUrl(file);
            setDataUrl(String(dataUrl || ''));
        } catch (e) {
            setErrorText(String(e?.message || 'Failed to process photo'));
        } finally {
        setBusy(false);
        }
    };

    const onPickPhoto = async (file) => onPickImage({
        setBusy: setPhotoBusy,
        setErrorText: setPhotoError,
        setDataUrl: setPhotoDataUrl,
        file
    });

    const onPickPodPhoto = async (key, file) => {
        onPickImage({
            setBusy: (v) => setPodPhotosBusy(p => ({ ...p, [key]: v })),
            setErrorText: (v) => setPodPhotosError(p => ({ ...p, [key]: v })),
            setDataUrl: (v) => setPodPhotos(p => ({ ...p, [key]: v })),
            file
        });
    };
    const onPickReceiptPhoto = async (file) => onPickImage({
        file,
        setBusy: setReceiptPhotoBusy,
        setErrorText: setReceiptPhotoError,
        setDataUrl: setReceiptPhotoDataUrl,
    });

    const onPickBuyBackPhoto = async (file) => onPickImage({
        file,
        setBusy: setBuyBackPhotoBusy,
        setErrorText: setBuyBackPhotoError,
        setDataUrl: setBuyBackPhotoDataUrl,
    });

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
            setDetailsError(detail ? String(detail) : tr('Failed to load shipment details', 'Nu am putut incarca detaliile coletului'));
        } finally {
            setDetailsLoading(false);
        }
    };

    useEffect(() => {
        if (!isDeliveredEvent || Number(expectedCod || 0) <= 0) {
            setCodWarningShown(false);
            setCodWarningAccepted(false);
            return;
        }
        if (codWarningShown) return;
        const msg = `Atentie, incaseaza ${money(expectedCod, shipment?.currency || 'RON')} ca ramburs!`;
        try {
            // Immediate warning before the driver confirms "Delivered".
            window.alert(msg);
        } catch { }
        setCodWarningShown(true);
    }, [codWarningShown, expectedCod, isDeliveredEvent, shipment?.currency]);

    useEffect(() => {
        if (!isRefusalEvent) return;
        if (String(refusalActionCode || '').trim()) return;
        const firstCode = String(refusalActionOptions?.[0]?.code || '').trim();
        if (firstCode) setRefusalActionCode(firstCode);
    }, [isRefusalEvent, refusalActionCode, refusalActionOptions]);

    useEffect(() => {
        const code = String(refusalActionCode || '').trim().toUpperCase();
        if (code !== 'REDIRECT_TO_FLANCO') {
            setSelectedFlancoDestinationId('');
            setShowAllFlancoDestinations(false);
        }
        if (code !== 'REDIRECT_TO_NEW_RECIPIENT') {
            setCustomRecipientName('');
            setCustomRecipientPhone('');
            setCustomRecipientLocality('');
            setCustomRecipientAddress('');
        }
    }, [refusalActionCode]);

    useEffect(() => {
        if (isRefusalEvent) return;
        setRefusalActionCode('');
        setSelectedFlancoDestinationId('');
        setShowAllFlancoDestinations(false);
        setCustomRecipientName('');
        setCustomRecipientPhone('');
        setCustomRecipientLocality('');
        setCustomRecipientAddress('');
    }, [isRefusalEvent]);

    useEffect(() => {
        const code = String(refusalActionCode || '').trim().toUpperCase();
        if (code !== 'REDIRECT_TO_FLANCO') return;
        if (String(selectedFlancoDestinationId || '').trim()) return;
        const firstBest = displayedFlancoDestinations?.[0];
        const candidateId = String(firstBest?.id || '').trim();
        if (candidateId) {
            setSelectedFlancoDestinationId(candidateId);
        }
    }, [refusalActionCode, selectedFlancoDestinationId, displayedFlancoDestinations]);

    useEffect(() => {
        const code = String(refusalActionCode || '').trim().toUpperCase();
        if (code !== 'REDIRECT_TO_FLANCO') return;
        const selectedId = String(selectedFlancoDestinationId || '').trim();
        if (!selectedId) return;
        const stillVisible = displayedFlancoDestinations.some((dest) => String(dest?.id || '').trim() === selectedId);
        if (!stillVisible && !showAllFlancoDestinations && matchingFlancoDestinations.length > 0) {
            setShowAllFlancoDestinations(true);
        }
    }, [
        refusalActionCode,
        selectedFlancoDestinationId,
        displayedFlancoDestinations,
        showAllFlancoDestinations,
        matchingFlancoDestinations,
    ]);

    const money = (amount, currency = 'RON') => {
        if (amount === null || amount === undefined || amount === '') return '--';
        const n = Number(amount);
        if (!Number.isFinite(n)) return '--';
        return `${n.toFixed(2)} ${String(currency || 'RON').toUpperCase()}`;
    };

    const buildNewRecipientPayload = () => {
        const action = String(refusalActionCode || '').trim().toUpperCase();
        if (action === 'REDIRECT_TO_FLANCO') {
            if (!selectedFlancoDestination) return null;
            return {
                type: 'flanco_store',
                id: String(selectedFlancoDestination.id || '').trim() || null,
                location_id: String(selectedFlancoDestination.location_id || '').trim() || null,
                name: String(selectedFlancoDestination.name || selectedFlancoDestination.shop_name || '').trim() || null,
                phone: String(selectedFlancoDestination.phone || '').trim() || null,
                locality: String(selectedFlancoDestination.locality || '').trim() || null,
                county: String(selectedFlancoDestination.county || '').trim() || null,
                address: String(selectedFlancoDestination.address || '').trim() || null,
                source: 'flanco_sender_shop',
            };
        }
        if (action === 'REDIRECT_TO_NEW_RECIPIENT') {
            const name = String(customRecipientName || '').trim();
            const phone = String(customRecipientPhone || '').trim();
            const locality = String(customRecipientLocality || '').trim();
            const address = String(customRecipientAddress || '').trim();
            if (!name || (!locality && !address)) return null;
            return {
                type: 'custom_recipient',
                id: null,
                location_id: null,
                name,
                phone: phone || null,
                locality: locality || null,
                county: null,
                address: address || null,
                source: 'manual',
            };
        }
        return null;
    };

    const buildPayloadOut = (identifier) => {
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

        if (gps) {
            payloadOut.gps = {
                latitude: Number(gps.latitude),
                longitude: Number(gps.longitude),
                accuracy_m: gps.accuracy_m ?? null,
                timestamp: gps.timestamp || new Date().toISOString(),
            };
        }

        if (photoDataUrl || signatureDataUrl || Object.values(podPhotos).some(Boolean)) {
            payloadOut.pod = {
                photo: photoDataUrl ? { data_url: String(photoDataUrl), mime: 'image/jpeg' } : null,
                signature: signatureDataUrl ? { data_url: String(signatureDataUrl), mime: 'image/png' } : null,
                photos: {
                    box1: podPhotos.box1 ? { data_url: String(podPhotos.box1), mime: 'image/jpeg' } : null,
                    box2: podPhotos.box2 ? { data_url: String(podPhotos.box2), mime: 'image/jpeg' } : null,
                    box3: podPhotos.box3 ? { data_url: String(podPhotos.box3), mime: 'image/jpeg' } : null,
                    box4: podPhotos.box4 ? { data_url: String(podPhotos.box4), mime: 'image/jpeg' } : null,
                    unwrapped: podPhotos.unwrapped ? { data_url: String(podPhotos.unwrapped), mime: 'image/jpeg' } : null,
                    packaging: podPhotos.packaging ? { data_url: String(podPhotos.packaging), mime: 'image/jpeg' } : null,
                    extra: podPhotos.extra ? { data_url: String(podPhotos.extra), mime: 'image/jpeg' } : null,
                },
            };
        }

        const activeRefusalActionCode = isRefusalEvent
            ? (refusalActionCode ? String(refusalActionCode).trim().toUpperCase() : null)
            : null;
        const newRecipient = isRefusalEvent ? buildNewRecipientPayload() : null;
        if (reasonCode || reasonNote || rescheduleAt || activeRefusalActionCode || newRecipient) {
            payloadOut.ndr = {
                reason_code: reasonCode ? String(reasonCode).trim() : null,
                note: reasonNote ? String(reasonNote).trim() : null,
                reschedule_at: rescheduleAt ? String(rescheduleAt).trim() : null,
                action_code: activeRefusalActionCode,
                action_label: activeRefusalActionCode && selectedRefusalAction
                    ? actionLabel(selectedRefusalAction.code, selectedRefusalAction.label)
                    : null,
                new_recipient: newRecipient,
            };
        }

        if (codCollected !== '' || codMethod || codReference) {
            const n = Number(codCollected);
            payloadOut.cod = {
                amount_collected: Number.isFinite(n) ? n : null,
                expected_amount: Number.isFinite(Number(expectedCod)) ? Number(expectedCod) : null,
                method: String(codMethod || '').trim() || null,
                reference: String(codReference || '').trim() || null,
                receipt_photo: receiptPhotoDataUrl ? { data_url: String(receiptPhotoDataUrl), mime: 'image/jpeg' } : null,
            };
        }

        if (isBuyBackShipment || buyBackPhotoDataUrl) {
            payloadOut.buy_back = {
                required: Boolean(isBuyBackShipment),
                marker: 'Retur deseu la GreenWee Buzau',
                instruction: instructionText || null,
                photo: buyBackPhotoDataUrl ? { data_url: String(buyBackPhotoDataUrl), mime: 'image/jpeg' } : null,
            };
        }

        return payloadOut;
    };

    const submitValidationError = (() => {
        if (!selectedId) return tr('Select a status first.', 'Selecteaza mai intai un status.');
        // Basic: require shipment details if we need any proof fields tied to it.
        const reqs = Array.isArray(requirements) ? requirements : [];

        const needsGps = reqs.includes('gps');
        const needsPhoto = reqs.includes('photo');
        const needsSignature = reqs.includes('signature') || String(selectedId) === '2';
        const needsReason = reqs.includes('reason');
        const needsRescheduleAt = reqs.includes('reschedule_at');
        const needsCodCollect = reqs.includes('cod_collect') && expectedCod > 0;
        const needsCodTransfer = reqs.includes('cod_transfer');
        const needsReceiptPhoto = isDeliveredEvent && expectedCod > 0;
        const needsBuyBackPhoto = isDeliveredEvent && isBuyBackShipment;

        if (needsGps && (!gps || !Number.isFinite(Number(gps?.latitude)) || !Number.isFinite(Number(gps?.longitude)))) {
            return tr('GPS is required for this status.', 'GPS-ul este obligatoriu pentru acest status.');
        }
        if (isDeliveredEvent) {
            if (!podPhotos.box1 || !podPhotos.box2 || !podPhotos.box3 || !podPhotos.box4) {
                return tr('Sunt obligatorii cele 4 poze cu ambalajul (toate 4 laturile) înainte de desfacere.', 'Sunt obligatorii cele 4 poze cu ambalajul (toate 4 laturile) înainte de desfacere.');
            }
        } else if (needsPhoto && !String(photoDataUrl || '').startsWith('data:image/')) {
            return tr('A photo is required for this status.', 'O fotografie este obligatorie pentru acest status.');
        }
        if (needsReceiptPhoto && !codWarningAccepted) {
            return tr('Confirm COD collection warning before Delivered.', 'Confirma avertizarea COD inainte de Livrat.');
        }
        if (needsReceiptPhoto && !String(receiptPhotoDataUrl || '').startsWith('data:image/')) {
            return tr('Receipt photo is required for COD delivery.', 'Fotografia chitantei este obligatorie pentru livrarea cu ramburs.');
        }
        if (needsBuyBackPhoto && !String(buyBackPhotoDataUrl || '').startsWith('data:image/')) {
            return tr('Buy-back product photo is required.', 'Fotografia produsului buy-back este obligatorie.');
        }
        if (needsSignature && !String(signatureDataUrl || '').startsWith('data:image/')) {
            return tr('Customer signature is required for delivered status.', 'Semnatura clientului este obligatorie pentru statusul Livrat.');
        }

        if (needsReason) {
            const code = String(reasonCode || '').trim();
            if (!code) return tr('Select a reason.', 'Selecteaza un motiv.');
            if (code.toUpperCase() === 'OTHER' && !String(reasonNote || '').trim()) {
                return tr('Add a note for reason Other.', 'Adauga o nota pentru motivul Altele.');
            }
        }
        if (isRefusalEvent) {
            const action = String(refusalActionCode || '').trim().toUpperCase();
            if (!action) return tr('Select an action for refused shipment.', 'Selecteaza o actiune pentru coletul refuzat.');
            if (action === 'REDIRECT_TO_FLANCO' && !selectedFlancoDestination) {
                return tr('Select a Flanco destination.', 'Selecteaza destinatia Flanco.');
            }
            if (action === 'REDIRECT_TO_NEW_RECIPIENT') {
                const name = String(customRecipientName || '').trim();
                const locality = String(customRecipientLocality || '').trim();
                const address = String(customRecipientAddress || '').trim();
                if (!name) return tr('New recipient name is required.', 'Numele noului destinatar este obligatoriu.');
                if (!locality && !address) {
                    return tr('Add at least locality or address for new recipient.', 'Adauga cel putin localitatea sau adresa pentru noul destinatar.');
                }
            }
        }
        if (needsRescheduleAt && !String(rescheduleAt || '').trim()) {
            return tr('Reschedule date/time is required.', 'Data/ora de reprogramare este obligatorie.');
        }

        if (needsCodCollect) {
            const n = Number(codCollected);
            if (!Number.isFinite(n) || n < 0) return tr('Collected COD amount is invalid.', 'Suma COD colectata este invalida.');
        }
        if (needsCodTransfer) {
            const n = Number(codCollected);
            if (!Number.isFinite(n) || n <= 0) return tr('Transferred COD amount is invalid.', 'Suma COD transferata este invalida.');
        }

        return '';
    })();

    const canSubmit = !submitValidationError;

    const handleSubmit = async () => {
        if (!selectedId) {
            return;
        }
        setSubmitError('');
        if (submitValidationError) {
            setSubmitError(submitValidationError);
            return;
        }

        setSubmitting(true);

        try {
            const token = localStorage.getItem('token');
            const identifier = actionAwb || normalizeShipmentIdentifier(awb);
            const payloadOut = buildPayloadOut(identifier);
            const payload = Object.keys(payloadOut).length ? payloadOut : undefined;
            await updateAwb(token, {
                awb: identifier,
                event_id: selectedId,
                timestamp: new Date().toISOString(),
                payload
            });
            onComplete('SUCCESS', { awb: identifier, event_id: selectedId, parcel_index: payloadOut.parcel_index, parcels_total: payloadOut.parcels_total, payload: payloadOut });
        } catch (e) {
            const statusCode = Number(e?.response?.status || 0);
            if (statusCode >= 400 && statusCode < 500) {
                const detail = String(e?.response?.data?.detail || '').trim();
                setSubmitError(detail || tr('Cannot submit this status update. Check required fields.', 'Nu putem trimite acest status. Verifica campurile obligatorii.'));
                return;
            }
            const identifier = actionAwb || normalizeShipmentIdentifier(awb);
            const payloadOut = buildPayloadOut(identifier);
            const payload = Object.keys(payloadOut).length ? payloadOut : undefined;
            try {
                await queueItem(identifier, selectedId, payload || {});
                onComplete('QUEUED', { awb: identifier, event_id: selectedId, parcel_index: payloadOut.parcel_index, parcels_total: payloadOut.parcels_total, payload: payloadOut });
            } catch {
                setSubmitError(tr('Failed to queue update offline. Please retry.', 'Nu am putut salva update-ul offline. Reincearca.'));
            }
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
                                {tr('Parcel', 'Colet')} {parcelIndex}{Number.isFinite(parcelsTotal) && parcelsTotal > 0 ? `/${parcelsTotal}` : ''}
                            </span>
                        ) : null}
                    </p>
                    {scanNormalized && actionAwb && scanNormalized !== actionAwb ? (
                        <p className="text-[10px] text-gray-500 dark:text-gray-400 font-mono mt-1">
                            {tr('Scanned', 'Scanat')}: {scanNormalized}
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
                                {detailsLoading ? tr('Loading details...', 'Se incarca detalii...') : (shipment?.recipient_name || '--')}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={refreshDetails}
                            disabled={detailsLoading}
                            className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-50"
                            title={tr('Refresh shipment details', 'Reincarca detalii colet')}
                            aria-label={tr('Refresh shipment details', 'Reincarca detalii colet')}
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
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Phone', 'Telefon')}</p>
                                <p className="text-sm font-mono text-gray-900 dark:text-white truncate">
                                    {shipment.recipient_phone || '--'}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Content', 'Continut')}</p>
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
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Parcels', 'Colete')}</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-white">
                                    {Number.isFinite(Number(shipment.number_of_parcels)) ? Number(shipment.number_of_parcels) : (shipment?.raw_data?.numberOfDistinctBarcodes || shipment?.raw_data?.numberOfParcels || 1)}
                                </p>
                            </div>
                            {Number.isInteger(parcelIndex) && parcelIndex > 0 ? (
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Parcel', 'Colet')}</p>
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
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Requirements', 'Cerinte')}</p>
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
                                            {gps ? `${Number(gps.latitude).toFixed(6)}, ${Number(gps.longitude).toFixed(6)}${gps.accuracy_m ? ` (±${Math.round(Number(gps.accuracy_m))}m)` : ''}` : tr('Not captured', 'Necapturat')}
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
                                        {gpsBusy ? tr('Getting…', 'Se obtine…') : tr('Get GPS', 'Obtine GPS')}
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {isDeliveredEvent ? (
                            <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
                                <div>
                                    <p className="text-[11px] uppercase tracking-wider font-bold text-red-600 dark:text-red-400 mb-2">
                                        {tr('Mandatory: 4 Package Photos (Before Unwrapping)', 'Obligatoriu: 4 Poze Ambalaj (Înainte de desfacere)')}
                                    </p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {[
                                            { key: 'box1', label: 'Fața 1' },
                                            { key: 'box2', label: 'Fața 2' },
                                            { key: 'box3', label: 'Fața 3' },
                                            { key: 'box4', label: 'Fața 4' },
                                        ].map(slot => (
                                            <div key={slot.key} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800/50 aspect-square flex flex-col items-center justify-center">
                                                {podPhotos[slot.key] ? (
                                                    <img src={podPhotos[slot.key]} alt={slot.label} className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="text-center p-2 opacity-50">
                                                        <Camera className="w-5 h-5 mx-auto mb-1" />
                                                        <span className="text-[9px] font-bold uppercase">{slot.label}</span>
                                                    </div>
                                                )}
                                                <input
                                                    type="file" accept="image/*" capture="environment"
                                                    onChange={(e) => onPickPodPhoto(slot.key, e.target.files && e.target.files[0])}
                                                    disabled={podPhotosBusy[slot.key]}
                                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                                />
                                                {podPhotosBusy[slot.key] && (
                                                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                                                        <Loader2 className="animate-spin text-white w-5 h-5" />
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-[11px] uppercase tracking-wider font-bold text-blue-600 dark:text-blue-400 mb-2">
                                        {tr('Optional: After Unwrapping', 'Opțional: După dezambalare')}
                                    </p>
                                    <div className="grid grid-cols-3 gap-2">
                                        {[
                                            { key: 'unwrapped', label: 'Produs', icon: <Package className="w-4 h-4" /> },
                                            { key: 'packaging', label: 'Ambalaje', icon: <Box className="w-4 h-4" /> },
                                            { key: 'extra', label: 'Extra', icon: <Plus className="w-4 h-4" /> },
                                        ].map(slot => (
                                            <div key={slot.key} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800/50 aspect-square flex flex-col items-center justify-center">
                                                {podPhotos[slot.key] ? (
                                                    <img src={podPhotos[slot.key]} alt={slot.label} className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="text-center p-1 opacity-50">
                                                        <div className="flex justify-center mb-1">{slot.icon}</div>
                                                        <span className="text-[8px] font-bold uppercase leading-none">{slot.label}</span>
                                                    </div>
                                                )}
                                                <input
                                                    type="file" accept="image/*" capture="environment"
                                                    onChange={(e) => onPickPodPhoto(slot.key, e.target.files && e.target.files[0])}
                                                    disabled={podPhotosBusy[slot.key]}
                                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                                />
                                                {podPhotosBusy[slot.key] && (
                                                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                                                        <Loader2 className="animate-spin text-white w-4 h-4" />
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                {Object.values(podPhotosError).some(Boolean) ? (
                                    <p className="text-[10px] text-red-600 font-bold">Unul sau mai multe upload-uri au eșuat. Vă rugăm reîncercați.</p>
                                ) : null}
                            </div>
                        ) : requirements.includes('photo') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Photo', 'Foto')}</p>
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
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Signature', 'Semnatura')}</p>
                                <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden bg-gray-50 dark:bg-gray-900/30">
                                    <SignaturePad value={signatureDataUrl} onChange={setSignatureDataUrl} />
                                </div>
                                {!String(signatureDataUrl || '').startsWith('data:image/') ? (
                                    <p className="text-[10px] font-bold text-red-600">
                                        {tr('Customer signature is mandatory before Delivered confirmation.', 'Semnatura clientului este obligatorie inainte de confirmarea Livrat.')}
                                    </p>
                                ) : null}
                            </div>
                        ) : null}

                        {isDeliveredEvent && expectedCod > 0 ? (
                            <div className="space-y-2 p-3 rounded-xl border border-amber-300/40 bg-amber-100/70 dark:bg-amber-900/20">
                                <p className="text-xs font-black text-amber-800 dark:text-amber-200">
                                    {`Atentie, incaseaza ${money(expectedCod, shipment?.currency || 'RON')} ca ramburs!`}
                                </p>
                                <label className="flex items-center gap-2 text-[11px] font-bold text-amber-900 dark:text-amber-100 select-none">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(codWarningAccepted)}
                                        onChange={(e) => setCodWarningAccepted(e.target.checked)}
                                    />
                                    {tr('I confirmed COD collection.', 'Am confirmat incasarea rambursului.')}
                                </label>
                            </div>
                        ) : null}

                        {isDeliveredEvent && expectedCod > 0 ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">
                                    {tr('Receipt photo', 'Poza chitanta')}
                                </p>
                                <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={(e) => onPickReceiptPhoto(e.target.files && e.target.files[0])}
                                    disabled={receiptPhotoBusy}
                                />
                                {receiptPhotoError ? <p className="text-[10px] text-red-600 font-bold">{receiptPhotoError}</p> : null}
                                {receiptPhotoDataUrl ? (
                                    <img src={receiptPhotoDataUrl} alt="Receipt" className="w-full rounded-xl border border-gray-200 dark:border-gray-700" />
                                ) : null}
                            </div>
                        ) : null}

                        {isDeliveredEvent && isBuyBackShipment ? (
                            <div className="space-y-2 p-3 rounded-xl border border-emerald-300/40 bg-emerald-100/70 dark:bg-emerald-900/20">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-900 dark:text-emerald-100">
                                    {tr('Buy-back required', 'Buy-back obligatoriu')}
                                </p>
                                <p className="text-xs font-bold text-emerald-900 dark:text-emerald-100">
                                    {instructionText || 'Retur deseu la GreenWee Buzau'}
                                </p>
                                <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={(e) => onPickBuyBackPhoto(e.target.files && e.target.files[0])}
                                    disabled={buyBackPhotoBusy}
                                />
                                {buyBackPhotoError ? <p className="text-[10px] text-red-600 font-bold">{buyBackPhotoError}</p> : null}
                                {buyBackPhotoDataUrl ? (
                                    <img src={buyBackPhotoDataUrl} alt="Buy-back" className="w-full rounded-xl border border-gray-200 dark:border-gray-700" />
                                ) : null}
                            </div>
                        ) : null}

                        {requirements.includes('reason') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Reason', 'Motiv')}</p>
                                <select
                                    value={reasonCode}
                                    onChange={(e) => setReasonCode(e.target.value)}
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                >
                                    <option value="">{tr('Select…', 'Selecteaza…')}</option>
                                    {(Array.isArray(ndrReasons) ? ndrReasons : []).map((r) => (
                                        <option key={r.code} value={r.code}>{r.label}</option>
                                    ))}
                                </select>
                                <textarea
                                    value={reasonNote}
                                    onChange={(e) => setReasonNote(e.target.value)}
                                    rows={2}
                                    placeholder={tr('Note (optional)', 'Nota (optional)')}
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                />
                            </div>
                        ) : null}

                        {isRefusalEvent ? (
                            <div className="space-y-2 p-3 rounded-xl border border-violet-300/40 bg-violet-100/70 dark:bg-violet-900/20">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-violet-900 dark:text-violet-100">
                                    {tr('Refusal action', 'Actiune dupa refuz')}
                                </p>
                                <select
                                    value={refusalActionCode}
                                    onChange={(e) => setRefusalActionCode(e.target.value)}
                                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                >
                                    <option value="">{tr('Select action…', 'Selecteaza actiunea…')}</option>
                                    {refusalActionOptions.map((opt) => (
                                        <option key={opt.code} value={opt.code}>
                                            {actionLabel(opt.code, opt.label)}
                                        </option>
                                    ))}
                                </select>

                                {String(refusalActionCode || '').trim().toUpperCase() === 'REDIRECT_TO_FLANCO' ? (
                                    <div className="space-y-2">
                                        <p className="text-[10px] uppercase tracking-wider font-bold text-violet-900 dark:text-violet-100">
                                            {tr('New recipient (Flanco)', 'Destinatar nou (Flanco)')}
                                        </p>
                                        {matchingFlancoDestinations.length > 0 ? (
                                            <p className="text-[11px] font-bold text-violet-900 dark:text-violet-100">
                                                {tr(
                                                    `Filtered by shipment area (${shipmentLocalityHint || '--'}, ${shipmentCountyHint || '--'}): ${matchingFlancoDestinations.length} matches.`,
                                                    `Filtrat dupa zona coletului (${shipmentLocalityHint || '--'}, ${shipmentCountyHint || '--'}): ${matchingFlancoDestinations.length} potriviri.`
                                                )}
                                            </p>
                                        ) : (
                                            <p className="text-[11px] font-bold text-violet-900 dark:text-violet-100">
                                                {tr('No local match found. Showing all Flanco destinations.', 'Nu exista potrivire locala. Afisez toate destinatiile Flanco.')}
                                            </p>
                                        )}
                                        <select
                                            value={selectedFlancoDestinationId}
                                            onChange={(e) => setSelectedFlancoDestinationId(e.target.value)}
                                            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                        >
                                            <option value="">{tr('Select Flanco destination…', 'Selecteaza destinatia Flanco…')}</option>
                                            {(Array.isArray(displayedFlancoDestinations) ? displayedFlancoDestinations : []).map((dest) => {
                                                const line2 = [dest.locality, dest.county].filter(Boolean).join(', ');
                                                return (
                                                    <option key={dest.id} value={dest.id}>
                                                        {line2 ? `${dest.name} - ${line2}` : dest.name}
                                                    </option>
                                                );
                                            })}
                                        </select>
                                        {matchingFlancoDestinations.length > 0 && flancoDestinationsWithScore.length > matchingFlancoDestinations.length ? (
                                            <button
                                                type="button"
                                                onClick={() => setShowAllFlancoDestinations((prev) => !prev)}
                                                className="px-3 py-2 rounded-xl border border-violet-300/40 bg-white/70 dark:bg-gray-900/40 text-[11px] font-black uppercase tracking-wider text-violet-900 dark:text-violet-100"
                                            >
                                                {showAllFlancoDestinations
                                                    ? tr('Show only local matches', 'Arata doar potrivirile locale')
                                                    : tr('Show all Flanco stores', 'Arata toate magazinele Flanco')}
                                            </button>
                                        ) : null}
                                        {selectedFlancoDestination ? (
                                            <p className="text-[11px] text-violet-900 dark:text-violet-100 font-bold">
                                                {[
                                                    selectedFlancoDestination.address,
                                                    selectedFlancoDestination.locality,
                                                    selectedFlancoDestination.county,
                                                ].filter(Boolean).join(', ') || '--'}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}

                                {String(refusalActionCode || '').trim().toUpperCase() === 'REDIRECT_TO_NEW_RECIPIENT' ? (
                                    <div className="space-y-2">
                                        <p className="text-[10px] uppercase tracking-wider font-bold text-violet-900 dark:text-violet-100">
                                            {tr('New recipient details', 'Detalii destinatar nou')}
                                        </p>
                                        <input
                                            value={customRecipientName}
                                            onChange={(e) => setCustomRecipientName(e.target.value)}
                                            placeholder={tr('Recipient name', 'Nume destinatar')}
                                            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                        />
                                        <input
                                            value={customRecipientPhone}
                                            onChange={(e) => setCustomRecipientPhone(e.target.value)}
                                            placeholder={tr('Phone (optional)', 'Telefon (optional)')}
                                            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                        />
                                        <input
                                            value={customRecipientLocality}
                                            onChange={(e) => setCustomRecipientLocality(e.target.value)}
                                            placeholder={tr('Locality', 'Localitate')}
                                            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                        />
                                        <textarea
                                            value={customRecipientAddress}
                                            onChange={(e) => setCustomRecipientAddress(e.target.value)}
                                            rows={2}
                                            placeholder={tr('Address', 'Adresa')}
                                            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm"
                                        />
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        {requirements.includes('reschedule_at') ? (
                            <div className="space-y-2">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">{tr('Reschedule', 'Reprogramare')}</p>
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
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider">{tr('Expected', 'Asteptat')}</p>
                                        <p className="text-sm font-bold text-gray-900 dark:text-white">{money(expectedCod, shipment?.currency || 'RON')}</p>
                                    </div>
                                    <input
                                        value={codCollected}
                                        onChange={(e) => setCodCollected(e.target.value)}
                                        inputMode="decimal"
                                        placeholder={tr('Collected amount', 'Suma colectata')}
                                        className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                    />
                                    <select
                                        value={codMethod}
                                        onChange={(e) => setCodMethod(e.target.value)}
                                        className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/30 text-sm font-bold text-gray-900 dark:text-white"
                                    >
                                        <option value="cash">{tr('Cash', 'Cash')}</option>
                                        <option value="card">{tr('Card', 'Card')}</option>
                                        <option value="transfer">{tr('Transfer', 'Transfer')}</option>
                                        <option value="other">{tr('Other', 'Altul')}</option>
                                    </select>
                                    <input
                                        value={codReference}
                                        onChange={(e) => setCodReference(e.target.value)}
                                        placeholder={tr('Reference (optional)', 'Referinta (optional)')}
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
                            onClick={() => {
                                setSelectedId(opt.event_id);
                                setSubmitError('');
                            }}
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
                {submitError ? (
                    <div className="mb-3 p-3 bg-red-100 text-red-700 rounded-xl text-xs font-bold">
                        {submitError}
                    </div>
                ) : null}
                <button
                    disabled={!canSubmit || submitting}
                    onClick={handleSubmit}
                    className="w-full py-4 bg-primary-600 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2"
                >
                    {submitting ? <Loader2 className="animate-spin" /> : tr('Confirm Status Update', 'Confirma Actualizarea Statusului')}
                </button>
            </div>
        </div>
    );
}

function SignaturePad({ value, onChange }) {
    const { lang } = useLanguage();
    const canvasRef = React.useRef(null);
    const drawingRef = React.useRef({ active: false, lastX: 0, lastY: 0, drew: false });

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
        drawingRef.current = { active: true, lastX: p.x, lastY: p.y, drew: false };
        try {
            e.currentTarget?.setPointerCapture?.(e.pointerId);
        } catch { }
    };

    const move = (e) => {
        if (!drawingRef.current.active) return;
        const p = pointerPos(e);
        if (!p) return;
        drawingRef.current.drew = true;
        draw(p.x, p.y);
    };

    const end = (e) => {
        if (!drawingRef.current.active) return;
        try {
            e?.currentTarget?.releasePointerCapture?.(e?.pointerId);
        } catch { }
        const drew = !!drawingRef.current.drew;
        drawingRef.current.active = false;
        const canvas = canvasRef.current;
        if (!canvas || !drew) return;
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
                className="w-full bg-white rounded-lg touch-none"
                style={{ touchAction: 'none' }}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onPointerLeave={end}
            />
            <div className="flex items-center justify-between">
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">{lang === 'ro' ? 'Semneaza mai sus' : 'Sign above'}</p>
                <button type="button" onClick={clear} className="text-xs font-bold text-gray-600">
                    {lang === 'ro' ? 'Sterge' : 'Clear'}
                </button>
            </div>
        </div>
    );
}
