import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { config } from "./src/config";
import { ConnectScreen } from "./src/components/ConnectScreen";
import { ProposalDetailScreen } from "./src/components/ProposalDetailScreen";
import { ProposalListScreen } from "./src/components/ProposalListScreen";
import { colors } from "./src/components/ui";
import { AccordMobileClient } from "./src/lib/contract";
import { clearSession, loadSession, saveSession } from "./src/lib/session";
import { secureSessionStorage } from "./src/lib/sessionStorage";
import type { ApprovalState, PreparedApproval, Proposal, WalletSession } from "./src/lib/types";
import { buildStellarTxUri, parseWalletCallback, verifySignedTransaction } from "./src/lib/wallet";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const client = useMemo(() => new AccordMobileClient(config), []);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [progress, setProgress] = useState<ApprovalState | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PreparedApproval | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const pendingRef = useRef<PreparedApproval | null>(null);
  pendingRef.current = pendingApproval;

  const refreshProposals = useCallback(
    async (owner: string) => {
      setLoading(true);
      setListError(null);
      try {
        const items = await client.getProposals();
        const enriched = await Promise.all(
          items.map(async (proposal) => ({
            ...proposal,
            userHasApproved: await client.hasApproved(owner, proposal.id),
          })),
        );
        setProposals(enriched);
      } catch (error) {
        setListError(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    loadSession(secureSessionStorage)
      .then((stored) => {
        if (!cancelled) setSession(stored);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session) void refreshProposals(session.address);
  }, [session, refreshProposals]);

  const connect = useCallback(async (address: string) => {
    setConnectError(null);
    try {
      const next: WalletSession = { address, connectedAt: Date.now() };
      await saveSession(next, secureSessionStorage);
      setSession(next);
    } catch (error) {
      setConnectError(errorMessage(error));
    }
  }, []);

  const disconnect = useCallback(() => {
    void clearSession(secureSessionStorage);
    setSession(null);
    setProposals([]);
    setSelected(null);
    setPendingApproval(null);
  }, []);

  const openProposal = useCallback(
    async (proposal: Proposal) => {
      setSelected(proposal);
      setApproveError(null);
      setPendingApproval(null);
      try {
        setProgress(await client.getApprovalState(proposal.id));
      } catch {
        setProgress(null);
      }
    },
    [client],
  );

  const startApproval = useCallback(async () => {
    if (!session || !selected) return;
    setPreparing(true);
    setApproveError(null);
    try {
      const prepared = await client.prepareApproval(selected.id, session.address);
      setPendingApproval(prepared);
      const uri = buildStellarTxUri({
        xdr: prepared.xdr,
        callback: config.walletCallbackUrl,
        message: `Approve Accord proposal #${selected.id}`,
      });
      const canOpen = await Linking.canOpenURL(uri);
      if (!canOpen) {
        setApproveError("No Stellar wallet responded. Paste the signed XDR after signing in your wallet.");
        return;
      }
      await Linking.openURL(uri);
    } catch (error) {
      setApproveError(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  }, [client, selected, session]);

  const submitSigned = useCallback(
    async (signedXdr: string) => {
      const prepared = pendingRef.current;
      if (!prepared || !session) return;
      setApproveError(null);
      if (!verifySignedTransaction(prepared.xdr, signedXdr, config.networkPassphrase)) {
        setApproveError("The signed transaction does not match the approval you reviewed.");
        return;
      }
      try {
        await client.submitApproval(signedXdr, prepared.hash);
        setPendingApproval(null);
        setSelected(null);
        await refreshProposals(session.address);
      } catch (error) {
        setApproveError(errorMessage(error));
      }
    },
    [client, refreshProposals, session],
  );

  useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => {
      const result = parseWalletCallback(url);
      if (result.error) setApproveError(`Wallet: ${result.error}`);
      if (result.signedXdr) void submitSigned(result.signedXdr);
    };
    const subscription = Linking.addEventListener("url", handleUrl);
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });
    return () => subscription.remove();
  }, [submitSigned]);

  if (booting) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <ConnectScreen onConnect={connect} error={connectError} />
      </View>
    );
  }

  if (selected) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <ProposalDetailScreen
          proposal={selected}
          progress={progress}
          pendingApproval={pendingApproval}
          preparing={preparing}
          error={approveError}
          onBack={() => {
            setSelected(null);
            setPendingApproval(null);
            setApproveError(null);
          }}
          onApprove={() => void startApproval()}
          onSubmitSigned={(xdr) => void submitSigned(xdr)}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ProposalListScreen
        proposals={proposals}
        loading={loading}
        error={listError}
        address={session.address}
        onRefresh={() => void refreshProposals(session.address)}
        onOpen={(proposal) => void openProposal(proposal)}
        onDisconnect={disconnect}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
});
