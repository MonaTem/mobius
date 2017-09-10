import { flush, createServerChannel } from "mobius";
import { JsonValue, Channel } from "mobius-types";

export const send: (topic: string, message: JsonValue) => void = flush;
export function receive(topic: string, callback: (message: JsonValue) => void, onAbort?: () => void) : Channel {
	return createServerChannel(callback, onAbort);
}
