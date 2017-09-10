export interface ConcurrenceChannel {
	close(): void;
	readonly channelId: number;
}

export interface ConcurrenceJsonMap {
	[key: string]: ConcurrenceJsonValue;
}
export interface ConcurrenceJsonArray extends Array<ConcurrenceJsonValue> {
}
export type ConcurrenceJsonValue = string | number | boolean | null | ConcurrenceJsonMap | ConcurrenceJsonArray;
