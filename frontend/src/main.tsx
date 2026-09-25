import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";
import { LandingPage } from "./pages/LandingPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/proposals/:id" element={<App />} />
        <Route path="/app/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
