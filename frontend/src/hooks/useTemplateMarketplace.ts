import { useCallback, useEffect, useState } from "react";
import {
  fetchMarketplaceTemplates,
  installMarketplaceTemplate,
  reconcileInstalls,
  uninstallMarketplaceTemplate,
  type InstalledMarketplaceTemplate,
  type MarketplaceTemplate,
} from "../lib/templateMarketplace";

export type TemplateMarketplaceState = {
  templates: MarketplaceTemplate[];
  installs: Record<string, InstalledMarketplaceTemplate>;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Throws a user-facing error when the template cannot be saved. */
  install: (template: MarketplaceTemplate) => void;
  uninstall: (marketplaceId: string) => void;
};

export function useTemplateMarketplace(
  load: () => Promise<MarketplaceTemplate[]> = fetchMarketplaceTemplates,
): TemplateMarketplaceState {
  const [templates, setTemplates] = useState<MarketplaceTemplate[]>([]);
  const [installs, setInstalls] = useState(() => reconcileInstalls());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((catalog) => {
        if (cancelled) return;
        setTemplates(catalog);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load templates");
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
    setAttempt((n) => n + 1);
  }, []);

  const install = useCallback((template: MarketplaceTemplate) => {
    installMarketplaceTemplate(template);
    setInstalls(reconcileInstalls());
  }, []);

  const uninstall = useCallback((marketplaceId: string) => {
    uninstallMarketplaceTemplate(marketplaceId);
    setInstalls(reconcileInstalls());
  }, []);

  return { templates, installs, loading, error, retry, install, uninstall };
}
