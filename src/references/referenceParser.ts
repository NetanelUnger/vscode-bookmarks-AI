/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

export interface ParsedReferenceAnnotation {
    raw: string;
    refs: string[];
    invalidRefs: ParsedInvalidReference[];
    column: number;
}

export interface ParsedInvalidReference {
    value: string;
    reason: string;
}

const REFERENCE_ANNOTATION_REGEXP = /@ref\s*\[([^\]]*)\]/;
const REFERENCE_BRIEF_REGEXP = /(?:@|\\)brief\s+(.+)$/;
const REFERENCE_BUG_REGEXP = /(?:@|\\)bug\s+(.+)$/;
const TODO_REGEXP = /\bTODO\b\s*:?\s*(.*)$/i;

export function parseReferenceAnnotation(text: string): ParsedReferenceAnnotation | undefined {
    const match = REFERENCE_ANNOTATION_REGEXP.exec(text);
    if (!match) {
        return undefined;
    }

    const refs: string[] = [];
    const invalidRefs: ParsedInvalidReference[] = [];
    const rawRefs = match[ 1 ].split(",");

    for (const rawRef of rawRefs) {
        const value = rawRef.trim();
        const reason = validateReferenceId(value);

        if (reason) {
            invalidRefs.push({ value, reason });
            continue;
        }

        const normalizedRef = normalizeReferenceId(value);
        if (!refs.includes(normalizedRef)) {
            refs.push(normalizedRef);
        }
    }

    return {
        raw: match[ 0 ],
        refs,
        invalidRefs,
        column: match.index
    };
}

export function removeReferenceAnnotation(text: string): string {
    return text.replace(REFERENCE_ANNOTATION_REGEXP, "").trimEnd();
}

export function parseReferenceTitle(text: string): string | undefined {
    const match = REFERENCE_BRIEF_REGEXP.exec(text);
    if (!match) {
        return undefined;
    }

    const title = match[ 1 ]
        .replace(/\*\//g, "")
        .trim();

    return title.length > 0 ? title : undefined;
}

export function parseBugAnnotation(text: string): string | undefined {
    const match = REFERENCE_BUG_REGEXP.exec(text);
    if (!match) {
        return undefined;
    }

    const label = cleanCommentText(match[ 1 ]);
    return label.length > 0 ? label : "Bug";
}

export function parseTodoComment(text: string): string | undefined {
    const match = TODO_REGEXP.exec(text);
    if (!match) {
        return undefined;
    }

    const label = cleanCommentText(match[ 1 ]);
    return label.length > 0 ? label : "TODO";
}

export function normalizeReferenceId(value: string): string {
    return value.trim().replace(/\\/g, "/").toLocaleLowerCase();
}

function cleanCommentText(text: string): string {
    return text
        .replace(/\*\//g, "")
        .replace(/^[-:]\s*/, "")
        .trim();
}

export function validateReferenceId(value: string): string | undefined {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return "Reference is empty";
    }

    if (trimmed.startsWith("/")) {
        return "Reference must not start with /";
    }

    if (trimmed.endsWith("/")) {
        return "Reference must not end with /";
    }

    if (trimmed.includes("//")) {
        return "Reference must not contain empty path segments";
    }

    if (/\s/.test(trimmed)) {
        return "Reference must not contain spaces";
    }

    if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
        return "Reference contains unsupported characters";
    }

    return undefined;
}

export function parseReferenceInput(value: string): { refs: string[]; invalidRefs: ParsedInvalidReference[] } {
    const refs: string[] = [];
    const invalidRefs: ParsedInvalidReference[] = [];

    for (const rawRef of value.split(",")) {
        const ref = rawRef.trim();
        const reason = validateReferenceId(ref);

        if (reason) {
            invalidRefs.push({ value: ref, reason });
            continue;
        }

        if (!refs.includes(ref)) {
            refs.push(ref);
        }
    }

    return { refs, invalidRefs };
}

export function formatReferenceSegment(segment: string): string {
    if (/^srs-\d+$/i.test(segment)) {
        return segment.toLocaleUpperCase();
    }

    return segment
        .replace(/[-_]/g, " ")
        .split(" ")
        .filter(part => part.length > 0)
        .map(part => part.charAt(0).toLocaleUpperCase() + part.slice(1))
        .join(" ");
}

export function formatReferenceLeafTitle(referenceId: string): string {
    const segments = referenceId.split("/").filter(segment => segment.length > 0);
    const leaf = segments.length > 0 ? segments[ segments.length - 1 ] : referenceId;
    return formatReferenceSegment(leaf);
}

export function formatReferenceTitle(referenceId: string): string {
    return referenceId
        .split("/")
        .filter(segment => segment.length > 0)
        .map(formatReferenceSegment)
        .join(" / ");
}
