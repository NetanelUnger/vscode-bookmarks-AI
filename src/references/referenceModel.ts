/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Uri, WorkspaceFolder } from "vscode";

export type ReferenceSource = "annotation" | "json" | "manual" | "todo" | "bug";

export interface ReferenceGroup {
    id: string;
    normalizedId: string;
    title: string;
    description?: string;
    parent?: string;
    normalizedParent?: string;
    order?: number;
    source: "json" | "virtual";
}

export interface ReferenceLocation {
    id: string;
    file: string;
    line: number;
    column: number;
    label: string;
    symbol?: string;
    refs: string[];
    source: ReferenceSource;
    workspaceFolder: WorkspaceFolder;
    uri: Uri;
}

export interface ReferenceProblem {
    message: string;
    file?: string;
    line?: number;
    column?: number;
    source: ReferenceSource | "validation";
    workspaceFolder?: WorkspaceFolder;
    uri?: Uri;
}

export interface ReferenceScanResult {
    locations: ReferenceLocation[];
    problems: ReferenceProblem[];
}

export interface BookmarksJsonLoadResult extends ReferenceScanResult {
    groups: ReferenceGroup[];
    bookmarksJsonUris: Uri[];
}

export const REFERENCE_SOURCE_FILE_EXTENSIONS = [
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cc",
    ".cxx",
    ".cs",
    ".py",
    ".ts",
    ".js"
];

export const DEFAULT_REFERENCE_IGNORED_FOLDERS = [
    ".git",
    "node_modules",
    "build",
    "out",
    "dist",
    "Debug",
    "Release",
    ".vs",
    "vendor",
    "third_party"
];
