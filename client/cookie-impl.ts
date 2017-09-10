export function set(key: string, value: string) {
	document.cookie = encodeURIComponent(key) + "=" + encodeURIComponent(value);
}

export function all() : Promise<Readonly<{[key: string]: string}>> {
	return new Promise<Readonly<{[key: string]: string}>>(resolve => {
		var result: {[key: string]: string} = {};
		var list = document.cookie.split(/;\s*/g);
		for (var i = 0; i < list.length; i++) {
			var split : string[] = list[i].split(/=/);
			if (split.length > 1) {
				result[decodeURIComponent(split[0])] = decodeURIComponent(split[1]);
			}
		}
		resolve(result);
	});
}
