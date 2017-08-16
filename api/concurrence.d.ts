interface ConcurrenceChannel {
	channelId: number;
	close(): void;
}

interface ConcurrenceLocalChannel<T extends Function> extends ConcurrenceChannel {
	send: T; // return type of T should be void
}

interface ConcurrenceJsonMap {
	[key: string]: ConcurrenceJsonValue;
}
interface ConcurrenceJsonArray extends Array<ConcurrenceJsonValue> {
}
type ConcurrenceJsonValue = string | number | boolean | null | ConcurrenceJsonMap | ConcurrenceJsonArray;
