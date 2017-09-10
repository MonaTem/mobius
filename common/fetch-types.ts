import { ConcurrenceJsonMap } from "concurrence-types";

export interface FetchOptions {
	method?: string;
	headers?: { [name: string]: string };
	body?: string;
	redirect?: "follow" | "error" | "manual";
	from?: "server" | "client";
}
export interface FetchResponse extends ConcurrenceJsonMap {
	type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
	url: string;
	status: number;
	ok: boolean;
	statusText: string;
	text: string;
	headers: { [name: string]: string };
}
