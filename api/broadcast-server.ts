declare module NodeJS  {
	interface Global {
		observers?: { [topic: string]: ((message: ConcurrenceJsonValue) => void)[] };
	}
}

namespace concurrence {
	export function broadcast(topic: string, message: ConcurrenceJsonValue) {
		const topics = global.observers;
		if (topics && Object.hasOwnProperty.call(topics, topic)) {
			const observers = topics[topic];
			for (let i = 0; i < observers.length; i++) {
				observers[i](message);
			}
		}
	}
	export function receive(topic: string, callback: (message: ConcurrenceJsonValue) => void): ConcurrenceChannel {
		const channel = concurrence.observeServerEventCallback<typeof callback>(callback, false);
		const topics = global.observers || (global.observers = {});
		const observers = Object.hasOwnProperty.call(topics, topic) ? topics[topic] : (topics[topic] = []);
		const dispatch = (message: ConcurrenceJsonValue) => channel.send(message);
		observers.push(dispatch);
		const close = channel.close;
		channel.close = function() {
			// Cleanup when unregistering
			const index = observers.indexOf(dispatch);
			if (index != -1) {
				observers.splice(index, 1);
			}
			if (observers.length == 0) {
				delete topics[topic];
			}
			return close.apply(this, arguments);
		};
		return channel;
	}
}
