export class BusinessError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function invalid(message) {
    return new BusinessError("invalid_input", message);
}
//# sourceMappingURL=errors.js.map