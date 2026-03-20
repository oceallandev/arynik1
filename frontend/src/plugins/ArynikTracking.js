import { registerPlugin } from '@capacitor/core';

export const ArynikTracking = registerPlugin('ArynikTracking');

export const startNativeTracking = async (options) => {
    try {
        await ArynikTracking.startTracker(options);
        return true;
    } catch (e) {
        console.warn('Native tracking plugin not available or failed to start:', e);
        return false;
    }
};

export const stopNativeTracking = async () => {
    try {
        await ArynikTracking.stopTracker();
        return true;
    } catch (e) {
        return false;
    }
};
