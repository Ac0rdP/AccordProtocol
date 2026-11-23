import * as SecureStore from "expo-secure-store";
import type { SessionStorageLike } from "./session";

/** SecureStore keeps the session out of plain-text app storage on the device. */
export const secureSessionStorage: SessionStorageLike = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
