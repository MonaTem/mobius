/// <reference path="../src/concurrence.d.ts" />

declare namespace concurrence {
	export function disconnect(): void;
	export var dead: boolean;

	// APIs for server/, not to be used inside src/
	export function receiveClientPromise<T>(...args: any[]): Promise<T>;
	export function observeServerPromise<T>(promise: Promise<T> | T): Promise<T>;
	export function receiveClientEventStream<T extends Function>(callback: T): ConcurrenceTransaction;
	export function observeServerEventCallback<T extends Function>(callback: T): ConcurrenceLocalTransaction<T>;
}
