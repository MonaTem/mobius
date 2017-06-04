/// <reference path="concurrence.ts" />

namespace concurrence {
	export function broadcast(text: string) {};
	export const receive = concurrence.receiveServerEventStream as (callback: (value: string) => void) => ConcurrenceTransaction;
}
