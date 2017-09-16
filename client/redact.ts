export class Redacted<T> {
	__suppress_declared_never_used_error?: T;
}

// Since we're ignoring the value anyway, we can reuse the same instance
const only = new Redacted<any>();

export function redact<T>(value: T) {
	return only as Redacted<T>;
}
