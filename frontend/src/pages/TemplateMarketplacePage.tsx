import { PageState } from "../components/PageState";
import { TemplateMarketplace } from "../components/TemplateMarketplace";
import { useTemplateMarketplace } from "../hooks/useTemplateMarketplace";

/** Browse and install community proposal templates. */
export function TemplateMarketplacePage() {
  const { templates, installs, loading, error, retry, install, uninstall } =
    useTemplateMarketplace();

  let body;
  if (loading) {
    body = <PageState status="loading" title="Loading template marketplace…" />;
  } else if (error) {
    body = (
      <PageState
        status="error"
        title="Could not load the template marketplace"
        description={error}
        onRetry={retry}
      />
    );
  } else if (templates.length === 0) {
    body = (
      <PageState
        status="empty"
        title="No community templates yet"
        description="Published templates will appear here once the catalog has entries."
      />
    );
  } else {
    body = (
      <TemplateMarketplace
        templates={templates}
        installs={installs}
        onInstall={install}
        onUninstall={uninstall}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Template marketplace</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Browse community proposal templates, preview what they pre-fill, and install them into
          your New Proposal template picker.
        </p>
      </header>
      {body}
    </div>
  );
}
