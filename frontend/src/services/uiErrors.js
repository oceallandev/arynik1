const asText = (value) => String(value || '').trim();

const looksLikeNetworkIssue = (text) => (
    /network error|failed to fetch|load failed|network request failed|timeout|ecconnrefused|err_network/i.test(asText(text))
);

const looksLikeBackendConfigIssue = (text) => (
    /backend login unavailable|no reachable backend api detected|api url points to the frontend|method not allowed/i.test(asText(text))
);

export const toUiError = (
    error,
    {
        lang = 'ro',
        fallbackRo = 'A aparut o eroare.',
        fallbackEn = 'Something went wrong.',
    } = {}
) => {
    const status = Number(error?.response?.status || 0);
    const detail = asText(error?.response?.data?.detail || error?.message || '');
    const isRo = String(lang || 'ro').toLowerCase() === 'ro';

    if (status === 401 || status === 403) {
        return isRo
            ? 'Sesiunea a expirat sau nu ai permisiuni. Reautentifica-te si incearca din nou.'
            : 'Session expired or insufficient permissions. Please sign in again.';
    }

    if (status === 405 || looksLikeBackendConfigIssue(detail)) {
        return isRo
            ? 'Nu ma pot conecta corect la backend. Verifica in Menu -> Settings -> API URL backend (HTTPS), apoi apasa Auto Detect Backend.'
            : 'Cannot reach backend API. Check Menu -> Settings -> Backend API URL (HTTPS), then press Auto Detect Backend.';
    }

    if (looksLikeNetworkIssue(detail)) {
        return isRo
            ? 'Conexiunea cu serverul este indisponibila. Verifica internetul si API URL backend din Settings, apoi incearca din nou.'
            : 'Cannot connect to server. Check your internet and Backend API URL in Settings, then retry.';
    }

    if (detail) return detail;
    return isRo ? fallbackRo : fallbackEn;
};

