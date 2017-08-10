interface ConcurrenceTransaction {
	close(): void;
}

interface ConcurrenceLocalTransaction<T extends Function> extends ConcurrenceTransaction {
	send: T; // return type of T should be void
}

interface ConcurrenceJsonMap {
	[key: string]: ConcurrenceJsonValue;
}
interface ConcurrenceJsonArray extends Array<ConcurrenceJsonValue> {
}
type ConcurrenceJsonValue = string | number | boolean | null | ConcurrenceJsonMap | ConcurrenceJsonArray;
