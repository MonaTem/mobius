/// <reference path="concurrence.ts" />

namespace concurrence {
	export function now(): Promise<number> {
		return concurrence.observeServerPromise(Date.now());
	}
	export function interval(callback: () => void, millis: number): ConcurrenceTransaction {
		const transaction = concurrence.observeServerEventCallback<void>(callback);
		const interval = setInterval(_ => {
			if (concurrence.dead) {
				transaction.close();
				clearInterval(interval);
			} else {
				transaction.send(undefined);
			}
		}, millis);
		return transaction;
	}
	export function timeout(millis: number): Promise<void> {
		return concurrence.observeServerPromise<void>(new Promise<void>(resolve => { setTimeout(() => resolve(), millis) }));
	}
}
