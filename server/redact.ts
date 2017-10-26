const symbol = Symbol();

export class Redacted<T> {
	/* tslint:disable variable-name */
	public __suppress_declared_never_used_error?: T;
	constructor(value: T) {
		Object.defineProperty(this, symbol, { value });
	}
}

export function peek<T>(value: T | Redacted<T>) {
	return value instanceof Redacted ? (value as any)[symbol] as T : value;
}

export function redact<T>(value: T) {
	return new Redacted<T>(value);
}

export function secret<T = any>(...keyPath: Array<string | number>): Redacted<T | undefined> {
	let result: any = require("secrets");
	try {
		for (const key of keyPath) {
			result = result[key];
		}
	} catch (e) {
		console.log(`Unable to read secret key path: ${keyPath.join(".")}!`);
		result = undefined;
	}
	return new Redacted<T>(result as T);
}
