/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { l10n } from "vscode";
import { ReferenceIndex } from "../references/referenceIndex";
import { ReferenceGroup, ReferenceLocation, ReferenceProblem } from "../references/referenceModel";
import { formatReferenceSegment } from "../references/referenceParser";
import { ReferenceFolderNode, ReferenceLocationNode, ReferenceProblemNode, ReferenceSectionId, ReferenceTreeItem, ReferenceTreeNode } from "./referenceTreeItem";

interface FolderBuilder {
    id: string;
    label: string;
    icon: string;
    referenceId?: string;
    order?: number;
    folders: Map<string, FolderBuilder>;
    locations: ReferenceLocation[];
}

export class ReferenceTreeProvider implements vscode.TreeDataProvider<ReferenceTreeItem> {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReferenceTreeItem | undefined | void>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly index: ReferenceIndex) {
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: ReferenceTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: ReferenceTreeItem): Thenable<ReferenceTreeItem[]> {
        if (element) {
            const children = "children" in element.node ? element.node.children : [];
            return Promise.resolve(children.map(child => new ReferenceTreeItem(child)));
        }

        return Promise.resolve(this.buildRootNodes().map(node => new ReferenceTreeItem(node)));
    }

    private buildRootNodes(): ReferenceTreeNode[] {
        const locations = this.index.getLocations();
        const problems = this.index.getProblems();

        return [
            this.createSection("byReference", l10n.t("By Reference"), "references", this.buildReferenceNodes(
                locations,
                ref => !ref.startsWith("work/") && !ref.startsWith("requirement/")
            )),
            this.createSection("byFile", l10n.t("By File"), "file-directory", this.buildFileNodes(locations)),
            this.createSection("developerWork", l10n.t("Developer Work"), "tools", this.buildReferenceNodes(
                locations,
                ref => ref.startsWith("work/"),
                "work/"
            )),
            this.createSection("requirements", l10n.t("Requirements"), "checklist", this.buildReferenceNodes(
                locations,
                ref => ref.startsWith("requirement/"),
                "requirement/"
            )),
            this.createSection("todo", l10n.t("Todo"), "checklist", this.buildSourceNodes(locations, "todo")),
            this.createSection("bugs", l10n.t("Bugs"), "bug", this.buildSourceNodes(locations, "bug")),
            this.createSection("unclassified", l10n.t("Unclassified"), "question", this.buildUnclassifiedNodes(locations)),
            this.createSection("badClassification", l10n.t("Bad Classification"), "warning", this.buildProblemNodes(problems))
        ];
    }

    private createSection(id: ReferenceSectionId, label: string, icon: string, children: ReferenceTreeNode[]): ReferenceTreeNode {
        return {
            kind: "section",
            id: `bookmarksAI.section.${id}`,
            sectionId: id,
            label,
            icon,
            children
        };
    }

    private buildReferenceNodes(
        locations: ReferenceLocation[],
        includeReference: (referenceId: string) => boolean,
        trimPrefix = ""
    ): ReferenceTreeNode[] {
        const roots = new Map<string, FolderBuilder>();
        const groups = this.index.getGroups();

        for (const location of locations) {
            for (const referenceId of location.refs) {
                if (!includeReference(referenceId)) {
                    continue;
                }

                const displayReferenceId = trimPrefix && referenceId.startsWith(trimPrefix)
                    ? referenceId.substring(trimPrefix.length)
                    : referenceId;

                if (displayReferenceId.length === 0) {
                    continue;
                }

                this.addReferenceLocation(roots, referenceId, displayReferenceId, location, groups);
            }
        }

        return this.convertFoldersToNodes(roots);
    }

    private addReferenceLocation(
        roots: Map<string, FolderBuilder>,
        fullReferenceId: string,
        displayReferenceId: string,
        location: ReferenceLocation,
        groups: Map<string, ReferenceGroup>
    ): void {
        const segments = displayReferenceId.split("/").filter(segment => segment.length > 0);
        const referencePrefix = fullReferenceId.endsWith(displayReferenceId)
            ? fullReferenceId.substring(0, fullReferenceId.length - displayReferenceId.length)
            : "";
        let currentFolders = roots;
        let builder: FolderBuilder | undefined;

        for (let index = 0; index < segments.length; index++) {
            const displayPath = segments.slice(0, index + 1).join("/");
            const referencePath = `${referencePrefix}${displayPath}`;
            const existingBuilder = currentFolders.get(displayPath);

            if (existingBuilder) {
                builder = existingBuilder;
            } else {
                const group = groups.get(referencePath);
                builder = {
                    id: `bookmarksAI.reference.${referencePath}`,
                    label: group?.title ?? formatReferenceSegment(segments[ index ]),
                    icon: "symbol-namespace",
                    referenceId: referencePath,
                    order: group?.order,
                    folders: new Map<string, FolderBuilder>(),
                    locations: []
                };
                currentFolders.set(displayPath, builder);
            }

            currentFolders = builder.folders;
        }

        builder?.locations.push(location);
    }

    private buildFileNodes(locations: ReferenceLocation[]): ReferenceTreeNode[] {
        const roots = new Map<string, FolderBuilder>();
        const multiRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1;

        for (const location of locations) {
            const segments = location.file.split("/").filter(segment => segment.length > 0);
            if (multiRoot) {
                segments.unshift(location.workspaceFolder.name);
            }

            this.addFileLocation(roots, segments, location);
        }

        return this.convertFoldersToNodes(roots);
    }

    private addFileLocation(roots: Map<string, FolderBuilder>, segments: string[], location: ReferenceLocation): void {
        let currentFolders = roots;
        let builder: FolderBuilder | undefined;
        let currentPath = "";

        for (let index = 0; index < segments.length; index++) {
            currentPath = currentPath.length === 0 ? segments[ index ] : `${currentPath}/${segments[ index ]}`;
            const existingBuilder = currentFolders.get(currentPath);
            const isFile = index === segments.length - 1;

            if (existingBuilder) {
                builder = existingBuilder;
            } else {
                builder = {
                    id: `bookmarksAI.file.${location.workspaceFolder.uri.toString()}.${currentPath}`,
                    label: segments[ index ],
                    icon: isFile ? "file-code" : "file-directory",
                    folders: new Map<string, FolderBuilder>(),
                    locations: []
                };
                currentFolders.set(currentPath, builder);
            }

            currentFolders = builder.folders;
        }

        builder?.locations.push(location);
    }

    private buildUnclassifiedNodes(locations: ReferenceLocation[]): ReferenceTreeNode[] {
        return locations
            .filter(location => location.refs.length === 0 && location.source !== "todo" && location.source !== "bug")
            .map((location, index) => this.createLocationNode(location, `unclassified.${index}`));
    }

    private buildSourceNodes(locations: ReferenceLocation[], source: ReferenceLocation["source"]): ReferenceTreeNode[] {
        return locations
            .filter(location => location.source === source)
            .map((location, index) => this.createLocationNode(location, `${source}.${index}`));
    }

    private buildProblemNodes(problems: ReferenceProblem[]): ReferenceTreeNode[] {
        return problems.map((problem, index): ReferenceProblemNode => ({
            kind: "problem",
            id: `bookmarksAI.problem.${index}.${problem.file ?? "workspace"}.${problem.line ?? 0}`,
            label: problem.message,
            problem
        }));
    }

    private convertFoldersToNodes(folders: Map<string, FolderBuilder>): ReferenceTreeNode[] {
        return Array.from(folders.values())
            .map(folder => this.convertFolderToNode(folder))
            .sort(compareNodes);
    }

    private convertFolderToNode(folder: FolderBuilder): ReferenceFolderNode {
        const children: ReferenceTreeNode[] = [
            ...this.convertFoldersToNodes(folder.folders),
            ...folder.locations.map((location, index) => this.createLocationNode(location, `${folder.id}.${index}`))
        ].sort(compareNodes);

        return {
            kind: "folder",
            id: folder.id,
            label: folder.label,
            icon: folder.icon,
            referenceId: folder.referenceId,
            order: folder.order,
            children
        };
    }

    private createLocationNode(location: ReferenceLocation, idSuffix: string): ReferenceLocationNode {
        return {
            kind: "location",
            id: `bookmarksAI.location.${idSuffix}.${location.id}`,
            label: location.label,
            location
        };
    }
}

function compareNodes(left: ReferenceTreeNode, right: ReferenceTreeNode): number {
    if (left.kind === "folder" && right.kind === "folder") {
        const orderDifference = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
        if (orderDifference !== 0) {
            return orderDifference;
        }
    }

    if (left.kind === "folder" && right.kind !== "folder") {
        return -1;
    }

    if (left.kind !== "folder" && right.kind === "folder") {
        return 1;
    }

    return left.label.localeCompare(right.label);
}
