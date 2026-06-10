/**
 * BFH (Bergfreunde Harness)
 *
 * Intake, state persistence, transition validation, and kickoff prompt.
 * Pi/the active model does implementation work with normal tools plus
 * Subagent scout/review and bfh_state for phase gates.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBfhAttentionNotifications } from "./attention.ts";
import { ensureBfhSubagentDefinitions } from "./bfh-agents.ts";
import { registerBfhCommands } from "./commands.ts";
import { registerBfhSafeMode } from "./safe-mode.ts";
import { registerBfhStateTool } from "./tool.ts";

export default function bfh(pi: ExtensionAPI) {
  registerBfhCommands(pi);
  registerBfhStateTool(pi);
  registerBfhAttentionNotifications(pi);
  registerBfhSafeMode(pi);

  pi.on("session_start", (_event, ctx) => {
    try {
      ensureBfhSubagentDefinitions(ctx.cwd);
    } catch {
      // Non-fatal — agents are also synced before each subagent run.
    }
  });
}
