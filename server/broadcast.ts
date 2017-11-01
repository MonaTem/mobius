import { createServerChannel } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { peek, Redacted } from "redact";

import { send as sendImplementation, addListener, removeListener } from "_broadcast";

export class Topic<T extends JsonValue> {
	/* tslint:disable variable-name */
	public __suppress_declared_never_used_error?: T;
}

export function topic<T extends JsonValue>(name: string | Redacted<string>) : Topic<T> {
	return name as any;
}

export function send<T extends JsonValue>(topic: Topic<T>, message: T | Redacted<T>) {
	sendImplementation(topic as any, message);
}

export function receive<T extends JsonValue>(topic: Topic<T>, callback: (message: T) => void, onAbort?: () => void): Channel {
	const peekedTopic = peek(topic as any as Redacted<string>);
	return createServerChannel(callback, send => {
		addListener(peekedTopic, send as (message: JsonValue) => void);
		return send;
	}, (send) => removeListener(peekedTopic, send as (message: JsonValue) => void), false);
}
