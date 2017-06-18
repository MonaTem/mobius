declare module NodeJS  {
	interface Global {
		observers: ((message: string) => void)[] | undefined;
	}
}

namespace concurrence {
	export function broadcast(message: string) {
		const observers = global.observers;
		if (observers) {
			for (let i = 0; i < observers.length; i++) {
				observers[i](message);
			}
		}
	}
	export function receive(callback: (message: string) => void): ConcurrenceTransaction {
		const transaction = concurrence.observeServerEventCallback<typeof callback>(callback, false);
		const observers = global.observers || (global.observers = []);
		const dispatch = (message: string) => transaction.send(message);
		observers.push(dispatch);
		const close = transaction.close;
		transaction.close = function() {
			// Cleanup when unregistering
			const index = observers.indexOf(dispatch);
			if (index != -1) {
				observers.splice(index, 1);
			}
			return close.apply(this, arguments);
		};
		return transaction;
	}
}
