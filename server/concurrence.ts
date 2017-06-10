/// <reference path="../unified/concurrence.d.ts" />
/// <reference path="reduced-dom.d.ts" />

declare namespace concurrence {
	export function disconnect(): void;
	export var dead: boolean;

	// APIs for server/, not to be used inside src/
	export function receiveClientPromise<T>(...args: any[]): Promise<T>;
	export function observeServerPromise<T>(promise: Promise<T> | T, includedInPrerender?: boolean): Promise<T>;
	export function receiveClientEventStream<T extends Function>(callback: T): ConcurrenceTransaction;
	export function observeServerEventCallback<T extends Function>(callback: T, includedInPrerender?: boolean): ConcurrenceLocalTransaction<T>;
	export function showDeterminismWarning(deprecated: string, instead: string): void;
	export function applyDeterminismWarning<T, K extends keyof T>(parent: T, key: K, example: string, replacement: string): T[K];
}

declare const document : Document | undefined;
