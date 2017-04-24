const path = require("path");
const fs = require("fs");
const util = require("util");
const uuid = require("uuid/v4");

const vm = require("vm");

const express = require("express");
const bodyParser = require("body-parser");
const server = express();

const relativePath = relative => path.join(__dirname, relative);

server.use(express.static(relativePath("public")));

class ConcurrenceHost {
	constructor(path) {
		this.sessions = {};
		this.script = new vm.Script(fs.readFileSync(path), {
			filename: path
		});
	}
	sessionById(sessionID) {
		var session = this.sessions[sessionID];
		if (!session) {
			if (!sessionID) {
				throw new Error("Session ID not valid!");
			}
			session = new ConcurrenceSession(this, sessionID);
			this.sessions[session.sessionID] = session;
		}
		return session;
	}
	destroySessionById(sessionID) {
		const session = this.sessions[sessionID];
		if (session) {
			session.destroy();
		}
	}
}

const observers = [];

class ConcurrenceSession {
	constructor(host, sessionID) {
		this.host = host;
		this.sessionID = sessionID;
		this.dead = false;
		this.localTransactionCounter = 0;
		this.localTransactionCount = 0;
		this.remoteTransactionCounter = 0;
		this.pendingTransactions = {};
		this.pendingTransactionCount = 0;
		this.incomingMessageId = 0;
		this.reorderedMessages = [];
		// Server-side version of the API
		this.context = {
			console: console,
			concurrence: {
				disconnect : () => this.destroy(),
				// Server-side implementations
				random: () => this.observeLocalPromise(Math.random()),
				interval: (callback, frequency) => {
					const transaction = this.observeLocalEventCallback(callback);
					const interval = setInterval(_ => {
						if (this.dead) {
							transaction.destroy();
							clearInterval(interval);
						} else {
							transaction.send();
						}
					}, frequency);
					return transaction;
				},
				timeout: interval => this.observeLocalPromise(new Promise(resolve => setTimeout(() => resolve(), interval))),
				broadcast: text => {
					for (var i = 0; i < observers.length; i++) {
						observers[i](text);
					}
				},
				receive: callback => {
					const transaction = this.observeLocalEventCallback(callback);
					observers.push(text => transaction.send(text));
					return transaction;
				},
				// Client-side implementations
				render: (selector, html) => undefined,
				observe: (selector, event, callback) => this.receiveRemoteEventStream(callback),
				read: selector => this.receiveRemotePromise()
			}
		};
		host.script.runInNewContext(this.context);
	}
	processMessage(message) {
		// Process messages in order
		const messageId = message.messageID | 0;
		if (messageId > this.incomingMessageId) {
			return false;
		}
		if (messageId < this.incomingMessageId) {
			return true;
		}
		this.incomingMessageId++;
		// Read each event and dispatch the appropriate transaction in order
		const jsonEvents = message.events;
		if (jsonEvents) {
			const events = JSON.parse(jsonEvents);
			for (var i = 0; i < events.length; i++) {
				const event = events[i];
				var transactionId = event[0];
				var transaction;
				if (transactionId < 0) {
					// Server decided the ordering on "fenced" events
					this.sendEvent([transactionId]);
					transaction = this.pendingTransactions[-transactionId];
				} else {
					// Regular client-side events are handled normally
					transaction = this.pendingTransactions[transactionId];
				}
				if (transaction) {
					transaction(event);
				}
			}
		}
		return true;
	}
	receiveMessage(message) {
		if (this.processMessage(message)) {
			// Process any messages we received out of order
			for (var i = 0; i < this.reorderedMessages.length; i++) {
				if (this.processMessage(this.reorderedMessages[i])) {
					i = 0;
					this.reorderedMessages.splice(i, 1);
				}
			}
			return true;
		}
		// Message was received out of order, queue it for later
		this.reorderedMessages.push(message);
		return false;
	}
	dequeueEvents() {
		return new Promise((resolve, reject) => {
			// Wait until events are ready, a new event handler comes in, or no more local transactions exist
			const queuedLocalEvents = this.queuedLocalEvents;
			const oldResolve = this.queuedLocalEventsResolve;
			if (queuedLocalEvents) {
				delete this.queuedLocalEvents;
				if (oldResolve) {
					this.queuedLocalEventsResolve = resolve;
					oldResolve(queuedLocalEvents);
				} else {
					resolve(queuedLocalEvents);
				}
			} else if (this.localTransactionCount) {
				this.queuedLocalEventsResolve = resolve;
				if (oldResolve) {
					oldResolve();
				}
			} else {
				resolve();
			}
		});
	}
	sendEvent(event) {
		if (this.dead) {
			throw new Error("Session has died!");
		}
		// Queue an event
		const queuedLocalEvents = this.queuedLocalEvents;
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			this.queuedLocalEvents = [event];
			this.sendQueuedEvents();
		}
	}
	sendQueuedEvents() {
		// Basic implementation of batching by deferring the response
		setImmediate(() => {
			const resolve = this.queuedLocalEventsResolve;
			if (resolve) {
				delete this.queuedLocalEventsResolve;
				const queuedLocalEvents = this.queuedLocalEvents;
				delete this.queuedLocalEvents;
				resolve(queuedLocalEvents);
			}
			// If no transactions remain, the session is in a state where no more events
			// can be sent from either the client or server. Session can be destroyed
			if (this.pendingTransactionCount + this.localTransactionCount == 0) {
				this.destroy();
			}
		});
	}
	observeLocalPromise(value) {
		// Record and ship values/errors of server-side promises
		this.localTransactionCount++;
		const transactionId = ++this.localTransactionCounter;
		return Promise.resolve(value).then(value => {
			this.localTransactionCount--;
			this.sendEvent([transactionId, value]);
			return value;
		}, error => {
			this.localTransactionCount--;
			this.sendEvent([transactionId, error, 1]);
			return error;
		});
	}
	observeLocalEventCallback(callback) {
		// Record and ship arguments of server-side events
		const session = this;
		session.localTransactionCount++;
		return {
			transactionId: ++this.localTransactionCounter,
			send: function() {
				const transactionId = this.transactionId;
				if (transactionId != null) {
					const message = Array.prototype.slice.call(arguments);
					message.unshift(transactionId);
					session.sendEvent(message);
					return callback.apply(null, arguments);
				}
			},
			destroy: function() {
				if (this.transactionId != null) {
					this.transactionId = null;
					if ((--session.localTransactionCount) == 0) {
						// If this was the last server transaction, reevaluate queued events so the session can be potentially collected
						session.sendQueuedEvents();
					}
				}
			}
		};
	}

	registerRemoteTransaction(callback) {
		if (this.dead) {
			throw new Error("Session has died!");
		}
		this.pendingTransactionCount++;
		const transactionId = ++this.remoteTransactionCounter;
		this.pendingTransactions[transactionId] = callback;
		return {
			destroy: () => {
				if (this.pendingTransactions[transactionId]) {
					delete this.pendingTransactions[transactionId];
					if ((--this.pendingTransactionCount) == 0) {
						// If this was the last client transaction, reevaluate queued events so the session can be potentially collected
						this.sendQueuedEvents();
					}
				}
			}
		};
	}
	receiveRemotePromise() {
		return new Promise((resolve, reject) => {
			const transaction = this.registerRemoteTransaction(function(event) {
				transaction.destroy();
				if (event && !event[2]) {
					resolve(event[1]);
				} else if (event) {
					reject(event[1]);
				} else {
					reject("Disconnected from client!");
				}
			});
		});
	}
	receiveRemoteEventStream(callback) {
		const transaction = this.registerRemoteTransaction(function(event) {
			if (event) {
				event.shift();
				callback.apply(null, event);
			} else {
				transaction.destroy();
			}
		});
		return transaction;
	}

	destroy() {
		if (!this.dead) {
			this.dead = true;
			delete this.host.sessions[this.sessionID];
		}
	}
};

var host = new ConcurrenceHost(relativePath("public/app.js"));

server.get("/", function (req, res) {
	res.send("<!doctype html><html><head></head><body><div id=\"host\"></div><div><button id=\"toggle\"></button></div><div><input id=\"input\"><button id=\"log\">Log</button></div><div><input id=\"broadcastField\"><button id=\"broadcast\">Broadcast</button></div><div><button id=\"disconnect\">Disconnect</button></div><script src=\"concurrence.js\"></script><script>concurrence._init(\"" + uuid() + "\")</script><script src=\"app.js\"></script></body></html>");
});

server.use(bodyParser.urlencoded({
	extended: true,
	type: () => true // Accept all MIME types
}));

server.post("/", function(req, res) {
	new Promise(resolve => {
		if (req.body.destroy) {
			// Forcefully clean up sessions
			host.destroySessionById(req.body.sessionID);
			res.set("Content-Type", "application/json");
			res.send("{\"goodbye\":\"world\"}");
			resolve();
		} else {
			// Process incoming events
			const session = host.sessionById(req.body.sessionID);
			if (session.receiveMessage(req.body)) {
				// Wait to send the response until we have events ready or until there are no more server-side transactions open
				resolve(session.dequeueEvents().then(events => {
					res.set("Content-Type", "application/json");
					const response = {};
					if (events && events.length) {
						response.events = events;
					}
					res.send(JSON.stringify(response));
				}));
			} else {
				// Out of order messages don't get any events
				res.set("Content-Type", "application/json");
				res.send("{}");
			}
		}
	}).catch(e => {
		res.status(500);
		res.set("Content-Type", "text/plain");
		res.send(util.inspect(e));
	});
});

server.listen(3000, function () {
	console.log("Listening on port 3000");
});
