import React from 'react';
import { useNavigate } from 'react-router-dom';
import { normalizeShipmentIdentifier } from '../services/awbScan';

const normalizeAwb = (value) => normalizeShipmentIdentifier(String(value || '').trim());

export const awbDetailsPath = (awb) => {
    const key = normalizeAwb(awb);
    if (!key) return '/shipments';
    return `/shipments?awb=${encodeURIComponent(key)}&open_awb=1`;
};

export default function AwbLink({
    awb,
    children = null,
    className = '',
    title = '',
    stopPropagation = true,
    disabled = false,
}) {
    const navigate = useNavigate();
    const key = normalizeAwb(awb);
    const label = children ?? key ?? '--';

    if (!key || disabled) {
        return <span className={className}>{label}</span>;
    }

    const go = (event) => {
        if (event) {
            event.preventDefault();
            if (stopPropagation) event.stopPropagation();
        }
        navigate(awbDetailsPath(key));
    };

    return (
        <span
            role="button"
            tabIndex={0}
            onClick={go}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    go(event);
                }
            }}
            className={className || 'cursor-pointer underline decoration-dotted underline-offset-2'}
            title={title || `Deschide detalii AWB ${key}`}
            aria-label={`Deschide detalii AWB ${key}`}
        >
            {label}
        </span>
    );
}
