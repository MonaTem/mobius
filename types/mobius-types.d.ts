export interface Channel {
	close(): void;
	readonly channelId: number;
}

export interface JsonMap {
	[key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {
}
export type JsonValue = string | number | boolean | null | JsonMap | JsonArray;
