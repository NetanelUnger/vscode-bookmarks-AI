/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { WorkspaceFolder, workspace } from "vscode";
import { appendPath, writeFileUri } from "../utils/fs";
import { DEFAULT_REFERENCE_IGNORED_FOLDERS, REFERENCE_SOURCE_FILE_EXTENSIONS } from "../references/referenceModel";

const BOOKMARK_MARKDOWN_FILE = "bookmark.md";

export function getBookmarkMarkdownUri(workspaceFolder: WorkspaceFolder): vscode.Uri {
    return appendPath(workspaceFolder.uri, BOOKMARK_MARKDOWN_FILE);
}

export class BookmarkMarkdownGuide {

    public async ensureAll(): Promise<void> {
        if (!workspace.workspaceFolders) {
            return;
        }

        for (const workspaceFolder of workspace.workspaceFolders) {
            await this.ensure(workspaceFolder);
        }
    }

    public async ensure(workspaceFolder: WorkspaceFolder): Promise<vscode.Uri> {
        const uri = getBookmarkMarkdownUri(workspaceFolder);
        if (await uriExists(uri)) {
            return uri;
        }

        await writeFileUri(uri, createBookmarkMarkdownGuide());
        return uri;
    }
}

function createBookmarkMarkdownGuide(): string {
    return `# Bookmarks AI Guide

This file explains how to use \`bookmarks.json\` as a fast project map for AI agents and developers.

AI agents should read this file first, then read \`bookmarks.json\`, before scanning source code. The bookmark map should answer where important code is, which files relate to a feature, and which references should be inspected before changing behavior.

Safety rule: the extension treats source/code files as read-only. It may read source files to scan comments, but it must not write source files or transfer source contents to an external service. Built-in AI prompts are opened as local unsaved text so the user can review them before sharing anything with a chat agent.

## Files

- \`bookmark.md\`: This guide for humans and AI agents.
- \`bookmarks.json\`: Shared project bookmark index. Keep it committed to Git.
- Source files: May contain \`@ref [...]\` annotations in comments.

## bookmarks.json Schema

\`\`\`json
{
    "version": 1,
    "groups": [
        {
            "id": "startup/power",
            "title": "Power Initialization",
            "description": "Optional human-readable description",
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
            "refs": [
                "startup/power",
                "requirement/SRS-321"
            ]
        }
    ]
}
\`\`\`

## Group Rules

- \`id\` is the stable reference path.
- Use \`/\` for hierarchy: \`startup/power\`, \`architecture/state-machine\`, \`requirement/SRS-321\`, \`work/nati/fix-312\`.
- Use \`-\` inside path segments.
- Do not use spaces, leading slash, trailing slash, or empty path segments.
- Matching is case-insensitive.
- Preserve configured \`title\` values for display.
- References starting with \`requirement/\` appear under Requirements.
- References starting with \`work/\` appear under Developer Work.

## Bookmark Rules

- \`file\` is relative to the workspace root.
- \`line\` and \`column\` are 1-based.
- \`symbol\` should name the closest function, method, class, or relevant code symbol when known.
- \`refs\` links the location to one or more group IDs.
- Use deterministic, stable IDs for curated bookmarks.
- IDs starting with \`bookmarks-ai-\` are extension-managed and may be replaced by the extension during scans. Do not use this prefix for manually curated entries.

## Source Annotation Format

The extension scans comments for \`@ref [...]\`:

\`\`\`ts
// @brief Startup Entry
// @ref [startup, startup/power, requirement/SRS-321]
export function startSystem() {
}
\`\`\`

Use Doxygen \`@brief\` or \`\\brief\` in the same comment block to control the bookmark label shown in the tree and saved to \`bookmarks.json\`. If \`@brief\` is missing, the extension uses the closest following symbol name when it can detect one.

Doxygen and block comments are also supported:

\`\`\`cpp
/**
 * Starts the product after power initialization.
 *
 * @brief System Startup
 * @ref [startup/power, requirement/SRS-321]
 */
void StartSystem(void)
{
}
\`\`\`

Supported file extensions:

\`\`\`text
${REFERENCE_SOURCE_FILE_EXTENSIONS.join("\n")}
\`\`\`

Default ignored folders:

\`\`\`text
${DEFAULT_REFERENCE_IGNORED_FOLDERS.join("\n")}
\`\`\`

## Tree Sections

The Bookmarks AI tree shows the same source location in several virtual sections based on its refs and validation state.

### Requirements

Add a bookmark to Requirements by using a reference that starts with \`requirement/\`.

Source annotation:

\`\`\`cpp
/**
 * @brief Analog startup requirement entry
 * @ref [requirement/SRS-321, sensing/analog]
 */
void InitAnalog(void)
{
}
\`\`\`

Equivalent \`bookmarks.json\` bookmark:

\`\`\`json
{
    "id": "analog-startup-requirement",
    "label": "Analog startup requirement entry",
    "file": "src/sensing/analog.c",
    "line": 42,
    "column": 1,
    "symbol": "InitAnalog",
    "refs": [
        "requirement/SRS-321",
        "sensing/analog"
    ]
}
\`\`\`

The \`requirement/SRS-321\` ref appears under the Requirements root. The same location also appears under By Reference and By File.

### Todo

Add a bookmark to Todo with a source comment that contains \`TODO\`.

\`\`\`c
// TODO: Verify analog gain defaults after calibration merge.
void InitAnalog(void)
{
}
\`\`\`

The Todo section is for work reminders found in code. TODO entries are scanned into the tree but are not automatically written as managed \`bookmarks.json\` bookmarks.

### Bugs

Add a bookmark to Bugs with the Doxygen-supported \`@bug\` or \`\\bug\` command.

\`\`\`c
/**
 * @brief Analog initialization
 * @bug Analog channel 3 may start with a stale calibration value.
 * @ref [startup, sensing/analog]
 */
void InitAnalog(void)
{
}
\`\`\`

Use \`@bug\` for known defects or risky behavior that should remain visible to developers and AI agents. The bug item appears under Bugs and the same file also appears under By File.

### Unclassified

Unclassified is for bookmarks that have no refs. Prefer adding refs when possible, because refs make the bookmark useful for navigation.

Use Unclassified only when a code location is important but the correct feature, work item, or requirement is not known yet.

\`\`\`json
{
    "id": "needs-classification",
    "label": "Investigate this startup edge case",
    "file": "src/startup/startup.c",
    "line": 90,
    "column": 1,
    "symbol": "CheckStartupEdgeCase",
    "refs": []
}
\`\`\`

Source annotations normally include at least one \`@ref\`, so they usually do not create Unclassified entries.

### Bad Classification

Do not intentionally add bookmarks to Bad Classification. Bad Classification is a validation section created by the extension.

Entries appear under Bad Classification when the extension finds invalid or stale data, for example:

- A malformed ref such as \`startup power\`, \`/startup\`, \`startup/\`, or \`work//nati\`.
- A bookmark that points to a missing file.
- A duplicate bookmark ID.
- Invalid \`bookmarks.json\` structure.
- A ref that does not match a configured group when groups are defined.

Fix Bad Classification entries by correcting the source annotation or \`bookmarks.json\` entry. For example, change:

\`\`\`cpp
// @ref [startup power]
\`\`\`

to:

\`\`\`cpp
// @ref [startup/power]
\`\`\`

## How AI Agents Should Use This Map

1. Read \`bookmark.md\`.
2. Read \`bookmarks.json\`.
3. Use groups and refs to identify likely files and symbols before scanning the whole codebase.
4. Open only the relevant source files first.
5. Do not edit source/code files from this workflow.
6. If a source annotation would help, propose the exact \`@ref [...]\`, \`@brief\`, or \`@bug\` comment text for manual review instead of applying it.
7. Let the extension scan existing source annotations and persist them into \`bookmarks.json\`.
8. If directly editing \`bookmarks.json\`, preserve existing groups, non-managed bookmarks, formatting, and stable IDs.

## Privacy And Source Safety

- Do not upload, paste, quote, or summarize proprietary source file contents into external chat or web services.
- Use file paths, symbols, reference IDs, and short labels in summaries instead of source snippets.
- The extension writes only bookmark metadata files that it owns: root \`bookmarks.json\`, generated \`bookmark.md\`, and the legacy \`.vscode/bookmarks.json\` file when the existing Bookmarks setting is enabled.
- Manual bookmark commands update \`bookmarks.json\`; they do not insert or delete comments in source files.

## Safe Update Workflow

When asked to update the bookmark map:

1. Read the current \`bookmarks.json\`.
2. Create a backup before large direct edits, for example \`bookmarks.json.bak.YYYYMMDD-HHMMSS\`.
3. Build a proposed change summary:
   - New bookmarks.
   - Deleted bookmarks.
   - Changed groups.
   - Malformed references or validation problems.
4. Ask for approval before overwriting \`bookmarks.json\`.
5. After approval, save deterministic JSON with 4-space indentation.

## Quick Examples

Feature group:

\`\`\`json
{
    "id": "startup/power",
    "title": "Power Initialization",
    "parent": "startup",
    "order": 20
}
\`\`\`

Requirement group:

\`\`\`json
{
    "id": "requirement/SRS-321",
    "title": "SRS-321",
    "description": "Startup and power-state requirement"
}
\`\`\`

Developer work group:

\`\`\`json
{
    "id": "work/nati/fix-312",
    "title": "Fix 312",
    "description": "Active investigation or fix area"
}
\`\`\`

Curated bookmark:

\`\`\`json
{
    "id": "system-start-entry",
    "label": "System startup entry point",
    "file": "src/system/system_start.cpp",
    "line": 84,
    "column": 1,
    "symbol": "StartSystem",
    "refs": [
        "startup",
        "startup/power",
        "requirement/SRS-321"
    ]
}
\`\`\`
`;
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
