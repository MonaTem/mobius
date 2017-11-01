import { createServerChannel, flush } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { Redacted } from "redact";

export class Topic<T extends JsonValue> {
	/* tslint:disable variable-name */
	public __suppress_declared_never_used_error?: T;
}

export function topic<T extends JsonValue>(name: string | Redacted<string>) : Topic<T> {
	return name as any;
}

export function send<T extends JsonValue>(topic: Topic<T>, message: T | Redacted<T>) {
	flush();
}

export function receive<T extends JsonValue>(topic: Topic<T>, callback: (message: T) => void, onAbort?: () => void): Channel {
	return createServerChannel(callback, onAbort);
}
