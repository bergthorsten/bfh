/**
 * Lean BFH (Bergfreunde Harness) POC
 *
 * Intake, state persistence, transition validation, and kickoff prompt.
 * Pi/the active model does implementation work with normal tools plus
 * Subagent scout/review and bfh_state for phase gates.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerLeanBfhCommands } from "./commands.ts";
import { registerBfhStateTool } from "./tool.ts";

export default function leanBfh(pi: ExtensionAPI) {
  registerLeanBfhCommands(pi);
  registerBfhStateTool(pi);
}
