import { createServerPromise, createClientPromise } from "mobius";
import { FetchOptions, FetchResponse } from "fetch-types";
import node_fetch from "node-fetch";

export default function fetch(url: string, options?: FetchOptions) : PromiseLike<FetchResponse> {
	if (options && options.from == "client") {
		return createClientPromise<FetchResponse>();
	}
	return createServerPromise(() => node_fetch(url, options).then(response => response.text().then(text => {
		const headers: { [name: string]: string } = {};
		response.headers.forEach((value, name) => headers[name] = value);
		const result: FetchResponse = {
			type: response.type,
			url: response.url,
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			text,
			headers
		}
		return result;
	})));
}
