import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, Zap } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { normalizeShipmentIdentifier } from '../services/awbScan';

const CONTINUOUS_CONFIRM_DELAY_MS = 1200;
const CONTINUOUS_ARM_GRACE_MS = 1600;
const CONTINUOUS_STABLE_WINDOW_MS = 450;
const MIN_BARCODE_SCAN_LENGTH = 8;
const DUPLICATE_SCAN_SUPPRESS_MS = 20000;

const uniqueNumericFormats = (values) => {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const n = Number(value);
        if (!Number.isInteger(n) || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
};

const BARCODE_FORMATS = uniqueNumericFormats([
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
]);

const QR_FORMATS = uniqueNumericFormats([Html5QrcodeSupportedFormats.QR_CODE]);

const ALL_FORMATS = uniqueNumericFormats([
    Html5QrcodeSupportedFormats.QR_CODE,
    ...BARCODE_FORMATS,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
    Html5QrcodeSupportedFormats.AZTEC,
    Html5QrcodeSupportedFormats.PDF_417,
]);

const SCAN_PROFILE_FORMATS = {
    all: ALL_FORMATS,
    barcode: BARCODE_FORMATS,
    qr: QR_FORMATS,
};

const toDisplayAwb = (value) => {
    const normalized = normalizeShipmentIdentifier(value);
    if (normalized) return normalized;
    return String(value || '').trim().toUpperCase();
};

const NATIVE_FORMATS = {
    all: ['qr_code', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'data_matrix', 'aztec', 'pdf417'],
    barcode: ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e'],
    qr: ['qr_code'],
};

const supportsBarcodeDetector = () => typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function';

const playSuccessBeep = () => {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx = new AudioContextClass();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        // Create an upbeat "success" double-chirp or ramping beep
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, ctx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
        
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
        gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
        
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.2);
    } catch (e) {
        // Ignore errors (e.g. audio not allowed without user interaction)
    }
};

export default function Scanner({ onScan, onClose, continuous = false, scanFeedback = null }) {
    const { t } = useLanguage();
    const [manualAwb, setManualAwb] = useState('');
    const [mode, setMode] = useState('camera'); // camera | manual
    const [profile, setProfile] = useState('barcode'); // barcode | qr
    const [enginePreference, setEnginePreference] = useState('auto'); // auto | compat
    const [engine, setEngine] = useState('idle'); // idle | native | html5
    const [scanError, setScanError] = useState('');
    const [awaitingNextScan, setAwaitingNextScan] = useState(Boolean(continuous));
    const [nextScanReady, setNextScanReady] = useState(!continuous);
    const [pauseReason, setPauseReason] = useState(continuous ? 'initial' : null);
    const [localFeedback, setLocalFeedback] = useState(null);
    const [confirmedScan, setConfirmedScan] = useState(null);

    useEffect(() => {
        if (scanFeedback) {
            const feedbackAwb = toDisplayAwb(scanFeedback?.awb || '');
            if (continuous && feedbackAwb) {
                const feedbackText = String(scanFeedback?.text || '').trim();
                const savedText = /confirmat|confirmed|salvat|saved|descarcat|unloaded/i.test(feedbackText);
                setLastScannedAwb(feedbackAwb);
                setConfirmedScan({
                    awb: feedbackAwb,
                    status: scanFeedback?.type === 'error' ? 'error' : (savedText ? 'saved' : 'saving'),
                    text: feedbackText,
                });
                setPauseReason('after-scan');
                setAwaitingNextScan(true);
                awaitingNextScanRef.current = true;
            }
            setLocalFeedback(scanFeedback);
        }
    }, [scanFeedback, continuous]);
    const [lastScannedAwb, setLastScannedAwb] = useState('');
    const [torchOn, setTorchOn] = useState(false);

    const readerIdRef = useRef(`reader-${Math.random().toString(36).slice(2, 9)}`);
    const scanLockedRef = useRef(false);
    const html5Ref = useRef(null);
    const nativeStreamRef = useRef(null);
    const nativeVideoRef = useRef(null);
    const nativeCanvasRef = useRef(null);
    const rafRef = useRef(null);
    const detectBusyRef = useRef(false);
    const detectStableRef = useRef({ key: '', raw: '', count: 0, ts: 0, firstTs: 0 });
    const awaitingNextScanRef = useRef(Boolean(continuous));
    const nextScanTimerRef = useRef(null);
    const ignoreDetectionsUntilRef = useRef(continuous ? Date.now() + CONTINUOUS_ARM_GRACE_MS : 0);
    const lastAcceptedScanRef = useRef({ key: '', ts: 0 });

    useEffect(() => {
        awaitingNextScanRef.current = awaitingNextScan;
    }, [awaitingNextScan]);

    const clearNextScanTimer = useCallback(() => {
        if (nextScanTimerRef.current) {
            clearTimeout(nextScanTimerRef.current);
            nextScanTimerRef.current = null;
        }
    }, []);

    const handleNextScan = useCallback(() => {
        clearNextScanTimer();
        setAwaitingNextScan(false);
        awaitingNextScanRef.current = false;
        setPauseReason(null);
        setNextScanReady(true);
        setScanError('');
        setLocalFeedback(null);
        setConfirmedScan(null);
        ignoreDetectionsUntilRef.current = Date.now() + CONTINUOUS_ARM_GRACE_MS;
        detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };
        setTimeout(() => {
            scanLockedRef.current = false;
        }, CONTINUOUS_ARM_GRACE_MS);
    }, [clearNextScanTimer]);

    const stopAll = useCallback(async () => {
        clearNextScanTimer();
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        if (nativeStreamRef.current) {
            for (const track of nativeStreamRef.current.getTracks()) {
                try {
                    track.stop();
                } catch {
                    // no-op
                }
            }
            nativeStreamRef.current = null;
        }

        if (nativeVideoRef.current) {
            try {
                nativeVideoRef.current.pause();
                nativeVideoRef.current.srcObject = null;
            } catch {
                // no-op
            }
        }

        if (html5Ref.current) {
            const inst = html5Ref.current;
            html5Ref.current = null;
            try {
                await inst.stop();
            } catch {
                // no-op
            }
            try {
                await inst.clear();
            } catch {
                // no-op
            }
        }
    }, [clearNextScanTimer]);

    const emitScan = useCallback((rawValue) => {
        if (scanLockedRef.current) return;
        const cleaned = String(rawValue || '').trim();
        if (!cleaned) return;
        const displayAwb = toDisplayAwb(cleaned);
        if (!displayAwb) return;
        scanLockedRef.current = true;
        lastAcceptedScanRef.current = {
            key: displayAwb.replace(/[^A-Z0-9]/g, ''),
            ts: Date.now(),
        };
        playSuccessBeep(); // Audio feedback
        window.setTimeout(async () => {
            if (continuous) {
                clearNextScanTimer();
                setLastScannedAwb(displayAwb);
                setConfirmedScan({
                    awb: displayAwb,
                    status: 'saving',
                    text: `AWB ${displayAwb} scanat. Se salveaza...`,
                });
                setLocalFeedback({
                    type: 'success',
                    awb: displayAwb,
                    text: `AWB ${displayAwb} scanat. Se salveaza...`,
                });
                setPauseReason('after-scan');
                setAwaitingNextScan(true);
                awaitingNextScanRef.current = true;
                setNextScanReady(false);
                const minConfirmDelay = new Promise((resolve) => {
                    nextScanTimerRef.current = window.setTimeout(() => {
                        nextScanTimerRef.current = null;
                        resolve();
                    }, CONTINUOUS_CONFIRM_DELAY_MS);
                });
                try {
                    await Promise.all([Promise.resolve(onScan(cleaned)), minConfirmDelay]);
                    setConfirmedScan({
                        awb: displayAwb,
                        status: 'saved',
                        text: `AWB ${displayAwb} scanat si salvat.`,
                    });
                    setLocalFeedback({
                        type: 'success',
                        awb: displayAwb,
                        text: `AWB ${displayAwb} scanat si salvat.`,
                    });
                } catch (err) {
                    const errText = String(err?.message || err || 'Scan handler failed');
                    setScanError(errText);
                    setConfirmedScan({
                        awb: displayAwb,
                        status: 'error',
                        text: errText,
                    });
                    setLocalFeedback({ type: 'error', awb: displayAwb, text: errText });
                } finally {
                    setNextScanReady(true);
                }
            } else {
                Promise.resolve(stopAll())
                    .catch(() => { })
                    .finally(() => {
                        try {
                            onScan(cleaned);
                        } catch (err) {
                            setScanError(String(err?.message || err || 'Scan handler failed'));
                            scanLockedRef.current = false;
                        }
                    });
            }
        }, 0);
    }, [onScan, stopAll, continuous, clearNextScanTimer, t]);

    const registerDetection = useCallback((rawValue) => {
        if (scanLockedRef.current) return;
        if (continuous && awaitingNextScanRef.current) return;
        if (continuous && Date.now() < ignoreDetectionsUntilRef.current) {
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };
            return;
        }
        const raw = String(rawValue || '').trim();
        if (!raw) return;

        const barcodeKey = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (profile === 'barcode' && barcodeKey.length < MIN_BARCODE_SCAN_LENGTH) return;

        const key = profile === 'barcode'
            ? barcodeKey
            : raw;
        if (!key) return;
        const lastAccepted = lastAcceptedScanRef.current || { key: '', ts: 0 };
        if (
            continuous
            && lastAccepted.key
            && key === lastAccepted.key
            && Date.now() - Number(lastAccepted.ts || 0) < DUPLICATE_SCAN_SUPPRESS_MS
        ) {
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };
            return;
        }

        const now = Date.now();
        const prev = detectStableRef.current || { key: '', count: 0, ts: 0, raw: '', firstTs: 0 };
        const sameAsPrev = prev.key === key && (now - Number(prev.ts || 0) <= 1200);
        const count = sameAsPrev ? Number(prev.count || 0) + 1 : 1;
        const firstTs = sameAsPrev ? (Number(prev.firstTs || 0) || Number(prev.ts || 0) || now) : now;
        detectStableRef.current = { key, raw, count, ts: now, firstTs };

        // Continuous unload scanning gets an extra stability check because the phone is moving through the warehouse.
        const needed = continuous && profile === 'barcode' ? 3 : (profile === 'barcode' ? 2 : 1);
        const stableLongEnough = !continuous || (now - firstTs >= CONTINUOUS_STABLE_WINDOW_MS);
        if (count >= needed && stableLongEnough) {
            emitScan(raw);
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };
        }
    }, [emitScan, profile, continuous]);

    const nativeHint = useMemo(() => {
        if (profile === 'barcode') return t('scanner.hint_barcode', 'Align barcode horizontally inside the scan area.');
        if (profile === 'qr') return t('scanner.hint_qr', 'Center the QR code in the scan area.');
        return t('scanner.hint_barcode', 'Align barcode horizontally inside the scan area.');
    }, [profile, t]);

    useEffect(() => {
        if (mode !== 'camera') {
            setScanError('');
            setEngine('idle');
            scanLockedRef.current = false;
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };
            stopAll();
            return undefined;
        }

        let cancelled = false;
        setScanError('');
        setEngine('idle');
        setTorchOn(false);
        clearNextScanTimer();
        setAwaitingNextScan(Boolean(continuous));
        awaitingNextScanRef.current = Boolean(continuous);
        setPauseReason(continuous ? 'initial' : null);
        setNextScanReady(true);
        setLastScannedAwb('');
        setConfirmedScan(null);
        scanLockedRef.current = false;
        detectBusyRef.current = false;
        detectStableRef.current = { key: '', raw: '', count: 0, ts: 0, firstTs: 0 };

        const startNativeScanner = async () => {
            if (!supportsBarcodeDetector()) return false;
            if (!navigator?.mediaDevices?.getUserMedia) return false;

            try {
                let formats = NATIVE_FORMATS[profile] || NATIVE_FORMATS.all;
                if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
                    const supported = await window.BarcodeDetector.getSupportedFormats();
                    if (Array.isArray(supported) && supported.length) {
                        const allowed = new Set(supported);
                        formats = formats.filter((f) => allowed.has(f));
                    }
                }

                const detector = new window.BarcodeDetector({
                    ...(Array.isArray(formats) && formats.length ? { formats } : {}),
                });

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: 'environment' },
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                });

                if (cancelled) {
                    stream.getTracks().forEach((track) => track.stop());
                    return false;
                }

                nativeStreamRef.current = stream;
                
                try {
                    const track = stream.getVideoTracks()[0];
                    if (track && typeof track.getCapabilities === 'function') {
                        const caps = track.getCapabilities();
                        if (caps.torch) {
                            // capability exists, we keep torch off by default
                            setTorchOn(false);
                        }
                    }
                } catch (e) {
                    // Ignore capability check failures
                }

                const videoEl = nativeVideoRef.current;
                if (!videoEl) return false;
                videoEl.srcObject = stream;
                videoEl.setAttribute('playsinline', 'true');
                videoEl.muted = true;
                await videoEl.play();

                const canvas = nativeCanvasRef.current || document.createElement('canvas');
                nativeCanvasRef.current = canvas;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    throw new Error('Canvas context unavailable');
                }

                setEngine('native');

                let lastDetectAt = 0;
                const tick = async (ts) => {
                    if (cancelled) return;
                    rafRef.current = requestAnimationFrame(tick);

                    if (scanLockedRef.current || (continuous && awaitingNextScanRef.current)) return;
                    if (detectBusyRef.current) return;
                    if (ts - lastDetectAt < 120) return;
                    lastDetectAt = ts;

                    const vw = videoEl.videoWidth || 0;
                    const vh = videoEl.videoHeight || 0;
                    if (!vw || !vh || videoEl.readyState < 2) return;

                    detectBusyRef.current = true;
                    try {
                        if (canvas.width !== vw || canvas.height !== vh) {
                            canvas.width = vw;
                            canvas.height = vh;
                        }
                        ctx.drawImage(videoEl, 0, 0, vw, vh);
                        const detections = await detector.detect(canvas);
                        if (!Array.isArray(detections) || !detections.length) return;
                        const first = detections.find((d) => String(d?.rawValue || '').trim()) || detections[0];
                        const raw = String(first?.rawValue || '').trim();
                        if (raw) registerDetection(raw);
                    } catch {
                        // Ignore frame-level decode failures.
                    } finally {
                        detectBusyRef.current = false;
                    }
                };

                rafRef.current = requestAnimationFrame(tick);
                return true;
            } catch {
                return false;
            }
        };

        const startHtml5Scanner = async () => {
            try {
                const scanner = new Html5Qrcode(readerIdRef.current, false);
                html5Ref.current = scanner;

                const vw = Number(window?.innerWidth || 390);
                const vh = Number(window?.innerHeight || 844);
                const qrbox = profile === 'barcode'
                    ? { width: Math.max(240, Math.floor(vw * 0.9)), height: Math.max(90, Math.floor(vh * 0.22)) }
                    : (() => {
                        const side = Math.max(220, Math.floor(Math.min(vw, vh) * 0.68));
                        return { width: side, height: side };
                    })();

                const baseConfig = {
                    fps: profile === 'barcode' ? 18 : 12,
                    qrbox,
                    aspectRatio: 1.777778,
                    disableFlip: false,
                };

                const formats = SCAN_PROFILE_FORMATS[profile] || ALL_FORMATS;
                const cameraConfig = { facingMode: 'environment' };

                const onDecode = (decodedText) => {
                    if (cancelled || scanLockedRef.current || (continuous && awaitingNextScanRef.current)) return;
                    registerDetection(decodedText);
                };

                try {
                    await scanner.start(
                        cameraConfig,
                        {
                            ...baseConfig,
                            ...(Array.isArray(formats) && formats.length ? { formatsToSupport: formats } : {}),
                        },
                        onDecode,
                        () => { }
                    );
                    // Torch starts off by default. Html5Qrcode doesn't currently support live toggle well natively.
                } catch {
                    await scanner.start(cameraConfig, baseConfig, onDecode, () => { });
                }

                if (cancelled) return false;
                setEngine('html5');
                return true;
            } catch (err) {
                if (!cancelled) {
                    setScanError(String(err?.message || err || 'Scanner init failed'));
                }
                return false;
            }
        };

        (async () => {
            await stopAll();
            if (enginePreference !== 'compat') {
                const nativeOk = await startNativeScanner();
                if (nativeOk || cancelled) return;
            }
            await startHtml5Scanner();
        })();

        return () => {
            cancelled = true;
            stopAll();
        };
    }, [mode, profile, enginePreference, registerDetection, stopAll, continuous, clearNextScanTimer]);

    const handleManualSubmit = async (event) => {
        event.preventDefault();
        const cleaned = String(manualAwb || '').trim().toUpperCase();
        if (!cleaned) return;

        const tokens = cleaned.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
        
        if (tokens.length === 1) {
            emitScan(tokens[0]);
            setManualAwb('');
            return;
        }

        scanLockedRef.current = true;
        try {
            for (const token of tokens) {
                 await Promise.resolve(onScan(token));
            }
            if (!continuous) stopAll();
            setManualAwb('');
            if (scanFeedback) {
                // The parent's toast might handle the last one, we just clear error
            }
        } catch (err) {
             setScanError(String(err?.message || err || 'Scan handler failed'));
        } finally {
             scanLockedRef.current = false;
        }
    };

    const toggleTorch = async () => {
        if (!nativeStreamRef.current) return;
        try {
            const track = nativeStreamRef.current.getVideoTracks()[0];
            if (track && typeof track.applyConstraints === 'function') {
                const nextState = !torchOn;
                await track.applyConstraints({
                    advanced: [{ torch: nextState }]
                });
                setTorchOn(nextState);
            }
        } catch (err) {
            console.warn('Torch toggle failed', err);
        }
    };

    const confirmedAwb = toDisplayAwb(confirmedScan?.awb || lastScannedAwb || localFeedback?.awb || '');
    const confirmedText = String(confirmedScan?.text || localFeedback?.text || '').trim();
    const confirmedStatus = String(confirmedScan?.status || (localFeedback?.type === 'error' ? 'error' : 'saved')).toLowerCase();
    const confirmCardClass = confirmedStatus === 'error'
        ? 'border-rose-300 bg-rose-500 shadow-[0_0_48px_rgba(244,63,94,0.65)]'
        : 'border-emerald-300 bg-emerald-500 shadow-[0_0_48px_rgba(16,185,129,0.65)]';
    const confirmLabel = confirmedStatus === 'error'
        ? 'AWB cu eroare'
        : (confirmedStatus === 'saving' ? 'AWB detectat' : 'AWB confirmat');

    return (
        <div className="fixed inset-0 bg-black/95 z-[80] flex flex-col pt-[env(safe-area-inset-top)]">
            <div className="sticky top-0 z-20 bg-black/90 backdrop-blur-md border-b border-white/10">
                <div className="flex justify-between items-center px-4 py-3 text-white">
                    <h2 className="text-lg font-bold">{t('scanner.title', 'Scaneaza cod AWB')}</h2>
                    <button onClick={onClose} className="p-2"><X /></button>
                </div>

                <div className="px-4 pb-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => setProfile('barcode')}
                            className={`px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${profile === 'barcode' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                        >
                            {t('scanner.barcode', 'Barcode')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setProfile('qr')}
                            className={`px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${profile === 'qr' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                        >
                            {t('scanner.qr', 'QR')}
                        </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => setMode('camera')}
                            className={`px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${mode === 'camera' ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                        >
                            {t('scanner.camera', 'Camera')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode('manual')}
                            className={`px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${mode === 'manual' ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                        >
                            {t('scanner.manual', 'Manual')}
                        </button>
                    </div>

                    {mode === 'camera' ? (
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setEnginePreference('auto')}
                                className={`px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-wide transition-all ${enginePreference === 'auto' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                            >
                                {t('scanner.engine_auto', 'Auto Engine')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setEnginePreference('compat')}
                                className={`px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-wide transition-all ${enginePreference === 'compat' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                            >
                                {t('scanner.engine_compat', 'Compat')}
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>

            {continuous && awaitingNextScan && pauseReason === 'after-scan' && confirmedAwb ? (
                <div className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+10px)] z-[110] rounded-2xl border-2 border-emerald-300 bg-emerald-500 px-4 py-3 text-center shadow-[0_0_36px_rgba(16,185,129,0.65)]">
                    <p className="text-[10px] font-black uppercase tracking-[0.26em] text-emerald-950">
                        {confirmLabel}
                    </p>
                    <p className="mt-1 break-words text-3xl font-black tracking-wider text-white">
                        {confirmedAwb}
                    </p>
                </div>
            ) : null}

            {continuous && awaitingNextScan && pauseReason === 'after-scan' && confirmedAwb ? (
                <div className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+7.25rem)] z-[105] flex justify-center sm:top-[calc(env(safe-area-inset-top)+8rem)]">
                    <div
                        aria-live="assertive"
                        className={`w-full max-w-md rounded-[2rem] border-4 ${confirmCardClass} px-4 py-5 text-center text-white`}
                    >
                        <p className="text-xs font-black uppercase tracking-[0.3em] text-black/70">
                            {confirmLabel}
                        </p>
                        <p className="mt-3 break-words font-mono text-[clamp(2.5rem,12vw,4.8rem)] font-black leading-none tracking-tight">
                            {confirmedAwb}
                        </p>
                        <p className="mt-3 text-sm font-black uppercase tracking-widest text-white/95">
                            {confirmedText || (confirmedStatus === 'saving' ? 'Se salveaza scanarea...' : 'Scanare salvata.')}
                        </p>
                    </div>
                </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 pb-[calc(9rem+env(safe-area-inset-bottom))]">
                {mode === 'camera' ? (
                    <div className="mx-auto w-full max-w-md space-y-3 relative">
                        {!continuous && scanFeedback ? (
                            <div className={`absolute inset-x-4 top-4 p-4 rounded-xl text-center shadow-2xl z-[70] transition-all ${scanFeedback?.type === 'success' ? 'bg-emerald-500 text-white border-2 border-emerald-400' : 'bg-rose-500 text-white border-2 border-rose-400'}`}>
                                <p className="font-extrabold tracking-wide text-sm md:text-base">{scanFeedback.text}</p>
                            </div>
                        ) : null}
                        
                        {continuous && awaitingNextScan && (
                            <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-[90] max-h-[62dvh] overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/96 shadow-2xl p-3 sm:absolute sm:bottom-3 sm:z-[80] sm:max-h-none sm:p-4">
                                <div className="text-center w-full">
                                    <h3 className="text-sm font-black text-emerald-400 uppercase tracking-widest mb-3 sm:text-lg sm:mb-4">
                                        {pauseReason === 'after-scan'
                                            ? t('scanner.success', 'Confirmare')
                                            : t('scanner.pause_title', 'Scanner in pauza')}
                                    </h3>

                                    {pauseReason === 'after-scan' ? (
                                        <>
                                            <div className="bg-emerald-500/15 border-2 border-emerald-400/70 p-3 rounded-2xl mb-3 shadow-2xl sm:p-4 sm:mb-4">
                                                <p className="text-[11px] text-emerald-200 uppercase tracking-widest font-black mb-2">
                                                    {t('scanner.last_scan', 'AWB confirmat')}
                                                </p>
                                                <p className="text-2xl text-white font-black break-words tracking-wider sm:text-3xl">
                                                    {confirmedAwb}
                                                </p>
                                            </div>

                                            {localFeedback ? (
                                                <div className={`p-3 rounded-xl text-center shadow-lg transition-all mb-3 sm:mb-4 ${localFeedback?.type === 'success' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50' : 'bg-rose-500/20 text-rose-300 border border-rose-500/50'}`}>
                                                    <p className="font-bold tracking-wide text-sm">{localFeedback.text}</p>
                                                </div>
                                            ) : null}

                                            <p className="text-[11px] font-bold text-slate-200 sm:text-xs">
                                                {t('scanner.pause_after_scan', 'Camera ramane blocata pana cand confirmi ca esti pregatit pentru urmatorul AWB.')}
                                            </p>
                                        </>
                                    ) : (
                                        <div className="bg-white/5 border border-white/20 p-3 rounded-2xl shadow-2xl sm:p-4">
                                            <p className="text-sm text-white font-black leading-snug">
                                                {t('scanner.pause_initial', 'Orienteaza telefonul spre urmatorul AWB, apoi apasa butonul mare pentru a activa scanarea.')}
                                            </p>
                                            <p className="text-[11px] text-slate-300 font-bold mt-3">
                                                {t('scanner.pause_initial_hint', 'Scannerul ramane in pauza intre scanari ca sa evitam detectiile false si trecerea prea rapida la urmatorul colet.')}
                                            </p>
                                        </div>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={handleNextScan}
                                    disabled={!nextScanReady}
                                    className={`mt-3 w-full min-h-[56px] py-3 px-3 text-white font-black text-sm tracking-wide uppercase rounded-2xl shadow-[0_0_30px_rgba(37,99,235,0.5)] transition-all sm:mt-4 sm:py-4 sm:text-base sm:tracking-widest ${nextScanReady ? 'bg-primary-600 active:scale-95' : 'bg-slate-700 cursor-wait opacity-80'}`}
                                >
                                    {nextScanReady
                                        ? (pauseReason === 'after-scan'
                                            ? t('scanner.next', 'Scaneaza Urmatorul AWB')
                                            : t('scanner.arm', 'Activeaza Scanarea'))
                                        : t('scanner.wait_next', 'Asteapta confirmarea...')}
                                </button>
                                <p className="mt-2 text-center text-[10px] font-bold uppercase tracking-wide text-slate-300 sm:mt-3 sm:tracking-widest">
                                    {nextScanReady
                                        ? t('scanner.resume_hint', 'Scanarea porneste doar dupa aceasta confirmare.')
                                        : t('scanner.cooldown_hint', 'Pastram cateva clipe AWB-ul vizibil pentru confirmare clara.')}
                                </p>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="mt-2 text-slate-400 font-bold uppercase tracking-wide text-xs hover:text-white sm:mt-3 sm:tracking-widest"
                                >
                                    {t('scanner.close', 'Inchide Scanner')}
                                </button>
                            </div>
                        )}
                        
                        {engine === 'native' ? (
                            <div className="relative w-full rounded-xl overflow-hidden bg-gray-800 border-2 border-primary-500 min-h-[300px] max-h-[58dvh]">
                                <video
                                    ref={nativeVideoRef}
                                    autoPlay
                                    muted
                                    playsInline
                                    className="w-full h-full object-cover min-h-[300px]"
                                />
                                <div className={`pointer-events-none absolute inset-x-[10%] ${profile === 'barcode' ? 'top-[38%] bottom-[38%]' : 'top-[20%] bottom-[20%]'} border-2 border-white/80 rounded-lg`} />
                                <button
                                    type="button"
                                    onClick={toggleTorch}
                                    className={`absolute bottom-4 right-4 p-3.5 rounded-full shadow-lg z-50 transition-colors ${torchOn ? 'bg-amber-400 text-black shadow-glow-sm border border-amber-300' : 'bg-black/60 text-white border border-white/20 hover:bg-black/80'}`}
                                    aria-label={t('scanner.toggle_torch', 'Lanterna')}
                                    title="Toggle Torch"
                                >
                                    <Zap size={22} className={torchOn ? 'fill-current' : ''} />
                                </button>
                            </div>
                        ) : (
                            <div id={readerIdRef.current} className="w-full rounded-xl overflow-hidden bg-gray-800 border-2 border-primary-500 min-h-[300px]"></div>
                        )}

                        <p className="text-[10px] text-slate-300 font-bold text-center">
                            {nativeHint}
                        </p>
                        <p className="text-[10px] text-cyan-300 font-bold text-center uppercase tracking-widest break-words">
                            {engine === 'native'
                                ? t('scanner.engine_native', 'Native detector')
                                : engine === 'html5'
                                    ? t('scanner.engine_fallback', 'Compatibility mode')
                                    : t('scanner.engine_starting', 'Starting camera')}
                        </p>
                        {scanError ? (
                            <p className="text-[11px] font-bold text-rose-300 text-center break-words">
                                {scanError}
                            </p>
                        ) : null}
                        
                        {continuous && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="mt-4 w-full py-4 bg-emerald-600 text-white font-black text-sm tracking-widest uppercase rounded-xl shadow-lg active:scale-95 transition-transform"
                            >
                                {t('scanner.done', 'GATA / INCHIDE SCANNER')}
                            </button>
                        )}
                    </div>
                ) : (
                    <form onSubmit={handleManualSubmit} className="mx-auto w-full max-w-sm space-y-4 mt-3">
                        <textarea
                            autoFocus
                            rows={6}
                            className="w-full p-4 rounded-xl bg-gray-800 text-white border border-gray-700 outline-none focus:border-primary-500 text-center text-xl tracking-widest break-words resize-none"
                            placeholder={t('scanner.enter_awb_bulk', 'INTRODU SAU LIPESTE AWB-URILE AICI')}
                            value={manualAwb}
                            onChange={(event) => setManualAwb(String(event?.target?.value || '').toUpperCase())}
                        />
                        <button className="w-full py-4 bg-primary-600 text-white rounded-xl font-bold uppercase tracking-wider">
                            {t('scanner.submit_manual', 'Trimite AWB-uri')}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
