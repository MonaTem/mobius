import * as impl from "cookie-impl";

export const set = impl.set;
export const all = impl.all;

export async function get(key: string): Promise<string | undefined> {
	const cookies = await all();
	return Object.hasOwnProperty.call(cookies, key) ? cookies[key] : undefined;
}
