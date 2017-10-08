import { JsonValue } from "mobius-types";

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
	let message = "Called " + deprecated + " which may result in split-brain!\nInstead use " + instead;
	const stack : string | undefined = (new Error() as any).stack;
	if (stack) {
		message += " " + stack.split(/\n\s*/g).slice(3).join("\n\t");
	}
	console.log(message);
}

const setPrototypeOf = (Object as any).setProtoTypeOf || ((obj: any, proto: any) => obj.__proto__ = proto);

export function interceptGlobals<T extends Partial<FakedGlobals>>(
	globals: T,
	insideCallback: () => boolean,
	coordinateValue: <T extends JsonValue>(generator: () => T) => T,
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
		ignore_nondeterminism:
		for (var i in __Date) {
			if (Object.hasOwnProperty.call(__Date, i)) {
				if (!(i in Date)) {
					(Date as any)[i] = (__Date as any)[i];
				}
			}
		}
		// Non-enumerable properties
		(Date as typeof __Date).UTC = __Date.UTC;
		(Date as typeof __Date).parse = function() {
			if (insideCallback()) {
				showDeterminismWarning("Date.parse(string)", "a date parsing library");
			}
			return __Date.parse.apply(this, arguments);
		}
		let proto: any;
		if (Object.create) {
			proto = Object.create(__Date.prototype);
		} else {
			proto = new Object();
			proto.__proto__ = __Date.prototype;
		}
		// Format as ISO strings by default (node's default for now, but might not be later)
		proto.toString = proto.toISOString;
		Date.prototype = proto;
		return Date as typeof __Date;
		function Date(this: any) {
			let args = Array.prototype.slice.call(arguments);
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
				setPrototypeOf(result, proto);
				// Add support for toISOString if it doesn't exist
				if (!proto.toISOString) {
					proto.toISOString = function(this: Date) {
						return this.getUTCFullYear() +
							'-' + pad(this.getUTCMonth() + 1) +
							'-' + pad(this.getUTCDate()) +
							'T' + pad(this.getUTCHours()) +
							':' + pad(this.getUTCMinutes()) +
							':' + pad(this.getUTCSeconds()) +
							'.' + (this.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5) +
							'Z';
					}
				}
				// Format as ISO strings by default (browser default is usually locale-specific)
				proto.toString = proto.toISOString;
				return result;
			} else {
				return new __Date(now()).toUTCString();
			}
		}
	}(Date);
	newDate.now = now;
	// Override timers with ones that are coordinated between client/server
	const timers: { [ id: number] : Closeable } = {};
	function destroyTimer(timerId: number) {
		if (typeof timerId == "number" && timerId < 0) {
			const channel = timers[timerId];
			if (channel) {
				delete timers[timerId];
				channel.close();
			}
			return true;
		}
	}
	let currentTimerId = 0;

	const realSetInterval = setInterval as Function as (callback: () => void, interval: number) => number;
	const realClearInterval = clearInterval as Function as (intervalId: number) => void;

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
		destroyTimer(intervalId) || realClearInterval(intervalId);
	};

	const realSetTimeout = setTimeout as Function as (callback: () => void, delay: number) => number;
	const realClearTimeout = clearTimeout as Function as (timerId: number) => void;

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
		destroyTimer(timeoutId) || realClearTimeout(timeoutId);
	};
	// Recast now that all fields have been filled
	return globals as (T & FakedGlobals);
}

function pad(number: number) {
	return ("0" + number).substr(-2);
}
