import { createServerPromise, createClientPromise } from "mobius";
import { FetchOptions, FetchResponse } from "fetch-types";
import { peek, Redacted } from "redact";
import node_fetch from "node-fetch";

async function fetch(url: string, options?: FetchOptions) {
	const response = await node_fetch(url, options);
	const headers: { [name: string]: string } = {};
	response.headers.forEach((value, name) => headers[name] = value);
	const result: FetchResponse = {
		type: response.type,
		url: response.url,
		status: response.status,
		ok: response.ok,
		statusText: response.statusText,
		text: await response.text(),
		headers
	}
	return result;
}

export function fromClient(url: string, options?: FetchOptions) : Promise<FetchResponse> {
	return createClientPromise<FetchResponse>(() => {
		throw new Error("Fetching from the client requires a browser that supports client-side rendering!");
	});
}

export function fromClientOrServer(url: string, options?: FetchOptions) : Promise<FetchResponse> {
	return createClientPromise<FetchResponse>(() => fetch(url, options));
}

export function fromServer(url: string | Redacted<string>, options?: FetchOptions | Redacted<FetchOptions>) : Promise<FetchResponse> {
	return createServerPromise<FetchResponse>(() => fetch(peek(url), options ? peek(options) : undefined));
}

export default fromServer;
