import { createRequestHandler } from "react-router";

import { TraceReplayAgent } from "./replay-agent";

export { TraceReplayAgent };

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env) {
    const { routeAgentRequest } = await import("agents");
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    return requestHandler(request, {});
  },
} satisfies ExportedHandler<Env>;
