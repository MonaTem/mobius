export class Redacted<T> {
	__suppress_declared_never_used_error?: T;
}

export function redact<T>(value: T) {
	return new Redacted<T>();
}
