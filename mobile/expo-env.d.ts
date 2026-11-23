/// <reference types="expo/types" />

// Expo inlines EXPO_PUBLIC_* variables at build time. `readConfig` is the only
// place that reads them so tests can pass a plain environment object instead.
declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_SOROBAN_RPC_URL?: string;
    EXPO_PUBLIC_NETWORK_PASSPHRASE?: string;
    EXPO_PUBLIC_CONTRACT_ADDRESS?: string;
    EXPO_PUBLIC_SIM_SOURCE?: string;
    EXPO_PUBLIC_WALLET_CALLBACK_URL?: string;
  }
}
