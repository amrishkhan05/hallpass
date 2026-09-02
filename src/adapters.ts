import type { AdapterCapabilities, HallpassEvent, ShellActionEvent, Violation } from "./core/types.js";
import type { HallpassRule } from "./core/types.js";
import { fingerprint } from "./utils.js";

export const capabilities: Record<string, AdapterCapabilities> = {
  generic: { instructionScan: true, preActionGuard: false, shellGuard: false, diffVerification: true, completionGate: true, approvalIntegration: true },
  claude: { instructionScan: true, preActionGuard: true, shellGuard: true, diffVerification: true, completionGate: true, approvalIntegration: true },
  cursor: { instructionScan: true, preActionGuard: true, shellGuard: true, diffVerification: true, completionGate: "partial", approvalIntegration: true },
  codex: { instructionScan: true, preActionGuard: "partial", shellGuard: true, diffVerification: true, completionGate: "partial", approvalIntegration: true },
  copilot: { instructionScan: true, preActionGuard: "partial", shellGuard: "partial", diffVerification: true, completionGate: "partial", approvalIntegration: "partial" },
};

export function normalizeEvent(adapter: string, payload: Record<string, unknown>, cwd: string): HallpassEvent {
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input as Record<string, unknown> : undefined;
  const input = payload.input && typeof payload.input === "object" ? payload.input as Record<string, unknown> : undefined;
  const command = String(payload.command ?? toolInput?.command ?? input?.command ?? "");
  if (command) return { id: fingerprint(adapter, payload), type: "shell.action", timestamp: new Date().toISOString(), adapter, workingDirectory: cwd, command } satisfies ShellActionEvent;
  return { id: fingerprint(adapter, payload), type: String(payload.type ?? "tool.action"), timestamp: new Date().toISOString(), adapter, workingDirectory: cwd, metadata: payload };
}

export function adapterResponse(adapter: string, findings: Violation[]): Record<string, unknown> {
  const blocked = findings.find((item) => item.decision === "block" || item.decision === "require-approval");
  const reason = blocked ? `${blocked.ruleId}: ${blocked.message}` : "Hallpass policy allows this action.";
  if (adapter === "cursor") return { permission: blocked ? "deny" : "allow", user_message: reason, agent_message: reason };
  if (adapter === "claude") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: blocked ? "deny" : "allow", permissionDecisionReason: reason } };
  return { decision: blocked ? "block" : "allow", reason, findings };
}

export function evaluateShell(event: ShellActionEvent, rules: HallpassRule[]): Violation[] {
  const coveredByProjectPolicy = rules.some((rule) => rule.detector.type === "shell-command" && rule.enforcement !== "allow" && rule.detector.commands?.some((command) => event.command.includes(command)));
  const builtIn = [
    ...(/\bhallpass\s+allow\b|\.hallpass\/approvals\.json/.test(event.command) ? [{ id: "GOV-APPROVAL", title: "Agents cannot grant their own approvals", classification: "deterministic", enforcement: "block", locked: true, detector: { type: "shell-command", commands: [event.command] } } satisfies HallpassRule] : []),
    ...(!coveredByProjectPolicy && /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--)(?:\s|$)/.test(event.command) ? [{ id: "GOV-GIT", title: "Destructive Git operations require human control", classification: "deterministic", enforcement: "block", locked: true, detector: { type: "shell-command", commands: [event.command] } } satisfies HallpassRule] : []),
  ];
  return [...builtIn, ...rules].filter((rule) => rule.detector.type === "shell-command").flatMap((rule) => {
    const matched = rule.detector.commands?.find((command) => event.command.includes(command));
    if (!matched || rule.enforcement === "allow") return [];
    const id = fingerprint(rule.id, event.command, matched);
    return [{ id, ruleId: rule.id, decision: rule.enforcement, classification: rule.classification, message: `${rule.title}: ${matched}`, category: "shell.denied", evidence: { command: event.command, matched }, remediation: "Use an allowed command or request approval.", fingerprint: id }];
  });
}
