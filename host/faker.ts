import { ConcurrenceJsonValue } from "concurrence-types";

export interface FakedGlobals {
	Math: typeof Math;
	Date: typeof Date,
	setInterval: (func: Function, interval: number) => number,
	clearInterval: (timerId: number) => void,
	setTimeout: (func: Function, delay: number) => number,
	clearTimeout: (timerId: number) => void
}

export interface Closeable {
	close: () => void
}

function showDeterminismWarning(deprecated: string, instead: string): void {
	console.log("Called " + deprecated + " which may result in split-brain!\nInstead use " + instead + " " + (new Error() as any).stack.split(/\n\s*/g).slice(3).join("\n\t"));
}

export function apply<T extends Partial<FakedGlobals>>(
	globals: T,
	insideCallback: () => boolean,
	coordinateValue: <T extends ConcurrenceJsonValue>(generator: () => T) => T,
	coordinateChannel: <T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean) => Closeable
) : T & FakedGlobals {
	// Override the Math object with one that returns a common stream of random numbers
	const newMath = globals.Math = Object.create(Math);
	newMath.random = coordinateValue.bind(null, Math.random.bind(Math));
	// Override the Date object with one that shows determinism errors
	// see: https://stackoverflow.com/a/22402079/4007
	const originalNow = Date.now.bind(Date);
	const now = coordinateValue.bind(null, originalNow);
	const newDate = globals.Date = function(__Date) {
		// Copy that property!
		for (let i of Object.getOwnPropertyNames(__Date)) {
			if (!(i in Date)) {
				(Date as any)[i] = (__Date as any)[i];
			}
		}
		(Date as typeof __Date).parse = function() {
			if (insideCallback()) {
				showDeterminismWarning("Date.parse(string)", "a date parsing library");
			}
			return __Date.parse.apply(this, arguments);
		}
		const proto = Object.create(__Date.prototype);
		// Format as ISO strings by default (node's default for now, but might not be later)
		proto.toString = proto.toISOString;
		Date.prototype = proto;
		return Date as typeof __Date;
		function Date(this: any) {
			let args = [...arguments];
			args.unshift(this);
			if (this instanceof __Date) {
				switch (args.length) {
					case 0:
						break;
					case 1:
						args.push(now());
						break;
					case 2:
						if (typeof args[1] != "number" && insideCallback()) {
							showDeterminismWarning("new Date(string)", "a date parsing library");
						}
						break;
					default:
						if (insideCallback()) {
							showDeterminismWarning("new Date(...)", "new Date(Date.UTC(...))");
						}
						break;
				}
				let result = new (Function.prototype.bind.apply(__Date, args));
				(Object as any).setPrototypeOf(result, proto);
				return result;
			} else {
				return new __Date(now()).toUTCString();
			}
		}
	}(Date);
	newDate.now = now;
	// Override timers with ones that are coordinated between client/server
	const timers: { [ id: number] : Closeable } = {};
	let currentTimerId = 0;

	const realSetInterval = setInterval;
	const realClearInterval = clearInterval;

	globals.setInterval = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!insideCallback()) {
			return realSetInterval(callback, delay) as any as number;
		}
		const result = --currentTimerId;
		timers[result] = coordinateChannel(callback, send => realSetInterval(send, delay), realClearInterval, false);
		return result;
	};

	globals.clearInterval = (intervalId: number) => {
		if (typeof intervalId == "number" && intervalId < 0) {
			const channel = timers[intervalId];
			if (channel) {
				delete timers[intervalId];
				channel.close();
			}
		} else {
			realClearInterval(intervalId);
		}
	};

	const realSetTimeout = setTimeout;
	const realClearTimeout = clearTimeout;

	globals.setTimeout = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!insideCallback()) {
			return realSetTimeout(callback, delay) as any as number;
		}
		const result = --currentTimerId;
		const targetTime = originalNow() + delay;
		const channel = coordinateChannel(callback, send => realSetTimeout(() => {
			send();
			channel.close();
		}, targetTime - originalNow()), realClearTimeout, false);
		timers[result] = channel;
		return result;
	};

	globals.clearTimeout = (timeoutId: number) => {
		if (typeof timeoutId == "number" && timeoutId < 0) {
			const channel = timers[timeoutId];
			if (channel) {
				delete timers[timeoutId];
				channel.close();
			}
		} else {
			realClearTimeout(timeoutId);
		}
	};
	// Recast now that all fields have been filled
	return globals as (T & FakedGlobals);
}
