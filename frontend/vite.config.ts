import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { buildSecurityHeaders } from "./security-headers.mjs";

export default defineConfig({
  // @ts-expect-error - Tailwind 4 types may mismatch with Vitest's Vite types
  plugins: [react(), tailwindcss()],
  server: {
    headers: buildSecurityHeaders({
      mode: "development",
      env: process.env,
      includeHsts: false,
    }),
  },
  preview: {
    headers: buildSecurityHeaders({
      mode: "production",
      env: process.env,
      includeHsts: true,
    }),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/visual/**",
    ],
  },
});
