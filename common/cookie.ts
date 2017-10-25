import * as impl from "cookie-impl";

export const set = impl.set;
export const all = impl.all;

export function get(key: string): Promise<string | undefined> {
	return all().then((all) => Object.hasOwnProperty.call(all, key) ? all[key] : undefined);
}
