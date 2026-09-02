/**
 * Cursor-specific event normalization
 * Handles Cursor's integrated editor model with file context
 */
import type { HallpassEvent } from "../core/types.js";
import { buildAction, extractPackageInfo, extractGitSubcommand, isGitCommand, isPackageManagerCommand, categorizeGitCommand, buildFileWriteAction } from "./helpers.js";

export interface CursorPayload {
    tool_name?: string;
    file_path?: string;
    content?: string;
    selected_files?: string[];
    expanded_folders?: string[];
    open_tabs?: string[];
    editor_selection?: { start: number; end: number };
    reasoning?: string;
}

/**
 * Enhance Cursor payload with editor context
 */
export function normalizeCursorEvent(payload: CursorPayload, baseId: string, baseTime: number, cwd: string): HallpassEvent {
    const toolName = payload.tool_name || "Unknown";
    const filePath: string = String(payload.file_path ?? "");
    const content: string = String(payload.content ?? "");
    const baseTimestamp = new Date(baseTime).toISOString();

    // Use Cursor editor context to improve action detection
    const selectedFiles = payload.selected_files || [];
    const openTabs = payload.open_tabs || [];
    const reasoning = payload.reasoning || "";

    // Cursor-specific: Check selected files for context
    const workspaceContext = {
        selectedFiles,
        openTabs,
        currentFile: filePath,
    };

    // File operations
    if (toolName === "Write" || toolName === "CreateFile" || toolName === "EditFile") {
        const fileIntent = toolName === "CreateFile" ? "create" : "modify";

        return {
            id: baseId,
            type: "file.write",
            timestamp: baseTimestamp,
            adapter: "cursor",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, content, workspaceContext, reasoning },
            action: buildFileWriteAction(filePath, fileIntent, fileIntent === "create" ? "file.create" : "file.modify"),
        };
    }

    if (toolName === "Delete" || toolName === "DeleteFile") {
        return {
            id: baseId,
            type: "file.delete",
            timestamp: baseTimestamp,
            adapter: "cursor",
            workingDirectory: cwd,
            target: filePath,
            metadata: { filePath, workspaceContext, reasoning },
            action: buildAction("file.delete", { target: filePath, intent: "delete", impact: "local" }),
        };
    }

    if (toolName === "Terminal" || toolName === "Shell" || toolName === "Bash") {
        const command = content || "";

        if (isGitCommand(command)) {
            const { subcommand, ref } = extractGitSubcommand(command);
            const gitCategory = categorizeGitCommand(subcommand);
            return {
                id: baseId,
                type: "shell.execute",
                timestamp: baseTimestamp,
                adapter: "cursor",
                workingDirectory: cwd,
                command,
                metadata: { command, isGit: true, workspaceContext },
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
                adapter: "cursor",
                workingDirectory: cwd,
                command,
                metadata: { command, isPackageManager: true, workspaceContext },
                action: buildAction(isAdd ? "dependency.add" : "dependency.remove", { target: pkg, intent: isAdd ? "install" : "uninstall", impact: "shared" }),
            };
        }

        return {
            id: baseId,
            type: "shell.execute",
            timestamp: baseTimestamp,
            adapter: "cursor",
            workingDirectory: cwd,
            command,
            metadata: { command, workspaceContext, reasoning },
            action: buildAction("shell.command", { target: command.split(/\s+/)[0] ?? "", intent: "execute", impact: "local" }),
        };
    }

    // Fallback
    return {
        id: baseId,
        type: "tool.action",
        timestamp: baseTimestamp,
        adapter: "cursor",
        workingDirectory: cwd,
        metadata: { toolName, workspaceContext, reasoning },
    };
}
