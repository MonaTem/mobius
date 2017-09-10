export let dead: boolean;
export const whenDisconnected: PromiseLike<void>;

export function disconnect(): void;
export function flush() : void;
export function synchronize() : PromiseLike<void>;
export function shareSession() : PromiseLike<string>;
