import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { ProposalStatus } from "../lib/types";

export const colors = {
  background: "#0b1020",
  surface: "#151d33",
  surfaceAlt: "#1d2742",
  primary: "#6ea8fe",
  text: "#f5f7ff",
  muted: "#9aa7c7",
  danger: "#ff7b72",
  success: "#5ed3a6",
  warning: "#f5c26b",
};

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
  tone = "primary",
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "danger" | "ghost";
}) {
  const background =
    tone === "danger" ? colors.danger : tone === "ghost" ? colors.surfaceAlt : colors.primary;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: background }, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, tone === "primary" && styles.buttonTextDark]}>{title}</Text>
    </TouchableOpacity>
  );
}

export function StatusBadge({ status }: { status: ProposalStatus }) {
  const color =
    status === "ready"
      ? colors.success
      : status === "pending"
        ? colors.warning
        : status === "executed"
          ? colors.primary
          : colors.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: colors.surfaceAlt,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 15 },
  buttonTextDark: { color: "#08122a" },
  disabled: { opacity: 0.45 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
});
