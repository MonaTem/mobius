import { JsonValue, JsonArray, JsonMap } from "mobius-types";
import { peek, Redacted } from "redact";

export function send(topic: string | Redacted<string>, message: JsonValue | Redacted<JsonValue | JsonArray | JsonMap>) : void;
export function addListener(topic: string, callback: (message: JsonValue) => void) : void;
export function removeListener(topic: string, callback: (message: JsonValue) => void) : void;
