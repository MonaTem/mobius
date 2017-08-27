namespace concurrence {
	// Override the Date object with one that shows determinism errors
	// see: https://stackoverflow.com/a/22402079/4007
	const now = concurrence.coordinateValue.bind(null, Date.now.bind(Date));
	self.Date = function(__Date) {
		// Copy that property!
		for (let i of Object.getOwnPropertyNames(__Date)) {
			if (!(i in Date)) {
				(Date as any)[i] = (__Date as any)[i];
			}
		}
		(Date as typeof __Date).parse = function() {
			if (insideCallback) {
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
			args.unshift(self);
			if (this instanceof __Date) {
				switch (args.length) {
					case 0:
						break;
					case 1:
						args.push(now());
						break;
					case 2:
						if (typeof args[1] != "number" && insideCallback) {
							concurrence.showDeterminismWarning("new Date(string)", "a date parsing library");
						}
						break;
					default:
						if (insideCallback) {
							concurrence.showDeterminismWarning("new Date(...)", "new Date(Date.UTC(...))");
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
	Date.now = now;

	const timers: { [ id: number] : ConcurrenceChannel } = {};
	let currentTimerId = 0;

	let registeredCleanup = false;
	function registerCleanup() {
		if (!registeredCleanup) {
			registeredCleanup = true;
			whenDisconnected.then(() => {
				for (var i in timers) {
					if (Object.hasOwnProperty.call(timers, i)) {
						timers[i].close();
					}
				}
			});
		}
	}

	const realSetInterval = setInterval;
	const realClearInterval = clearInterval;

	self.setInterval = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!insideCallback) {
			return realSetInterval(callback, delay);
		}
		registerCleanup();
		const channel = concurrence.observeServerEventCallback(callback, false);
		const realIntervalId = realSetInterval(channel.send.bind(channel), delay);
		const result = --currentTimerId;
		const close = channel.close;
		channel.close = function(this: ConcurrenceChannel) {
			realClearInterval(realIntervalId);
			close.call(this);
		};
		timers[result] = channel;
		return result as any as NodeJS.Timer;
	};

	self.clearInterval = function(intervalId: NodeJS.Timer) {
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

	self.setTimeout = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!insideCallback) {
			return realSetTimeout(callback, delay);
		}
		registerCleanup();
		const channel = concurrence.observeServerEventCallback(callback, false);
		const realTimeoutId = realSetTimeout(() => {
			channel.send();
			channel.close();
		}, delay);
		const result = --currentTimerId;
		const close = channel.close;
		channel.close = function(this: ConcurrenceChannel) {
			realClearTimeout(realTimeoutId);
			close.call(this);
		};
		timers[result] = channel;
		return result as any as NodeJS.Timer;
	};

	self.clearInterval = function(timeoutId: NodeJS.Timer) {
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

}
