namespace concurrence {
	function pad(number: number) {
		return ("0" + number).substr(-2);
	}

	// Override the Date object with one that shows determinism errors
	// see: https://stackoverflow.com/a/22402079/4007
	const now = concurrence.coordinateValue.bind(null, Date.now.bind(Date));
	(self as any).Date = function(__Date) {
		// Copy that property!
		for (var i in __Date) {
			if (Object.hasOwnProperty.call(__Date, i)) {
				if (!(i in Date)) {
					(Date as any)[i] = (__Date as any)[i];
				}
			}
		}
		//
		let proto: any;
		if (Object.create) {
			proto = Object.create(__Date.prototype);
		} else {
			proto = new Object();
			proto.__proto__ = __Date.prototype;
		}
		const setPrototypeOf = (Object as any).setProtoTypeOf || ((obj: any, proto: any) => obj.__proto__ = proto);
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
		Date.prototype = proto;
		return Date as typeof __Date;
		function Date(this: any) {
			let args = [].slice.call(arguments);
			args.unshift(self);
			if (this instanceof __Date) {
				if (args.length == 1) {
					args.push(now());
				}
				let result = new (Function.prototype.bind.apply(__Date, args));
				setPrototypeOf(result, proto);
				return result;
			} else {
				return __Date.apply(self, args);
			}
		}
	}(Date);
	Date.now = now;
	export const interval = concurrence.receiveServerEventStream as (callback: () => void, millis: number) => ConcurrenceChannel;
	export const timeout = concurrence.receiveServerPromise as (millis: number) => Promise<void>;
}
