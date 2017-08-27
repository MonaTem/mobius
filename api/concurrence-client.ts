///<reference types="preact"/>
namespace concurrence {
	const setTimeout = window.setTimeout;

	type Task = () => void;
	function isPromiseLike<T>(value: T | PromiseLike<T> | undefined) : value is PromiseLike<T> {
		return typeof value == "object" && "then" in (value as any);
	}

	const microTaskQueue : Task[] = [];
	const taskQueue : Task[] = [];

	const scheduleFlushTasks = (() => {
		const setImmediate = window.setImmediate;
		// Try native setImmediate support
		if (setImmediate) {
			return setImmediate.bind(window, flushTasks);
		}
		// Attempt postMessage, but only if it's asynchronous
		if (window.postMessage && window.addEventListener) {
			let isAsynchronous = true;
			const synchronousTest = () => isAsynchronous = false;
			window.addEventListener("message", synchronousTest, false);
			window.postMessage("__concurrence_test", "*");
			window.removeEventListener("message", synchronousTest, false);
			if (isAsynchronous) {
				window.addEventListener("message", flushTasks, false);
				return () => {
					window.postMessage("__concurrence_flush", "*")
				};
			}
		}
		// Try a <script> tag's onreadystatechange
		let script: any = document.createElement("script");
		if ("onreadystatechange" in script) {
			return () => {
				(script as any).onreadystatechange = () => {
					document.head.removeChild(script);
					script = document.createElement("script")
					flushTasks();
				}
				document.head.appendChild(script);
			};
		}
		// Try requestAnimationFrame
		const requestAnimationFrame = window.requestAnimationFrame || (window as any).webkitRequestRequestAnimationFrame || (window as any).mozRequestRequestAnimationFrame;
		if (requestAnimationFrame) {
			return requestAnimationFrame.bind(window, flushTasks);
		}
		// Fallback to setTimeout(..., 0)
		return setTimeout.bind(window, flushTasks, 0);
	})();

	function flushMicroTasks() {
		let task: Task | undefined;
		while (task = microTaskQueue.shift()) {
			task();
		}
	}

	function flushTasks() {
		let completed: boolean | undefined;
		try {
			flushMicroTasks();
			let task = taskQueue.shift();
			if (task) {
				task();
			}
			completed = !taskQueue.length;
		} finally {
			if (!completed) {
				scheduleFlushTasks();
			}
		}
	}

	function submitTask(queue: Task[], task: Task) {
		queue.push(task);
		if (microTaskQueue.length + taskQueue.length == 1) {
			scheduleFlushTasks();
		}
	}

	// Setup bundled Promise implementation if native implementation doesn't schedule as micro-tasks or is not present
	if (!("Promise" in (window as any)) || !/^Google |^Apple /.test(navigator.vendor)) {
		(window as any).Promise = bundledPromiseImplementation();
	}

	const resolvedPromise: PromiseLike<void> = Promise.resolve();

	function defer() : PromiseLike<void>;
	function defer<T>() : PromiseLike<T>;
	function defer(value?: any) : PromiseLike<any> {
		return new Promise<any>(resolve => submitTask(taskQueue, resolve.bind(null, value)));
	}

	function escape(e: any) {
		submitTask(microTaskQueue, () => {
			throw e;
		});
	}

	function escaping(handler: () => any | PromiseLike<any>) : () => PromiseLike<void>;
	function escaping<T>(handler: (value: T) => any | PromiseLike<any>) : (value: T) => PromiseLike<T | void>;
	function escaping(handler: (value?: any) => any | PromiseLike<any>) : (value?: any) => PromiseLike<any> {
		return (value?: any) => {
			try {
				return Promise.resolve(handler(value)).catch(escape);
			} catch(e) {
				escape(e);
				return resolvedPromise;
			}
		};
	}

	const reduce = function<T, U>(array: ArrayLike<T>, callback: (previousValue: U, currentValue: T, currentIndex: number, array: ArrayLike<T>) => U, initialValue: U) : U {
		for (var i = 0; i < array.length; i++) {
			initialValue = callback(initialValue, array[i], i, array);
		}
		return initialValue;
	};
	const slice = Array.prototype.slice;

	type ConcurrenceEvent = [number] | [number, any] | [number, any, any];

	interface ConcurrenceServerMessage {
		events: ConcurrenceEvent[];
		messageID: number;
		close?: boolean;
	}

	interface ConcurrenceClientMessage extends ConcurrenceServerMessage {
		sessionID?: string;
		clientID?: number;
		destroy?: true;
	}

	function logOrdering(from: "client" | "server", type: "open" | "close" | "message", channelId: number) {
		// const stack = (new Error().stack || "").toString().split(/\n\s*/).slice(2).map(s => s.replace(/^at\s*/, ""));
		// console.log(from + " " + type + " " + channelId, stack);
	}

	function uuid() : string {
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
			const r = Math.random() * 16 | 0;
			return (c == "x" ? r : (r & 3 | 8)).toString(16);
		});
	}

	function roundTrip<T>(obj: T) : T {
		// Round-trip values through JSON so that the client receives exactly the same type of values as the server
		return typeof obj == "undefined" ? obj : JSON.parse(JSON.stringify([obj]))[0] as T;
	}

	interface BootstrapData {
		sessionID: string;
		clientID?: number;
		events?: ConcurrenceEvent[];
	}

	// Message ordering
	let outgoingMessageId = 0;
	let incomingMessageId = 0;
	const reorderedMessages : { [messageId: number]: ConcurrenceServerMessage } = {};
	let willSynchronizeChannels : boolean = false;
	let currentEvents: ConcurrenceEvent[] | undefined;

	let dispatchingEvent = 1;
	export let insideCallback: boolean = true;
	function exitCallback() {
		insideCallback = (dispatchingEvent--) != 0;
	}

	// Session state
	let sessionID: string | undefined;
	let clientID = 0;
	const bootstrapElement = (elements => {
		for (let i = 0; i < elements.length; i++) {
			if (elements[i].getAttribute("type") == "application/x-concurrence-bootstrap") {
				return elements[i];
			}
		}
	})(document.getElementsByTagName("script"));
	const serverURL = location.href;
	let activeConnectionCount = 0;
	export let dead = false;

	// Remote channels
	let remoteChannelCounter = 0;
	const pendingChannels : { [channelId: number]: (event?: ConcurrenceEvent) => void; } = {};
	let pendingChannelCount = 0;
	let hadOpenServerChannel = false;

	// Local channels
	let localChannelCounter = 0;
	let queuedLocalEvents: ConcurrenceEvent[] = [];
	const fencedLocalEvents: [number, (event: ConcurrenceEvent) => void][] = [];
	let totalBatched = 0;
	let isBatched: { [channelId: number]: true } = {};
	let pendingBatchedActions: (() => void)[] = [];

	// Heartbeat
	const sessionHeartbeatInterval = 4 * 60 * 1000;
	let heartbeatTimeout: number = 0;

	// Websocket support
	const socketURL = serverURL.replace(/^http/, "ws") + "?";
	let WebSocketClass = (window as any).WebSocket as typeof WebSocket | undefined;
	let websocket: WebSocket | undefined;

	if (bootstrapElement) {
		bootstrapElement.parentNode!.removeChild(bootstrapElement);
		const bootstrapData = JSON.parse(bootstrapElement.textContent || bootstrapElement.innerHTML) as BootstrapData;
		sessionID = bootstrapData.sessionID;
		clientID = (bootstrapData.clientID as number) | 0;
		++outgoingMessageId;
		const concurrenceForm = document.getElementById("concurrence-form") as HTMLFormElement;
		if (concurrenceForm) {
			concurrenceForm.onsubmit = function() { return false; };
		}
		currentEvents = bootstrapData.events || [];
		hadOpenServerChannel = true;
		willSynchronizeChannels = true;
		defer().then(escaping(processMessage.bind(null, bootstrapData))).then(defer).then(exitCallback).then(escaping(synchronizeChannels));
	} else {
		sessionID = uuid();
		defer().then(exitCallback);
	}

	function produceMessage() : Partial<ConcurrenceClientMessage> {
		const result: Partial<ConcurrenceClientMessage> = { messageID: outgoingMessageId++ };
		if (queuedLocalEvents.length) {
			result.events = queuedLocalEvents;
			queuedLocalEvents = [];
		}
		if (clientID) {
			result.clientID = clientID;
		}
		return result;
	}

	function cancelHeartbeat() {
		if (heartbeatTimeout) {
			clearTimeout(heartbeatTimeout);
			heartbeatTimeout = 0;
		}
	}

	function restartHeartbeat() {
		cancelHeartbeat();
		heartbeatTimeout = setTimeout(sendMessages, sessionHeartbeatInterval);
	}

	let sendWhenDisconnected: (() => void) | undefined;
	export const whenDisconnected: PromiseLike<void> = new Promise(resolve => sendWhenDisconnected = resolve);
	export const disconnect = destroySession;

	function destroySession() {
		if (sessionID) {
			dead = true;
			cancelHeartbeat();
			window.removeEventListener("unload", destroySession, false);
			// Forcefully tear down WebSocket
			if (websocket) {
				if (websocket.readyState < 2) {
					websocket.close();
				}
				websocket = undefined;
			}
			// Abandon pending channels
			for (let channelId in pendingChannels) {
				if (Object.hasOwnProperty.call(pendingChannels, channelId)) {
					pendingChannels[channelId]();
				}
			}
			// Send a "destroy" message so that the server can clean up the session
			const message = produceMessage();
			message.destroy = true;
			const body = messageAsQueryString(message);
			sessionID = undefined;
			if (navigator.sendBeacon) {
				navigator.sendBeacon(serverURL, body);
			} else {
				const request = new XMLHttpRequest();
				request.open("POST", serverURL, false);
				request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
				request.send(body);
			}
			// Flush fenced events
			reduce(fencedLocalEvents, (promise, event) => {
				return promise.then(() => dispatchEvent([event[0]])).then(defer);
			}, resolvedPromise).then(() => {
				// Send disconnection event
				if (sendWhenDisconnected) {
					sendWhenDisconnected();
				}
			});
		}
	}
	window.addEventListener("unload", destroySession, false);

	function dispatchEvent(event: ConcurrenceEvent) : PromiseLike<void> | undefined {
		let channelId = event[0];
		let channel: ((event?: ConcurrenceEvent) => void) | undefined;
		if (channelId < 0) {
			// Fenced client-side event
			channelId = -channelId;
			for (let i = 0; i < fencedLocalEvents.length; i++) {
				if (fencedLocalEvents[i][0] == channelId) {
					channel = fencedLocalEvents[i][1];
					fencedLocalEvents.splice(i, 1);
					break;
				}
			}
			// Apply batching
			if (totalBatched && isBatched[channelId] && ((--totalBatched) == 0)) {
				const batchedActions = pendingBatchedActions;
				pendingBatchedActions = [];
				isBatched = {};
				return reduce(batchedActions, (promise, action) => {
					return promise.then(escaping(action)).then(defer);
				}, resolvedPromise).then(escaping(callChannelWithEvent.bind(null, channel, event)));
			}
		} else {
			// Server-side event
			channel = pendingChannels[channelId];
		}
		callChannelWithEvent(channel, event);
	}

	function callChannelWithEvent(channel: ((event: ConcurrenceEvent) => void) | undefined, event: ConcurrenceEvent) {
		if (channel) {
			if (totalBatched) {
				pendingBatchedActions.push(channel.bind(null, event));
			} else {
				channel(event);
			}
		} else {
			throw new Error("Guru meditation error!");
		}
	}

	function processMessage(message: ConcurrenceServerMessage) : PromiseLike<void> {
		// Process messages in order
		const messageId = message.messageID;
		if (messageId > incomingMessageId) {
			// Message was received out of order, queue it for later
			reorderedMessages[messageId] = message;
			return resolvedPromise;
		}
		if (messageId < incomingMessageId) {
			return resolvedPromise;
		}
		incomingMessageId++;
		// Read each event and dispatch the appropriate event in order
		hadOpenServerChannel = pendingChannelCount != 0;
		const promise = reduce(currentEvents = message.events, (promise: PromiseLike<any>, event: ConcurrenceEvent) => {
			return promise.then(escaping(dispatchEvent.bind(null, event))).then(defer);
		}, resolvedPromise).then(() => {
			currentEvents = undefined;
			const reorderedMessage = reorderedMessages[incomingMessageId];
			if (reorderedMessage) {
				delete reorderedMessages[incomingMessageId];
				return processMessage(reorderedMessage);
			}
		});
		if (willSynchronizeChannels) {
			return promise;
		}
		willSynchronizeChannels = true;
		return promise.then(escaping(synchronizeChannels));
	}

	function deserializeMessage(messageText: string, defaultMessageID: number) : ConcurrenceServerMessage {
		const result = ((messageText.length == 0 || messageText[0] == "[") ? { events: JSON.parse("[" + messageText + "]") } : JSON.parse(messageText)) as ConcurrenceServerMessage;
		result.messageID = result.messageID | defaultMessageID;
		if (!result.events) {
			result.events = [];
		}
		return result;
	}

	function messageAsSocketText(message: Partial<ConcurrenceClientMessage>) : string {
		if ("events" in message && !("messageID" in message) && !("close" in message) && !("destroy" in message) && !("clientID" in message)) {
			// Only send events, if that's all we have to send
			return JSON.stringify(message.events).slice(1, -1);
		}
		return JSON.stringify(message);
	}

	function messageAsQueryString(message: Partial<ConcurrenceClientMessage>) : string {
		let result = "sessionID=" + sessionID;
		if (clientID) {
			result += "&clientID=" + clientID;
		}
		if ("messageID" in message) {
			result += "&messageID=" + message.messageID;
		}
		if ("events" in message) {
			result += "&events=" + encodeURIComponent(JSON.stringify(message.events).slice(1, -1)).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",").replace(/%20/g, "+");
		}
		if (message.destroy) {
			result += "&destroy=1";
		}
		return result;
	}

	function sendFormMessage(message: Partial<ConcurrenceClientMessage>) {
		// Form post over XMLHttpRequest is used when WebSockets are unavailable or fail
		activeConnectionCount++;
		const request = new XMLHttpRequest();
		request.open("POST", serverURL, true);
		request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
		request.onreadystatechange = () => {
			if (request.readyState == 4) {
				activeConnectionCount--;
				if (request.status == 200) {
					processMessage(deserializeMessage(request.responseText, 0));
				} else {
					destroySession();
				}
			}
		}
		request.send(messageAsQueryString(message));
	}

	let lastWebSocketMessageId = 0;

	function sendMessages(attemptWebSockets?: boolean) {
		if (!sessionID) {
			return;
		}
		if (heartbeatTimeout) {
			restartHeartbeat();
		}
		const existingSocket = websocket;
		if (existingSocket) {
			if (!queuedLocalEvents.length) {
				return;
			}
			const message = produceMessage();
			if (lastWebSocketMessageId == message.messageID) {
				delete message.messageID;
			}
			lastWebSocketMessageId = outgoingMessageId;
			if (existingSocket.readyState == 1) {
				// Send on open socket
				existingSocket.send(messageAsSocketText(message));
			} else {
				// Coordinate with existing WebSocket that's in the process of being opened,
				// falling back to a form POST if necessary
				const existingSocketOpened = () => {
					existingSocket.removeEventListener("open", existingSocketOpened, false);
					existingSocket.removeEventListener("error", existingSocketErrored, false);
					existingSocket.send(messageAsSocketText(message));
				}
				const existingSocketErrored = () => {
					existingSocket.removeEventListener("open", existingSocketOpened, false);
					existingSocket.removeEventListener("error", existingSocketErrored, false);
					sendFormMessage(message);
				}
				existingSocket.addEventListener("open", existingSocketOpened, false);
				existingSocket.addEventListener("error", existingSocketErrored, false);
			}
			return;
		}
		// Message will be sent in query string of new connection
		const message = produceMessage();
		lastWebSocketMessageId = outgoingMessageId;
		if (attemptWebSockets && WebSocketClass) {
			try {
				const newSocket = new WebSocketClass(socketURL + messageAsQueryString(message));
				// Attempt to open a WebSocket for channels, but not heartbeats
				const newSocketOpened = () => {
					newSocket.removeEventListener("open", newSocketOpened, false);
					newSocket.removeEventListener("error", newSocketErrored, false);
				}
				const newSocketErrored = () => {
					// WebSocket failed, fallback using form POSTs
					newSocketOpened();
					WebSocketClass = undefined;
					websocket = undefined;
					sendFormMessage(message);
				}
				newSocket.addEventListener("open", newSocketOpened, false);
				newSocket.addEventListener("error", newSocketErrored, false);
				let lastWebSocketMessageId = -1;
				newSocket.addEventListener("message", (event: any) => {
					const message = deserializeMessage(event.data, lastWebSocketMessageId + 1);
					lastWebSocketMessageId = message.messageID;
					const promise = processMessage(message)
					if (message.close) {
						promise.then(escaping(() => {
							if (pendingChannelCount) {
								// Reopen the same web socket,
								const message = produceMessage();
								message.close = false;
								newSocket.send(messageAsSocketText(message));
							} else {
								// Disconnect with orderly shutdown from server
								newSocket.close();
								websocket = undefined;
							}
						}));
					}
				}, false);
				websocket = newSocket;
				return;
			} catch (e) {
				WebSocketClass = undefined;
			}
		}
		// WebSockets failed fast or were unavailable
		sendFormMessage(message);
	}

	function synchronizeChannels() {
		willSynchronizeChannels = false;
		if (!dead) {
			if ((pendingChannelCount != 0 && activeConnectionCount == 0) || queuedLocalEvents.length) {
				sendMessages(pendingChannelCount != 0);
				restartHeartbeat();
			} else if (websocket) {
				// Disconnect WebSocket when server can't possibly send us messages
				if (websocket.readyState < 2) {
					websocket.close();
				}
				websocket = undefined;
			}
		}
	}

	function registerRemoteChannel(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceChannel {
		// Expect that the server will run some code in parallel that provides data
		pendingChannelCount++;
		const channelId = ++remoteChannelCounter;
		logOrdering("server", "open", channelId);
		pendingChannels[channelId] = function(event?: ConcurrenceEvent) {
			logOrdering("server", "message", channelId);
			callback(event);
		}
		flush();
		return {
			channelId,
			close() {
				// Cleanup the bookkeeping
				if (pendingChannels[this.channelId]) {
					logOrdering("server", "close", this.channelId);
					pendingChannelCount--;
					delete pendingChannels[this.channelId];
					this.channelId = -1
				}
			}
		};
	}

	function sendEvent(event: ConcurrenceEvent, batched?: boolean, skipsFencing?: boolean) : PromiseLike<ConcurrenceEvent | void> {
		if (dead) {
			return resolvedPromise;
		}
		const result = new Promise<ConcurrenceEvent | void>((resolve, reject) => {
			if (pendingChannelCount && !skipsFencing) {
				// Let server decide on the ordering of events since server-side channels are active
				const channelId = event[0];
				if (batched) {
					isBatched[channelId] = true;
					++totalBatched;
				}
				fencedLocalEvents.push([channelId, resolve]);
				event[0] = -channelId;
			} else {
				// No pending server-side channels, resolve immediately
				resolve();
			}
		});
		// Queue an event to be sent to the server in the next flush
		queuedLocalEvents.push(event);
		if (!batched || websocket || queuedLocalEvents.length > 9) {
			flush();
		}
		return result;
	}

	export function flush() {
		if (!willSynchronizeChannels) {
			willSynchronizeChannels = true;
			defer().then(escaping(synchronizeChannels));
		}
	}

	function enteringCallback() {
		dispatchingEvent++;
		defer().then(exitCallback);
	}

	// APIs for client/, not to be used inside src/
	export function receiveServerPromise<T extends ConcurrenceJsonValue>(...args: any[]) : PromiseLike<T> { // Must be cast to the proper signature
		return new Promise<T>((resolve, reject) => {
			if (dead) {
				return reject(new Error("Session has been disconnected!"));
			}
			const channel = registerRemoteChannel(event => {
				channel.close();
				enteringCallback();
				parseValueEvent(event, resolve as (value: ConcurrenceJsonValue) => void, reject);
			});
		});
	};

	export const synchronize = receiveServerPromise as () => PromiseLike<void>;

	export function receiveServerEventStream<T extends Function>(callback: T): ConcurrenceChannel {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		const channel = registerRemoteChannel(event => {
			if (event) {
				enteringCallback();
				callback.apply(null, event.slice(1));
			} else {
				channel.close();
			}
		});
		return channel;
	}

	function eventForValue(channelId: number, value: ConcurrenceJsonValue | void) : ConcurrenceEvent {
		return typeof value == "undefined" ? [channelId] : [channelId, roundTrip(value)];
	}

	function eventForException(channelId: number, error: any) : ConcurrenceEvent {
		// Convert Error types to a representation that can be reconstituted on the server
		let type : any = 1;
		let serializedError: any = error;
		if (error instanceof Error) {
			let errorClass : any = error.constructor;
			if ("name" in errorClass) {
				type = errorClass.name;
			} else {
				// ES5 support
				type = errorClass.toString().match(/.*? (\w+)/)[0];
			}
			serializedError = { message: error.message, stack: error.stack };
			let anyError : any = error;
			for (let i in anyError) {
				if (Object.hasOwnProperty.call(anyError, i)) {
					serializedError[i] = anyError[i];
				}
			}
		}
		return [channelId, serializedError, type];
	}

	function parseValueEvent<T>(event: ConcurrenceEvent | undefined, resolve: (value: ConcurrenceJsonValue) => T, reject: (error: Error | ConcurrenceJsonValue) => T) : T {
		if (!event) {
			return reject(new Error("Session has been disconnected!"));
		}
		let value = event[1];
		if (event.length != 3) {
			return resolve(value);
		}
		const type = event[2];
		// Convert serialized representation into the appropriate Error type
		if (type != 1 && /Error$/.test(type)) {
			const ErrorType : typeof Error = (window as any)[type] || Error;
			const error: Error = new ErrorType(value.message);
			delete value.message;
			for (let i in value) {
				if (Object.hasOwnProperty.call(value, i)) {
					(error as any)[i] = value[i];
				}
			}
			return reject(error);
		}
		return reject(value);
	}

	export function observeClientPromise<T extends ConcurrenceJsonValue | void>(value: PromiseLike<T> | T) : PromiseLike<T> {
		let channelId = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		return Promise.resolve(value).then(value => {
			return resolvedPromise.then(escaping(() => sendEvent(eventForValue(channelId, value), true))).then(() => {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				let roundtripped = roundTrip(value);
				enteringCallback();
				return roundtripped;
			});
		}, error => {
			return resolvedPromise.then(escaping(() => sendEvent(eventForException(channelId, error), true))).then(() => {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				enteringCallback();
				return Promise.reject(error) as any as T;
			});
		});
	};

	export function observeClientEventCallback<T extends Function>(callback: T, batched?: boolean, shouldFlushMicroTasks?: true) : ConcurrenceLocalChannel<T> {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		const channelId: number = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		return {
			channelId,
			send: function(this: ConcurrenceChannel) {
				if (this.channelId >= 0) {
					const message = roundTrip(slice.call(arguments));
					const args = message.slice();
					message.unshift(this.channelId);
					resolvedPromise.then(escaping(() => sendEvent(message, batched))).then(() => {
						// Finally send event if a destroy call hasn't won the race
						if (this.channelId >= 0) {
							logOrdering("client", "message", this.channelId);
							enteringCallback();
							(callback as any as Function).apply(null, roundTrip(args));
						}
					});
					if (shouldFlushMicroTasks) {
						flushMicroTasks();
					}
				}
			} as any as T,
			close() {
				if (this.channelId >= 0) {
					logOrdering("client", "close", this.channelId);
					this.channelId = -1;
				}
			}
		};
	}

	export function coordinateValue<T extends ConcurrenceJsonValue>(generator: () => T) : T {
		if (!dispatchingEvent) {
			return generator();
		}
		let value: T;
		let events = currentEvents;
		if (events && hadOpenServerChannel) {
			let channelId = ++remoteChannelCounter;
			logOrdering("server", "open", channelId);
			// Peek at incoming events to find the value generated on the server
			for (var i = 0; i < events.length; i++) {
				var event = events[i];
				if (event[0] == channelId) {
					pendingChannels[channelId] = function() {
					};
					return parseValueEvent(event, value => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						return value;
					}, error => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						throw error
					}) as T;
				}
			}
			console.log("Expected a value from the server, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			value = generator();
			logOrdering("server", "message", channelId);
			logOrdering("server", "close", channelId);
		} else {
			let channelId = ++localChannelCounter;
			logOrdering("client", "open", channelId);
			try {
				value = generator();
				try {
					sendEvent(eventForValue(channelId, value), true, true);
				} catch(e) {
					escape(e);
				}
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
			} catch(e) {
				try {
					sendEvent(eventForException(channelId, e), true, true);
				} catch(e) {
					escape(e);
				}
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				throw e;
			}
		}
		return roundTrip(value);
	}

	function bundledPromiseImplementation() {
		// Promise implementation that properly schedules as a micro-task
		function isPromise<T>(value: T | PromiseLike<T> | undefined) : value is Promise<T> {
			return typeof value == "object" && "then" in (value as any) && "catch" in (value as any);
		}

		const enum PromiseState {
			Pending = 0,
			Fulfilled = 1,
			Rejected = 2,
		};

		function populatePromise<T>(this: Promise<T>, state: PromiseState, value: any) {
			if (!this.__state) {
				if (value instanceof Promise) {
					if (value.__state) {
						if (state != PromiseState.Rejected) {
							state = value.__state;
							value = value.__value;
						}
					} else {
						(value.__observers || (value.__observers = [])).push(populatePromise.bind(this, state, value));
						return;
					}
				} else if (isPromiseLike(value)) {
					value.then(populatePromise.bind(this, state), populatePromise.bind(this, PromiseState.Rejected));
					return;
				}
				this.__state = state;
				this.__value = value;
				const observers = this.__observers;
				if (observers) {
					this.__observers = undefined;
					for (let i = 0; i < observers.length; i++) {
						submitTask(microTaskQueue, observers[i]);
					}
				}
			}
		}

		class Promise <T> {
			__state: PromiseState;
			__value: any;
			__observers?: Task[];
			constructor(executor?: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) {
				if (executor) {
					const reject = populatePromise.bind(this, PromiseState.Rejected);
					try {
						executor(populatePromise.bind(this, PromiseState.Fulfilled), reject);
					} catch (e) {
						reject(e);
					}
				}
			}
			then<TResult1 = T, TResult2 = never>(onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): PromiseLike<TResult1 | TResult2> {
				return new Promise<TResult1 | TResult2>((resolve, reject) => {
					const completed = () => {
						try {
							if (this.__state == PromiseState.Fulfilled) {
								resolve(onFulfilled ? onFulfilled(this.__value) : this.__value);
							} else {
								reject(onRejected ? onRejected(this.__value) : this.__value);
							}
						} catch (e) {
							reject(e);
						}
					}
					if (this.__state) {
						submitTask(microTaskQueue, completed);
					} else {
						(this.__observers || (this.__observers = [])).push(completed);
					}
				});
			}
			catch<TResult = never>(onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): PromiseLike<T | TResult> {
				return this.then(undefined, onRejected);
			}
			static resolve<T>(value: PromiseLike<T> | T) : PromiseLike<T>;
		    static resolve(): Promise<void>;
			static resolve<T>(value?: PromiseLike<T> | T) : PromiseLike<T> {
				if (isPromise(value)) {
					return value;
				}
				if (isPromiseLike(value)) {
					return new Promise<T>((resolve, reject) => value.then(resolve, reject));
				}
				const result = new Promise<T>();
				result.__value = value;
				result.__state = PromiseState.Fulfilled;
				return result;
			}
			static reject<T = never>(reason: any) : PromiseLike<T> {
				return new Promise<T>((resolve, reject) => reject(reason));
			}
			static race<T>(values: ReadonlyArray<PromiseLike<T> | T>) : PromiseLike<T> {
				for (let i = 0; i < values.length; i++) {
					const value = values[i];
					if (!isPromiseLike(value)) {
						const result = new Promise<T>();
						result.__value = value;
						result.__state = PromiseState.Fulfilled;
						return result;
					} else if (value instanceof Promise && value.__state) {
						return value;
					}
				}
				return new Promise<T>((resolve, reject) => {
					for (let i = 0; i < values.length; i++) {
						(values[i] as PromiseLike<T>).then(resolve, reject);
					}
				});
			}
			static all<T>(values: ReadonlyArray<PromiseLike<T> | T>) : PromiseLike<T[]> {
				let remaining = values.length;
				const result = new Array(remaining);
				return new Promise<T[]>((resolve, reject) => {
					for (let i = 0; i < values.length; i++) {
						const value = values[i];
						if (isPromiseLike(value)) {
							value.then(value => {
								result[i] = value;
								if ((--remaining) == 0) {
									resolve(result);
								}
							}, reject);
						} else {
							result[i] = value;
							if ((--remaining) == 0) {
								resolve(result);
							}
						}
					}
				});
			}
		};

		return Promise;
	}

}
