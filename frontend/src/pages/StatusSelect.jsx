import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { queueItem } from '../store/queue';
import { getStatusOptions, updateAwb } from '../services/api';

export default function StatusSelect({ awb, onBack, onComplete }) {
    const [options, setOptions] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchOptions = async () => {
            try {
                const token = localStorage.getItem('token');
                const data = await getStatusOptions(token);
                setOptions(data);
            } catch {
                setError('Failed to load status options');
            } finally {
                setLoading(false);
            }
        };

        fetchOptions();
    }, []);

    const handleSubmit = async () => {
        if (!selectedId) {
            return;
        }

        setSubmitting(true);

        try {
            const token = localStorage.getItem('token');
            await updateAwb(token, {
                awb,
                event_id: selectedId,
                timestamp: new Date().toISOString()
            });
            onComplete('SUCCESS');
        } catch {
            await queueItem(awb, selectedId);
            onComplete('QUEUED');
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
                    <p className="text-xs text-primary-600 font-mono tracking-wider">{awb}</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                    disabled={!selectedId || submitting}
                    onClick={handleSubmit}
                    className="w-full py-4 bg-primary-600 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2"
                >
                    {submitting ? <Loader2 className="animate-spin" /> : 'Confirm Status Update'}
                </button>
            </div>
        </div>
    );
}
