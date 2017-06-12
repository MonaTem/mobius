namespace concurrence {
	export function broadcast(text: string) {
		const observers = (global as any).observers;
		if (observers) {
			for (let i = 0; i < observers.length; i++) {
				observers[i](text);
			}
		}
	}
	export function receive(callback: (value: string) => void): ConcurrenceTransaction {
		const transaction = concurrence.observeServerEventCallback<typeof callback>(callback, false);
		const observers = (global as any).observers || ((global as any).observers = []);
		observers.push((text: string) => transaction.send(text));
		return transaction;
	}
}
