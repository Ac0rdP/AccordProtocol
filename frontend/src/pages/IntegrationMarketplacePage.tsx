import { IntegrationMarketplace } from "../components/IntegrationMarketplace";
import { PageState } from "../components/PageState";
import { useIntegrationMarketplace } from "../hooks/useIntegrationMarketplace";

/** Browse and install reviewed notifications, accounting, and treasury automation integrations. */
export function IntegrationMarketplacePage() {
  const { plugins, installs, loading, error, actionError, retry, install, uninstall } =
    useIntegrationMarketplace();

  let body;
  if (loading) {
    body = <PageState status="loading" title="Loading integration marketplace…" />;
  } else if (error) {
    body = (
      <PageState
        status="error"
        title="Could not load the integration marketplace"
        description={error}
        onRetry={retry}
      />
    );
  } else if (plugins.length === 0) {
    body = (
      <PageState
        status="empty"
        title="No reviewed integrations available"
        description="Reviewed integrations for notifications, accounting, and treasury automation will appear here."
      />
    );
  } else {
    body = (
      <IntegrationMarketplace
        plugins={plugins}
        installs={installs}
        actionError={actionError}
        onInstall={install}
        onUninstall={uninstall}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">
          Integration marketplace
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Install reviewed integrations for notifications, accounting, and treasury automation.
          Every integration declares explicit permissions and data boundaries.
        </p>
      </header>
      {body}
    </div>
  );
}
