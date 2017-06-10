/// <reference path="concurrence.ts" />

namespace concurrence {
	export function observe(selector: string, event: string, callback: () => void) : ConcurrenceTransaction {
		return concurrence.receiveClientEventStream(callback);
	}
	export const read = concurrence.receiveClientPromise as (selector: string) => Promise<string>;
}
