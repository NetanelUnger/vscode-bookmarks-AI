/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { ReferenceLocation, ReferenceProblem } from "../references/referenceModel";

export type ReferenceSectionId = "byReference" | "byFile" | "developerWork" | "requirements" | "todo" | "bugs" | "unclassified" | "badClassification";

export type ReferenceTreeNode = ReferenceSectionNode | ReferenceFolderNode | ReferenceLocationNode | ReferenceProblemNode;

export interface ReferenceSectionNode {
    kind: "section";
    id: string;
    sectionId: ReferenceSectionId;
    label: string;
    icon: string;
    children: ReferenceTreeNode[];
}

export interface ReferenceFolderNode {
    kind: "folder";
    id: string;
    label: string;
    icon: string;
    referenceId?: string;
    order?: number;
    children: ReferenceTreeNode[];
}

export interface ReferenceLocationNode {
    kind: "location";
    id: string;
    label: string;
    location: ReferenceLocation;
}

export interface ReferenceProblemNode {
    kind: "problem";
    id: string;
    label: string;
    problem: ReferenceProblem;
}

export class ReferenceTreeItem extends vscode.TreeItem {

    constructor(public readonly node: ReferenceTreeNode) {
        super(node.label, getCollapsibleState(node));

        this.id = node.id;
        this.iconPath = getIconPath(node);
        this.contextValue = getContextValue(node);

        if (node.kind === "location") {
            this.description = `(Ln ${node.location.line}, Col ${node.location.column})`;
            this.tooltip = `${node.location.file}:${node.location.line}`;
            this.resourceUri = node.location.uri;
            this.command = {
                command: "_bookmarksAI.revealLocation",
                title: "",
                arguments: [ node.location ]
            };
        }

        if (node.kind === "problem") {
            this.description = getProblemDescription(node.problem);
            this.tooltip = node.problem.message;
            this.resourceUri = node.problem.uri;
            if (node.problem.uri && node.problem.line) {
                this.command = {
                    command: "_bookmarksAI.revealLocation",
                    title: "",
                    arguments: [ node.problem ]
                };
            }
        }
    }
}

function getCollapsibleState(node: ReferenceTreeNode): vscode.TreeItemCollapsibleState {
    if (node.kind === "location" || node.kind === "problem") {
        return vscode.TreeItemCollapsibleState.None;
    }

    return node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
}

function getIconPath(node: ReferenceTreeNode): vscode.ThemeIcon {
    if (node.kind === "section") {
        return new vscode.ThemeIcon(node.icon);
    }

    if (node.kind === "folder") {
        return new vscode.ThemeIcon(node.icon);
    }

    if (node.kind === "problem") {
        return new vscode.ThemeIcon("warning");
    }

    if (node.location.source === "todo") {
        return new vscode.ThemeIcon("checklist");
    }

    if (node.location.source === "bug") {
        return new vscode.ThemeIcon("bug");
    }

    return new vscode.ThemeIcon("bookmark");
}

function getContextValue(node: ReferenceTreeNode): string | undefined {
    if (node.kind === "folder" && node.referenceId) {
        return "BookmarksAIReference";
    }

    if (node.kind === "location") {
        return "BookmarksAILocation";
    }

    if (node.kind === "problem") {
        return "BookmarksAIProblem";
    }

    return undefined;
}

function getProblemDescription(problem: ReferenceProblem): string | undefined {
    if (!problem.file) {
        return undefined;
    }

    if (!problem.line) {
        return problem.file;
    }

    return `${problem.file}:${problem.line}`;
}
