/// <reference path="../types/reduced-dom.d.ts" />

declare namespace concurrence {
	export function disconnect(): void;
	export let dead: boolean;
	export let insideCallback: boolean;

	// APIs for server/, not to be used inside src/
	export function receiveClientPromise<T extends ConcurrenceJsonValue | void>(...args: any[]): Promise<T>;
	export function observeServerPromise<T extends ConcurrenceJsonValue | void>(promise: Promise<T> | T, includedInPrerender?: boolean): Promise<T>;
	export function receiveClientEventStream<T extends Function>(callback: T, batched?: true): ConcurrenceChannel;
	export function observeServerEventCallback<T extends Function>(callback: T, includedInPrerender?: boolean): ConcurrenceLocalChannel<T>;
	export function showDeterminismWarning(deprecated: string, instead: string): void;
	export function applyDeterminismWarning<T, K extends keyof T>(parent: T, key: K, example: string, replacement: string): T[K];
	export function coordinateValue<T extends ConcurrenceJsonValue | void>(generator: () => T, inCallbackGenerator?: () => T, remoteInvocation?: (value: T) => void) : T;

	export let secrets: { [key: string]: any };

	export function synchronize() : PromiseLike<void>;
}
