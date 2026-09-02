import type { AdapterCapabilities, FileDeleteEvent, FileWriteEvent, HallpassEvent, ShellActionEvent, Violation, NormalizedAction } from "./core/types.js";
import type { HallpassRule } from "./core/types.js";
import { fingerprint } from "./utils.js";
import { normalizeClaudeEvent, type ClaudePayload } from "./adapters/claude.js";
import { normalizeCursorEvent, type CursorPayload } from "./adapters/cursor.js";
import { normalizeCopilotEvent, type CopilotPayload } from "./adapters/copilot.js";
import { normalizeCodexEvent, type CodexPayload } from "./adapters/codex.js";
import { isGitCommand, isPackageManagerCommand, isConfigFile, extractGitSubcommand, extractPackageInfo, buildAction, categorizeGitCommand } from "./adapters/helpers.js";

export const capabilities: Record<string, AdapterCapabilities> = {
  generic: {
    instructionScan: true, preActionGuard: false, shellGuard: false, diffVerification: true, completionGate: true, approvalIntegration: true,
    eventCoverage: { "shell.execute": true, "file.write": true, "file.delete": true, "dependency.add": "partial", "dependency.remove": "partial", "git.commit": "partial", "git.push": "partial", "config.modify": true, "workflow.modify": false },
  },
  claude: {
    instructionScan: true, preActionGuard: "partial", shellGuard: true, diffVerification: true, completionGate: true, approvalIntegration: true,
    eventCoverage: { "shell.execute": true, "file.write": true, "file.delete": true, "dependency.add": true, "dependency.remove": true, "git.commit": "partial", "git.push": "partial", "config.modify": true, "workflow.modify": false },
    hooks: { preToolHook: { integration: "native", reliability: "high" }, completionHook: { integration: "native", reliability: "high" } },
  },
  cursor: {
    instructionScan: true, preActionGuard: "partial", shellGuard: true, diffVerification: true, completionGate: "partial", approvalIntegration: true,
    eventCoverage: { "shell.execute": true, "file.write": true, "file.delete": true, "dependency.add": true, "dependency.remove": true, "git.commit": "partial", "git.push": "partial", "config.modify": true, "workflow.modify": false },
    hooks: { preToolHook: { integration: "native", reliability: "medium" } },
  },
  codex: {
    instructionScan: true, preActionGuard: "partial", shellGuard: true, diffVerification: true, completionGate: "partial", approvalIntegration: "partial",
    eventCoverage: { "shell.execute": true, "file.write": true, "file.delete": true, "dependency.add": "partial", "dependency.remove": "partial", "git.commit": false, "git.push": false, "config.modify": true, "workflow.modify": false },
    hooks: { preToolHook: { integration: "wrapper", reliability: "medium" } },
  },
  copilot: {
    instructionScan: true, preActionGuard: "partial", shellGuard: "partial", diffVerification: true, completionGate: "partial", approvalIntegration: "partial",
    eventCoverage: { "shell.execute": "partial", "file.write": true, "file.delete": true, "dependency.add": "partial", "dependency.remove": "partial", "git.commit": false, "git.push": false, "config.modify": "partial", "workflow.modify": false },
    hooks: { preToolHook: { integration: "wrapper", reliability: "low" } },
  },
};

export function normalizeEvent(adapter: string, payload: Record<string, unknown>, cwd: string): HallpassEvent {
  const baseId = fingerprint(adapter, payload);
  const baseTimestamp = new Date().toISOString();
  const baseTime = Date.now();

  // Dispatch to adapter-specific normalization
  if (adapter === "claude") {
    return normalizeClaudeEvent(payload as ClaudePayload, baseId, baseTime, cwd);
  }
  if (adapter === "cursor") {
    return normalizeCursorEvent(payload as CursorPayload, baseId, baseTime, cwd);
  }
  if (adapter === "copilot") {
    return normalizeCopilotEvent(payload as CopilotPayload, baseId, baseTime, cwd);
  }
  if (adapter === "codex") {
    return normalizeCodexEvent(payload as CodexPayload, baseId, baseTime, cwd);
  }

  // Fallback: generic normalization
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input as Record<string, unknown> : undefined;
  const input = payload.input && typeof payload.input === "object" ? payload.input as Record<string, unknown> : undefined;
  const toolName = String(payload.tool_name ?? payload.tool ?? "");
  const command = String(payload.command ?? toolInput?.command ?? input?.command ?? "");
  const filePath = String(payload.file_path ?? payload.path ?? toolInput?.file_path ?? toolInput?.path ?? input?.file_path ?? input?.path ?? "");
  const edits = payload.edits && Array.isArray(payload.edits) ? payload.edits as Record<string, unknown>[] : undefined;
  const editFilePath = edits?.[0] && typeof edits[0] === "object" ? String((edits[0] as Record<string, unknown>).file_path ?? (edits[0] as Record<string, unknown>).path ?? "") : "";

  // Shell commands take priority (can be git, npm, etc.)
  if (command) {
    const shellEvent: ShellActionEvent = {
      id: baseId,
      type: "shell.execute",
      timestamp: baseTimestamp,
      adapter,
      workingDirectory: cwd,
      command,
      action: buildAction("shell.command"),
    };

    // If it's a git command, add git-specific action info
    if (isGitCommand(command)) {
      const { subcommand, ref, remote } = extractGitSubcommand(command);
      const gitAction: NormalizedAction = { category: categorizeGitCommand(subcommand) };
      if (ref) gitAction.target = ref;
      shellEvent.action = gitAction;
      const metadata: Record<string, unknown> = { ...shellEvent.metadata, gitSubcommand: subcommand };
      if (remote) metadata.gitRemote = remote;
      shellEvent.metadata = metadata;
    }

    // If it's a package manager command, add dependency info
    if (isPackageManagerCommand(command)) {
      const { manager, action, package: pkg } = extractPackageInfo(command);
      const depAction: NormalizedAction = { category: action === "add" ? "dependency.add" : "dependency.remove" };
      if (pkg) depAction.target = pkg;
      shellEvent.action = depAction;
      const metadata: Record<string, unknown> = { ...shellEvent.metadata, packageManager: manager };
      if (pkg) metadata.package = pkg;
      shellEvent.metadata = metadata;
    }

    return shellEvent;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || (toolName === "Bash" && filePath)) {
    const target = filePath || editFilePath;
    if (target) {
      const event: FileWriteEvent = {
        id: baseId,
        type: "file.write",
        timestamp: baseTimestamp,
        adapter,
        workingDirectory: cwd,
        target,
        action: buildAction(isConfigFile(target) ? "config.modify" : "file.modify", { target }),
      };
      return event;
    }
  }
  if (toolName === "Delete" || toolName === "Remove") {
    const target = filePath;
    if (target) {
      const event: FileDeleteEvent = {
        id: baseId,
        type: "file.delete",
        timestamp: baseTimestamp,
        adapter,
        workingDirectory: cwd,
        target,
        action: buildAction("file.delete", { target }),
      };
      return event;
    }
  }
  return { id: baseId, type: String(payload.type ?? "tool.action"), timestamp: baseTimestamp, adapter, workingDirectory: cwd, metadata: payload };
}

/**
 * Validate adapter hook integration and capabilities.
 * Returns validation status and any issues found.
 */
export function validateAdapterHookIntegration(adapter: string): { isValid: boolean; issues: string[]; coverage: Record<string, string | boolean> } {
  const issues: string[] = [];
  const caps = capabilities[adapter];

  if (!caps) {
    issues.push(`Unknown adapter: ${adapter}`);
    return { isValid: false, issues, coverage: {} };
  }

  if (!caps.preActionGuard) {
    issues.push(`${adapter} has no preActionGuard support`);
  }

  if (!caps.shellGuard) {
    issues.push(`${adapter} has no shellGuard support`);
  }

  if (!caps.completionGate) {
    issues.push(`${adapter} has no completionGate support`);
  }

  const coverage: Record<string, string | boolean> = {};
  if (caps.eventCoverage) {
    Object.entries(caps.eventCoverage).forEach(([eventType, supported]) => {
      coverage[eventType] = supported;
    });
  }

  return { isValid: issues.length === 0, issues, coverage };
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
