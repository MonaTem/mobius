const path = require("path");
const fs = require("fs");
const util = require("util");
const uuid = require("uuid/v4");

const vm = require("vm");

const express = require("express");
const expressWs = require("express-ws");
const bodyParser = require("body-parser");
const qs = require("qs");
const server = express();

const relativePath = relative => path.join(__dirname, relative);

server.disable("x-powered-by");
server.disable("etag");

server.use(express.static(relativePath("public")));

class ConcurrenceHost {
	constructor(path) {
		this.sessions = {};
		this.script = new vm.Script(fs.readFileSync(path), {
			filename: path
		});
		this.staleSessionTimeout = setInterval(() => {
			var now = Date.now();
			for (var i in this.sessions) {
				if (this.sessions.hasOwnProperty(i)) {
					if (now - this.sessions[i].lastMessageTime > 5 * 60 * 1000) {
						this.sessions[i].destroy();
					}
				}
			}
		}, 60 * 1000);
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
	destroy() {
		for (var i in this.sessions) {
			if (this.sessions.hasOwnProperty(i)) {
				this.sessions[i].destroy();
			}
		}
		clearInterval(this.staleSessionTimeout);
	}
}

const globals = this;

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
		this.lastMessageTime = Date.now();
		// Server-side version of the API
		var context = Object.create(global);
		context.concurrence = {
			disconnect : this.destroy.bind(this),
			receiveClientPromise: this.receiveRemotePromise.bind(this),
			observeServerPromise: this.observeLocalPromise.bind(this),
			receiveClientEventStream: this.receiveRemoteEventStream.bind(this),
			observeServerEventCallback: this.observeLocalEventCallback.bind(this),
		};
		this.context = context;
		host.script.runInNewContext(context);
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
			const events = JSON.parse("[" + jsonEvents + "]");
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
		this.lastMessageTime = Date.now();
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
					oldResolve(queuedLocalEvents);
				} else {
					resolve(queuedLocalEvents);
					return;
				}
			} else if (this.localTransactionCount) {
				if (oldResolve) {
					oldResolve();
				}
			} else {
				resolve();
				return;
			}
			this.queuedLocalEventsResolve = resolve;
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
			}
			this.localResolveTimeout = setTimeout(resolve, 30000);
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
				if (this.localResolveTimeout !== undefined) {
					clearTimeout(this.localResolveTimeout);
					delete this.localResolveTimeout;
				}
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
			var type = 1;
			var serializedError = error;
			if (error instanceof Error) {
				// Convert Error types to a representation that can be reconstituted on the client
				type = error.constructor.name;
				serializedError = Object.assign({ message: error.message, stack: error.stack }, error);
			}
			this.sendEvent([transactionId, serializedError, type]);
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
			close: function() {
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
			close: () => {
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
				transaction.close();
				if (!event) {
					reject(new Error("Disconnected from client!"));
				} else {
					var value = event[1];
					var type = event[2];
					if (type) {
						// Convert serialized representation into the appropriate Error type
						if (type !== 1) {
							type = globals[type] || Error;
							var newValue = new type(value.message);
							delete value.message;
							value = Object.assign(newValue, value);
						}
						reject(value);
					} else {
						resolve(value);
					}
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
				transaction.close();
			}
		});
		return transaction;
	}

	destroy() {
		if (!this.dead) {
			this.dead = true;
			this.sendQueuedEvents();
			delete this.host.sessions[this.sessionID];
		}
	}
};

function noCache(res) {
	res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
	res.header("Expires", new Date(0).toUTCString());
	res.header("Pragma", "no-cache");
}

var host = new ConcurrenceHost(relativePath("server.js"));

server.get("/", function (req, res) {
	noCache(res);
	res.send("<!doctype html><html><head></head><body><div id=\"host\"></div><div><button id=\"toggle\"></button></div><div><input id=\"input\"><button id=\"log\">Log</button></div><div><input id=\"broadcastField\"><button id=\"broadcast\">Broadcast</button><button id=\"connect\">Connect</button></div><div><button id=\"destroy\">End Session</button></div><script src=\"client.js\"></script></body></html>");
});

server.use(bodyParser.urlencoded({
	extended: true,
	type: () => true // Accept all MIME types
}));

server.post("/", function(req, res) {
	noCache(res);
	new Promise(resolve => {
		if (req.body.destroy) {
			// Forcefully clean up sessions
			host.destroySessionById(req.body.sessionID);
			res.set("Content-Type", "text/plain");
			res.send("");
			resolve();
		} else {
			// Process incoming events
			const session = host.sessionById(req.body.sessionID);
			if (session.receiveMessage(req.body)) {
				// Wait to send the response until we have events ready or until there are no more server-side transactions open
				resolve(session.dequeueEvents().then(events => {
					res.set("Content-Type", "text/plain");
					res.send(events && events.length ? JSON.stringify(events).slice(1, -1) : "");
				}));
			} else {
				// Out of order messages don't get any events
				res.set("Content-Type", "text/plain");
				res.send("");
				resolve();
			}
		}
	}).catch(e => {
		res.status(500);
		res.set("Content-Type", "text/plain");
		res.send(util.inspect(e));
	});
});

expressWs(server);
server.ws("/", function(ws, req) {
	const body = qs.parse(req.query);
	const session = host.sessionById(body.sessionID);
	var messageId = body.messageID | 0;
	var closed = false;
	function processMessage(body) {
		if (session.receiveMessage(body)) {
			session.dequeueEvents().then(events => {
				if (!closed) {
					ws.send(events && events.length ? JSON.stringify(events).slice(1, -1) : "");
				} else {
					session.destroy();
				}
			});
		} else {
			ws.send("");
		}
	}
	processMessage(body);
	ws.on("message", function(msg) {
		processMessage({
			messageID: ++messageId,
			events: msg,
		});
	});
	ws.on("close", function() {
		closed = true;
	});
});

server.listen(3000, function() {
	console.log("Listening on port 3000");
	server.on("close", function() {
		host.destroy();
	});
});
