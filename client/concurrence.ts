/// <reference path="../src/concurrence.d.ts" />

namespace concurrence {
	const defer = window.setImmediate || window.requestAnimationFrame || (window as any).webkitRequestRequestAnimationFrame || (window as any).mozRequestRequestAnimationFrame || function(callback: () => void) { setTimeout(callback, 0) };

	// Session state
	var sessionID: string | undefined = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
		var r = Math.random() * 16 | 0;
		return (c == "x" ? r : (r & 3 | 8)).toString(16);
	});
	var activeConnectionCount = 0;
	export var dead = false;

	// Message ordering
	var outgoingMessageId = 0;
	var incomingMessageId = 0;
	var reorderedMessages : any[][] = [];

	// Remote transactions
	var remoteTransactionCounter = 0;
	var pendingTransactions : { [key: number]: (event: any[] | undefined) => void; } = {};
	var pendingTransactionCount = 0;

	// Local transactions
	var localTransactionCounter = 0;
	var queuedLocalEvents: any[] = [];
	var fencedLocalEvents: { [key: number]: ((event: any[]) => void)[]; } = {};

	// Heartbeat
	var sessionHeartbeatInterval = 4 * 60 * 1000;
	var heartbeatTimeout: any;

	// Websocket support
	var WebSocketClass: typeof WebSocket | undefined = WebSocket;
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
			var message = serializeMessage(outgoingMessageId++) + "&destroy=1";
			sessionID = undefined;
			if (navigator.sendBeacon) {
				navigator.sendBeacon(location.href, message);
			} else {
				var request = new XMLHttpRequest();
				request.open("POST", location.href, false);
				request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
				request.send(message);
			}
		}
	}
	window.addEventListener("unload", destroySession, false);

	function processMessage(events: any[][], messageId: number) {
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
		var message = messageText.length ? JSON.parse("[" + messageText + "]") : [];
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
		var request = new XMLHttpRequest();
		request.open("POST", location.href, true);
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
		var messageId = outgoingMessageId++;
		if (websocket) {
			pendingSocketMessageIds.push(messageId);
			var message = JSON.stringify(queuedLocalEvents).slice(1, -1);
			if (websocket.readyState == 1) {
				queuedLocalEvents = [];
				websocket.send(message);
			} else {
				// Coordinate with existing WebSocket that's in the process of being opened,
				// falling back to a form POST if necessary
				var body = serializeMessage(messageId);
				var existingSocketOpened = () => {
					if (websocket) {
						websocket.removeEventListener("open", existingSocketOpened, false);
						websocket.removeEventListener("error", existingSocketErrored, false);
						websocket.send(message);
					}
				}
				var existingSocketErrored = () => {
					if (websocket) {
						websocket.removeEventListener("open", existingSocketOpened, false);
						websocket.removeEventListener("error", existingSocketErrored, false);
						sendFormMessage(body, messageId);
					}
				}
				websocket.addEventListener("open", existingSocketOpened, false);
				websocket.addEventListener("error", existingSocketErrored, false);
			}
			return;
		}
		var body = serializeMessage(messageId);
		if (attemptWebSockets && WebSocketClass) {
			// Attempt to open a WebSocket for transactions, but not heartbeats
			var newSocketOpened = () => {
				if (websocket) {
					websocket.removeEventListener("open", newSocketOpened, false);
					websocket.removeEventListener("error", newSocketErrored, false);
				}
			}
			var newSocketErrored = () => {
				// WebSocket failed, fallback using form POSTs
				newSocketOpened();
				WebSocketClass = undefined;
				websocket = undefined;
				pendingSocketMessageIds = [];
				sendFormMessage(body, messageId);
			}
			try {
				const newSocket = websocket = new WebSocketClass(location.href.replace(/^http/, "ws") + "?" + body);
				newSocket.addEventListener("open", newSocketOpened, false);
				newSocket.addEventListener("error", newSocketErrored, false);
				newSocket.addEventListener("message", function(event: any) {
					activeConnectionCount--;
					var pendingId = pendingSocketMessageIds.shift();
					if (typeof pendingId != "undefined") {
						receiveMessage(event.data, pendingId);
					}
				}, false);
				pendingSocketMessageIds = [messageId];
				return;
			} catch (e) {
			}
		}
		sendFormMessage(body, messageId);
	}

	function synchronizeTransactions() {
		// Deferred sending of events so that we many from a single event loop can be batched
		defer(() => {
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

	function registerRemoteTransaction(callback: (event: any) => void) {
		if (dead) {
			throw new Error("Session has died!");
		}
		// Expect that the server will run some code in parallel that provides data
		pendingTransactionCount++;
		var transactionId = ++remoteTransactionCounter;
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

	function sendEvent(event: any[]) {
		if (dead) {
			return Promise.reject(new Error("Session has died!"));
		}
		var result = new Promise(function(resolve) {
			if (pendingTransactionCount) {
				// Let server decide on the ordering of events since server-side transactions are active
				var transactionId = event[0];
				var fencedQueue = fencedLocalEvents[transactionId] || (fencedLocalEvents[transactionId] = []);
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
	export function receiveServerPromise() {
		return new Promise(function(resolve, reject) {
			var transaction = registerRemoteTransaction(function(event) {
				transaction.close();
				if (!event) {
					reject(new Error("Disconnected from server!"));
				} else {
					var value = event[1];
					var type = event[2];
					if (type) {
						// Convert serialized representation into the appropriate Error type
						if (type !== 1) {
							type = (window as any)[type] || Error;
							var newValue = new type(value.message);
							delete value.message;
							for (var i in value) {
								if (value.hasOwnProperty(i)) {
									newValue[i] = value[i];
								}
							}
							value = newValue;
						}
						reject(value);
					} else {
						resolve(value);
					}
				}
			});
		});
	};

	export function receiveServerEventStream<T>(callback: (value: T) => void, ...args: any[]): ConcurrenceTransaction {
		var transaction = registerRemoteTransaction(function(event) {
			if (event) {
				event.shift();
				callback.apply(null, event);
			} else {
				transaction.close();
			}
		});
		return transaction;
	}

	export function observeClientPromise<T>(value: Promise<T> | T) : Promise<T> {
		var transactionId = ++localTransactionCounter;
		return Promise.resolve(value).then(value => sendEvent([transactionId, value]).then(() => value), error => {
			// Convert Error types to a representation that can be reconstituted on the server
			var type : any = 1;
			var serializedError: any = error;
			if (error instanceof Error) {
				var errorClass : any = error.constructor;
				if ("name" in errorClass) {
					type = errorClass.name;
				} else {
					// ES5 support
					type = errorClass.toString().match(/function (\w+)\(/)[1];
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

	export function observeClientEventCallback(callback: (...args: any[]) => void) {
		return {
			transactionId: ++localTransactionCounter,
			send: function() {
				var transactionId = this.transactionId;
				if (transactionId >= 0) {
					var message = Array.prototype.slice.call(arguments);
					var args = message.slice();
					message.unshift(transactionId);
					var transaction = this;
					sendEvent(message).then(function() {
						// Finally send event if a destroy call hasn't won the race
						if (transaction.transactionId != null) {
							callback.apply(null, args);
						}
					});
				}
			},
			close: function() {
				this.transactionId = -1;
			}
		};
	}
}
