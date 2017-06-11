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
	var outgoingMessageId = 0;
	var incomingMessageId = 0;
	const reorderedMessages : [ConcurrenceEvent[], number][] = [];

	// Session state
	var sessionID: string | undefined;
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
	var activeConnectionCount = 0;
	export var dead = false;

	// Remote transactions
	var remoteTransactionCounter = 0;
	const pendingTransactions : { [key: number]: (event: ConcurrenceEvent | undefined) => void; } = {};
	var pendingTransactionCount = 0;

	// Local transactions
	var localTransactionCounter = 0;
	var queuedLocalEvents: ConcurrenceEvent[] = [];
	const fencedLocalEvents: { [key: number]: ((event: ConcurrenceEvent) => void)[]; } = {};

	// Heartbeat
	const sessionHeartbeatInterval = 4 * 60 * 1000;
	var heartbeatTimeout: number | undefined;

	// Websocket support
	const socketURL = serverURL.replace(/^http/, "ws") + "?";
	var WebSocketClass = (window as any).WebSocket as typeof WebSocket | undefined;
	var websocket: WebSocket | undefined;
	var pendingSocketMessageIds: number[] = [];

	function serializeMessage(messageId: number | undefined) {
		var message = "sessionID=" + sessionID;
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
			// Abandon pending transactions
			for (var transactionId in pendingTransactions) {
				pendingTransactions[transactionId](undefined);
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
		// Read each event and dispatch the appropriate transaction in order
		for (var i = 0; i < events.length; i++) {
			var event = events[i];
			var transactionId = event[0];
			var transaction;
			if (transactionId < 0) {
				// Fenced client-side event
				var fencedQueue = fencedLocalEvents[-transactionId];
				transaction = fencedQueue.shift();
				if (fencedQueue.length == 0) {
					delete fencedLocalEvents[-transactionId];
				}
			} else {
				// Server-side event
				transaction = pendingTransactions[transactionId];
			}
			if (transaction) {
				transaction(event);
			} else {
				throw new Error("Guru meditation error!");
			}
		}
		synchronizeTransactions();
		return true;
	}

	function receiveMessage(messageText: string, messageId: number) {
		const message: ConcurrenceEvent[] = messageText.length ? JSON.parse("[" + messageText + "]") : [];
		if (processMessage(message, messageId)) {
			// Process any messages we received out of order
			for (var i = 0; i < reorderedMessages.length; i++) {
				var entry = reorderedMessages[i];
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
				// Attempt to open a WebSocket for transactions, but not heartbeats
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

	function synchronizeTransactions() {
		// Deferred sending of events so that we many from a single event loop can be batched
		defer(() => {
			if (idleDuringPrerender) {
				setTimeout(() => {
					idleDuringPrerender = false;
					synchronizeTransactions();
				}, 1);
				return;
			}
			if (!dead) {
				if ((pendingTransactionCount != 0 && activeConnectionCount == 0) || queuedLocalEvents.length) {
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

	function registerRemoteTransaction(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceTransaction {
		if (dead) {
			throw new Error("Session has died!");
		}
		// Expect that the server will run some code in parallel that provides data
		pendingTransactionCount++;
		const transactionId = ++remoteTransactionCounter;
		pendingTransactions[transactionId] = callback;
		synchronizeTransactions();
		return {
			close: () => {
				// Cleanup the bookkeeping
				if (pendingTransactions[transactionId]) {
					pendingTransactionCount--;
					delete pendingTransactions[transactionId];
				}
			}
		};
	}

	function sendEvent(event: ConcurrenceEvent) : Promise<ConcurrenceEvent | undefined> {
		if (dead) {
			return Promise.reject(new Error("Session has died!"));
		}
		const result = new Promise<ConcurrenceEvent | undefined>((resolve, reject) => {
			if (pendingTransactionCount) {
				// Let server decide on the ordering of events since server-side transactions are active
				const transactionId = event[0];
				const fencedQueue = fencedLocalEvents[transactionId] || (fencedLocalEvents[transactionId] = []);
				fencedQueue.push(resolve);
				event[0] = -transactionId;
			} else {
				// No pending server-side transactions, resolve immediately
				resolve();
			}
		});
		// Queue an event to be sent to the server in the next flush
		queuedLocalEvents.push(event);
		if (queuedLocalEvents.length == 1) {
			synchronizeTransactions();
		}
		return result;
	}

	export const disconnect = destroySession;

	// APIs for client/, not to be used inside src/
	export function receiveServerPromise<T>(...args: any[]) : Promise<T> { // Must be cast to the proper signature
		return new Promise(function(resolve, reject) {
			const transaction = registerRemoteTransaction(function(event) {
				transaction.close();
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
							for (var i in value) {
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

	export function receiveServerEventStream<T extends Function>(callback: T): ConcurrenceTransaction {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		const transaction = registerRemoteTransaction(event => {
			if (event) {
				callback.apply(null, event.slice(1));
			} else {
				transaction.close();
			}
		});
		return transaction;
	}

	export function observeClientPromise<T>(value: Promise<T> | T) : Promise<T> {
		var transactionId = ++localTransactionCounter;
		return Promise.resolve(value).then(value => sendEvent([transactionId, value]).then(() => roundTrip(value)), error => {
			// Convert Error types to a representation that can be reconstituted on the server
			var type : any = 1;
			var serializedError: any = error;
			if (error instanceof Error) {
				var errorClass : any = error.constructor;
				if ("name" in errorClass) {
					type = errorClass.name;
				} else {
					// ES5 support
					type = errorClass.toString().match(/.*? (\w+)/)[0];
				}
				serializedError = { message: error.message, stack: error.stack };
				var anyError : any = error;
				for (var i in anyError) {
					if (anyError.hasOwnProperty(i)) {
						serializedError[i] = anyError[i];
					}
				}
			}
			return sendEvent([transactionId, serializedError, type]).then(() => Promise.reject(error));
		});
	};

	export function observeClientEventCallback<T extends Function>(callback: T) : ConcurrenceLocalTransaction<T> {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		var transactionId: number = ++localTransactionCounter;
		return {
			send: function() {
				if (transactionId >= 0) {
					const message = Array.prototype.slice.call(arguments);
					const args = message.slice();
					message.unshift(transactionId);
					sendEvent(message).then(function() {
						// Finally send event if a destroy call hasn't won the race
						if (transactionId >= 0) {
							(callback as any as Function).apply(null, roundTrip(args));
						}
					});
				}
			} as any as T,
			close: function() {
				transactionId = -1;
			}
		};
	}
}
