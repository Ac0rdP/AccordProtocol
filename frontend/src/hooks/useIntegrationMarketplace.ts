import { useCallback, useEffect, useState } from "react";
import {
  fetchIntegrationMarketplace,
  installIntegrationPlugin,
  uninstallIntegrationPlugin,
  type InstalledIntegration,
  type IntegrationPlugin,
} from "../lib/integrationMarketplace";

export type IntegrationMarketplaceState = {
  plugins: IntegrationPlugin[];
  installs: Record<string, InstalledIntegration>;
  loading: boolean;
  error: string | null;
  actionError: string | null;
  retry: () => void;
  install: (plugin: IntegrationPlugin, config: Record<string, string>) => Promise<void>;
  uninstall: (pluginId: string) => Promise<void>;
};

export function useIntegrationMarketplace(
  load = fetchIntegrationMarketplace,
): IntegrationMarketplaceState {
  const [plugins, setPlugins] = useState<IntegrationPlugin[]>([]);
  const [installs, setInstalls] = useState<Record<string, InstalledIntegration>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((res) => {
        if (cancelled) return;
        setPlugins(res.catalog);
        setInstalls(res.installs);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load integration marketplace");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setActionError(null);
    setAttempt((n) => n + 1);
  }, []);

  const install = useCallback(
    async (plugin: IntegrationPlugin, config: Record<string, string>) => {
      setActionError(null);
      try {
        const installed = await installIntegrationPlugin(plugin, config);
        setInstalls((prev) => ({ ...prev, [plugin.id]: installed }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : `Could not install ${plugin.name}`;
        setActionError(msg);
        throw err;
      }
    },
    [],
  );

  const uninstall = useCallback(async (pluginId: string) => {
    setActionError(null);
    try {
      await uninstallIntegrationPlugin(pluginId);
      setInstalls((prev) => {
        const next = { ...prev };
        delete next[pluginId];
        return next;
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not uninstall integration";
      setActionError(msg);
      throw err;
    }
  }, []);

  return {
    plugins,
    installs,
    loading,
    error,
    actionError,
    retry,
    install,
    uninstall,
  };
}
