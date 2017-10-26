import * as impl from "cookie-impl";

export const set = impl.set;
export const all = impl.all;

export function get(key: string): Promise<string | undefined> {
	return all().then((cookies) => Object.hasOwnProperty.call(cookies, key) ? cookies[key] : undefined);
}
