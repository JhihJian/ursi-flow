type BusinessCode = "not_found" | "conflict" | "busy" | "invalid_input";

export class BusinessError extends Error {
	readonly code: BusinessCode;
	constructor(code: BusinessCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function invalid(message: string) {
	return new BusinessError("invalid_input", message);
}
