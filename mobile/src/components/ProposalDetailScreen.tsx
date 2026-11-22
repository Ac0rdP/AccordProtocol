import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { formatDeadline } from "../lib/format";
import type { ApprovalState, PreparedApproval, Proposal } from "../lib/types";
import { Card, PrimaryButton, StatusBadge, colors } from "./ui";

export function ProposalDetailScreen({
  proposal,
  progress,
  pendingApproval,
  preparing,
  error,
  onBack,
  onApprove,
  onSubmitSigned,
}: {
  proposal: Proposal;
  progress: ApprovalState | null;
  pendingApproval: PreparedApproval | null;
  preparing: boolean;
  error: string | null;
  onBack: () => void;
  onApprove: () => void;
  onSubmitSigned: (signedXdr: string) => void;
}) {
  const [signedXdr, setSignedXdr] = useState("");

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <PrimaryButton title="← Back to proposals" tone="ghost" onPress={onBack} />
      <Card>
        <View style={styles.row}>
          <Text style={styles.title}>Proposal #{proposal.id}</Text>
          <StatusBadge status={proposal.status} />
        </View>
        <Text style={styles.description}>{proposal.description || "No description"}</Text>
        <Info label="Type" value={proposal.kind.replace(/_/g, " ")} />
        <Info label="Amount" value={`${proposal.amount} ${proposal.token}`} />
        <Info label="Recipient" value={proposal.to} />
        <Info label="Proposed by" value={proposal.proposer} />
        <Info label="Deadline" value={formatDeadline(proposal.deadlineTs)} />
        <Info
          label="Approvals"
          value={`${progress?.approvalWeight ?? proposal.approvalWeight} / ${
            progress?.quorumWeight ?? proposal.quorumWeight
          } (total weight ${progress?.totalWeight ?? "—"})`}
        />
      </Card>

      {error && <Text style={styles.error}>{error}</Text>}

      {!pendingApproval ? (
        <PrimaryButton
          title={
            preparing
              ? "Preparing approval…"
              : proposal.userHasApproved
                ? "You already approved"
                : "Open wallet to approve"
          }
          onPress={onApprove}
          disabled={preparing || proposal.userHasApproved || proposal.status !== "pending" && proposal.status !== "ready"}
        />
      ) : (
        <Card>
          <Text style={styles.heading}>Waiting for your wallet</Text>
          <Text style={styles.body}>
            Your wallet should have opened with the approval transaction. Sign it there, then return
            here — the signed result is sent back automatically. You can also paste the signed XDR
            below if your wallet does not support return links.
          </Text>
          <TextInput
            accessibilityLabel="Signed transaction XDR"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholder="Signed transaction XDR (base64)"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={signedXdr}
            onChangeText={setSignedXdr}
          />
          <PrimaryButton
            title="Submit signed approval"
            onPress={() => onSubmitSigned(signedXdr.trim())}
            disabled={!signedXdr.trim()}
          />
        </Card>
      )}
    </ScrollView>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 40 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  description: { color: colors.text, fontSize: 15, marginTop: 12, lineHeight: 21 },
  heading: { color: colors.text, fontSize: 17, fontWeight: "600" },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  infoLabel: { color: colors.muted, fontSize: 13 },
  infoValue: { color: colors.text, fontSize: 13, maxWidth: "65%", textAlign: "right" },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.surfaceAlt,
    backgroundColor: colors.background,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    marginTop: 14,
    minHeight: 90,
    fontFamily: "monospace",
  },
});
