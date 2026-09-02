/**
 * Claude-specific event normalization
 * Handles Claude's tool_use format: { tool_name: string, tool_input: object }
 */
import type { HallpassEvent } from "../core/types.js";
import { buildAction, extractPackageInfo, extractGitSubcommand, isGitCommand, isPackageManagerCommand, categorizeGitCommand, buildFileWriteAction } from "./helpers.js";

export interface ClaudePayload {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    command?: string;
    file_path?: string;
    content?: string;
    explanation?: string;
    tool_context?: Record<string, unknown>;
}

function normalizeShellCommand(command: string, baseId: string, baseTimestamp: string, cwd: string, reasoning: string): HallpassEvent {
    if (isGitCommand(command)) {
        const { subcommand, ref } = extractGitSubcommand(command);
        const gitCategory = categorizeGitCommand(subcommand);
        return {
            id: baseId,
            type: "shell.execute",
            timestamp: baseTimestamp,
            adapter: "claude",
            workingDirectory: cwd,
            command,
            metadata: { command, isGit: true, subcommand, gitSubcommand: subcommand },
            action: buildAction(gitCategory, { target: ref ?? command, intent: subcommand, impact: "remote" }),
        };
    }

    if (isPackageManagerCommand(command)) {
        const pkgInfo = extractPackageInfo(command);
        const pkg = pkgInfo.package || "";
        const isAdd = pkgInfo.action === "add";

        return {
            id: baseId,
            type: "shell.execute",
            timestamp: baseTimestamp,
            adapter: "claude",
            workingDirectory: cwd,
            command,
            metadata: { command, isPackageManager: true, package: pkg, packageManager: pkgInfo.manager },
            action: buildAction(isAdd ? "dependency.add" : "dependency.remove", {
                target: pkg,
                intent: isAdd ? "install" : "uninstall",
                impact: "shared",
            }),
        };
    }

    return {
        id: baseId,
        type: "shell.execute",
        timestamp: baseTimestamp,
        adapter: "claude",
        workingDirectory: cwd,
        command,
        metadata: { command, reasoning },
        action: buildAction("shell.command", { target: command.split(/\s+/)[0] ?? "", intent: "execute", impact: "local" }),
    };
}

/**
 * Enhance Claude payload with tool context for better categorization
 */
export function normalizeClaudeEvent(payload: ClaudePayload, baseId: string, baseTime: number, cwd: string): HallpassEvent {
    const toolName = payload.tool_name || "Unknown";
    const toolInput = payload.tool_input || payload;
    const filePath: string = String(toolInput.file_path ?? payload.file_path ?? "");
    const command: string = String(toolInput.command ?? payload.command ?? "");
    const content: string = String(toolInput.content ?? payload.content ?? "");
    const explanation = (payload.explanation || toolInput.explanation || "") as string;
    const baseTimestamp = new Date(baseTime).toISOString();

    // Extract Claude tool context for richer categorization
    const toolContext = payload.tool_context || {};
    const reasoning = explanation || String(toolContext.reasoning || "");

    // Shell execution
    if (toolName === "Bash" || toolName === "ShellCommand" || toolName === "ExecuteCommand") {
        return normalizeShellCommand(command, baseId, baseTimestamp, cwd, reasoning);
    }

    // File operations
    if (toolName === "Write" || toolName === "CreateFile") {
        return {
            id: baseId,
            type: "file.write",
            timestamp: baseTimestamp,
            adapter: "claude",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, content },
            action: buildFileWriteAction(filePath, "create", "file.create"),
        };
    }

    if (toolName === "Edit" || toolName === "ModifyFile") {
        return {
            id: baseId,
            type: "file.write",
            timestamp: baseTimestamp,
            adapter: "claude",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, content },
            action: buildFileWriteAction(filePath, "modify", "file.modify"),
        };
    }

    if (toolName === "Delete" || toolName === "RemoveFile") {
        return {
            id: baseId,
            type: "file.delete",
            timestamp: baseTimestamp,
            adapter: "claude",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath },
            action: buildAction("file.delete", { target: filePath, intent: "delete", impact: "local" }),
        };
    }

    // Command handling when no specific tool is identified
    if (command) {
        const fallbackReasoning = (toolInput as Record<string, unknown>).reasoning || (payload as Record<string, unknown>).reasoning || "";
        return normalizeShellCommand(command, baseId, baseTimestamp, cwd, String(fallbackReasoning));
    }

    // Fallback
    return {
        id: baseId,
        type: "tool.action",
        timestamp: baseTimestamp,
        adapter: "claude",
        workingDirectory: cwd,
        metadata: { toolName, toolInput, reasoning },
    };
}
