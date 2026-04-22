import type { Config } from "@react-router/dev/config";

export default {
  routeDiscovery: {
    mode: "initial",
  },
  ssr: false,
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
