namespace concurrence {
	// Override the Date object with one that shows determinism errors
	// see: https://stackoverflow.com/a/22402079/4007
	self.Date = function(__Date) {
		// Copy that property!
		for (let i of Object.getOwnPropertyNames(__Date)) {
			if (!(i in Date)) {
				(Date as any)[i] = (__Date as any)[i];
			}
		}
		//
		const proto = Object.create(__Date.prototype);
		concurrence.applyDeterminismWarning(proto, "toString", "date.toString()", "date.toUTCString()");
		Date.prototype = proto;
		return Date as typeof __Date;
		function Date(this: any) {
			let args = [...arguments];
			args.unshift(self);
			if (this instanceof __Date) {
				if (args.length == 1) {
					concurrence.showDeterminismWarning("new Date()", "concurrence.now()");
				}
				let result = new (Function.prototype.bind.apply(__Date, args));
				(Object as any).setPrototypeOf(result, proto);
				return result;
			} else {
				concurrence.showDeterminismWarning("Date()", "concurrence.now()");
				return __Date.apply(self, args);
			}
		}
	}(Date);
	const realNow = concurrence.applyDeterminismWarning(Date, "now", "Date.now", "concurrence.now()");
	export function now(): Promise<number> {
		return concurrence.observeServerPromise(realNow.call(Date));
	}
	const realSetInterval = concurrence.applyDeterminismWarning(self, "setInterval", "setInterval(callback, millis)", "concurrence.interval(callback, millis)");
	export function interval(callback: () => void, millis: number): ConcurrenceChannel {
		const channel = concurrence.observeServerEventCallback<typeof callback>(callback, false);
		const interval = realSetInterval(_ => {
			if (concurrence.dead) {
				channel.close();
				clearInterval(interval);
			} else {
				channel.send();
			}
		}, millis);
		return channel;
	}
	const realSetTimeout = concurrence.applyDeterminismWarning(self, "setTimeout", "setTimeout(callback, millis)", "concurrence.timeout(millis).then(callback)");
	export function timeout(millis: number): Promise<void> {
		return concurrence.observeServerPromise<void>(new Promise<void>(resolve => { realSetTimeout(() => resolve(), millis) }), false);
	}
}
