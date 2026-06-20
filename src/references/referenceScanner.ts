/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { TextDocument, Uri, WorkspaceFolder, l10n, workspace } from "vscode";
import { getRelativePath } from "../utils/fs";
import { DEFAULT_REFERENCE_IGNORED_FOLDERS, REFERENCE_SOURCE_FILE_EXTENSIONS, ReferenceScanResult, ReferenceSource } from "./referenceModel";
import { parseBugAnnotation, parseReferenceAnnotation, parseReferenceTitle, parseTodoComment } from "./referenceParser";

export const REFERENCE_SOURCE_GLOB = `**/*.{${REFERENCE_SOURCE_FILE_EXTENSIONS.map(extension => extension.substring(1)).join(",")}}`;

interface SymbolMatch {
    symbol: string;
    line: number;
    column: number;
    label: string;
}

export class ReferenceScanner {

    public async scanWorkspace(): Promise<ReferenceScanResult> {
        const result: ReferenceScanResult = {
            locations: [],
            problems: []
        };

        if (!workspace.workspaceFolders) {
            return result;
        }

        const uris = await workspace.findFiles(REFERENCE_SOURCE_GLOB, this.getExcludeGlob());
        for (const uri of uris) {
            const fileResult = await this.scanFile(uri);
            result.locations.push(...fileResult.locations);
            result.problems.push(...fileResult.problems);
        }

        return result;
    }

    public async scanFile(uri: Uri): Promise<ReferenceScanResult> {
        const result: ReferenceScanResult = {
            locations: [],
            problems: []
        };

        const workspaceFolder = workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder || !this.isSupportedSourceFile(uri) || this.isIgnoredUri(uri, workspaceFolder)) {
            return result;
        }

        let contents: string;
        try {
            contents = new TextDecoder("utf-8").decode(await workspace.fs.readFile(uri));
        } catch (error) {
            result.problems.push({
                message: l10n.t("Unable to scan {0}: {1}", uri.fsPath, getErrorMessage(error)),
                source: "annotation",
                workspaceFolder,
                uri
            });
            return result;
        }

        return this.scanText(contents, uri, workspaceFolder);
    }

    public scanTextDocument(document: TextDocument): ReferenceScanResult {
        const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder || !this.isSupportedSourceFile(document.uri) || this.isIgnoredUri(document.uri, workspaceFolder)) {
            return {
                locations: [],
                problems: []
            };
        }

        return this.scanText(document.getText(), document.uri, workspaceFolder);
    }

    public isSupportedSourceFile(uri: Uri): boolean {
        const extension = path.extname(uri.fsPath).toLocaleLowerCase();
        return REFERENCE_SOURCE_FILE_EXTENSIONS.includes(extension);
    }

    public isIgnoredUri(uri: Uri, workspaceFolder: WorkspaceFolder): boolean {
        const relativePath = getRelativePath(workspaceFolder.uri.fsPath, uri.fsPath);
        const ignoredFolders = this.getIgnoredFolders().map(folder => folder.toLocaleLowerCase());
        const segments = relativePath.split(/[\\/]/).map(segment => segment.toLocaleLowerCase());
        return segments.some(segment => ignoredFolders.includes(segment));
    }

    public getIgnoredFolders(): string[] {
        const configuredValue = workspace.getConfiguration("bookmarks.references").get<string[]>("ignoredFolders");
        if (!Array.isArray(configuredValue) || configuredValue.length === 0) {
            return DEFAULT_REFERENCE_IGNORED_FOLDERS;
        }

        return configuredValue.filter(folder => typeof folder === "string" && folder.trim().length > 0);
    }

    private scanText(contents: string, uri: Uri, workspaceFolder: WorkspaceFolder): ReferenceScanResult {
        const result: ReferenceScanResult = {
            locations: [],
            problems: []
        };
        const file = getRelativePath(workspaceFolder.uri.fsPath, uri.fsPath);
        const lines = contents.split(/\r?\n/);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const todo = isCommentLine(lines[ lineIndex ].trim()) ? parseTodoComment(lines[ lineIndex ]) : undefined;
            if (todo) {
                result.locations.push(createMarkerLocation(
                    "todo",
                    todo,
                    lines[ lineIndex ],
                    lineIndex,
                    file,
                    workspaceFolder,
                    uri
                ));
            }

            const bug = isCommentLine(lines[ lineIndex ].trim()) ? parseBugAnnotation(lines[ lineIndex ]) : undefined;
            if (bug) {
                const symbol = findFollowingSymbol(lines, lineIndex);
                result.locations.push(createMarkerLocation(
                    "bug",
                    bug,
                    lines[ lineIndex ],
                    lineIndex,
                    file,
                    workspaceFolder,
                    uri,
                    symbol
                ));
            }

            const annotation = parseReferenceAnnotation(lines[ lineIndex ]);
            if (!annotation) {
                continue;
            }

            for (const invalidRef of annotation.invalidRefs) {
                result.problems.push({
                    message: l10n.t("Malformed reference {0}: {1}", invalidRef.value, invalidRef.reason),
                    file,
                    line: lineIndex + 1,
                    column: annotation.column + 1,
                    source: "annotation",
                    workspaceFolder,
                    uri
                });
            }

            if (annotation.refs.length === 0) {
                result.problems.push({
                    message: l10n.t("Reference annotation has no valid references"),
                    file,
                    line: lineIndex + 1,
                    column: annotation.column + 1,
                    source: "annotation",
                    workspaceFolder,
                    uri
                });
                continue;
            }

            const symbol = findFollowingSymbol(lines, lineIndex);
            const title = findReferenceTitle(lines, lineIndex);
            const line = symbol?.line ?? lineIndex + 1;
            const column = symbol?.column ?? annotation.column + 1;
            const label = title ?? symbol?.label ?? lines[ lineIndex ].trim();

            result.locations.push({
                id: `${workspaceFolder.uri.toString()}:annotation:${file}:${lineIndex + 1}:${annotation.refs.join(",")}`,
                file,
                line,
                column,
                label: label.length > 0 ? label : path.basename(file),
                symbol: symbol?.symbol,
                refs: annotation.refs,
                source: "annotation",
                workspaceFolder,
                uri
            });
        }

        return result;
    }

    private getExcludeGlob(): string {
        const folders = this.getIgnoredFolders()
            .map(folder => folder.replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, ""))
            .filter(folder => folder.length > 0);

        return folders.length > 0
            ? `**/{${folders.join(",")}}/**`
            : "";
    }
}

function findFollowingSymbol(lines: string[], annotationLineIndex: number): SymbolMatch | undefined {
    const maxLine = Math.min(lines.length, annotationLineIndex + 25);

    for (let index = annotationLineIndex + 1; index < maxLine; index++) {
        const line = lines[ index ];
        const trimmedLine = line.trim();

        if (trimmedLine.length === 0 || isCommentLine(trimmedLine)) {
            continue;
        }

        const symbol = extractSymbol(line);
        if (!symbol) {
            return undefined;
        }

        return {
            symbol,
            line: index + 1,
            column: line.indexOf(symbol) + 1,
            label: `${symbol}()`
        };
    }

    return undefined;
}

function createMarkerLocation(
    source: ReferenceSource,
    label: string,
    lineText: string,
    lineIndex: number,
    file: string,
    workspaceFolder: WorkspaceFolder,
    uri: Uri,
    symbol?: SymbolMatch
) {
    const line = symbol?.line ?? lineIndex + 1;
    const column = symbol?.column ?? Math.max(lineText.search(/\S/), 0) + 1;
    const prefix = source === "todo" ? "TODO" : "Bug";

    return {
        id: `${workspaceFolder.uri.toString()}:${source}:${file}:${lineIndex + 1}:${label}`,
        file,
        line,
        column,
        label: `${prefix}: ${label}`,
        symbol: symbol?.symbol,
        refs: [],
        source,
        workspaceFolder,
        uri
    };
}

function findReferenceTitle(lines: string[], annotationLineIndex: number): string | undefined {
    const firstLine = findCommentBlockFirstLine(lines, annotationLineIndex);
    const lastLine = findCommentBlockLastLine(lines, annotationLineIndex);

    for (let index = firstLine; index <= lastLine; index++) {
        const title = parseReferenceTitle(lines[ index ]);
        if (title) {
            return title;
        }
    }

    return undefined;
}

function findCommentBlockFirstLine(lines: string[], annotationLineIndex: number): number {
    if (!isInBlockComment(lines, annotationLineIndex)) {
        for (let index = annotationLineIndex - 1; index >= 0; index--) {
            const trimmedLine = lines[ index ].trim();
            if (trimmedLine.length === 0 || !isCommentLine(trimmedLine)) {
                return index + 1;
            }
        }

        return 0;
    }

    for (let index = annotationLineIndex; index >= 0; index--) {
        const trimmedLine = lines[ index ].trim();

        if (trimmedLine.includes("/*") || trimmedLine.startsWith("/**")) {
            return index;
        }

        if (index !== annotationLineIndex && !isCommentLine(trimmedLine) && trimmedLine.length > 0) {
            return index + 1;
        }
    }

    return 0;
}

function findCommentBlockLastLine(lines: string[], annotationLineIndex: number): number {
    if (!isInBlockComment(lines, annotationLineIndex)) {
        for (let index = annotationLineIndex + 1; index < lines.length; index++) {
            const trimmedLine = lines[ index ].trim();
            if (trimmedLine.length === 0 || !isCommentLine(trimmedLine)) {
                return index - 1;
            }
        }

        return lines.length - 1;
    }

    for (let index = annotationLineIndex; index < lines.length; index++) {
        const trimmedLine = lines[ index ].trim();

        if (trimmedLine.includes("*/")) {
            return index;
        }

        if (index !== annotationLineIndex && !isCommentLine(trimmedLine) && trimmedLine.length > 0) {
            return index - 1;
        }
    }

    return lines.length - 1;
}

function isInBlockComment(lines: string[], annotationLineIndex: number): boolean {
    const annotationLine = lines[ annotationLineIndex ].trim();
    if (annotationLine.includes("/*") || annotationLine.startsWith("*")) {
        return true;
    }

    for (let index = annotationLineIndex - 1; index >= 0; index--) {
        const trimmedLine = lines[ index ].trim();
        if (trimmedLine.includes("*/")) {
            return false;
        }

        if (trimmedLine.includes("/*")) {
            return true;
        }

        if (trimmedLine.length > 0 && !isCommentLine(trimmedLine)) {
            return false;
        }
    }

    return false;
}

function isCommentLine(trimmedLine: string): boolean {
    return trimmedLine.startsWith("//") ||
        trimmedLine.startsWith("#") ||
        trimmedLine.startsWith("*") ||
        trimmedLine.startsWith("/*") ||
        trimmedLine.startsWith("*/");
}

function extractSymbol(line: string): string | undefined {
    const trimmedLine = line.trim();
    if (/^(if|for|while|switch|catch|return|else|do)\b/.test(trimmedLine)) {
        return undefined;
    }

    const patterns = [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/,
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
        /^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^({]+)?\s*\{/,
        /^\s*(?:[A-Za-z_][\w:<>,~*&\s]+\s+)+([A-Za-z_~][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/
    ];

    for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (match) {
            return trimQualifiedSymbol(match[ 1 ]);
        }
    }

    return undefined;
}

function trimQualifiedSymbol(symbol: string): string {
    const segments = symbol.split("::");
    return segments[ segments.length - 1 ];
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
