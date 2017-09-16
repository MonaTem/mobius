export class Redacted<T> {
	value: T;
	constructor(value: T) {
		this.value = value;
	}
}

export function peek<T>(value: T | Redacted<T>) {
	return value instanceof Redacted ? value.value : value;
}

export function redact<T>(value: T) {
	return new Redacted<T>(value);
}
