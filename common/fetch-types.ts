import { JsonMap } from "mobius-types";

export interface FetchOptions {
	method?: string;
	headers?: { [name: string]: string };
	body?: string;
	redirect?: "follow" | "error" | "manual";
	from?: "server" | "client" | "client-or-server";
}
export interface FetchResponse extends JsonMap {
	type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
	url: string;
	status: number;
	ok: boolean;
	statusText: string;
	text: string;
	headers: { [name: string]: string };
}
