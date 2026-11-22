import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { config } from "../config";
import { isValidWalletAddress } from "../lib/wallet";
import { Card, PrimaryButton, colors } from "./ui";

export function ConnectScreen({
  onConnect,
  error,
}: {
  onConnect: (address: string) => Promise<void>;
  error: string | null;
}) {
  const [address, setAddress] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const connect = async () => {
    const trimmed = address.trim();
    if (!isValidWalletAddress(trimmed)) {
      setValidationError("Enter a valid Stellar public key (starts with G).");
      return;
    }
    setValidationError(null);
    setConnecting(true);
    try {
      await onConnect(trimmed);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Accord Protocol</Text>
      <Text style={styles.subtitle}>Multisig treasury, in your pocket.</Text>
      <Card>
        <Text style={styles.heading}>Connect an owner wallet</Text>
        <Text style={styles.body}>
          Paste the public address of the owner wallet you use in the web app. Your secret key
          never leaves your device or wallet app.
        </Text>
        <TextInput
          accessibilityLabel="Stellar wallet address"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="G... your Stellar public key"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={address}
          onChangeText={setAddress}
        />
        {(validationError || error) && (
          <Text style={styles.error}>{validationError || error}</Text>
        )}
        <PrimaryButton
          title={connecting ? "Connecting..." : "Connect wallet"}
          onPress={connect}
          disabled={connecting}
        />
      </Card>
      <Text style={styles.network}>
        Network: {config.network} · Contract: {config.contractId.slice(0, 8)}…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: 30, fontWeight: "700" },
  subtitle: { color: colors.muted, fontSize: 15, marginTop: 6, marginBottom: 24 },
  heading: { color: colors.text, fontSize: 18, fontWeight: "600" },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.surfaceAlt,
    backgroundColor: colors.background,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    marginTop: 16,
    fontFamily: "monospace",
  },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 },
  network: { color: colors.muted, fontSize: 11, textAlign: "center", marginTop: 20 },
});
