/// <reference path="../src/concurrence.d.ts" />

declare namespace concurrence {
	export function disconnect(): void;
	export const dead: boolean;

	// APIs for server/, not to be used inside src/
	export function receiveClientPromise<T>(...args: any[]): Promise<T>;
	export function observeServerPromise<T>(promise: Promise<T> | T): Promise<T>;
	export function receiveClientEventStream<T>(callback: (value: T) => void, ...args: any[]): ConcurrenceTransaction;
	export function observeServerEventCallback<T>(callback: (...args: any[]) => void): ConcurrenceLocalTransaction<T>;
}
