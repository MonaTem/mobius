interface Concurrence {
	disconnect: () => void;
	// Server-side implementations
	now: () => Promise<number>;
	random: () => Promise<number>;
	interval: (callback: () => void, millis: number) => ConcurrenceTransaction;
	timeout: () => Promise<void>;
	broadcast: (text: string) => void;
	receive: (callback: (value: string) => void) => ConcurrenceTransaction;
	// Client-side implementations
	render: (selector: string, value: string) => void;
	observe: (selector: string, event: string, callback: () => void) => ConcurrenceTransaction;
	read: (selector: string) => Promise<string>;
}

interface ConcurrenceTransaction {
	close(): void;
}
