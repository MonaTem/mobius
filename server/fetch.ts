import { createServerPromise, createClientPromise } from "mobius";
import { FetchOptions, FetchResponse } from "fetch-types";
import node_fetch from "node-fetch";

export default function fetch(url: string, options?: FetchOptions) : Promise<FetchResponse> {
	const serverSide = () => node_fetch(url, options).then(response => response.text().then(text => {
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
	}));
	switch (options && options.from) {
		case "client":
			return createClientPromise<FetchResponse>(() => {
				throw new Error("Fetching from the client requires a browser that supports client-side rendering!");
			});
		case "client-or-server":
			return createClientPromise<FetchResponse>(serverSide);
		case "server":
		default:
			return createServerPromise<FetchResponse>(serverSide);
	}
}
