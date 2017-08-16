namespace concurrence {
	export function broadcast(topic: string, message: ConcurrenceJsonValue) {};
	export function receive(topic: string, callback: (message: ConcurrenceJsonValue) => void) {
		return concurrence.receiveServerEventStream(callback);
	}
}
