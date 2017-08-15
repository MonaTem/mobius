declare module NodeJS  {
	interface Global {
		observers?: { [inboxName: string]: ((message: ConcurrenceJsonValue) => void)[] };
	}
}

namespace concurrence {
	export function broadcast(inboxName: string, message: ConcurrenceJsonValue) {
		const inboxes = global.observers;
		if (inboxes && Object.hasOwnProperty.call(inboxes, inboxName)) {
			const observers = inboxes[inboxName];
			for (let i = 0; i < observers.length; i++) {
				observers[i](message);
			}
		}
	}
	export function receive(inboxName: string, callback: (message: ConcurrenceJsonValue) => void): ConcurrenceChannel {
		const transaction = concurrence.observeServerEventCallback<typeof callback>(callback, false);
		const inboxes = global.observers || (global.observers = {});
		const observers = Object.hasOwnProperty.call(inboxes, inboxName) ? inboxes[inboxName] : (inboxes[inboxName] = []);
		const dispatch = (message: ConcurrenceJsonValue) => transaction.send(message);
		observers.push(dispatch);
		const close = transaction.close;
		transaction.close = function() {
			// Cleanup when unregistering
			const index = observers.indexOf(dispatch);
			if (index != -1) {
				observers.splice(index, 1);
			}
			if (observers.length == 0) {
				delete inboxes[inboxName];
			}
			return close.apply(this, arguments);
		};
		return transaction;
	}
}
