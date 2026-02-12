import React, { useEffect, useState } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { X, Camera, Keyboard } from 'lucide-react';

export default function Scanner({ onScan, onClose }) {
    const [manualAwb, setManualAwb] = useState('');
    const [mode, setMode] = useState('camera'); // 'camera' or 'manual'

    useEffect(() => {
        if (mode === 'camera') {
            const scanner = new Html5QrcodeScanner("reader", {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0
            });

            scanner.render((decodedText) => {
                scanner.clear();
                onScan(decodedText);
            }, (err) => {
                // console.error(err);
            });

            return () => {
                scanner.clear();
            };
        }
    }, [mode, onScan]);

    const handleManualSubmit = (e) => {
        e.preventDefault();
        if (manualAwb.trim()) {
            onScan(manualAwb.trim());
        }
    };

    return (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col pt-safe">
            <div className="flex justify-between items-center p-4 text-white">
                <h2 className="text-lg font-bold">Scan AWB Barcode</h2>
                <button onClick={onClose} className="p-2"><X /></button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-4">
                {mode === 'camera' ? (
                    <div id="reader" className="w-full max-w-sm rounded-xl overflow-hidden bg-gray-800 border-2 border-primary-500"></div>
                ) : (
                    <form onSubmit={handleManualSubmit} className="w-full max-w-sm space-y-4">
                        <input
                            autoFocus
                            className="w-full p-4 rounded-xl bg-gray-800 text-white border border-gray-700 outline-none focus:border-primary-500 text-center text-2xl tracking-widest"
                            placeholder="ENTER AWB #"
                            value={manualAwb}
                            onChange={(e) => setManualAwb(e.target.value.toUpperCase())}
                        />
                        <button className="w-full py-4 bg-primary-600 text-white rounded-xl font-bold">
                            Submit Manually
                        </button>
                    </form>
                )}
            </div>

            <div className="p-8 flex justify-center gap-4">
                <button
                    onClick={() => setMode('camera')}
                    className={`p-4 rounded-full flex items-center gap-2 ${mode === 'camera' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                >
                    <Camera size={24} /> <span>Camera</span>
                </button>
                <button
                    onClick={() => setMode('manual')}
                    className={`p-4 rounded-full flex items-center gap-2 ${mode === 'manual' ? 'bg-primary-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                >
                    <Keyboard size={24} /> <span>Manual</span>
                </button>
            </div>
        </div>
    );
}
