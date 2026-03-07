import React, { useEffect, useRef, useState } from 'react';
import { Html5QrcodeScanner, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, Keyboard, ScanLine } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const BARCODE_FORMATS = [
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
];

const QR_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

const ALL_FORMATS = [
    Html5QrcodeSupportedFormats.QR_CODE,
    ...BARCODE_FORMATS,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
    Html5QrcodeSupportedFormats.AZTEC,
    Html5QrcodeSupportedFormats.PDF_417,
];

const SCAN_PROFILE_FORMATS = {
    all: ALL_FORMATS,
    barcode: BARCODE_FORMATS,
    qr: QR_FORMATS,
};

export default function Scanner({ onScan, onClose }) {
    const [manualAwb, setManualAwb] = useState('');
    const [mode, setMode] = useState('camera'); // 'camera' or 'manual'
    const [profile, setProfile] = useState('barcode'); // 'all' | 'barcode' | 'qr'
    const scannerRef = useRef(null);
    const { t } = useLanguage();

    useEffect(() => {
        if (mode !== 'camera') {
            return undefined;
        }

        let stopped = false;

        const scanner = new Html5QrcodeScanner('reader', {
            // Higher fps helps 1D barcode reading at movement.
            fps: profile === 'barcode' ? 20 : 12,
            qrbox: (vw, vh) => {
                if (profile === 'barcode') {
                    const width = Math.max(260, Math.floor(vw * 0.92));
                    const height = Math.max(90, Math.floor(vh * 0.24));
                    return { width, height };
                }
                const side = Math.max(220, Math.floor(Math.min(vw, vh) * 0.7));
                return { width: side, height: side };
            },
            aspectRatio: 1.777778,
            formatsToSupport: SCAN_PROFILE_FORMATS[profile] || ALL_FORMATS,
            rememberLastUsedCamera: true,
            showTorchButtonIfSupported: true,
            showZoomSliderIfSupported: true,
            // Prefer rear camera on phones (falls back automatically).
            videoConstraints: { facingMode: { ideal: 'environment' } },
        }, false);

        scannerRef.current = scanner;

        scanner.render(
            (decodedText) => {
                const cleaned = String(decodedText || '').trim();
                if (!cleaned || stopped) return;
                stopped = true;
                Promise.resolve(scanner.clear())
                    .catch(() => { })
                    .finally(() => onScan(cleaned));
            },
            () => {
                // Frequent decode attempts are expected while searching for barcode/QR.
            }
        );

        return () => {
            stopped = true;
            if (scannerRef.current) {
                Promise.resolve(scannerRef.current.clear()).catch(() => { });
                scannerRef.current = null;
            }
        };
    }, [mode, profile, onScan]);

    const handleManualSubmit = (e) => {
        e.preventDefault();
        if (manualAwb.trim()) {
            onScan(manualAwb.trim());
        }
    };

    return (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col pt-safe">
            <div className="flex justify-between items-center p-4 text-white">
                <h2 className="text-lg font-bold">{t('scanner.title', 'Scan AWB Barcode')}</h2>
                <button onClick={onClose} className="p-2"><X /></button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-4">
                {mode === 'camera' ? (
                    <div className="w-full max-w-md space-y-3">
                        <div className="p-2 rounded-xl bg-slate-900/70 border border-slate-700">
                            <div className="grid grid-cols-3 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setProfile('barcode')}
                                    className={`px-2 py-2 rounded-lg text-[10px] font-black uppercase tracking-wide transition-all ${profile === 'barcode' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                                >
                                    {t('scanner.barcode', 'Barcode')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setProfile('all')}
                                    className={`px-2 py-2 rounded-lg text-[10px] font-black uppercase tracking-wide transition-all ${profile === 'all' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                                >
                                    {t('scanner.auto', 'Auto')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setProfile('qr')}
                                    className={`px-2 py-2 rounded-lg text-[10px] font-black uppercase tracking-wide transition-all ${profile === 'qr' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                                >
                                    {t('scanner.qr', 'QR')}
                                </button>
                            </div>
                        </div>
                        <div id="reader" className="w-full rounded-xl overflow-hidden bg-gray-800 border-2 border-primary-500"></div>
                        <p className="text-[10px] text-slate-300 font-bold text-center">
                            {profile === 'barcode'
                                ? t('scanner.hint_barcode', 'Align barcode horizontally inside the scan area.')
                                : profile === 'qr'
                                    ? t('scanner.hint_qr', 'Center the QR code in the scan area.')
                                    : t('scanner.hint_auto', 'Auto mode reads both QR and barcodes.')}
                        </p>
                    </div>
                ) : (
                    <form onSubmit={handleManualSubmit} className="w-full max-w-sm space-y-4">
                        <input
                            autoFocus
                            className="w-full p-4 rounded-xl bg-gray-800 text-white border border-gray-700 outline-none focus:border-primary-500 text-center text-2xl tracking-widest"
                            placeholder={t('scanner.enter_awb', 'ENTER AWB #')}
                            value={manualAwb}
                            onChange={(e) => setManualAwb(e.target.value.toUpperCase())}
                        />
                        <button className="w-full py-4 bg-primary-600 text-white rounded-xl font-bold">
                            {t('scanner.submit_manual', 'Submit Manually')}
                        </button>
                    </form>
                )}
            </div>

            <div className="p-8 flex justify-center gap-4">
                <button
                    onClick={() => setMode('camera')}
                    className={`p-4 rounded-full flex items-center gap-2 ${mode === 'camera' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                >
                    <ScanLine size={24} /> <span>{t('scanner.camera', 'Camera')}</span>
                </button>
                <button
                    onClick={() => setMode('manual')}
                    className={`p-4 rounded-full flex items-center gap-2 ${mode === 'manual' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                >
                    <Keyboard size={24} /> <span>{t('scanner.manual', 'Manual')}</span>
                </button>
            </div>
        </div>
    );
}
