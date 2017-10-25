import { createServerPromise } from "mobius";

export function set(key: string, value: string) {
	document.cookie = encodeURIComponent(key) + "=" + encodeURIComponent(value);
}

export function all(): Promise<Readonly<{[key: string]: string}>> {
	return createServerPromise<Readonly<{[key: string]: string}>>(() => {
		const result: {[key: string]: string} = {};
		const list = document.cookie.split(/;\s*/g);
		for (let i = 0; i < list.length; i++) {
			const split: string[] = list[i].split(/=/);
			if (split.length > 1) {
				result[decodeURIComponent(split[0])] = decodeURIComponent(split[1]);
			}
		}
		return result;
	});
}
