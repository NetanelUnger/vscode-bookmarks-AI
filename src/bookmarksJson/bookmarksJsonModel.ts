/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

export interface BookmarksJsonDocument {
    version?: unknown;
    groups?: unknown;
    bookmarks?: unknown;
}

export interface BookmarksJsonGroup {
    id?: unknown;
    title?: unknown;
    description?: unknown;
    parent?: unknown;
    order?: unknown;
}

export interface BookmarksJsonBookmark {
    id?: unknown;
    label?: unknown;
    file?: unknown;
    line?: unknown;
    column?: unknown;
    symbol?: unknown;
    refs?: unknown;
}
