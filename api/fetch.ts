namespace concurrence {
	export interface FetchOptions {
		method?: string;
		headers?: { [index: string]: string };
		body?: string;
		redirect?: "follow" | "error" | "manual";
	}
	export interface FetchResponse extends ConcurrenceJsonMap {
		type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
		url: string;
		status: number;
		ok: boolean;
		size: number;
		statusText: string;
		timeout: number;
		text: string;
	}
}
