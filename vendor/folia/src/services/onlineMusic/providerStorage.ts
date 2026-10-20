import type { OnlineProviderId } from '../../types/onlineMusic';
import { getFromCache, saveToCache } from '../db';

// src/services/onlineMusic/providerStorage.ts

export const getProviderCacheKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider_${providerId}_${key}`
);

export const getProviderSessionKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider:${providerId}:${key}`
);

// Reads an old unscoped cache once, then stores the value in the provider namespace.
export const getProviderCacheWithLegacyMigration = async <T>(
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): Promise<T | null> => {
    const namespacedKey = getProviderCacheKey(providerId, key);
    const current = await getFromCache<T>(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = await getFromCache<T>(legacyKey);
        if (legacy == null) continue;
        await saveToCache(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

// Yingjian keeps only opaque session-presence markers in renderer memory.
// Actual platform credentials are injected and encrypted by the main transport.
const sessionMemory = new Map<string, string>();
export const readProviderSessionValue = (providerId: OnlineProviderId, key: string): string | null => sessionMemory.get(getProviderSessionKey(providerId, key)) ?? null;
export const writeProviderSessionValue = (providerId: OnlineProviderId, key: string, value: string): void => { sessionMemory.set(getProviderSessionKey(providerId, key), value); };
export const removeProviderSessionValue = (providerId: OnlineProviderId, key: string): void => { sessionMemory.delete(getProviderSessionKey(providerId, key)); };
