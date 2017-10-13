export class Redacted<T> {
	__suppress_declared_never_used_error?: T;
}

export function redact<T>(value: T) {
	return new Redacted<T>();
}

export function secret<T = any>(...keyPath: (string | number)[]) : Redacted<T | undefined> {
	return new Redacted<T | undefined>();
}
