import * as path from "path";
import * as fs from "fs";
import * as util from "util";

import * as vm from "vm";

import * as express from "express";
import * as bodyParser from "body-parser";
import * as qs from "qs";
const expressWs = require("express-ws");

import * as uuid from "uuid";
import { JSDOM } from "jsdom";

const server = express();

const relativePath = (relative: string) => path.join(__dirname, relative);

server.disable("x-powered-by");
server.disable("etag");

function showDeterminismWarning(deprecated: string, instead: string): void {
	console.log("Called " + deprecated + " which may result in split-brain!\nInstead use " + instead + " " + (new Error() as any).stack.split(/\n\s*/g).slice(3).join("\n\t"));
}

function applyDeterminismWarning<T>(parent: T, key: keyof T, example: string, replacement: string): T[keyof T] {
	const original = parent[key];
	parent[key] = function(this: any) {
		showDeterminismWarning(example, replacement);
		return (original as any as Function).apply(this, arguments);
	} as any as T[keyof T];
	return original;
}

function immediate<T>(value: T) : Promise<T> {
	return new Promise<T>(resolve => setImmediate(() => resolve(value)));
}

class ConcurrenceHost {
	sessions: { [key: string]: ConcurrenceSession; } = {};
	script: vm.Script;
	staleSessionTimeout: any;
	constructor(path: string) {
		this.sessions = {};
		this.script = new vm.Script(fs.readFileSync(path).toString(), {
			filename: path
		});
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (var i in this.sessions) {
				if (this.sessions.hasOwnProperty(i)) {
					if (now - this.sessions[i].lastMessageTime > 5 * 60 * 1000) {
						this.sessions[i].destroy();
					}
				}
			}
		}, 60 * 1000);
	}
	sessionById(sessionID: string, createSession: boolean) {
		let session = this.sessions[sessionID];
		if (!session) {
			if (!sessionID) {
				throw new Error("No session ID specified!");
			}
			if (!createSession) {
				throw new Error("Session ID is not valid!");
			}
			session = new ConcurrenceSession(this, sessionID);
			this.sessions[sessionID] = session;
			session.run();
		}
		return session;
	}
	newSession() {
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions[sessionID]) {
				return this.sessions[sessionID] = new ConcurrenceSession(this, sessionID);
			}
		}
	}
	destroySessionById(sessionID: string) {
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

type ConcurrenceEvent = [number] | [number, any] | [number, any, any];

interface ConcurrenceMessage {
	events: string | undefined;
	messageID: string | number | undefined;
}

class ConcurrenceSession {
	host: ConcurrenceHost;
	sessionID: string;
	dead: boolean = false;
	lastMessageTime: number = Date.now();
	localTransactionCounter: number = 0;
	localTransactionCount: number = 0;
	localPrerenderTransactionCount: number = 0;
	remoteTransactionCounter: number = 0;
	pendingTransactions: { [transactionId: number]: (event: ConcurrenceEvent) => void; } = {};
	pendingTransactionCount: number = 0;
	incomingMessageId: number = 0;
	reorderedMessages: ConcurrenceMessage[] = [];
	context: any;
	queuedLocalEvents: ConcurrenceEvent[] | undefined;
	queuedLocalEventsResolve: ((events: ConcurrenceEvent[] | undefined) => void) | undefined;
	prerenderCallback: ((events: ConcurrenceEvent[] | undefined, idle: boolean) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	constructor(host: ConcurrenceHost, sessionID: string) {
		this.host = host;
		this.sessionID = sessionID;
		// Server-side version of the API
		const context = Object.create(global);
		context.global = context;
		context.document = undefined;
		context.concurrence = {
			disconnect : this.destroy.bind(this),
			dead: false,
			receiveClientPromise: this.receiveRemotePromise.bind(this),
			observeServerPromise: this.observeLocalPromise.bind(this),
			receiveClientEventStream: this.receiveRemoteEventStream.bind(this),
			observeServerEventCallback: this.observeLocalEventCallback.bind(this),
			showDeterminismWarning: showDeterminismWarning,
			applyDeterminismWarning: applyDeterminismWarning
		};
		this.context = context;
	}
	run() {
		host.script.runInNewContext(this.context);
	}
	processMessage(message: ConcurrenceMessage) {
		// Process messages in order
		const messageId = (message.messageID as any) | 0;
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
	receiveMessage(message: ConcurrenceMessage) {
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
	dequeueEvents() : Promise<ConcurrenceEvent[] | undefined> {
		return new Promise<ConcurrenceEvent[] | undefined>((resolve, reject) => {
			// Wait until events are ready, a new event handler comes in, or no more local transactions exist
			const queuedLocalEvents = this.queuedLocalEvents;
			const oldResolve = this.queuedLocalEventsResolve;
			if (queuedLocalEvents) {
				this.queuedLocalEvents = undefined;
				if (oldResolve) {
					this.queuedLocalEventsResolve = resolve;
					oldResolve(queuedLocalEvents);
				} else {
					resolve(queuedLocalEvents);
					return;
				}
			} else if (this.localTransactionCount) {
				this.queuedLocalEventsResolve = resolve;
				if (oldResolve) {
					oldResolve(undefined);
				}
			} else {
				resolve();
				return;
			}
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
			}
			this.localResolveTimeout = setTimeout(resolve, 30000);
		});
	}
	sendEvent(event: ConcurrenceEvent) {
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
		return immediate(undefined).then(() => {
			const resolve = this.queuedLocalEventsResolve;
			if (resolve) {
				this.queuedLocalEventsResolve = undefined;
				const queuedLocalEvents = this.queuedLocalEvents;
				this.queuedLocalEvents = undefined;
				resolve(queuedLocalEvents);
				if (this.localResolveTimeout !== undefined) {
					clearTimeout(this.localResolveTimeout);
					this.localResolveTimeout = undefined;
				}
			}
			// If no transactions remain, the session is in a state where no more events
			// can be sent from either the client or server. Session can be destroyed
			if (this.pendingTransactionCount + this.localTransactionCount == 0) {
				this.destroy();
			}
		});
	}
	sendPrerender() {
		return immediate(undefined).then(() => {
			const prerenderCallback = this.prerenderCallback;
			if (prerenderCallback) {
				++this.incomingMessageId;
				this.prerenderCallback = undefined;
				const queuedLocalEvents = this.queuedLocalEvents;
				this.queuedLocalEvents = undefined;
				prerenderCallback(queuedLocalEvents, this.localTransactionCount == 0);
				this.sendQueuedEvents();
			}
		});
	}
	enterLocalTransaction(includedInPrerender: boolean = true) : number {
		if (includedInPrerender) {
			++this.localPrerenderTransactionCount;
		}
		return ++this.localTransactionCount;
	}
	exitLocalTransaction(includedInPrerender: boolean = true) : number {
		if (includedInPrerender) {
			if (--this.localPrerenderTransactionCount == 0) {
				this.sendPrerender();
			}
		}
		return --this.localTransactionCount;
	}
	observeLocalPromise<T>(value: Promise<T> | T, includedInPrerender: boolean = true): Promise<T> {
		// Record and ship values/errors of server-side promises
		this.enterLocalTransaction(includedInPrerender);
		const transactionId = ++this.localTransactionCounter;
		return Promise.resolve(value).then(value => {
			// Forward the value to the client
			this.exitLocalTransaction(includedInPrerender);
			this.sendEvent([transactionId, value]);
			return value;
		}, error => {
			// Serialize the reject error type or string
			this.exitLocalTransaction(includedInPrerender);
			var type: number | string = 1;
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
	observeLocalEventCallback<T extends Function>(callback: T, includedInPrerender: boolean = true): ConcurrenceLocalTransaction<T> {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		// Record and ship arguments of server-side events
		const session = this;
		session.enterLocalTransaction(includedInPrerender);
		var transactionId = ++session.localTransactionCounter;
		return {
			send: function() {
				if (transactionId >= 0) {
					if (!session.dead) {
						const message = Array.prototype.slice.call(arguments);
						message.unshift(transactionId);
						session.sendEvent(message);
					}
					(callback as any as Function).apply(null, arguments);
				}
			} as any as T,
			close: function() {
				if (transactionId >= 0) {
					transactionId = -1;
					if (session.exitLocalTransaction(includedInPrerender) == 0) {
						// If this was the last server transaction, reevaluate queued events so the session can be potentially collected
						session.sendQueuedEvents();
					}
				}
			}
		};
	}

	registerRemoteTransaction(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceTransaction {
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
			const transaction = this.registerRemoteTransaction(event => {
				transaction.close();
				if (!event) {
					reject(new Error("Disconnected from client!"));
				} else {
					var value : any = event[1];
					const type = event[2];
					if (type) {
						// Convert serialized representation into the appropriate Error type
						if (type != 1 && /Error$/.test(type)) {
							const ErrorType : typeof Error = (global as any)[type] || Error;
							const newValue = new ErrorType(value.message);
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
	receiveRemoteEventStream<T extends Function>(callback: T): ConcurrenceTransaction {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
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
			this.context.concurrence.dead = true;
			this.sendPrerender();
			this.sendQueuedEvents();
			delete this.host.sessions[this.sessionID];
		}
	}
};

function noCache(res: express.Response) {
	res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
	res.header("Expires", new Date(0).toUTCString());
	res.header("Pragma", "no-cache");
}

const host = new ConcurrenceHost(relativePath("server.js"));

server.use(bodyParser.urlencoded({
	extended: true,
	type: () => true // Accept all MIME types
}));

const indexHTML = fs.readFileSync(relativePath("../public/index.html")).toString();

server.get("/", (req, res) => {
	new Promise(resolve => {
		const dom = new JSDOM(indexHTML);
		const document = (dom.window as any).document as Document;
		const clientScript = document.querySelector("script[src=\"client.js\"]");
		if (clientScript) {
			const session = host.newSession();
			return resolve(new Promise(resolve => {
				session.context.document = document;
				++session.localPrerenderTransactionCount;
				session.prerenderCallback = (events, idle) => resolve({ sessionID: session.sessionID, events: events, idle: idle });
				session.run();
				if (--session.localPrerenderTransactionCount == 0) {
					session.sendPrerender();
				}
			}).then(data => {
				session.context.document = undefined;
				const bootstrapScript = document.createElement("script");
				bootstrapScript.type = "application/x-concurrence-bootstrap";
				bootstrapScript.appendChild(document.createTextNode(JSON.stringify(data)));
				clientScript.parentNode!.insertBefore(bootstrapScript, clientScript);
				const serialized = dom.serialize();
				noCache(res);
				res.set("Content-Type", "text/html");
				res.send(serialized);
			}));
		}
		const serialized = dom.serialize();
		noCache(res);
		res.set("Content-Type", "text/html");
		res.send(serialized);
		resolve();
	}).catch(e => {
		res.status(500);
		res.set("Content-Type", "text/plain");
		res.send(util.inspect(e));
	});
});

server.post("/", function(req, res) {
	new Promise(resolve => {
		noCache(res);
		if (req.body.destroy) {
			// Forcefully clean up sessions
			host.destroySessionById(req.body.sessionID);
			res.set("Content-Type", "text/plain");
			res.send("");
			resolve();
		} else {
			// Process incoming events
			const body = req.body;
			const session = host.sessionById(body.sessionID, (body.messageID | 0) == 0);
			if (session.receiveMessage(body)) {
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
(server as any).ws("/", function(ws: any, req: express.Request) {
	try {
		const body = qs.parse(req.query);
		var messageId = body.messageID | 0;
		const session = host.sessionById(body.sessionID, messageId == 0);
		var closed = false;
		function processMessage(body: ConcurrenceMessage) {
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
		ws.on("message", function(msg: string) {
			processMessage({
				messageID: ++messageId,
				events: msg,
			});
		});
		ws.on("close", function() {
			closed = true;
		});
	} catch (e) {
		console.log(e);
		ws.close();
	}
});

server.use(express.static(relativePath("../public")));

server.listen(3000, function() {
	console.log("Listening on port 3000");
	(server as any).on("close", function() {
		host.destroy();
	});
});
