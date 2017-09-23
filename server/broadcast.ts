import { createServerChannel } from "mobius";
import { JsonValue, Channel } from "mobius-types";

declare global {
	namespace NodeJS {
		export interface Global {
			observers?: { [topic: string]: ((message: JsonValue) => void)[] };
		}
	}
}

export const send = (topic: string, message: JsonValue) => {
	const topics = global.observers;
	if (topics && Object.hasOwnProperty.call(topics, topic)) {
		topics[topic].slice().forEach(async (observer) => observer(message));
	}
}

export function receive(topic: string, callback: (message: JsonValue) => void, onAbort?: () => void): Channel {
	const topics = global.observers || (global.observers = {});
	return createServerChannel(callback, send => {
		const observers = Object.hasOwnProperty.call(topics, topic) ? topics[topic] : (topics[topic] = []);
		observers.push(send);
		return send;
	}, send => {
		if (Object.hasOwnProperty.call(topics, topic)) {
			const observers = topics[topic];
			const index = observers.indexOf(send);
			if (index != -1) {
				observers.splice(index, 1);
			}
			if (observers.length == 0) {
				delete topics[topic];
			}
		}
	}, false);
}
