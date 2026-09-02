/**
 * Copilot-specific event normalization
 * Handles GitHub Copilot for VS Code with terminal integration
 */
import type { HallpassEvent } from "../core/types.js";
import { buildAction, extractPackageInfo, extractGitSubcommand, isGitCommand, isPackageManagerCommand, categorizeGitCommand, buildFileWriteAction } from "./helpers.js";

export interface CopilotPayload {
    type?: string;
    file_path?: string;
    content?: string;
    active_editor?: string;
    workspace_folder?: string;
    terminal_input?: string;
    command?: string;
    diagnostics?: unknown[];
    explanation?: string;
}

/**
 * Enhance Copilot payload with VS Code context
 */
export function normalizeCopilotEvent(payload: CopilotPayload, baseId: string, baseTime: number, cwd: string): HallpassEvent {
    const type = payload.type || "unknown";
    const filePath: string = String(payload.file_path ?? "");
    const content: string = String(payload.content ?? "");
    const terminalInput: string = String(payload.terminal_input ?? payload.command ?? "");
    const baseTimestamp = new Date(baseTime).toISOString();

    // VS Code context
    const activeEditor = payload.active_editor || "";
    const workspaceFolder = payload.workspace_folder || cwd;
    const diagnostics = payload.diagnostics || [];

    const vsCodeContext = {
        activeEditor,
        workspaceFolder,
        diagnosticCount: Array.isArray(diagnostics) ? diagnostics.length : 0,
    };

    // File operations
    if (type === "file.write" || type === "write" || type === "create") {
        const fileIntent = type === "create" ? "create" : "modify";

        return {
            id: baseId,
            type: "file.write",
            timestamp: baseTimestamp,
            adapter: "copilot",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, content, vsCodeContext },
            action: buildFileWriteAction(filePath, fileIntent, fileIntent === "create" ? "file.create" : "file.modify"),
        };
    }

    if (type === "file.delete" || type === "delete") {
        return {
            id: baseId,
            type: "file.delete",
            timestamp: baseTimestamp,
            adapter: "copilot",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, vsCodeContext },
            action: buildAction("file.delete", { target: filePath, intent: "delete", impact: "local" }),
        };
    }

    // Terminal input - better parsing for VS Code integration
    if (terminalInput) {
        const command = terminalInput.trim();

        if (isGitCommand(command)) {
            const { subcommand, ref } = extractGitSubcommand(command);
            const gitCategory = categorizeGitCommand(subcommand);
            return {
                id: baseId,
                type: "shell.execute",
                timestamp: baseTimestamp,
                adapter: "copilot",
                workingDirectory: cwd,
                command,
                metadata: { command, isGit: true, vsCodeContext },
                action: buildAction(gitCategory, { target: ref ?? command, intent: subcommand, impact: "remote", subtype: "partial" }),
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
                adapter: "copilot",
                workingDirectory: cwd,
                command,
                metadata: { command, isPackageManager: true, vsCodeContext },
                action: buildAction(isAdd ? "dependency.add" : "dependency.remove", { target: pkg, intent: isAdd ? "install" : "uninstall", impact: "shared", subtype: "partial" }),
            };
        }

        return {
            id: baseId,
            type: "shell.execute",
            timestamp: baseTimestamp,
            adapter: "copilot",
            workingDirectory: cwd,
            command,
            metadata: { command, vsCodeContext, explanation: payload.explanation },
            action: buildAction("shell.command", { target: command.split(/\s+/)[0] ?? "", intent: "execute", impact: "local", subtype: "partial" }),
        };
    }

    // Fallback
    return {
        id: baseId,
        type: "tool.action",
        timestamp: baseTimestamp,
        adapter: "copilot",
        workingDirectory: cwd,
        metadata: { type, vsCodeContext },
    };
}
