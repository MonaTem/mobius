interface ConcurrenceChannel {
	close(): void;
}

interface ConcurrenceJsonMap {
	[key: string]: ConcurrenceJsonValue;
}
interface ConcurrenceJsonArray extends Array<ConcurrenceJsonValue> {
}
type ConcurrenceJsonValue = string | number | boolean | null | ConcurrenceJsonMap | ConcurrenceJsonArray;
