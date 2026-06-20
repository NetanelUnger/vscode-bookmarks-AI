/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceFolder, l10n, workspace } from "vscode";
import { appendPath } from "../utils/fs";
import { BookmarksJsonBookmark, BookmarksJsonDocument, BookmarksJsonGroup } from "./bookmarksJsonModel";
import { BookmarksJsonLoadResult, ReferenceGroup, ReferenceLocation, ReferenceProblem } from "../references/referenceModel";
import { formatReferenceLeafTitle, normalizeReferenceId, validateReferenceId } from "../references/referenceParser";

export function getBookmarksJsonUri(workspaceFolder: WorkspaceFolder): vscode.Uri {
    return appendPath(workspaceFolder.uri, "bookmarks.json");
}

export class BookmarksJsonLoader {

    public async load(): Promise<BookmarksJsonLoadResult> {
        const result: BookmarksJsonLoadResult = {
            groups: [],
            locations: [],
            problems: [],
            bookmarksJsonUris: []
        };

        if (!workspace.workspaceFolders) {
            return result;
        }

        for (const workspaceFolder of workspace.workspaceFolders) {
            const folderResult = await this.loadWorkspaceFolder(workspaceFolder);
            result.groups.push(...folderResult.groups);
            result.locations.push(...folderResult.locations);
            result.problems.push(...folderResult.problems);
            result.bookmarksJsonUris.push(...folderResult.bookmarksJsonUris);
        }

        return result;
    }

    private async loadWorkspaceFolder(workspaceFolder: WorkspaceFolder): Promise<BookmarksJsonLoadResult> {
        const result: BookmarksJsonLoadResult = {
            groups: [],
            locations: [],
            problems: [],
            bookmarksJsonUris: []
        };
        const bookmarksJsonUri = getBookmarksJsonUri(workspaceFolder);

        if (!await this.uriExists(bookmarksJsonUri)) {
            return result;
        }

        result.bookmarksJsonUris.push(bookmarksJsonUri);

        let document: BookmarksJsonDocument;
        try {
            const contents = new TextDecoder("utf-8").decode(await workspace.fs.readFile(bookmarksJsonUri));
            document = JSON.parse(contents) as BookmarksJsonDocument;
        } catch (error) {
            result.problems.push({
                message: l10n.t("Invalid bookmarks.json: {0}", getErrorMessage(error)),
                file: "bookmarks.json",
                source: "json",
                workspaceFolder,
                uri: bookmarksJsonUri
            });
            return result;
        }

        if (!isObject(document)) {
            result.problems.push({
                message: l10n.t("Invalid bookmarks.json: root must be an object"),
                file: "bookmarks.json",
                source: "json",
                workspaceFolder,
                uri: bookmarksJsonUri
            });
            return result;
        }

        if (document.version !== 1) {
            result.problems.push({
                message: l10n.t("bookmarks.json must contain version 1"),
                file: "bookmarks.json",
                source: "json",
                workspaceFolder,
                uri: bookmarksJsonUri
            });
        }

        const groups = this.parseGroups(document.groups, workspaceFolder, bookmarksJsonUri, result.problems);
        result.groups.push(...groups);
        result.locations.push(...await this.parseBookmarks(document.bookmarks, groups, workspaceFolder, bookmarksJsonUri, result.problems));

        return result;
    }

    private parseGroups(
        groupsValue: unknown,
        workspaceFolder: WorkspaceFolder,
        bookmarksJsonUri: vscode.Uri,
        problems: ReferenceProblem[]
    ): ReferenceGroup[] {
        if (typeof groupsValue === "undefined") {
            return [];
        }

        if (!Array.isArray(groupsValue)) {
            problems.push({
                message: l10n.t("bookmarks.json groups must be an array"),
                file: "bookmarks.json",
                source: "json",
                workspaceFolder,
                uri: bookmarksJsonUri
            });
            return [];
        }

        const groups: ReferenceGroup[] = [];
        const seenGroups = new Set<string>();

        for (let index = 0; index < groupsValue.length; index++) {
            const rawGroup = groupsValue[ index ] as BookmarksJsonGroup;
            if (!isObject(rawGroup) || typeof rawGroup.id !== "string") {
                problems.push({
                    message: l10n.t("Invalid group entry at index {0}", index),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            const validationProblem = validateReferenceId(rawGroup.id);
            if (validationProblem) {
                problems.push({
                    message: l10n.t("Malformed group id {0}: {1}", rawGroup.id, validationProblem),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            const normalizedId = normalizeReferenceId(rawGroup.id);
            if (seenGroups.has(normalizedId)) {
                problems.push({
                    message: l10n.t("Duplicate group: {0}", rawGroup.id),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            seenGroups.add(normalizedId);
            groups.push({
                id: rawGroup.id.trim(),
                normalizedId,
                title: typeof rawGroup.title === "string" && rawGroup.title.trim().length > 0
                    ? rawGroup.title.trim()
                    : formatReferenceLeafTitle(normalizedId),
                description: typeof rawGroup.description === "string" ? rawGroup.description : undefined,
                parent: typeof rawGroup.parent === "string" ? rawGroup.parent : undefined,
                normalizedParent: typeof rawGroup.parent === "string" ? normalizeReferenceId(rawGroup.parent) : undefined,
                order: typeof rawGroup.order === "number" ? rawGroup.order : undefined,
                source: "json"
            });
        }

        for (const group of groups) {
            if (group.normalizedParent && !seenGroups.has(group.normalizedParent)) {
                problems.push({
                    message: l10n.t("Unknown parent group: {0}", group.parent),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
            }
        }

        return groups;
    }

    private async parseBookmarks(
        bookmarksValue: unknown,
        groups: ReferenceGroup[],
        workspaceFolder: WorkspaceFolder,
        bookmarksJsonUri: vscode.Uri,
        problems: ReferenceProblem[]
    ): Promise<ReferenceLocation[]> {
        if (typeof bookmarksValue === "undefined") {
            return [];
        }

        if (!Array.isArray(bookmarksValue)) {
            problems.push({
                message: l10n.t("bookmarks.json bookmarks must be an array"),
                file: "bookmarks.json",
                source: "json",
                workspaceFolder,
                uri: bookmarksJsonUri
            });
            return [];
        }

        const groupIds = new Set(groups.map(group => group.normalizedId));
        const seenBookmarkIds = new Set<string>();
        const locations: ReferenceLocation[] = [];

        for (let index = 0; index < bookmarksValue.length; index++) {
            const rawBookmark = bookmarksValue[ index ] as BookmarksJsonBookmark;
            if (!isObject(rawBookmark)) {
                problems.push(this.createInvalidBookmarkProblem(index, workspaceFolder, bookmarksJsonUri));
                continue;
            }

            if (typeof rawBookmark.file !== "string" || typeof rawBookmark.line !== "number") {
                problems.push(this.createInvalidBookmarkProblem(index, workspaceFolder, bookmarksJsonUri));
                continue;
            }

            const refs = this.parseBookmarkRefs(rawBookmark.refs, groupIds, workspaceFolder, bookmarksJsonUri, problems);
            const file = rawBookmark.file.replace(/\\/g, "/");
            const line = Math.floor(rawBookmark.line);
            const column = typeof rawBookmark.column === "number" ? Math.max(1, Math.floor(rawBookmark.column)) : 1;

            if (file.trim().length === 0 || line < 1) {
                problems.push(this.createInvalidBookmarkProblem(index, workspaceFolder, bookmarksJsonUri));
                continue;
            }

            const bookmarkId = typeof rawBookmark.id === "string" && rawBookmark.id.trim().length > 0
                ? rawBookmark.id.trim()
                : `${file}:${line}:${column}:${index}`;

            if (seenBookmarkIds.has(bookmarkId)) {
                problems.push({
                    message: l10n.t("Duplicate bookmark id: {0}", bookmarkId),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            seenBookmarkIds.add(bookmarkId);

            const uri = appendPath(workspaceFolder.uri, file);
            if (!await this.uriExists(uri)) {
                problems.push({
                    message: l10n.t("Missing file: {0}", file),
                    file,
                    line,
                    column,
                    source: "json",
                    workspaceFolder,
                    uri
                });
                continue;
            }

            const symbol = typeof rawBookmark.symbol === "string" && rawBookmark.symbol.trim().length > 0
                ? rawBookmark.symbol.trim()
                : undefined;
            const label = typeof rawBookmark.label === "string" && rawBookmark.label.trim().length > 0
                ? rawBookmark.label.trim()
                : symbol ?? path.basename(file);

            locations.push({
                id: `${workspaceFolder.uri.toString()}:json:${bookmarkId}`,
                file,
                line,
                column,
                label,
                symbol,
                refs,
                source: "json",
                workspaceFolder,
                uri
            });
        }

        return locations;
    }

    private parseBookmarkRefs(
        refsValue: unknown,
        groupIds: Set<string>,
        workspaceFolder: WorkspaceFolder,
        bookmarksJsonUri: vscode.Uri,
        problems: ReferenceProblem[]
    ): string[] {
        if (!Array.isArray(refsValue)) {
            return [];
        }

        const refs: string[] = [];
        for (const refValue of refsValue) {
            if (typeof refValue !== "string") {
                problems.push({
                    message: l10n.t("Invalid reference: {0}", String(refValue)),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            const validationProblem = validateReferenceId(refValue);
            if (validationProblem) {
                problems.push({
                    message: l10n.t("Malformed reference {0}: {1}", refValue, validationProblem),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
                continue;
            }

            const normalizedRef = normalizeReferenceId(refValue);
            if (groupIds.size > 0 && !groupIds.has(normalizedRef)) {
                problems.push({
                    message: l10n.t("Unknown group: {0}", refValue),
                    file: "bookmarks.json",
                    source: "json",
                    workspaceFolder,
                    uri: bookmarksJsonUri
                });
            }

            if (!refs.includes(normalizedRef)) {
                refs.push(normalizedRef);
            }
        }

        return refs;
    }

    private createInvalidBookmarkProblem(
        index: number,
        workspaceFolder: WorkspaceFolder,
        uri: vscode.Uri
    ): ReferenceProblem {
        return {
            message: l10n.t("Invalid bookmark entry at index {0}", index),
            file: "bookmarks.json",
            source: "json",
            workspaceFolder,
            uri
        };
    }

    private async uriExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
