import React from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { formatDeadline, shortenAddress } from "../lib/format";
import type { Proposal } from "../lib/types";
import { Card, PrimaryButton, StatusBadge, colors } from "./ui";

export function ProposalListScreen({
  proposals,
  loading,
  error,
  address,
  onRefresh,
  onOpen,
  onDisconnect,
}: {
  proposals: Proposal[];
  loading: boolean;
  error: string | null;
  address: string;
  onRefresh: () => void;
  onOpen: (proposal: Proposal) => void;
  onDisconnect: () => void;
}) {
  const pending = proposals.filter((p) => p.status === "pending" || p.status === "ready").length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Proposals</Text>
          <Text style={styles.subtitle}>
            {pending} awaiting action · {shortenAddress(address)}
          </Text>
        </View>
        <PrimaryButton title="Disconnect" tone="ghost" onPress={onDisconnect} />
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={proposals}
        keyExtractor={(item) => String(item.id)}
        refreshing={loading}
        onRefresh={onRefresh}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {loading ? "Reading the contract…" : "No proposals found for this contract."}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Text style={styles.proposalId}>#{item.id}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={styles.description} numberOfLines={2}>
              {item.description || "No description"}
            </Text>
            <Text style={styles.detail}>
              {item.kind.replace(/_/g, " ")} · {item.amount} {item.token} → {item.to}
            </Text>
            <Text style={styles.detail}>
              Approvals {item.approvalWeight}/{item.quorumWeight} · {formatDeadline(item.deadlineTs)}
            </Text>
            {item.userHasApproved && <Text style={styles.approved}>✓ You approved</Text>}
            <PrimaryButton title="Review & approve" onPress={() => onOpen(item)} />
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16, paddingTop: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: colors.text, fontSize: 26, fontWeight: "700" },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 4 },
  error: { color: colors.danger, fontSize: 12, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  proposalId: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  description: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: 8 },
  detail: { color: colors.muted, fontSize: 12, marginTop: 6 },
  approved: { color: colors.success, fontSize: 12, marginTop: 6 },
  empty: { paddingVertical: 40, alignItems: "center" },
  emptyText: { color: colors.muted, fontSize: 14 },
});
