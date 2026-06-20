/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Uri } from "vscode";
import { ReferenceGroup, ReferenceLocation, ReferenceProblem } from "./referenceModel";

export class ReferenceIndex {

    private groups = new Map<string, ReferenceGroup>();
    private jsonLocations: ReferenceLocation[] = [];
    private jsonProblems: ReferenceProblem[] = [];
    private annotationLocationsByFile = new Map<string, ReferenceLocation[]>();
    private annotationProblemsByFile = new Map<string, ReferenceProblem[]>();

    public replaceJson(groups: ReferenceGroup[], locations: ReferenceLocation[], problems: ReferenceProblem[]): void {
        this.groups = new Map(groups.map(group => [ group.normalizedId, group ]));
        this.jsonLocations = locations;
        this.jsonProblems = problems;
    }

    public replaceAnnotations(locations: ReferenceLocation[], problems: ReferenceProblem[]): void {
        this.annotationLocationsByFile.clear();
        this.annotationProblemsByFile.clear();

        for (const location of locations) {
            const key = getUriKey(location.uri);
            const fileLocations = this.annotationLocationsByFile.get(key) ?? [];
            fileLocations.push(location);
            this.annotationLocationsByFile.set(key, fileLocations);
        }

        for (const problem of problems) {
            const key = problem.uri ? getUriKey(problem.uri) : "__workspace";
            const fileProblems = this.annotationProblemsByFile.get(key) ?? [];
            fileProblems.push(problem);
            this.annotationProblemsByFile.set(key, fileProblems);
        }
    }

    public replaceFileAnnotations(uri: Uri, locations: ReferenceLocation[], problems: ReferenceProblem[]): void {
        const key = getUriKey(uri);
        this.annotationLocationsByFile.set(key, locations);
        this.annotationProblemsByFile.set(key, problems);
    }

    public removeFileAnnotations(uri: Uri): void {
        const key = getUriKey(uri);
        this.annotationLocationsByFile.delete(key);
        this.annotationProblemsByFile.delete(key);
    }

    public getGroups(): Map<string, ReferenceGroup> {
        return new Map(this.groups);
    }

    public getGroup(referenceId: string): ReferenceGroup | undefined {
        return this.groups.get(referenceId);
    }

    public getLocations(): ReferenceLocation[] {
        return uniqueLocations([
            ...this.jsonLocations,
            ...Array.from(this.annotationLocationsByFile.values()).flat()
        ]);
    }

    public getAnnotationLocations(): ReferenceLocation[] {
        return Array.from(this.annotationLocationsByFile.values()).flat()
            .filter(location => location.source === "annotation");
    }

    public getProblems(): ReferenceProblem[] {
        return [
            ...this.jsonProblems,
            ...Array.from(this.annotationProblemsByFile.values()).flat()
        ];
    }

    public getKnownReferenceIds(): string[] {
        const references = new Set<string>();

        for (const group of this.groups.keys()) {
            references.add(group);
        }

        for (const location of this.getLocations()) {
            for (const ref of location.refs) {
                references.add(ref);
            }
        }

        return Array.from(references).sort((left, right) => left.localeCompare(right));
    }

    public getLocationsAt(uri: Uri, line: number): ReferenceLocation[] {
        const key = getUriKey(uri);
        return this.getLocations()
            .filter(location => getUriKey(location.uri) === key && location.line === line);
    }
}

function getUriKey(uri: Uri): string {
    return uri.toString().toLocaleLowerCase();
}

function uniqueLocations(locations: ReferenceLocation[]): ReferenceLocation[] {
    const unique = new Map<string, ReferenceLocation>();

    for (const location of locations) {
        const key = [
            getUriKey(location.uri),
            location.line,
            location.column,
            location.symbol ?? "",
            [ ...location.refs ].sort((left, right) => left.localeCompare(right)).join(",")
        ].join("|");

        const existingLocation = unique.get(key);
        if (!existingLocation || existingLocation.source === "annotation") {
            unique.set(key, location);
        }
    }

    return Array.from(unique.values());
}
