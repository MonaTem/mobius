/// <reference types="node-fetch" />

namespace concurrence {
	export function fetch(url: string, options?: FetchOptions) : PromiseLike<FetchResponse> {
		return createServerPromise<FetchResponse>(() => new Promise<Response>(resolve => resolve(require("node-fetch")(url, options))).then(response => response.text().then(text => ({
			url: response.url,
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			text
		}) as FetchResponse)));
	}
}
