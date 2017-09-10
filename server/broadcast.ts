import { createServerChannel } from "concurrence";
import { ConcurrenceJsonValue, ConcurrenceChannel } from "concurrence-types";

declare global {
	namespace NodeJS {
		export interface Global {
			observers?: { [topic: string]: ((message: ConcurrenceJsonValue) => void)[] };
		}
	}
}

export const send = (topic: string, message: ConcurrenceJsonValue) => {
	const topics = global.observers;
	if (topics && Object.hasOwnProperty.call(topics, topic)) {
		const observers = topics[topic];
		for (let i = 0; i < observers.length; i++) {
			observers[i](message);
		}
	}
}
export function receive(topic: string, callback: (message: ConcurrenceJsonValue) => void, onAbort?: () => void): ConcurrenceChannel {
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
