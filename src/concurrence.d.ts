interface ConcurrenceTransaction {
	close(): void;
}

interface ConcurrenceLocalTransaction<T> extends ConcurrenceTransaction {
	send: T;
}
