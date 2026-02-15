import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Loader2, RefreshCw } from 'lucide-react';
import { queueItem } from '../store/queue';
import { getShipment, getStatusOptions, updateAwb } from '../services/api';

export default function StatusSelect({ awb, onBack, onComplete }) {
    const [options, setOptions] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [detailsLoading, setDetailsLoading] = useState(true);
    const [shipment, setShipment] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [detailsError, setDetailsError] = useState('');

    useEffect(() => {
        let cancelled = false;

        const token = localStorage.getItem('token');

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

        setDetailsLoading(true);
        setDetailsError('');
        setShipment(null);
        getShipment(token, awb, { refresh: true })
            .then((data) => {
                if (cancelled) return;
                setShipment(data);
            })
            .catch((e) => {
                if (cancelled) return;
                const detail = e?.response?.data?.detail;
                setDetailsError(detail ? String(detail) : 'Failed to load shipment details');
            })
            .finally(() => {
                if (cancelled) return;
                setDetailsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [awb]);

    const refreshDetails = async () => {
        setDetailsLoading(true);
        setDetailsError('');
        try {
            const token = localStorage.getItem('token');
            const details = await getShipment(token, awb, { refresh: true });
            setShipment(details);
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

    const handleSubmit = async () => {
        if (!selectedId) {
            return;
        }

        setSubmitting(true);

        try {
            const token = localStorage.getItem('token');
            const locality =
                shipment?.locality
                || shipment?.raw_data?.recipientLocation?.locality
                || shipment?.raw_data?.recipientLocation?.localityName
                || '';
            const payload = locality ? { locality } : undefined;
            await updateAwb(token, {
                awb,
                event_id: selectedId,
                timestamp: new Date().toISOString(),
                payload
            });
            onComplete('SUCCESS');
        } catch {
            const locality =
                shipment?.locality
                || shipment?.raw_data?.recipientLocation?.locality
                || shipment?.raw_data?.recipientLocation?.localityName
                || '';
            const payload = locality ? { locality } : undefined;
            await queueItem(awb, selectedId, payload);
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
                <div className="p-4 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Shipment</p>
                            <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                                {detailsLoading ? 'Loading details...' : (shipment?.recipient_name || '--')}
                            </p>
                            {shipment?.awb && String(shipment.awb).toUpperCase() !== String(awb || '').toUpperCase() ? (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400 font-mono mt-1">
                                    Resolved AWB: {String(shipment.awb).toUpperCase()}
                                </p>
                            ) : null}
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
                                        || shipment?.raw_data?.packageContent
                                        || shipment?.raw_data?.shipmentContent
                                        || shipment?.raw_data?.goodsDescription
                                        || shipment?.raw_data?.additionalServices?.contentDescription
                                        || shipment?.raw_data?.additionalServices?.contents
                                        || shipment?.raw_data?.additionalServices?.content
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
                        </div>
                    ) : null}
                </div>

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
