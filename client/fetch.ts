import { FetchOptions, FetchResponse } from "fetch-types";
import { createClientPromise, createServerPromise } from "mobius";
import { Redacted } from "redact";

export async function fromClient(url: string, options?: FetchOptions): Promise<FetchResponse> {
	const request = await createClientPromise<FetchResponse>(() => new Promise<XMLHttpRequest>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const method = options!.method;
		xhr.open(typeof method == "string" ? method : "GET", url, true);
		const headers = options!.headers;
		if (headers) {
			for (const headerName in headers) {
				if (Object.hasOwnProperty.call(headers, headerName)) {
					xhr.setRequestHeader(headerName, headers[headerName]);
				}
			}
		}
		xhr.onreadystatechange = () => {
			if (xhr.readyState == 4) {
				try {
					if (xhr.status != 0) {
						return resolve(xhr);
					}
				} catch (e) {
					/* tslint:disable no-empty */
				}
				reject(new TypeError("Request not sent!"));
			}
		};
		if ("body" in options!) {
			xhr.send(options!.body);
		} else {
			xhr.send();
		}
	}));
	const headerString = request.getAllResponseHeaders ? request.getAllResponseHeaders() : null;
	const responseHeaders: { [name: string]: string } = {};
	if (headerString) {
		const splitHeaders = headerString.split(/\r?\n/g);
		for (let i = 0; i < splitHeaders.length; i++) {
			const pair = splitHeaders[i].match(/^(.*?): (.*)/);
			if (pair) {
				responseHeaders[pair[1] as string] = pair[2] as string;
			}
		}
	}
	const status = request.status;
	const response: FetchResponse = {
		type: "basic",
		url,
		status,
		ok: status >= 200 && status < 300,
		statusText: request.statusText,
		text: request.responseText,
		headers: responseHeaders,
	};
	return response;
}
export const fromClientOrServer = fromClient;

export function fromServer(url: string | Redacted<string>, options?: FetchOptions | Redacted<string>): Promise<FetchResponse> {
	return createServerPromise<FetchResponse>();
}

export default fromServer;
