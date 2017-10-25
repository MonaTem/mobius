export class Redacted<T> {
	public __suppress_declared_never_used_error?: T;
}

export function redact<T>(value: T) {
	return new Redacted<T>();
}

export function secret<T = any>(...keyPath: Array<string | number>): Redacted<T | undefined> {
	return new Redacted<T | undefined>();
}
