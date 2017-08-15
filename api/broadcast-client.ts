namespace concurrence {
	export function broadcast(inboxName: string, message: ConcurrenceJsonValue) {};
	export function receive(inboxName: string, callback: (message: ConcurrenceJsonValue) => void) {
		return concurrence.receiveServerEventStream(callback);
	}
}
