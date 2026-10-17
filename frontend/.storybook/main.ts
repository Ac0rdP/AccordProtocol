import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const storybookDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(storybookDir, "../src");

const config: StorybookConfig = {
  stories: ["../src/components/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  async viteFinal(viteConfig) {
    viteConfig.plugins = viteConfig.plugins ?? [];
    viteConfig.plugins.push(tailwindcss());

    const mocksDir = path.resolve(storybookDir, "./mocks");
    viteConfig.resolve = viteConfig.resolve ?? {};
    const existingAlias = viteConfig.resolve.alias;
    const aliasEntries: Record<string, string> = {
      [path.resolve(srcDir, "lib/contract.ts")]: path.resolve(
        mocksDir,
        "contract.ts",
      ),
      [path.resolve(srcDir, "hooks/useRecurringPayments.ts")]: path.resolve(
        mocksDir,
        "useRecurringPayments.ts",
      ),
    };

    if (Array.isArray(existingAlias)) {
      viteConfig.resolve.alias = [
        ...existingAlias,
        ...Object.entries(aliasEntries).map(([find, replacement]) => ({
          find,
          replacement,
        })),
      ];
    } else {
      viteConfig.resolve.alias = {
        ...(existingAlias as Record<string, string> | undefined),
        ...aliasEntries,
      };
    }

    return viteConfig;
  },
};

export default config;
