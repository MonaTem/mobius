import { createServerChannel } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { peek, Redacted } from "redact";

export { send } from "_broadcast";
import { addListener, removeListener } from "_broadcast";

export function receive(topic: string | Redacted<string>, callback: (message: JsonValue) => void, onAbort?: () => void): Channel {
	const peekedTopic = peek(topic);
	return createServerChannel(callback, (send) => {
		addListener(peekedTopic, send);
		return send;
	}, (send) => removeListener(peekedTopic, send), false);
}
