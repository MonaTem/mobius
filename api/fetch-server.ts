/// <reference types="node-fetch" />

namespace concurrence {
	export function fetch(url: string, options?: FetchOptions) : PromiseLike<FetchResponse> {
		if (options && options.from == "client") {
			return createClientPromise<FetchResponse>();
		}
		return createServerPromise(() => require("node-fetch")(url, options).then((response: Response) => response.text().then(text => ({
			url: response.url,
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			text
		}) as FetchResponse)));
	}
}
