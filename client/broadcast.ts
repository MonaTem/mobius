import { flush, createServerChannel } from "concurrence";
import { ConcurrenceJsonValue, ConcurrenceChannel } from "concurrence-types";

export const send: (topic: string, message: ConcurrenceJsonValue) => void = flush;
export function receive(topic: string, callback: (message: ConcurrenceJsonValue) => void, onAbort?: () => void) : ConcurrenceChannel {
	return createServerChannel(callback, onAbort);
}
