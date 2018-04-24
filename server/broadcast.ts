import { createServerChannel, createServerPromise } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { peek, redact, Redacted } from "redact";

import { addListener, removeListener, send as sendImplementation } from "_broadcast";

export type Topic<T> = Redacted<string> & { messageType: T };
export const topic = redact as <T extends JsonValue>(name: string) => Topic<T>;

export function send<T extends JsonValue>(dest: Topic<T>, message: T | Redacted<T>): Promise<void> {
	return createServerPromise<void>(() => {
		sendImplementation(peek(dest as any), peek(message));
	});
}

export function receive<T extends JsonValue>(source: Topic<T>, callback: (message: T) => void, onAbort?: () => void): Channel {
	const peekedTopic = peek(source as any as Redacted<string>);
	return createServerChannel(callback, (sendMessage) => {
		addListener(peekedTopic, sendMessage as (message: JsonValue) => void);
		return sendMessage;
	}, (sendMessage) => removeListener(peekedTopic, sendMessage as (message: JsonValue) => void), false);
}
