import { createServerPromise } from "mobius";

var cachedCookies: {[key: string]: string};
function populateCachedCookies() : {[key: string]: string} {
	if (cachedCookies) {
		return cachedCookies;
	}
	var result: {[key: string]: string} = {};
	var list = ((require("request")["headers"]["Cookie"] || "") as string).split(/;\s*/g);
	for (var i = 0; i < list.length; i++) {
		var split : string[] = list[i].split(/=/);
		if (split.length > 1) {
			result[decodeURIComponent(split[0])] = decodeURIComponent(split[1]);
		}
	}
	return cachedCookies = result;
}

export function set(key: string, value: string) {
	populateCachedCookies()[key] = value;
	require("setCookie")(key, value);
}

export async function all() : Promise<Readonly<{[key: string]: string}>> {
	return createServerPromise(populateCachedCookies);
}
