/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { ExtensionContext, Position, Range, TextEditor, Uri, l10n, workspace } from "vscode";
import { BookmarkMarkdownGuide, getBookmarkMarkdownUri } from "../bookmarksJson/bookmarkMarkdownGuide";
import { BookmarksJsonLoader, getBookmarksJsonUri } from "../bookmarksJson/bookmarksJsonLoader";
import { BookmarksJsonWriter } from "../bookmarksJson/bookmarksJsonWriter";
import { getRelativePath } from "../utils/fs";
import { ReferenceIndex } from "../references/referenceIndex";
import { ReferenceLocation, ReferenceProblem } from "../references/referenceModel";
import { REFERENCE_SOURCE_GLOB, ReferenceScanner } from "../references/referenceScanner";
import { normalizeReferenceId, parseReferenceInput } from "../references/referenceParser";
import { ReferenceTreeProvider } from "../views/referenceTreeProvider";
import { ReferenceTreeItem } from "../views/referenceTreeItem";

const REFERENCE_HIGHLIGHT_TIMEOUT = 1200;

export function registerBookmarksAI(context: ExtensionContext): ReferenceTreeProvider {
    const index = new ReferenceIndex();
    const bookmarkMarkdownGuide = new BookmarkMarkdownGuide();
    const loader = new BookmarksJsonLoader();
    const writer = new BookmarksJsonWriter();
    const scanner = new ReferenceScanner();
    const provider = new ReferenceTreeProvider(index);
    const controller = new BookmarksAIController(index, bookmarkMarkdownGuide, loader, writer, scanner, provider);

    context.subscriptions.push(
        controller,
        vscode.commands.registerCommand("bookmarksAI.refreshProjectIndex", (showMessage = true) => controller.refresh(showMessage !== false)),
        vscode.commands.registerCommand("bookmarksAI.updateProjectFiles", () => controller.updateProjectFiles()),
        vscode.commands.registerCommand("bookmarksAI.showReferencesForCurrentLine", () => controller.showReferencesForCurrentLine()),
        vscode.commands.registerCommand("bookmarksAI.addReferenceToCurrentLocation", () => controller.addReferenceToCurrentLocation()),
        vscode.commands.registerCommand("bookmarksAI.removeReference", () => controller.removeReference()),
        vscode.commands.registerCommand("bookmarksAI.openBookmarksJson", () => controller.openBookmarksJson()),
        vscode.commands.registerCommand("bookmarksAI.openBookmarkGuide", () => controller.openBookmarkGuide()),
        vscode.commands.registerCommand("bookmarksAI.validateProjectReferences", () => controller.validateProjectReferences()),
        vscode.commands.registerCommand("bookmarksAI.copyReferencePath", (item?: ReferenceTreeItem) => controller.copyReferencePath(item)),
        vscode.commands.registerCommand("bookmarksAI.agentFillBookmarks", () => controller.openAgentFillBookmarks()),
        vscode.commands.registerCommand("bookmarksAI.agentScanCode", () => controller.openAgentScanCode()),
        vscode.commands.registerCommand("_bookmarksAI.revealLocation", (target: ReferenceLocation | ReferenceProblem) => revealLocation(target))
    );

    controller.start();
    return provider;
}

class BookmarksAIController implements vscode.Disposable {

    private readonly disposables: vscode.Disposable[] = [];
    private readonly pendingFileScans = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly index: ReferenceIndex,
        private readonly bookmarkMarkdownGuide: BookmarkMarkdownGuide,
        private readonly loader: BookmarksJsonLoader,
        private readonly writer: BookmarksJsonWriter,
        private readonly scanner: ReferenceScanner,
        private readonly provider: ReferenceTreeProvider
    ) {
    }

    public start(): void {
        this.registerWatchers();
        this.refresh(false);
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        for (const timeout of this.pendingFileScans.values()) {
            clearTimeout(timeout);
        }

        this.pendingFileScans.clear();
    }

    public async refresh(showMessage: boolean): Promise<void> {
        await this.loadProjectIndex();
        this.provider.refresh();

        if (showMessage) {
            vscode.window.showInformationMessage(l10n.t(
                "Bookmarks AI index refreshed: {0} locations, {1} problems",
                this.index.getLocations().length,
                this.index.getProblems().length
            ));
        }
    }

    public async updateProjectFiles(): Promise<void> {
        try {
            await this.loadProjectIndex();
            await this.bookmarkMarkdownGuide.ensureAll();
            await this.writer.saveAnnotationLocations(this.index.getAnnotationLocations());

            const jsonResult = await this.loader.load();
            this.index.replaceJson(jsonResult.groups, jsonResult.locations, jsonResult.problems);
            this.provider.refresh();

            vscode.window.showInformationMessage(l10n.t(
                "Bookmarks AI project files updated: {0} locations, {1} problems",
                this.index.getLocations().length,
                this.index.getProblems().length
            ));
        } catch (error) {
            vscode.window.showErrorMessage(l10n.t("Unable to update Bookmarks AI project files: {0}", getErrorMessage(error)));
        }
    }

    public async validateProjectReferences(): Promise<void> {
        await this.refresh(false);

        const problemCount = this.index.getProblems().length;
        if (problemCount === 0) {
            vscode.window.showInformationMessage(l10n.t("Bookmarks AI validation complete: no problems found"));
            return;
        }

        vscode.window.showWarningMessage(l10n.t("Bookmarks AI validation complete: {0} problem(s) found", problemCount));
    }

    public async openBookmarksJson(): Promise<void> {
        const workspaceFolder = getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            vscode.window.showInformationMessage(l10n.t("Open a folder first to use Bookmarks AI"));
            return;
        }

        const uri = getBookmarksJsonUri(workspaceFolder);
        if (!await uriExists(uri)) {
            vscode.window.showInformationMessage(l10n.t("{0} has not been created yet. Run Bookmarks AI: Update Bookmark Files to create it.", "bookmarks.json"));
            return;
        }

        const document = await workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
    }

    public async openBookmarkGuide(): Promise<void> {
        const workspaceFolder = getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            vscode.window.showInformationMessage(l10n.t("Open a folder first to use Bookmarks AI"));
            return;
        }

        const uri = getBookmarkMarkdownUri(workspaceFolder);
        if (!await uriExists(uri)) {
            vscode.window.showInformationMessage(l10n.t("{0} has not been created yet. Run Bookmarks AI: Update Bookmark Files to create it.", "bookmark.md"));
            return;
        }

        const document = await workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
    }

    public async showReferencesForCurrentLine(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(l10n.t("Open a file first to use Bookmarks AI"));
            return;
        }

        const locations = this.index.getLocationsAt(editor.document.uri, editor.selection.active.line + 1);
        const refs = unique(locations.flatMap(location => location.refs));

        if (refs.length === 0) {
            vscode.window.showInformationMessage(l10n.t("No references found at the current line"));
            return;
        }

        const groups = this.index.getGroups();
        const items = refs.map(ref => ({
            label: groups.get(ref)?.title ?? ref,
            detail: ref
        }));

        await vscode.window.showQuickPick(items, {
            placeHolder: l10n.t("References for current line")
        });
    }

    public async addReferenceToCurrentLocation(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(l10n.t("Open a file first to use Bookmarks AI"));
            return;
        }

        const value = await vscode.window.showInputBox({
            prompt: l10n.t("Reference names"),
            placeHolder: l10n.t("Type reference IDs separated by commas")
        });

        if (typeof value === "undefined") {
            return;
        }

        const parsed = parseReferenceInput(value);
        if (parsed.invalidRefs.length > 0 || parsed.refs.length === 0) {
            const firstInvalidRef = parsed.invalidRefs[ 0 ];
            const message = firstInvalidRef
                ? l10n.t("Invalid reference {0}: {1}", firstInvalidRef.value, firstInvalidRef.reason)
                : l10n.t("Invalid reference: {0}", value);
            vscode.window.showWarningMessage(message);
            return;
        }

        const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            vscode.window.showInformationMessage(l10n.t("Open a workspace file first to use Bookmarks AI"));
            return;
        }

        const line = editor.selection.active.line + 1;
        const column = editor.selection.active.character + 1;
        const file = getRelativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);
        const location: ReferenceLocation = {
            id: `${workspaceFolder.uri.toString()}:manual:${file}:${line}:${column}`,
            file,
            line,
            column,
            label: getBookmarkLabel(editor),
            refs: parsed.refs,
            source: "manual",
            workspaceFolder,
            uri: editor.document.uri
        };

        try {
            await this.writer.saveManualLocation(location);
            await this.reloadBookmarksJson();
            this.provider.refresh();
            vscode.window.showInformationMessage(l10n.t("Saved bookmark metadata to bookmarks.json"));
        } catch (error) {
            vscode.window.showErrorMessage(l10n.t("Unable to save bookmarks.json: {0}", getErrorMessage(error)));
        }
    }

    public async removeReference(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(l10n.t("Open a file first to use Bookmarks AI"));
            return;
        }

        const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            vscode.window.showInformationMessage(l10n.t("Open a workspace file first to use Bookmarks AI"));
            return;
        }

        const line = editor.selection.active.line + 1;
        const file = getRelativePath(workspaceFolder.uri.fsPath, editor.document.uri.fsPath);

        try {
            const removedCount = await this.writer.removeManualBookmarksAtLocation(workspaceFolder, file, line);
            if (removedCount > 0) {
                await this.reloadBookmarksJson();
                this.provider.refresh();
                vscode.window.showInformationMessage(l10n.t("Removed {0} bookmarks.json bookmark(s)", removedCount));
                return;
            }
        } catch (error) {
            vscode.window.showErrorMessage(l10n.t("Unable to save bookmarks.json: {0}", getErrorMessage(error)));
            return;
        }

        const sourceLocations = this.index.getLocationsAt(editor.document.uri, line)
            .filter(location => location.source === "annotation");
        if (sourceLocations.length > 0) {
            vscode.window.showInformationMessage(l10n.t("This bookmark comes from a source @ref annotation. Source files are read-only for this extension; edit the comment manually if you want to remove it."));
            return;
        }

        vscode.window.showInformationMessage(l10n.t("No removable bookmarks.json bookmark found at the current line"));
    }

    public async copyReferencePath(item?: ReferenceTreeItem): Promise<void> {
        const referenceId = this.getReferenceIdFromTreeItem(item);
        if (referenceId) {
            await vscode.env.clipboard.writeText(referenceId);
            vscode.window.showInformationMessage(l10n.t("Copied reference path: {0}", referenceId));
            return;
        }

        const references = this.index.getKnownReferenceIds();
        if (references.length === 0) {
            vscode.window.showInformationMessage(l10n.t("No reference path available"));
            return;
        }

        const selection = await vscode.window.showQuickPick(references, {
            placeHolder: l10n.t("Copy Reference Path")
        });

        if (!selection) {
            return;
        }

        await vscode.env.clipboard.writeText(selection);
        vscode.window.showInformationMessage(l10n.t("Copied reference path: {0}", selection));
    }

    public async openAgentFillBookmarks(): Promise<void> {
        const scope = await vscode.window.showInputBox({
            prompt: l10n.t("Optional scope or instruction for the chat agent"),
            placeHolder: l10n.t("Example: go over file asdasd.js and bookmark my latest addition code")
        });

        if (typeof scope === "undefined") {
            return;
        }

        await openBookmarksAgentChat(createBookmarksAgentPrompt("fill", scope));
    }

    public async openAgentScanCode(): Promise<void> {
        const scope = await vscode.window.showInputBox({
            prompt: l10n.t("Optional scan scope for the chat agent"),
            placeHolder: l10n.t("Example: scan src only, or scan the current feature branch changes")
        });

        if (typeof scope === "undefined") {
            return;
        }

        await openBookmarksAgentChat(createBookmarksAgentPrompt("scan", scope));
    }

    private getReferenceIdFromTreeItem(item?: ReferenceTreeItem): string | undefined {
        if (!item) {
            return undefined;
        }

        if (item.node.kind === "folder") {
            return item.node.referenceId;
        }

        if (item.node.kind === "location" && item.node.location.refs.length === 1) {
            return item.node.location.refs[ 0 ];
        }

        return undefined;
    }

    private registerWatchers(): void {
        const sourceWatcher = workspace.createFileSystemWatcher(REFERENCE_SOURCE_GLOB);
        this.disposables.push(
            sourceWatcher,
            sourceWatcher.onDidCreate(uri => this.scheduleFileScan(uri)),
            sourceWatcher.onDidChange(uri => this.scheduleFileScan(uri)),
            sourceWatcher.onDidDelete(uri => {
                this.index.removeFileAnnotations(uri);
                this.provider.refresh();
            })
        );

        const jsonWatcher = workspace.createFileSystemWatcher("**/bookmarks.json");
        this.disposables.push(
            jsonWatcher,
            jsonWatcher.onDidCreate(uri => this.reloadBookmarksJsonIfRoot(uri)),
            jsonWatcher.onDidChange(uri => this.reloadBookmarksJsonIfRoot(uri)),
            jsonWatcher.onDidDelete(uri => this.reloadBookmarksJsonIfRoot(uri))
        );

        this.disposables.push(workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("bookmarks.references.ignoredFolders")) {
                this.refresh(false);
            }
        }));
    }

    private reloadBookmarksJsonIfRoot(uri: Uri): void {
        if (!isRootBookmarksJson(uri)) {
            return;
        }

        this.reloadBookmarksJson();
    }

    private async reloadBookmarksJson(): Promise<void> {
        const jsonResult = await this.loader.load();
        this.index.replaceJson(jsonResult.groups, jsonResult.locations, jsonResult.problems);
        this.provider.refresh();
    }

    private scheduleFileScan(uri: Uri): void {
        const key = uri.toString();
        const existingTimeout = this.pendingFileScans.get(key);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
            this.pendingFileScans.delete(key);
            this.scanDocument(uri);
        }, 300);

        this.pendingFileScans.set(key, timeout);
    }

    private async scanDocument(uri: Uri): Promise<void> {
        if (!this.scanner.isSupportedSourceFile(uri)) {
            return;
        }

        const workspaceFolder = workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder || this.scanner.isIgnoredUri(uri, workspaceFolder)) {
            this.index.removeFileAnnotations(uri);
            this.provider.refresh();
            return;
        }

        const openDocument = workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        const scanResult = openDocument
            ? this.scanner.scanTextDocument(openDocument)
            : await this.scanner.scanFile(uri);
        this.index.replaceFileAnnotations(uri, scanResult.locations, scanResult.problems);
        this.provider.refresh();
    }

    private async loadProjectIndex(): Promise<void> {
        const [ jsonResult, scanResult ] = await Promise.all([
            this.loader.load(),
            this.scanner.scanWorkspace()
        ]);

        this.index.replaceJson(jsonResult.groups, jsonResult.locations, jsonResult.problems);
        this.index.replaceAnnotations(scanResult.locations, scanResult.problems);
    }
}

async function revealLocation(target: ReferenceLocation | ReferenceProblem): Promise<void> {
    if (!target.uri || !target.line) {
        return;
    }

    try {
        const document = await workspace.openTextDocument(target.uri);
        const editor = await vscode.window.showTextDocument(document);
        const line = Math.min(Math.max(target.line - 1, 0), Math.max(document.lineCount - 1, 0));
        const character = Math.min(Math.max((target.column ?? 1) - 1, 0), document.lineAt(line).text.length);
        const position = new Position(line, character);
        const range = new Range(position, position);

        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        highlightLine(editor, line);
    } catch (error) {
        vscode.window.showErrorMessage(l10n.t("Unable to open referenced file: {0}", getErrorMessage(error)));
    }
}

function highlightLine(editor: TextEditor, line: number): void {
    const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground")
    });

    editor.setDecorations(decoration, [ editor.document.lineAt(line).range ]);
    setTimeout(() => decoration.dispose(), REFERENCE_HIGHLIGHT_TIMEOUT);
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        return workspace.getWorkspaceFolder(activeEditor.document.uri);
    }

    return workspace.workspaceFolders?.[ 0 ];
}

async function uriExists(uri: Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

function getBookmarkLabel(editor: TextEditor): string {
    const selectedText = editor.document.getText(editor.selection).trim().replace(/\s+/g, " ");
    if (selectedText.length > 0) {
        return truncateLabel(selectedText);
    }

    const lineText = editor.document.lineAt(editor.selection.active.line).text.trim().replace(/\s+/g, " ");
    if (lineText.length > 0) {
        return truncateLabel(lineText);
    }

    return editor.document.uri.fsPath.split(/[\\/]/).pop() ?? "Bookmark";
}

function truncateLabel(label: string): string {
    return label.length > 120
        ? `${label.substring(0, 117)}...`
        : label;
}

function isRootBookmarksJson(uri: Uri): boolean {
    const workspaceFolder = workspace.getWorkspaceFolder(uri);
    return !!workspaceFolder && uri.toString().toLocaleLowerCase() === getBookmarksJsonUri(workspaceFolder).toString().toLocaleLowerCase();
}

async function openBookmarksAgentChat(prompt: string): Promise<void> {
    const document = await workspace.openTextDocument({
        language: "markdown",
        content: prompt
    });
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(l10n.t("Bookmarks AI prompt opened locally. Review it before sharing with any chat agent."));
}

function createBookmarksAgentPrompt(mode: "fill" | "scan", scope: string): string {
    const workspaceFolder = getActiveWorkspaceFolder();
    const workspaceName = workspaceFolder?.name ?? "the current workspace";
    const bookmarkGuidePath = workspaceFolder
        ? getBookmarkMarkdownUri(workspaceFolder).fsPath
        : "<workspace-root>/bookmark.md";
    const bookmarksJsonPath = workspaceFolder
        ? getBookmarksJsonUri(workspaceFolder).fsPath
        : "<workspace-root>/bookmarks.json";
    const normalizedScope = scope.trim().length > 0
        ? scope.trim()
        : "No extra scope was provided. Ask me what files, folders, feature, or recent changes to inspect before making edits.";

    return `${createBookmarksAgentBasePrompt(workspaceName, bookmarkGuidePath, bookmarksJsonPath)}

User scope/instructions:
${normalizedScope}

${mode === "fill" ? createFillBookmarksPrompt() : createScanCodePrompt()}`;
}

function createBookmarksAgentBasePrompt(workspaceName: string, bookmarkGuidePath: string, bookmarksJsonPath: string): string {
    return `You are helping with the Bookmarks AI VS Code extension in workspace "${workspaceName}".

Bookmarks AI builds a deterministic project navigation map from:
1. The AI guide: ${bookmarkGuidePath}
2. The root shared file: ${bookmarksJsonPath}
3. Source comments containing @ref annotations.

Read bookmark.md first. It explains the bookmarks.json schema, managed bookmark IDs, reference naming rules, and safe update workflow.

Root bookmarks.json schema:
{
    "version": 1,
    "groups": [
        {
            "id": "startup/power",
            "title": "Power Initialization",
            "description": "Optional description",
            "parent": "startup",
            "order": 20
        }
    ],
    "bookmarks": [
        {
            "id": "stable-bookmark-id",
            "label": "Human readable label",
            "file": "src/example.ts",
            "line": 10,
            "column": 1,
            "symbol": "ExampleSymbol",
            "refs": ["startup/power", "requirement/SRS-321"]
        }
    ]
}

Source annotation format:
// @brief Human Readable Bookmark Label
// @ref [startup, startup/power, requirement/SRS-321, work/nati/fix-312]

Use Doxygen @brief or \\brief in the same comment block when the tree/bookmarks.json label should be more descriptive than the function name. If @brief is missing, the extension uses the closest following symbol name when detected.

The same @ref syntax may appear inside block or Doxygen comments:
 /**
 * Description.
 * @brief Analog Initialization
 * @ref [startup/power, requirement/SRS-321]
 */

Reference ID rules:
- Use slash-separated hierarchy, for example startup/power or requirement/SRS-321.
- Use hyphens inside names.
- Do not use spaces, leading slash, trailing slash, or empty path segments.
- Treat IDs case-insensitively, but preserve configured titles in bookmarks.json.
- requirement/* appears under Requirements; work/* appears under Developer Work.
- // TODO comments appear under Todo.
- Doxygen @bug or \\bug comments appear under Bugs.
- Bookmarks with no refs appear under Unclassified; Bad Classification is validation-only and should be fixed, not targeted.

Supported annotation scan file extensions:
.c, .h, .cpp, .hpp, .cc, .cxx, .cs, .py, .ts, .js.

Default ignored folders:
.git, node_modules, build, out, dist, Debug, Release, .vs, vendor, third_party.

Safety rules:
- The extension itself must not edit source/code files.
- Do not paste, upload, quote, or summarize proprietary source code into external services.
- Do not apply source-file changes for this task. If source annotations are needed, propose them for the user to review manually.
- Only write bookmarks.json after explicit user approval, unless the user is using the extension's local metadata command.`;
}

function createFillBookmarksPrompt(): string {
    return `Task: Fill bookmarks metadata safely.

Build a proposed bookmarks.json metadata update for the requested scope without editing source files.

Requirements:
- Read bookmarks.json first and reuse existing group IDs when they fit.
- Do not write to source/code files.
- Do not paste or upload source file contents into chat.
- If @ref or @brief comments would help, provide suggested comment text as a proposal only; do not apply it.
- Keep proposed labels accurate and concise.
- Do not invent broad references when a narrower existing reference fits.
- If a needed group does not exist, propose the new group ID/title before using it broadly.
- Do not update bookmarks.json for this task unless I explicitly approve the exact summary.
- If my scope is ambiguous, ask me for the exact files, folders, feature, or changes to inspect.`;
}

function createScanCodePrompt(): string {
    return `Task: Scan the code and update bookmarks.json from source @ref annotations.

Workflow requirements:
1. Read the current bookmarks.json.
2. Create a backup copy before any proposed update. Use a timestamped filename next to bookmarks.json, for example bookmarks.json.bak.YYYYMMDD-HHMMSS.
3. Scan the requested code scope for @ref annotations in supported files.
4. Build the proposed bookmarks.json changes:
   - Add bookmarks for new annotated locations.
   - Delete bookmarks whose matching source annotations no longer exist.
   - Preserve valid existing groups and metadata.
   - Add missing groups only when a scanned annotation references them.
   - Keep deterministic formatting and stable IDs.
5. Before overwriting bookmarks.json, show me a summary with:
   - New bookmarks to add.
   - Old bookmarks to delete.
   - Groups to add or change.
   - Validation problems or malformed references.
6. Wait for my explicit approval before saving the updated bookmarks.json.

Do not edit source/code files. Do not overwrite bookmarks.json until I approve the summary.`;
}

function unique(values: string[]): string[] {
    const seen = new Set<string>();
    for (const value of values) {
        seen.add(normalizeReferenceId(value));
    }

    return Array.from(seen);
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
