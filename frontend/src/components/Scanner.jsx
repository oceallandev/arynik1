import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

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

const NATIVE_FORMATS = {
    all: ['qr_code', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'data_matrix', 'aztec', 'pdf417'],
    barcode: ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e'],
    qr: ['qr_code'],
};

const supportsBarcodeDetector = () => typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function';

export default function Scanner({ onScan, onClose }) {
    const { t } = useLanguage();
    const [manualAwb, setManualAwb] = useState('');
    const [mode, setMode] = useState('camera'); // camera | manual
    const [profile, setProfile] = useState('barcode'); // barcode | qr
    const [enginePreference, setEnginePreference] = useState('auto'); // auto | compat
    const [engine, setEngine] = useState('idle'); // idle | native | html5
    const [scanError, setScanError] = useState('');

    const readerIdRef = useRef(`reader-${Math.random().toString(36).slice(2, 9)}`);
    const scanLockedRef = useRef(false);
    const html5Ref = useRef(null);
    const nativeStreamRef = useRef(null);
    const nativeVideoRef = useRef(null);
    const nativeCanvasRef = useRef(null);
    const rafRef = useRef(null);
    const detectBusyRef = useRef(false);
    const detectStableRef = useRef({ key: '', raw: '', count: 0, ts: 0 });

    const stopAll = useCallback(async () => {
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
    }, []);

    const emitScan = useCallback((rawValue) => {
        if (scanLockedRef.current) return;
        const cleaned = String(rawValue || '').trim();
        if (!cleaned) return;
        scanLockedRef.current = true;
        window.setTimeout(() => {
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
        }, 0);
    }, [onScan, stopAll]);

    const registerDetection = useCallback((rawValue) => {
        if (scanLockedRef.current) return;
        const raw = String(rawValue || '').trim();
        if (!raw) return;

        const key = profile === 'barcode'
            ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
            : raw;
        if (!key) return;

        const now = Date.now();
        const prev = detectStableRef.current || { key: '', count: 0, ts: 0, raw: '' };
        const sameAsPrev = prev.key === key && (now - Number(prev.ts || 0) <= 1200);
        const count = sameAsPrev ? Number(prev.count || 0) + 1 : 1;
        detectStableRef.current = { key, raw, count, ts: now };

        // For barcodes we require 2 consecutive reads to avoid noisy partial detections.
        const needed = profile === 'barcode' ? 2 : 1;
        if (count >= needed) {
            emitScan(raw);
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0 };
        }
    }, [emitScan, profile]);

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
            detectStableRef.current = { key: '', raw: '', count: 0, ts: 0 };
            stopAll();
            return undefined;
        }

        let cancelled = false;
        setScanError('');
        setEngine('idle');
        scanLockedRef.current = false;
        detectBusyRef.current = false;
        detectStableRef.current = { key: '', raw: '', count: 0, ts: 0 };

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
                    if (cancelled || scanLockedRef.current) return;
                    rafRef.current = requestAnimationFrame(tick);

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
                    if (cancelled || scanLockedRef.current) return;
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
    }, [mode, profile, enginePreference, registerDetection, stopAll]);

    const handleManualSubmit = (event) => {
        event.preventDefault();
        const cleaned = String(manualAwb || '').trim().toUpperCase();
        if (!cleaned) return;
        emitScan(cleaned);
    };

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

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 pb-[calc(9rem+env(safe-area-inset-bottom))]">
                {mode === 'camera' ? (
                    <div className="mx-auto w-full max-w-md space-y-3">
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
                    </div>
                ) : (
                    <form onSubmit={handleManualSubmit} className="mx-auto w-full max-w-sm space-y-4 mt-3">
                        <input
                            autoFocus
                            className="w-full p-4 rounded-xl bg-gray-800 text-white border border-gray-700 outline-none focus:border-primary-500 text-center text-2xl tracking-widest"
                            placeholder={t('scanner.enter_awb', 'INTRODU AWB')}
                            value={manualAwb}
                            onChange={(event) => setManualAwb(String(event?.target?.value || '').toUpperCase())}
                        />
                        <button className="w-full py-4 bg-primary-600 text-white rounded-xl font-bold">
                            {t('scanner.submit_manual', 'Trimite Manual')}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
