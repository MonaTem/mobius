import { createServerChannel } from "mobius";
import { JsonValue, JsonArray, JsonMap, Channel } from "mobius-types";
import { peek, Redacted } from "redact";

declare global {
	namespace NodeJS {
		export interface Global {
			observers?: { [topic: string]: ((message: JsonValue) => void)[] };
		}
	}
}

export const send = (topic: string | Redacted<string>, message: JsonValue | Redacted<JsonValue | JsonArray | JsonMap>) => {
	const peekedTopic = peek(topic);
	const peekedMessage = peek(message);
	const topics = global.observers;
	if (topics && Object.hasOwnProperty.call(topics, peekedTopic)) {
		topics[peekedTopic].slice().forEach(async (observer) => observer(peekedMessage));
	}
}

export function receive(topic: string | Redacted<string>, callback: (message: JsonValue) => void, onAbort?: () => void): Channel {
	const topics = global.observers || (global.observers = {});
	const peekedTopic = peek(topic);
	return createServerChannel(callback, send => {
		const observers = Object.hasOwnProperty.call(topics, peekedTopic) ? topics[peekedTopic] : (topics[peekedTopic] = []);
		observers.push(send);
		return send;
	}, send => {
		if (Object.hasOwnProperty.call(topics, peekedTopic)) {
			const observers = topics[peekedTopic];
			const index = observers.indexOf(send);
			if (index != -1) {
				observers.splice(index, 1);
			}
			if (observers.length == 0) {
				delete topics[peekedTopic];
			}
		}
	}, false);
}
