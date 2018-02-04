import * as impl from "cookie-impl";

let cache: {[key: string]: string} | undefined;

export function set(key: string, value: string) {
	if (cache) {
		cache[key] = value;
	}
	return impl.set(key, value);
}

export async function all() {
	return cache || (cache = await impl.all());
}

export async function get(key: string) {
	return (await all())[key];
}
