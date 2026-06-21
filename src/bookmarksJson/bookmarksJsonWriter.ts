/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as crypto from "crypto";
import * as vscode from "vscode";
import { WorkspaceFolder, workspace } from "vscode";
import { BookmarksJsonBookmark, BookmarksJsonDocument, BookmarksJsonGroup } from "./bookmarksJsonModel";
import { getBookmarksJsonUri } from "./bookmarksJsonLoader";
import { ReferenceLocation } from "../references/referenceModel";
import { formatReferenceLeafTitle, normalizeReferenceId } from "../references/referenceParser";
import { Controller } from "../core/controller";
import { File } from "../core/file";
import { writeFileUri } from "../utils/fs";

const MANAGED_BOOKMARK_ID_PREFIX = "bookmarks-ai-";
const MANUAL_BOOKMARK_ID_PREFIX = "manual-bookmark-";

interface WritableBookmarksJsonDocument {
    version: number;
    groups: BookmarksJsonGroup[];
    bookmarks: BookmarksJsonBookmark[];
}

export class BookmarksJsonWriter {

    public async saveControllerBookmarks(controller: Controller): Promise<void> {
        if (!controller.workspaceFolder) {
            return;
        }

        const uri = getBookmarksJsonUri(controller.workspaceFolder);
        const currentContents = await this.readCurrentContents(uri);
        const document = this.parseDocument(currentContents);
        const writableDocument = this.toWritableDocument(document);

        writableDocument.bookmarks = [
            ...writableDocument.bookmarks.filter(bookmark => !isManualBookmark(bookmark)),
            ...toManualControllerBookmarks(controller)
        ].sort(compareBookmarks);

        const nextContents = JSON.stringify(writableDocument, null, 4) + "\n";
        if (currentContents === nextContents) {
            return;
        }

        await writeFileUri(uri, nextContents);
    }

    public async saveManualLocation(location: ReferenceLocation): Promise<void> {
        const uri = getBookmarksJsonUri(location.workspaceFolder);
        const currentContents = await this.readCurrentContents(uri);
        const document = this.parseDocument(currentContents);
        const writableDocument = this.toWritableDocument(document);

        writableDocument.groups = mergeGroups(writableDocument.groups, [ location ]);
        upsertManualBookmark(writableDocument.bookmarks, location);
        writableDocument.bookmarks = writableDocument.bookmarks.sort(compareBookmarks);

        const nextContents = JSON.stringify(writableDocument, null, 4) + "\n";
        if (currentContents === nextContents) {
            return;
        }

        await writeFileUri(uri, nextContents);
    }

    public async removeManualBookmarksAtLocation(workspaceFolder: WorkspaceFolder, file: string, line: number): Promise<number> {
        const uri = getBookmarksJsonUri(workspaceFolder);
        const currentContents = await this.readCurrentContents(uri);
        const document = this.parseDocument(currentContents);
        const writableDocument = this.toWritableDocument(document);
        const normalizedFile = normalizeBookmarkFile(file);
        const beforeCount = writableDocument.bookmarks.length;

        writableDocument.bookmarks = writableDocument.bookmarks.filter(bookmark => {
            if (isManagedBookmark(bookmark)) {
                return true;
            }

            return !isSameBookmarkLine(bookmark, normalizedFile, line);
        });

        const removedCount = beforeCount - writableDocument.bookmarks.length;
        if (removedCount === 0) {
            return 0;
        }

        const nextContents = JSON.stringify(writableDocument, null, 4) + "\n";
        await writeFileUri(uri, nextContents);
        return removedCount;
    }

    public async saveAnnotationLocations(locations: ReferenceLocation[]): Promise<void> {
        const locationsByWorkspace = new Map<string, { workspaceFolder: WorkspaceFolder; locations: ReferenceLocation[] }>();

        for (const location of locations) {
            const key = location.workspaceFolder.uri.toString();
            const workspaceLocations = locationsByWorkspace.get(key) ?? {
                workspaceFolder: location.workspaceFolder,
                locations: []
            };
            workspaceLocations.locations.push(location);
            locationsByWorkspace.set(key, workspaceLocations);
        }

        const workspaceFolders = workspace.workspaceFolders ?? [];
        for (const workspaceFolder of workspaceFolders) {
            const workspaceLocations = locationsByWorkspace.get(workspaceFolder.uri.toString())?.locations ?? [];
            await this.saveWorkspaceAnnotationLocations(workspaceFolder, workspaceLocations);
        }
    }

    private async saveWorkspaceAnnotationLocations(workspaceFolder: WorkspaceFolder, locations: ReferenceLocation[]): Promise<void> {
        const uri = getBookmarksJsonUri(workspaceFolder);
        const currentContents = await this.readCurrentContents(uri);
        const document = this.parseDocument(currentContents);
        const writableDocument = this.toWritableDocument(document);

        writableDocument.groups = mergeGroups(writableDocument.groups, locations);
        writableDocument.bookmarks = [
            ...writableDocument.bookmarks.filter(bookmark => !isManagedBookmark(bookmark)),
            ...locations.map(location => toBookmark(location))
        ].sort(compareBookmarks);

        const nextContents = JSON.stringify(writableDocument, null, 4) + "\n";
        if (currentContents === nextContents) {
            return;
        }

        await writeFileUri(uri, nextContents);
    }

    private async readCurrentContents(uri: vscode.Uri): Promise<string | undefined> {
        try {
            return new TextDecoder("utf-8").decode(await workspace.fs.readFile(uri));
        } catch {
            return undefined;
        }
    }

    private parseDocument(contents: string | undefined): BookmarksJsonDocument {
        if (!contents) {
            return {
                version: 1,
                groups: [],
                bookmarks: []
            };
        }

        return JSON.parse(contents) as BookmarksJsonDocument;
    }

    private toWritableDocument(document: BookmarksJsonDocument): WritableBookmarksJsonDocument {
        return {
            version: document.version === 1 ? 1 : 1,
            groups: Array.isArray(document.groups) ? document.groups.filter(isObject) as BookmarksJsonGroup[] : [],
            bookmarks: Array.isArray(document.bookmarks) ? document.bookmarks.filter(isObject) as BookmarksJsonBookmark[] : []
        };
    }
}

function mergeGroups(groups: BookmarksJsonGroup[], locations: ReferenceLocation[]): BookmarksJsonGroup[] {
    const mergedGroups = [ ...groups ];
    const knownGroupIds = new Set<string>();

    for (const group of mergedGroups) {
        if (typeof group.id === "string") {
            knownGroupIds.add(normalizeReferenceId(group.id));
        }
    }

    for (const location of locations) {
        for (const ref of location.refs) {
            addReferenceGroupChain(mergedGroups, knownGroupIds, ref);
        }
    }

    return mergedGroups.sort(compareGroups);
}

function addReferenceGroupChain(groups: BookmarksJsonGroup[], knownGroupIds: Set<string>, ref: string): void {
    const segments = ref.split("/").filter(segment => segment.length > 0);
    let parent: string | undefined;

    for (let index = 0; index < segments.length; index++) {
        const groupId = segments.slice(0, index + 1).join("/");
        const normalizedGroupId = normalizeReferenceId(groupId);

        if (!knownGroupIds.has(normalizedGroupId)) {
            groups.push({
                id: groupId,
                title: formatReferenceLeafTitle(groupId),
                parent
            });
            knownGroupIds.add(normalizedGroupId);
        }

        parent = groupId;
    }
}

function toBookmark(location: ReferenceLocation): BookmarksJsonBookmark {
    return {
        id: createManagedBookmarkId(location),
        label: location.label,
        file: location.file,
        line: location.line,
        column: location.column,
        symbol: location.symbol,
        refs: [ ...location.refs ].sort((left, right) => left.localeCompare(right))
    };
}

function upsertManualBookmark(bookmarks: BookmarksJsonBookmark[], location: ReferenceLocation): void {
    const existingBookmark = bookmarks.find(bookmark =>
        !isManagedBookmark(bookmark) &&
        isSameBookmarkLocation(bookmark, location.file, location.line, location.column));

    if (existingBookmark) {
        existingBookmark.label = location.label;
        existingBookmark.file = location.file;
        existingBookmark.line = location.line;
        existingBookmark.column = location.column;
        existingBookmark.symbol = location.symbol;
        existingBookmark.refs = mergeBookmarkRefs(existingBookmark.refs, location.refs);
        return;
    }

    bookmarks.push(toManualBookmark(location));
}

function toManualControllerBookmarks(controller: Controller): BookmarksJsonBookmark[] {
    const bookmarks: BookmarksJsonBookmark[] = [];

    for (const file of controller.files.filter(canSaveControllerFile)) {
        for (const bookmark of file.bookmarks) {
            bookmarks.push({
                id: createManualControllerBookmarkId(controller, file.path, bookmark.line + 1, bookmark.column + 1),
                label: bookmark.label,
                file: normalizeBookmarkFile(file.path),
                line: bookmark.line + 1,
                column: bookmark.column + 1,
                refs: []
            });
        }
    }

    return bookmarks;
}

function canSaveControllerFile(file: File): boolean {
    return !file.uri && file.bookmarks.length > 0;
}

function toManualBookmark(location: ReferenceLocation): BookmarksJsonBookmark {
    return {
        id: createManualBookmarkId(location),
        label: location.label,
        file: location.file,
        line: location.line,
        column: location.column,
        symbol: location.symbol,
        refs: [ ...location.refs ].sort((left, right) => left.localeCompare(right))
    };
}

function createManagedBookmarkId(location: ReferenceLocation): string {
    const hash = crypto
        .createHash("sha1")
        .update(`${location.workspaceFolder.uri.toString()}|${location.file}|${location.line}|${location.column}|${location.symbol ?? ""}|${[ ...location.refs ].sort((left, right) => left.localeCompare(right)).join(",")}`)
        .digest("hex")
        .substring(0, 12);

    return `${MANAGED_BOOKMARK_ID_PREFIX}${hash}`;
}

function createManualBookmarkId(location: ReferenceLocation): string {
    return createManualControllerBookmarkId(location.workspaceFolder.uri.toString(), location.file, location.line, location.column);
}

function createManualControllerBookmarkId(controllerOrWorkspace: Controller | string, file: string, line: number, column: number): string {
    const workspaceKey = typeof controllerOrWorkspace === "string"
        ? controllerOrWorkspace
        : controllerOrWorkspace.workspaceFolder?.uri.toString() ?? "";
    const hash = crypto
        .createHash("sha1")
        .update(`${workspaceKey}|${file}|${line}|${column}`)
        .digest("hex")
        .substring(0, 12);

    return `${MANUAL_BOOKMARK_ID_PREFIX}${hash}`;
}

function isManagedBookmark(bookmark: BookmarksJsonBookmark): boolean {
    return typeof bookmark.id === "string" && bookmark.id.startsWith(MANAGED_BOOKMARK_ID_PREFIX);
}

function isManualBookmark(bookmark: BookmarksJsonBookmark): boolean {
    return typeof bookmark.id === "string" && bookmark.id.startsWith(MANUAL_BOOKMARK_ID_PREFIX);
}

function isSameBookmarkLocation(bookmark: BookmarksJsonBookmark, file: string, line: number, column: number): boolean {
    return isSameBookmarkLine(bookmark, file, line) &&
        Number(bookmark.column ?? 1) === column;
}

function isSameBookmarkLine(bookmark: BookmarksJsonBookmark, file: string, line: number): boolean {
    return typeof bookmark.file === "string" &&
        normalizeBookmarkFile(bookmark.file) === normalizeBookmarkFile(file) &&
        Number(bookmark.line) === line;
}

function normalizeBookmarkFile(file: string): string {
    return file.replace(/\\/g, "/");
}

function mergeBookmarkRefs(existingRefs: unknown, newRefs: string[]): string[] {
    const refs = new Set<string>();

    if (Array.isArray(existingRefs)) {
        for (const ref of existingRefs) {
            if (typeof ref === "string") {
                refs.add(normalizeReferenceId(ref));
            }
        }
    }

    for (const ref of newRefs) {
        refs.add(normalizeReferenceId(ref));
    }

    return Array.from(refs).sort((left, right) => left.localeCompare(right));
}

function compareGroups(left: BookmarksJsonGroup, right: BookmarksJsonGroup): number {
    const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
    const orderDifference = leftOrder - rightOrder;
    if (orderDifference !== 0) {
        return orderDifference;
    }

    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function compareBookmarks(left: BookmarksJsonBookmark, right: BookmarksJsonBookmark): number {
    const fileDifference = String(left.file ?? "").localeCompare(String(right.file ?? ""));
    if (fileDifference !== 0) {
        return fileDifference;
    }

    const lineDifference = Number(left.line ?? 0) - Number(right.line ?? 0);
    if (lineDifference !== 0) {
        return lineDifference;
    }

    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
