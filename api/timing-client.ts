namespace concurrence {
	export const now = concurrence.receiveServerPromise as () => Promise<number>;
	export const interval = concurrence.receiveServerEventStream as (callback: () => void, millis: number) => ConcurrenceChannel;
	export const timeout = concurrence.receiveServerPromise as (millis: number) => Promise<void>;
}
