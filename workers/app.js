import { routeAgentRequest } from "agents";

import { TraceReplayAgent } from "./replay-agent";

export { TraceReplayAgent };

export default {
  async fetch(request, env) {
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    return new Response("Not found", { status: 404 });
  },
};
