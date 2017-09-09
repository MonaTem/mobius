namespace concurrence {
	export function fetch(url: string, options?: FetchOptions) : PromiseLike<FetchResponse> {
		if (options && options.from == "client") {
			return createClientPromise<FetchResponse>(() => (new Promise<XMLHttpRequest>((resolve, reject) => {
				const request = new XMLHttpRequest();
				request.open(typeof options.method == "string" ? options.method : "GET", url, true);
				const headers = options.headers;
				if (headers) {
					for (var headerName in headers) {
						if (Object.hasOwnProperty.call(headers, headerName)) {
							request.setRequestHeader(headerName, headers[headerName]);
						}
					}
				}
				request.onreadystatechange = () => {
					if (request.readyState == 4) {
						try {
							if (request.status != 0) {
								return resolve(request);
							}
						} catch (e) {
						}
						reject(new TypeError("Request not sent!"));
					}
				}
				if ("body" in options) {
					request.send(options.body);
				} else {
					request.send();
				}
			})).then(request => {
				const headerString = request.getAllResponseHeaders ? request.getAllResponseHeaders() : null;
				const headers: { [name: string]: string } = {};
				if (headerString) {
					const splitHeaders = headerString.split(/\r?\n/g);
					for (var i = 0; i < splitHeaders.length; i++) {
						const pair = splitHeaders[i].match(/^(.*?): (.*)/);
						if (pair) {
							headers[pair[1] as string] = pair[2] as string;
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
					headers,
				};
				return response;
			}));
		}
		return createServerPromise<FetchResponse>();
	}
}
