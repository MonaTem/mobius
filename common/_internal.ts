import { JsonValue } from "mobius-types";
import { roundTrip } from "./determinism";

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
	let serializedError: any = error;
	if (error instanceof Error) {
		let errorClass : any = error.constructor;
		if ("name" in errorClass) {
			type = errorClass.name;
		} else {
			// ES5 support
			type = errorClass.toString().match(/.*? (\w+)/)[0];
		}
		serializedError = { message: error.message, stack: error.stack };
		let anyError : any = error;
		for (let i in anyError) {
			if (Object.hasOwnProperty.call(anyError, i)) {
				serializedError[i] = anyError[i];
			}
		}
	}
	return [channelId, serializedError, type];
}

export function parseValueEvent<T>(event: Event | undefined, resolve: (value: JsonValue) => T, reject: (error: Error | JsonValue) => T) : T {
	if (!event) {
		return reject(disconnectedError());
	}
	let value = event[1];
	if (event.length != 3) {
		return resolve(value);
	}
	const type = event[2];
	// Convert serialized representation into the appropriate Error type
	if (type != 1 && /Error$/.test(type)) {
		const ErrorType : typeof Error = (self as any)[type] || Error;
		const error: Error = new ErrorType(value.message);
		delete value.message;
		for (let i in value) {
			if (Object.hasOwnProperty.call(value, i)) {
				(error as any)[i] = value[i];
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
