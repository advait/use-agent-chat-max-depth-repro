import { routeAgentRequest } from "agents";

import { TraceReplayAgent } from "./replay-agent";
import { SandboxTimeoutSweepAgent } from "./sweep-agent";

export { TraceReplayAgent, SandboxTimeoutSweepAgent };

export default {
  async fetch(request, env) {
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    return new Response("Not found", { status: 404 });
  },
};
