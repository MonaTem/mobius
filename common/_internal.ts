import { JsonValue } from "mobius-types";

function classNameForConstructor(constructor: any): string {
	const name = constructor.name as string | undefined;
	// Support ES5 by falling back to parsing toString
	return name || Object.toString.call(constructor).match(/.*? (\w+)/)[1];
}

function throwError(message: string) {
	throw new Error(message);
}

function roundTripValue(obj: any, cycleDetection: any[]) : any {
	// Round-trip values through JSON so that the client receives exactly the same type of values as the server
	// return typeof obj == "undefined" ? obj : JSON.parse(JSON.stringify(obj)) as T;
	switch (typeof obj) {
		default:
			if (obj !== null) {
				if (cycleDetection.indexOf(obj) != -1) {
					throwError("Cycles do not round-trip!");
				}
				cycleDetection.push(obj);
				let result: any;
				const constructor = obj.constructor;
				switch (constructor) {
					case undefined:
					case Object:
						result = {};
						for (var key in obj) {
							if (Object.hasOwnProperty.call(obj, key)) {
								result[key] = roundTripValue(obj[key], cycleDetection);
							}
						}
						break;
					case Array:
						result = [];
						for (var i = 0; i < obj.length; i++) {
							result[i] = roundTripValue(obj[i], cycleDetection);
						}
						break;
					default:
						throwError(classNameForConstructor(constructor) + " does not round-trip!");
				}
				cycleDetection.pop();
				return result;
			}
			// fallthrough
		case "boolean":
		case "string":
			return obj;
		case "number":
			if (obj !== obj) {
				throwError("NaN does not round-trip!");
			}
			return obj;
		case "undefined":
			throwError("undefined does not round-trip!");
	}
}

export function roundTrip<T extends JsonValue | void>(obj: T) : T {
	return typeof obj == "undefined" ? obj : roundTripValue(obj, []) as T;
}

export type Event = [number] | [number, any] | [number, any, any];

export interface ServerMessage {
	events: Event[];
	messageID: number;
	close?: boolean;
}

export interface ClientMessage extends ServerMessage {
	sessionID?: string;
	clientID?: number;
	destroy?: true;
	noJavaScript?: true;
}

export interface BootstrapData {
	sessionID: string;
	clientID?: number;
	events?: (Event | boolean)[];
	channels?: number[];
}


export function logOrdering(from: "client" | "server", type: "open" | "close" | "message", channelId: number, sessionID?: string) {
	// const stack = (new Error().stack || "").toString().split(/\n\s*/).slice(2).map(s => s.replace(/^at\s*/, ""));
	// console.log(from + " " + type + " " + channelId + (sessionID ? " " + sessionID : ""), stack);
}

export function disconnectedError() {
	return new Error("Session has been disconnected!");
}

export function eventForValue(channelId: number, value: JsonValue | void) : Event {
	return typeof value == "undefined" ? [channelId] : [channelId, roundTrip(value)];
}

export function eventForException(channelId: number, error: any) : Event {
	// Convert Error types to a representation that can be reconstituted remotely
	let type : any = 1;
	let serializedError: { [key: string]: JsonValue } = {};
	if (error instanceof Error) {
		let errorClass : any = error.constructor;
		type = classNameForConstructor(errorClass);
		serializedError = { message: roundTrip(error.message) };
		let anyError : any = error;
		for (let i in anyError) {
			if (Object.hasOwnProperty.call(anyError, i)) {
				serializedError[i] = roundTrip(anyError[i]);
			}
		}
	}
	return [channelId, serializedError, type];
}

export function parseValueEvent<T>(global: any, event: Event | undefined, resolve: (value: JsonValue) => T, reject: (error: Error | JsonValue) => T) : T {
	if (!event) {
		return reject(disconnectedError());
	}
	let value = roundTrip(event[1]);
	if (event.length != 3) {
		return resolve(value);
	}
	const type = event[2];
	// Convert serialized representation into the appropriate Error type
	if (type != 1 && /Error$/.test(type)) {
		const ErrorType : typeof Error = global[type] || Error;
		const error: Error = new ErrorType(value.message);
		for (var i in value) {
			if (Object.hasOwnProperty.call(value, i) && i != "message") {
				(error as any)[i] = roundTrip(value[i]);
			}
		}
		return reject(error);
	}
	return reject(value);
}

export function deserializeMessageFromText<T extends ServerMessage>(messageText: string, defaultMessageID: number) : T {
	const result = ((messageText.length == 0 || messageText[0] == "[") ? { events: JSON.parse("[" + messageText + "]") } : JSON.parse(messageText)) as T;
	result.messageID = result.messageID | defaultMessageID;
	if (!result.events) {
		result.events = [];
	}
	return result;
}

export function serializeMessageAsText(message: Partial<ServerMessage | ClientMessage>) : string {
	if ("events" in message && !("messageID" in message) && !("close" in message) && !("destroy" in message) && !("clientID" in message)) {
		// Only send events, if that's all we have to send
		return JSON.stringify(message.events).slice(1, -1);
	}
	return JSON.stringify(message);
}
