import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.piedro.learnpiano",
  appName: "Learn Piano",
  webDir: "dist/mobile",
  backgroundColor: "#16181d",
  android: { allowMixedContent: false },
};

export default config;
