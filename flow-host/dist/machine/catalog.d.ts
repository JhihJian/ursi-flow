export declare function id(value: unknown): string;
export declare function readJson(file: string): Promise<any>;
export declare function save(file: string, value: unknown): Promise<void>;
export declare function optional<T>(op: Promise<T>, fallback: T): Promise<T>;
export type PackageFiles = Record<string, string>;
export declare function checkFiles(files: unknown): asserts files is PackageFiles;
export declare class Catalog {
    readonly home: string;
    constructor(home: string);
    private published;
    current(): Promise<string | null>;
    root(revision: string): string;
    private publish;
    list(): Promise<string[]>;
    get(name: string, expectedRevision?: string): Promise<{
        id: string;
        revision: string;
        files: PackageFiles;
    }>;
    change(op: string, name: string, files: unknown, expected?: string): Promise<{
        id: string;
        valid: boolean;
        revision?: undefined;
    } | {
        id: string;
        revision: `${string}-${string}-${string}-${string}-${string}`;
        valid?: undefined;
    }>;
}
//# sourceMappingURL=catalog.d.ts.map