import { Channel, JsonValue } from "mobius-types";

export let dead: boolean;
export function disconnect(): void;
export function flush() : Promise<void>;
export function synchronize() : Promise<void>;
// APIs for server/, not to be used inside src/
export function createClientPromise<T extends JsonValue | void>(fallback?: () => Promise<T> | T): Promise<T>;
export function createServerPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender?: boolean): Promise<T>;
export function createClientChannel<T extends Function>(callback: T): Channel;
export function createServerChannel<T extends Function, U = void>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean): Channel;
export function coordinateValue<T extends JsonValue>(generator: () => T) : T;
export function shareSession() : Promise<string>;
