namespace concurrence {
	export const broadcast: (topic: string, message: ConcurrenceJsonValue) => void = concurrence.flush;
	export function receive(topic: string, callback: (message: ConcurrenceJsonValue) => void) {
		return concurrence.receiveServerEventStream(callback);
	}
}
