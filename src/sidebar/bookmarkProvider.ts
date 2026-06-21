/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import path = require("path");
import * as vscode from "vscode";
import { Controller } from "../core/controller";
import { parsePosition, Point } from "./parser";
import { codicons } from "vscode-ext-codicons";
import { listBookmarks } from "../core/operations";
import { FileNode } from "./fileNode";
import { BookmarkNode, BookmarkPreview } from "./bookmarkNode";
import { WorkspaceNode } from "./workspaceNode";
import { BookmarkNodeKind } from "./nodes";
import { BadgeConfig } from "../core/constants";
import { ReferenceTreeProvider } from "../views/referenceTreeProvider";
import { ReferenceTreeItem, ReferenceTreeNode } from "../views/referenceTreeItem";

type BookmarkExplorerNode = BookmarkNode | WorkspaceNode | FileNode | ReferenceTreeItem;

export class BookmarkProvider implements vscode.TreeDataProvider<BookmarkExplorerNode> {

    private _onDidChangeTreeData: vscode.EventEmitter<BookmarkExplorerNode | void> = new vscode.EventEmitter<BookmarkExplorerNode | void>();
    public readonly onDidChangeTreeData: vscode.Event<BookmarkExplorerNode | void> = this._onDidChangeTreeData.event;

    private tree: BookmarkNode[] = [];

    private collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    private filterText = "";
    private filterTerms: string[] = [];

    constructor(private controllers: Controller[], private referenceTreeProvider?: ReferenceTreeProvider) {

        if (vscode.workspace.getConfiguration("bookmarks.sideBar").get<boolean>("expanded", false)) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }

        this.referenceTreeProvider?.onDidChangeTreeData(() => this.refresh());
        this.registerControllerListeners(controllers);
    }

    public updateControllers(controllers: Controller[]): void {
        this.controllers = controllers;
        this.registerControllerListeners(controllers);
        this.refresh();
    }

    private registerControllerListeners(controllers: Controller[]): void {

        for (const controller of controllers) {
            controller.onDidClearBookmarks(() => {
                this._onDidChangeTreeData.fire();
            });
        }

        for (const controller of controllers) {

            controller.onDidAddBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.file) {

                        if (!bkm.label) {
                            bn.books.push({
                                file: bn.books[ 0 ].file,
                                line: bkm.line,
                                column: bkm.column,
                                preview: bkm.linePreview,
                                uri: bkm.uri
                            });
                        } else {
                            bn.books.push({
                                file: bn.books[ 0 ].file,
                                line: bkm.line,
                                column: bkm.column,
                                preview: "\u270E " + bkm.label,
                                uri: bkm.uri
                            });
                        }

                        bn.books.sort((n1, n2) => {
                            if (n1.line > n2.line) {
                                return 1;
                            }

                            if (n1.line < n2.line) {
                                return -1;
                            }

                            return 0;
                        });

                        this._onDidChangeTreeData.fire(bn);
                        return;
                    }
                }

                // not found - new file
                this._onDidChangeTreeData.fire();
            });
        }


        for (const controller of controllers) {

            controller.onDidRemoveBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.bookmark) {

                        // last one - reset
                        if (bn.books.length === 1) {
                            this._onDidChangeTreeData.fire(null);
                            return;
                        }

                        // remove just that one
                        for (let index = 0; index < bn.books.length; index++) {
                            const element = bn.books[ index ];
                            if (element.line === bkm.line) {
                                bn.books.splice(index, 1);
                                this._onDidChangeTreeData.fire(bn);
                                return;
                            }
                        }
                    }
                }
            });
        }

        for (const controller of controllers) {

            controller.onDidUpdateBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.file) {

                        bn.books[ bkm.index ].line = bkm.line;
                        bn.books[ bkm.index ].column = bkm.column ? bkm.column : bn.books[ bkm.index ].column;
                        if (bkm.linePreview) {
                            bn.books[ bkm.index ].preview = bkm.linePreview;
                        } else {
                            bn.books[ bkm.index ].preview = "\u270E " + bkm.label;
                        }

                        this._onDidChangeTreeData.fire(bn);
                        return;
                    }
                }

                // not found - new file
                this._onDidChangeTreeData.fire();
            });
        }
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public setFilter(filterText: string): void {
        this.filterText = filterText.trim();
        this.filterTerms = normalizeFilterTerms(this.filterText);
        this.refresh();
    }

    public getFilterText(): string {
        return this.filterText;
    }

    public getTreeItem(element: BookmarkExplorerNode): vscode.TreeItem {
        return element;
    }

    // very much based in `listFromAllFiles` command
    public getChildren(element?: FileNode | WorkspaceNode | ReferenceTreeItem): Thenable<BookmarkExplorerNode[]> {

        if (element instanceof ReferenceTreeItem) {
            return this.referenceTreeProvider
                ? this.referenceTreeProvider.getChildren(element)
                : Promise.resolve([]);
        }

        // no bookmark
        // let totalBookmarkCount = 0;

        let someFileHasBookmark: boolean;
        for (const controller of this.controllers) {
            someFileHasBookmark = controller.hasAnyBookmark();
            if (someFileHasBookmark) { break; }
        }

        if (!someFileHasBookmark) {
            this.tree = [];
            return this.getReferenceRootChildren();
        }

        // loop !!!
        return new Promise(resolve => {

            if (element) {

                if (element.kind === BookmarkNodeKind.NODE_WORKSPACE_FOLDER) {

                    const promisses = [];
                    const ne = <WorkspaceNode>element;
                    for (const file of ne.controller.files) {
                        const pp = listBookmarks(file, ne.controller.workspaceFolder);
                        promisses.push(pp);
                    }

                    Promise.all(promisses).then(
                        (values) => {

                            // raw list
                            const lll: FileNode[] = [];
                            for (const bb of ne.controller.files) {

                                // this bookmark has bookmarks?
                                if (bb.bookmarks.length > 0) {

                                    const books: BookmarkPreview[] = [];

                                    // search from `values`no
                                    for (const elm of values) {
                                        if (elm) {
                                            for (const elementInside of elm) {

                                                if (bb.path === elementInside.detail) {

                                                    const point: Point = parsePosition(elementInside.description);
                                                    books.push(
                                                        {
                                                            file: elementInside.detail,
                                                            line: point.line,
                                                            column: point.column,
                                                            preview: elementInside.label.replace(codicons.tag, "\u270E"),
                                                            uri: elementInside.uri
                                                        }
                                                    );
                                                }
                                            }
                                        }
                                    }

                                    const filteredBooks = this.filterBooks(bb.path, books);
                                    if (this.shouldIncludeFile(bb.path, filteredBooks)) {
                                        const itemPath = path.basename(bb.path);
                                        const bn: FileNode = new FileNode(itemPath, removeRelativePathFromFile(bb.path), this.collapsibleState, BookmarkNodeKind.NODE_FILE, bb, filteredBooks);
                                        lll.push(bn);
                                    }
                                    // this.tree.push(bn);
                                }
                            }

                            resolve(lll);
                        }
                    );
                    return;
                }

                if (element.kind === BookmarkNodeKind.NODE_FILE) {
                    const ll: BookmarkNode[] = [];

                    const ne = <BookmarkNode>element;

                    const filteredBooks = this.filterBooks(ne.bookmark.path, ne.books ?? []);
                    for (const bbb of filteredBooks) {
                        ll.push(new BookmarkNode(bbb.preview, `(Ln ${bbb.line}, Col ${bbb.column})`, vscode.TreeItemCollapsibleState.None, BookmarkNodeKind.NODE_BOOKMARK, null, [], {
                            command: "_bookmarks.jumpTo",
                            title: "",
                            arguments: [ bbb.file, bbb.line, bbb.column, bbb.uri ],
                        }));
                    }

                    resolve(ll);
                } else {
                    resolve([]);
                }
            } else { // ROOT

                // has more than one controller/worskpace, just loop through the controllers and returns its workspaces
                if (this.controllers.length > 1) {
                    const workspaces = [];
                    for (const controller of this.controllers) {
                        const wn: WorkspaceNode = new WorkspaceNode(controller.workspaceFolder.name, controller.workspaceFolder,
                            this.collapsibleState, BookmarkNodeKind.NODE_WORKSPACE_FOLDER, [], controller);
                        workspaces.push(wn);
                    }
                    this.getReferenceRootChildren().then(referenceNodes => {
                        resolve([ ...workspaces, ...referenceNodes ]);
                    });
                    return;
                }

                this.tree = [];
                const promisses = [];

                // get all files, from all controllers/workspaces
                for (const controller of this.controllers) {
                    for (const file of controller.files) {
                        const pp = listBookmarks(file, controller.workspaceFolder);
                        promisses.push(pp);
                    }
                }

                // all files, from all controllers/workspaces
                Promise.all(promisses).then(
                    (values) => {

                        // raw list
                        const lll: FileNode[] = [];
                        for (const controller of this.controllers) {
                            for (const bb of controller.files) {

                                // this bookmark has bookmarks?
                                if (bb.bookmarks.length > 0) {

                                    const books: BookmarkPreview[] = [];

                                    // search from `values`no
                                    for (const elm of values) {
                                        if (elm) {
                                            for (const elementInside of elm) {

                                                if (bb.path === elementInside.detail) {

                                                    const point: Point = parsePosition(elementInside.description);
                                                    books.push(
                                                        {
                                                            file: elementInside.detail,
                                                            line: point.line,
                                                            column: point.column,
                                                            preview: elementInside.label.replace(codicons.tag, "\u270E"),
                                                            uri: elementInside.uri
                                                        }
                                                    );
                                                }
                                            }
                                        }
                                    }

                                    const filteredBooks = this.filterBooks(bb.path, books);
                                    if (this.shouldIncludeFile(bb.path, filteredBooks)) {
                                        const itemPath = path.basename(bb.path);
                                        const bn: FileNode = new FileNode(itemPath, removeRelativePathFromFile(bb.path), this.collapsibleState, BookmarkNodeKind.NODE_FILE, bb, filteredBooks);
                                        lll.push(bn);
                                    }
                                    // this.tree.push(bn);
                                }
                            }
                        }

                        this.getReferenceRootChildren().then(referenceNodes => {
                            resolve([ ...lll, ...referenceNodes ]);
                        });
                    }
                );
            }
        });
    }

    private getReferenceRootChildren(): Thenable<ReferenceTreeItem[]> {
        if (!this.referenceTreeProvider) {
            return Promise.resolve([]);
        }

        return this.referenceTreeProvider.getChildren()
            .then(children => this.filterReferenceItems(children));
    }

    private filterBooks(filePath: string, books: BookmarkPreview[]): BookmarkPreview[] {
        if (!this.hasFilter()) {
            return books;
        }

        const fileText = removeRelativePathFromFile(filePath) + " " + path.basename(filePath) + " " + filePath;
        if (this.matchesFilter(fileText + " " + books.map(book => this.getBookSearchText(book)).join(" "))) {
            return books;
        }

        return books.filter(book => this.matchesFilter(fileText + " " + this.getBookSearchText(book)));
    }

    private shouldIncludeFile(filePath: string, books: BookmarkPreview[]): boolean {
        if (!this.hasFilter()) {
            return true;
        }

        if (books.length > 0) {
            return true;
        }

        return this.matchesFilter(filePath);
    }

    private getBookSearchText(book: BookmarkPreview): string {
        return [
            book.file,
            book.preview,
            `line ${book.line}`,
            `column ${book.column}`
        ].join(" ");
    }

    private filterReferenceItems(items: ReferenceTreeItem[]): ReferenceTreeItem[] {
        if (!this.hasFilter()) {
            return items;
        }

        return items
            .map(item => this.filterReferenceItem(item, ""))
            .filter((item): item is ReferenceTreeItem => !!item);
    }

    private filterReferenceItem(item: ReferenceTreeItem, ancestorText: string): ReferenceTreeItem | undefined {
        const nodeText = `${ancestorText} ${getReferenceNodeSearchText(item.node)}`;
        const selfMatches = this.matchesFilter(nodeText);

        if (!("children" in item.node)) {
            return selfMatches ? item : undefined;
        }

        if (selfMatches) {
            return item;
        }

        const filteredChildren = item.node.children
            .map(child => this.filterReferenceItem(new ReferenceTreeItem(child), nodeText))
            .filter((child): child is ReferenceTreeItem => !!child);

        if (filteredChildren.length === 0) {
            return undefined;
        }

        return new ReferenceTreeItem({
            ...item.node,
            children: filteredChildren.map(child => child.node)
        } as ReferenceTreeNode);
    }

    private hasFilter(): boolean {
        return this.filterTerms.length > 0;
    }

    private matchesFilter(text: string): boolean {
        const normalizedText = text.toLocaleLowerCase();
        return this.filterTerms.every(term => normalizedText.includes(term));
    }

}

function removeRelativePathFromFile(aPath: string): string {
    const filename = path.basename(aPath);
    const dirname = aPath.substring(0, aPath.length - filename.length - 1);
    return dirname;
}

export class BookmarksExplorer {

    private bookmarksExplorer: vscode.TreeView<BookmarkExplorerNode>;
    private treeDataProvider: BookmarkProvider;
    private controllers: Controller[];
    private controllerListenerDisposables: vscode.Disposable[] = [];

    constructor(controllers: Controller[], referenceTreeProvider?: ReferenceTreeProvider) {
        this.controllers = controllers;
        this.treeDataProvider = new BookmarkProvider(controllers, referenceTreeProvider);
        this.bookmarksExplorer = vscode.window.createTreeView("bookmarksExplorer", {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        this.registerControllerListeners(controllers);
    }

    private registerControllerListeners(controllers: Controller[]): void {
        for (const controller of controllers) {
            this.controllerListenerDisposables.push(
                controller.onDidClearBookmarks(() => {
                    this.updateBadge();
                })
            );
            this.controllerListenerDisposables.push(
                controller.onDidAddBookmark(() => {
                    this.updateBadge();
                })
            );
            this.controllerListenerDisposables.push(
                controller.onDidRemoveBookmark(() => {
                    this.updateBadge();
                })
            );
        }
    }

    getProvider() {
        return this.treeDataProvider;
    }

    async openAll(): Promise<void> {
        const roots = await this.treeDataProvider.getChildren();
        for (const root of roots) {
            await this.revealExpanded(root);
        }
    }

    private async revealExpanded(node: BookmarkExplorerNode): Promise<void> {
        await this.bookmarksExplorer.reveal(node, { expand: true });
        const children = await this.treeDataProvider.getChildren(node);
        for (const child of children) {
            await this.revealExpanded(child);
        }
    }

    updateBadge() {
        const config = vscode.workspace.getConfiguration("bookmarks.sideBar").get<string>("countBadge", "all");
        if (config === BadgeConfig.Off) {
            this.bookmarksExplorer.badge = { value: 0, tooltip: "" };
            return;
        }

        if (config === BadgeConfig.All) {
            this.updateBadgeAllFiles();
        } else {
            this.updateBadgePerFile();
        }
    }

    private updateBadgeAllFiles() {
        let total = 0;
        this.controllers.forEach(controller =>
            total = total + controller.countBookmarks()
        );

        const badgeTooltip = total === 0
            ? ""
            : total === 1
                ? "1 bookmark"
                : `${total} bookmarks`;

        this.bookmarksExplorer.badge = { value: total, tooltip: badgeTooltip };
    }

    private updateBadgePerFile() {
        let total = 0;
        this.controllers.forEach(controller =>
            total = total + controller.countFilesWithBookmarks()
        );

        const badgeTooltip = total === 0
            ? ""
            : total === 1
                ? vscode.l10n.t("1 file with bookmarks")
                : `${total} ` + vscode.l10n.t("files with bookmarks");

        this.bookmarksExplorer.badge = { value: total, tooltip: badgeTooltip };

    }

    updateControllers(controllers: Controller[]): void {
        this.controllers = controllers;
        this.treeDataProvider.updateControllers(controllers);

        // Dispose of old listeners to prevent memory leaks
        this.controllerListenerDisposables.forEach(disposable => disposable.dispose());
        this.controllerListenerDisposables = [];

        // Register new listeners
        this.registerControllerListeners(controllers);

        this.updateBadge();
    }
}

function normalizeFilterTerms(filterText: string): string[] {
    return filterText
        .toLocaleLowerCase()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(term => term.length > 0);
}

function getReferenceNodeSearchText(node: ReferenceTreeNode): string {
    if (node.kind === "location") {
        return [
            node.label,
            node.location.file,
            node.location.label,
            node.location.symbol ?? "",
            node.location.source,
            node.location.refs.join(" "),
            node.location.workspaceFolder.name,
            `line ${node.location.line}`,
            `column ${node.location.column}`
        ].join(" ");
    }

    if (node.kind === "problem") {
        return [
            node.label,
            node.problem.message,
            node.problem.file ?? "",
            node.problem.source,
            node.problem.workspaceFolder?.name ?? "",
            node.problem.line ? `line ${node.problem.line}` : "",
            node.problem.column ? `column ${node.problem.column}` : ""
        ].join(" ");
    }

    if (node.kind === "folder") {
        return [
            node.label,
            node.referenceId ?? ""
        ].join(" ");
    }

    return node.label;
}
