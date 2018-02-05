import { createServerPromise } from "mobius";

let cachedCookies: {[key: string]: string} | undefined;

async function populateCachedCookies(): Promise<{[key: string]: string}> {
	if (cachedCookies) {
		return cachedCookies;
	}
	const newCookies = await (require("allCookies") as () => Promise<{[key: string]: string}>)();
	return cachedCookies || (cachedCookies = newCookies);
}

export function set(key: string, value: string) {
	populateCachedCookies().then((cookies) => cookies[key] = value);
	require("setCookie")(key, value);
}

export function all(): Promise<Readonly<{[key: string]: string}>> {
	return createServerPromise(populateCachedCookies);
}
