type BusinessCode = "not_found" | "conflict" | "busy" | "invalid_input";
export declare class BusinessError extends Error {
    readonly code: BusinessCode;
    constructor(code: BusinessCode, message: string);
}
export declare function invalid(message: string): BusinessError;
export {};
//# sourceMappingURL=errors.d.ts.map