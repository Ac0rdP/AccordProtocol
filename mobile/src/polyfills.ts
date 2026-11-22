// Stellar's transaction encoder expects Buffer and a CSPRNG. React Native does
// not ship either as a global, so install them before any Stellar SDK import.
import "react-native-get-random-values";
import { Buffer } from "buffer";

const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalWithBuffer.Buffer) globalWithBuffer.Buffer = Buffer;
