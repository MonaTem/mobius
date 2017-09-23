export let dead: boolean;
export const whenDisconnected: Promise<void>;

export function disconnect(): void;
export function flush() : Promise<void>;
export function synchronize() : Promise<void>;
export function shareSession() : Promise<string>;
