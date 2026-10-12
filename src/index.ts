import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { parseSettings } from "./config.js";
import { createProvider, PROVIDER_ID } from "./provider.js";

type ConfigSnapshot = { plugins?: { entries?: Record<string, { config?: unknown } | undefined> } };

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "System One",
  description: "Typed decision provider for any System One server.",
  register(api) {
    // Read the live config on every call so Settings changes apply without re-registering.
    const current = () => (api.runtime.config.current() as ConfigSnapshot).plugins?.entries?.[PROVIDER_ID]?.config ?? api.pluginConfig;
    api.registerDecisionProvider(
      createProvider({
        getSettings: () => parseSettings(current()),
        readPreparedKey: () => getPreparedPluginSecretInput(PROVIDER_ID, "apiKey").value,
        warn: (message) => api.logger.warn(message),
      }),
    );
  },
});
