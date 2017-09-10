import { ConcurrenceChannel, ConcurrenceJsonValue } from "concurrence-types";

export let insideCallback: boolean;
export let dead: boolean;
export const whenDisconnected: PromiseLike<void>;
export function disconnect(): void;
export function flush() : void;
export function synchronize() : PromiseLike<void>;
// APIs for server/, not to be used inside src/
export function createClientPromise<T extends ConcurrenceJsonValue | void>(...args: any[]): Promise<T>;
export function createServerPromise<T extends ConcurrenceJsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender?: boolean): Promise<T>;
export function createClientChannel<T extends Function>(callback: T): ConcurrenceChannel;
export function createServerChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean): ConcurrenceChannel;
export function showDeterminismWarning(deprecated: string, instead: string): void;
export function coordinateValue<T extends ConcurrenceJsonValue>(generator: () => T) : T;
export function shareSession() : PromiseLike<string>;

export let secrets: { [key: string]: any };

