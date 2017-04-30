(function() {
	var defer = this.setImmediate || this.requestAnimationFrame || this.webkitRequestRequestAnimationFrame || this.mozRequestRequestAnimationFrame || function(callback) { setTimeout(callback, 0) };

	// Session state
	var sessionID = "";
	var activeConnectionCount = 0;
	var dead = false;

	// Message ordering
	var outgoingMessageId = 0;
	var incomingMessageId = 0;
	var reorderedMessages = [];

	// Remote transactions
	var remoteTransactionCounter = 0;
	var pendingTransactions = {};
	var pendingTransactionCount = 0;

	// Local transactions
	var localTransactionCounter = 0;
	var queuedLocalEvents;
	var fencedLocalEvents = {};

	function serializeMessage(messageId) {
		var message = "sessionID=" + sessionID + "&messageID=" + messageId;
		if (queuedLocalEvents) {
			message += "&events=" + encodeURIComponent(JSON.stringify(queuedLocalEvents).slice(1, -1));
			queuedLocalEvents = undefined;
		}
		return message;
	}

	function destroySession() {
		if (sessionID) {
			dead = true;
			window.removeEventListener("unload", destroySession, false);
			for (var transactionId in pendingTransactions) {
				pendingTransactions[transactionId]();
			}
			// Send a "destroy" message so that the server can clean up the session
			var message = serializeMessage(outgoingMessageId++) + "&destroy=1";
			sessionID = "";
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

	function processMessage(message, messageId) {
		// Process messages in order
		if (messageId > incomingMessageId) {
			return false;
		}
		if (messageId < incomingMessageId) {
			return true;
		}
		incomingMessageId++;
		// Read each event and dispatch the appropriate transaction in order
		var events = message.events;
		if (events) {
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
		}
		synchronizeTransactions();
		return true;
	}

	function receiveMessage(message, messageId) {
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

	function synchronizeTransactions() {
		// Deferred sending of events so that we many from a single event loop can be batched
		defer(function() {
			if (((pendingTransactionCount != 0 && activeConnectionCount == 0) || queuedLocalEvents) && !dead) {
				var request = new XMLHttpRequest();
				request.open("POST", location.href, true);
				activeConnectionCount++;
				request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
				var messageId = outgoingMessageId++;
				request.onreadystatechange = function() {
					if (request.readyState == 4) {
						activeConnectionCount--;
						if (request.status == 200) {
							var responseText = request.responseText;
							receiveMessage(responseText.length ? JSON.parse(responseText) : {}, messageId);
						} else {
							destroySession();
						}
					}
				}
				request.send(serializeMessage(messageId));
			}
		});
	}

	function registerRemoteTransaction(callback) {
		if (dead) {
			throw new Error("Session has died!");
		}
		// Expect that the server will run some code in parallel that provides data
		pendingTransactionCount++;
		var transactionId = ++remoteTransactionCounter;
		pendingTransactions[transactionId] = callback;
		synchronizeTransactions();
		return {
			close: function() {
				// Cleanup the bookkeeping
				if (pendingTransactions[transactionId]) {
					pendingTransactionCount--;
					delete pendingTransactions[transactionId];
				}
			}
		};
	}

	function receiveRemotePromise() {
		return new Promise(function(resolve, reject) {
			var transaction = registerRemoteTransaction(function(event) {
				transaction.close();
				if (event && !event[2]) {
					resolve(event[1]);
				} else if (event) {
					reject(event[1]);
				} else {
					reject("Disconnected from server!");
				}
			});
		});
	}

	function receiveRemoteEventStream(callback) {
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

	function sendEvent(event) {
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
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			queuedLocalEvents = [event];
			synchronizeTransactions();
		}
		return result;
	}

	function observeLocalPromise(value) {
		var transactionId = ++localTransactionCounter;
		return Promise.resolve(value).then(function(value) {
			return sendEvent([transactionId, value]).then(function() {
				return value;
			});
		}, function(error) {
			return sendEvent([transactionId, error, 1]).then(function() {
				return Promise.reject(error);
			});
		});
	}

	function observeLocalEventCallback(callback) {
		return {
			transactionId: ++localTransactionCounter,
			send: function() {
				var transactionId = this.transactionId;
				if (transactionId != null) {
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
				this.transactionId = null;
			}
		};
	}

	// Client-side version of the API
	this.concurrence = {
		_init: function(newSessionID) {
			delete this._init;
			sessionID = newSessionID;
		},
		disconnect: destroySession,
		// Server-side implementations
		random: receiveRemotePromise,
		interval: receiveRemoteEventStream,
		timeout: receiveRemotePromise,
		broadcast: function(text) {},
		receive: receiveRemoteEventStream,
		// Client-side implementations
		render: function(selector, value) {
			var element = document.querySelector(selector)
			if (element) {
				if ("value" in element) {
					element.value = value;
				}
				if ("innerText" in element && element.nodeName != "INPUT") {
					element.innerText = value;
				}
			}
		},
		observe: function(selector, event, callback) {
			var transaction = observeLocalEventCallback(callback);
			var elements = document.querySelectorAll(selector);
			for (var i = 0; i < elements.length; i++) {
				elements[i].addEventListener(event, function() {
					transaction.send();
				}, false);
			}
			return transaction;
		},
		read: function(selector) {
			var element = document.querySelector(selector);
			return observeLocalPromise(element ? Promise.resolve(element.value) : Promise.reject("Selector not found!"));
		}
	};
})();
