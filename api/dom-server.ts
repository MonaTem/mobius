namespace concurrence {
	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceChannel {
		return concurrence.receiveClientEventStream(callback);
	}
	export const read = concurrence.receiveClientPromise as (selector: string) => Promise<string>;
}
