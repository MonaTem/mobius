///<reference types="preact"/>
namespace concurrence {
	const defer = window.setImmediate || window.requestAnimationFrame || (window as any).webkitRequestRequestAnimationFrame || (window as any).mozRequestRequestAnimationFrame || function(callback: () => void) { setTimeout(callback, 0) };

	type ConcurrenceEvent = [number] | [number, any] | [number, any, any];

	function uuid() : string {
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
			const r = Math.random() * 16 | 0;
			return (c == "x" ? r : (r & 3 | 8)).toString(16);
		});
	}

	function roundTrip<T>(obj: T) : T {
		// Round-trip values through JSON so that the client receives exactly the same type of values as the server
		return JSON.parse(JSON.stringify([obj]))[0] as T;
	}

	interface BootstrapData {
		sessionID: string;
		events: ConcurrenceEvent[];
		idle: boolean;
	}

	// Message ordering
	let outgoingMessageId = 0;
	let incomingMessageId = 0;
	const reorderedMessages : [ConcurrenceEvent[], number][] = [];

	// Session state
	let sessionID: string | undefined;
	const bootstrapElement = document.querySelector("script[type=\"application/x-concurrence-bootstrap\"]");
	let idleDuringPrerender: boolean = false;
	if (bootstrapElement) {
		bootstrapElement.parentNode!.removeChild(bootstrapElement);
		const bootstrapData = JSON.parse(bootstrapElement.textContent || bootstrapElement.innerHTML) as BootstrapData;
		sessionID = bootstrapData.sessionID;
		idleDuringPrerender = bootstrapData.idle;
		++outgoingMessageId;
		setTimeout(() => {
			processMessage(bootstrapData.events, 0);
		}, 0);
		const concurrenceForm = document.getElementById("concurrence-form") as HTMLFormElement;
		if (concurrenceForm) {
			concurrenceForm.onsubmit = function() { return false; };
		}
	} else {
		sessionID = uuid();
	}
	const serverURL = location.href;
	let activeConnectionCount = 0;
	export let dead = false;

	// Remote channels
	let remoteChannelCounter = 0;
	const pendingChannels : { [key: number]: (event: ConcurrenceEvent | undefined) => void; } = {};
	let pendingChannelCount = 0;

	// Local channels
	let localChannelCounter = 0;
	let queuedLocalEvents: ConcurrenceEvent[] = [];
	const fencedLocalEvents: { [key: number]: ((event: ConcurrenceEvent) => void)[]; } = {};

	// Heartbeat
	const sessionHeartbeatInterval = 4 * 60 * 1000;
	let heartbeatTimeout: any;

	// Websocket support
	const socketURL = serverURL.replace(/^http/, "ws") + "?";
	let WebSocketClass = (window as any).WebSocket as typeof WebSocket | undefined;
	let websocket: WebSocket | undefined;
	let pendingSocketMessageIds: number[] = [];

	function serializeMessage(messageId: number | undefined) {
		let message = "sessionID=" + sessionID;
		if (messageId) {
			message += "&messageID=" + messageId;
		}
		if (queuedLocalEvents.length) {
			message += "&events=" + encodeURIComponent(JSON.stringify(queuedLocalEvents).slice(1, -1)).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",").replace(/%20/g, "+");
			queuedLocalEvents = [];
		}
		return message;
	}

	function cancelHeartbeat() {
		if (heartbeatTimeout !== undefined) {
			clearTimeout(heartbeatTimeout);
			heartbeatTimeout = undefined;
		}
	}

	function restartHeartbeat() {
		cancelHeartbeat();
		heartbeatTimeout = setTimeout(() => sendMessages(false), sessionHeartbeatInterval);
	}

	function destroySession() {
		if (sessionID) {
			dead = true;
			cancelHeartbeat();
			window.removeEventListener("unload", destroySession, false);
			// Forcefully tear down WebSocket
			if (websocket) {
				pendingSocketMessageIds = [];
				if (websocket.readyState < 2) {
					websocket.close();
				}
				websocket = undefined;
			}
			// Abandon pending channels
			for (let channelId in pendingChannels) {
				pendingChannels[channelId](undefined);
			}
			// Send a "destroy" message so that the server can clean up the session
			const message = serializeMessage(outgoingMessageId++) + "&destroy=1";
			sessionID = undefined;
			if (navigator.sendBeacon) {
				navigator.sendBeacon(serverURL, message);
			} else {
				const request = new XMLHttpRequest();
				request.open("POST", serverURL, false);
				request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
				request.send(message);
			}
		}
	}
	window.addEventListener("unload", destroySession, false);

	function processMessage(events: ConcurrenceEvent[], messageId: number) {
		// Process messages in order
		if (messageId > incomingMessageId) {
			return false;
		}
		if (messageId < incomingMessageId) {
			return true;
		}
		incomingMessageId++;
		// Read each event and dispatch the appropriate event in order
		for (let i = 0; i < events.length; i++) {
			const event = events[i];
			const channelId = event[0];
			let channel: ((event: ConcurrenceEvent | undefined) => void) | undefined;
			if (channelId < 0) {
				// Fenced client-side event
				let fencedQueue = fencedLocalEvents[-channelId];
				channel = fencedQueue.shift();
				if (fencedQueue.length == 0) {
					delete fencedLocalEvents[-channelId];
				}
			} else {
				// Server-side event
				channel = pendingChannels[channelId];
			}
			if (channel) {
				channel(event);
			} else {
				throw new Error("Guru meditation error!");
			}
		}
		synchronizeChannels();
		return true;
	}

	function receiveMessage(messageText: string, messageId: number) {
		const message: ConcurrenceEvent[] = messageText.length ? JSON.parse("[" + messageText + "]") : [];
		if (processMessage(message, messageId)) {
			// Process any messages we received out of order
			for (let i = 0; i < reorderedMessages.length; i++) {
				const entry = reorderedMessages[i];
				if (processMessage(entry[0], entry[1])) {
					i = 0;
					reorderedMessages.splice(i, 1);
				}
			}
		} else {
			// Message was received out of order, queue it for later
			reorderedMessages.push([message, messageId]);
		}
	}

	function sendFormMessage(body: string, messageId: number) {
		// Form post over XMLHttpRequest is used when WebSockets are unavailable or fail
		const request = new XMLHttpRequest();
		request.open("POST", serverURL, true);
		request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
		request.onreadystatechange = () => {
			if (request.readyState == 4) {
				activeConnectionCount--;
				if (request.status == 200) {
					receiveMessage(request.responseText, messageId);
				} else {
					destroySession();
				}
			}
		}
		request.send(body);
	}

	function sendMessages(attemptWebSockets: boolean) {
		if (heartbeatTimeout != undefined) {
			restartHeartbeat();
		}
		activeConnectionCount++;
		const messageId = outgoingMessageId++;
		const existingSocket = websocket;
		if (existingSocket) {
			pendingSocketMessageIds.push(messageId);
			const message = JSON.stringify(queuedLocalEvents).slice(1, -1);
			if (existingSocket.readyState == 1) {
				// Send on open socket
				queuedLocalEvents = [];
				existingSocket.send(message);
			} else {
				// Coordinate with existing WebSocket that's in the process of being opened,
				// falling back to a form POST if necessary
				const body = serializeMessage(messageId);
				const existingSocketOpened = () => {
					existingSocket.removeEventListener("open", existingSocketOpened, false);
					existingSocket.removeEventListener("error", existingSocketErrored, false);
					existingSocket.send(message);
				}
				const existingSocketErrored = () => {
					existingSocket.removeEventListener("open", existingSocketOpened, false);
					existingSocket.removeEventListener("error", existingSocketErrored, false);
					sendFormMessage(body, messageId);
				}
				existingSocket.addEventListener("open", existingSocketOpened, false);
				existingSocket.addEventListener("error", existingSocketErrored, false);
			}
			return;
		}
		// Message will be sent in query string of new connection
		const body = serializeMessage(messageId);
		if (attemptWebSockets && WebSocketClass) {
			try {
				const newSocket = new WebSocketClass(socketURL + body);
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
					pendingSocketMessageIds = [];
					sendFormMessage(body, messageId);
				}
				newSocket.addEventListener("open", newSocketOpened, false);
				newSocket.addEventListener("error", newSocketErrored, false);
				newSocket.addEventListener("message", (event: any) => {
					activeConnectionCount--;
					const pendingId = pendingSocketMessageIds.shift();
					if (typeof pendingId != "undefined") {
						receiveMessage(event.data, pendingId);
					}
				}, false);
				pendingSocketMessageIds = [messageId];
				websocket = newSocket;
				return;
			} catch (e) {
				WebSocketClass = undefined;
			}
		}
		// WebSockets failed fast or were unavailable
		sendFormMessage(body, messageId);
	}

	function synchronizeChannels() {
		// Deferred sending of events so that we many from a single event loop can be batched
		defer(() => {
			if (idleDuringPrerender) {
				setTimeout(() => {
					idleDuringPrerender = false;
					synchronizeChannels();
				}, 1);
				return;
			}
			if (!dead) {
				if ((pendingChannelCount != 0 && activeConnectionCount == 0) || queuedLocalEvents.length) {
					sendMessages(true);
					restartHeartbeat();
				} else if (websocket && pendingSocketMessageIds.length == 0) {
					// Disconnect WebSocket when server can't possibly send us messages
					if (websocket.readyState < 2) {
						websocket.close();
					}
					websocket = undefined;
				}
			}
		});
	}

	function registerRemoteChannel(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceChannel {
		if (dead) {
			throw new Error("Session has died!");
		}
		// Expect that the server will run some code in parallel that provides data
		pendingChannelCount++;
		const channelId = ++remoteChannelCounter;
		pendingChannels[channelId] = callback;
		synchronizeChannels();
		return {
			close: () => {
				// Cleanup the bookkeeping
				if (pendingChannels[channelId]) {
					pendingChannelCount--;
					delete pendingChannels[channelId];
				}
			}
		};
	}

	function sendEvent(event: ConcurrenceEvent) : Promise<ConcurrenceEvent | undefined> {
		if (dead) {
			return Promise.reject(new Error("Session has died!"));
		}
		const result = new Promise<ConcurrenceEvent | undefined>((resolve, reject) => {
			if (pendingChannelCount) {
				// Let server decide on the ordering of events since server-side channels are active
				const channelId = event[0];
				const fencedQueue = fencedLocalEvents[channelId] || (fencedLocalEvents[channelId] = []);
				fencedQueue.push(resolve);
				event[0] = -channelId;
			} else {
				// No pending server-side channels, resolve immediately
				resolve();
			}
		});
		// Queue an event to be sent to the server in the next flush
		queuedLocalEvents.push(event);
		if (queuedLocalEvents.length == 1) {
			synchronizeChannels();
		}
		return result;
	}

	export const disconnect = destroySession;

	// APIs for client/, not to be used inside src/
	export function receiveServerPromise<T extends ConcurrenceJsonValue>(...args: any[]) : Promise<T> { // Must be cast to the proper signature
		return new Promise<T>(function(resolve, reject) {
			const channel = registerRemoteChannel(function(event) {
				channel.close();
				if (!event) {
					reject(new Error("Disconnected from server!"));
				} else {
					const value = event[1];
					const type = event[2];
					if (type) {
						// Convert serialized representation into the appropriate Error type
						if (type != 1 && /Error$/.test(type)) {
							const ErrorType : typeof Error = (window as any)[type] || Error;
							const error: any = new ErrorType(value.message);
							delete value.message;
							for (let i in value) {
								if (value.hasOwnProperty(i)) {
									error[i] = value[i];
								}
							}
							reject(error);
						} else {
							reject(value);
						}
					} else {
						resolve(value);
					}
				}
			});
		});
	};

	export function receiveServerEventStream<T extends Function>(callback: T): ConcurrenceChannel {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		const channel = registerRemoteChannel(event => {
			if (event) {
				callback.apply(null, event.slice(1));
			} else {
				channel.close();
			}
		});
		return channel;
	}

	export function observeClientPromise<T extends ConcurrenceJsonValue | void>(value: Promise<T> | T) : Promise<T> {
		let channelId = ++localChannelCounter;
		return Promise.resolve(value).then(value => sendEvent(typeof value == "undefined" ? [channelId] : [channelId, value]).then(() => roundTrip(value)), error => {
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
					if (anyError.hasOwnProperty(i)) {
						serializedError[i] = anyError[i];
					}
				}
			}
			return sendEvent([channelId, serializedError, type]).then(() => Promise.reject(error));
		});
	};

	export function createRenderPromise<T extends ConcurrenceJsonValue | void>(handler: (document: Document, resolve: (value: T) => void, reject: (error: any) => void) => void) : Promise<T> {
		return observeClientPromise(new Promise<T>((resolve, reject) => handler(document, resolve, reject)));
	};

	export function observeClientEventCallback<T extends Function>(callback: T) : ConcurrenceLocalChannel<T> {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let channelId: number = ++localChannelCounter;
		return {
			send: function() {
				if (channelId >= 0) {
					const message = Array.prototype.slice.call(arguments);
					const args = message.slice();
					message.unshift(channelId);
					sendEvent(message).then(function() {
						// Finally send event if a destroy call hasn't won the race
						if (channelId >= 0) {
							(callback as any as Function).apply(null, roundTrip(args));
						}
					});
				}
			} as any as T,
			close: function() {
				channelId = -1;
			}
		};
	}

}
