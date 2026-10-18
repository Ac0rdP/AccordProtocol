import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";
import { LandingPage } from "./pages/LandingPage.tsx";

import { installPreviewSeed } from "./lib/previewSeed";
import { registerServiceWorker } from "./lib/pwa";

registerServiceWorker();

// Preview deployments inject seeded analytics data before the app renders. In
// every other build `installPreviewSeed` resolves immediately and this is a
// no-op, so startup is unaffected.
void (async () => {
  await installPreviewSeed();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/onboarding" element={<App />} />
          <Route path="/proposals/:id" element={<App />} />
          <Route path="/app/*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>
  );
})();
