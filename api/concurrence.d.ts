interface ConcurrenceTransaction {
	close(): void;
}

interface ConcurrenceLocalTransaction<T extends Function> extends ConcurrenceTransaction {
	send: T; // return type of T should be void
}
