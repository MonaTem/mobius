/// <reference path="../types/reduced-dom.d.ts" />

declare namespace concurrence {
	export function disconnect(): void;
	export const whenDisconnected: PromiseLike<void>;
	export let dead: boolean;
	export let insideCallback: boolean;

	// APIs for server/, not to be used inside src/
	export function receiveClientPromise<T extends ConcurrenceJsonValue | void>(...args: any[]): Promise<T>;
	export function observeServerPromise<T extends ConcurrenceJsonValue | void>(promise: Promise<T> | T, includedInPrerender?: boolean): Promise<T>;
	export function receiveClientEventStream<T extends Function>(callback: T, batched?: true): ConcurrenceChannel;
	export function observeServerEventCallback<T extends Function>(callback: T, includedInPrerender?: boolean): ConcurrenceLocalChannel<T>;
	export function showDeterminismWarning(deprecated: string, instead: string): void;
	export function coordinateValue<T extends ConcurrenceJsonValue>(generator: () => T) : T;

	export let secrets: { [key: string]: any };

	export function synchronize() : PromiseLike<void>;
}
