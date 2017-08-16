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

const readFile = (path: string) => fs.readFileSync(path).toString();

const secrets = JSON.parse(readFile(relativePath("../secrets.json")));

server.disable("x-powered-by");
server.disable("etag");

function showDeterminismWarning(deprecated: string, instead: string): void {
	console.log("Called " + deprecated + " which may result in split-brain!\nInstead use " + instead + " " + (new Error() as any).stack.split(/\n\s*/g).slice(3).join("\n\t"));
}

function logOrdering(from: "client" | "server", type: "open" | "close" | "message", channelId: number, session: ConcurrenceSession) {
	// const stack = (new Error().stack || "").toString().split(/\n\s*/).slice(2).map(s => s.replace(/^at\s*/, ""));
	// console.log(from + " " + type + " " + channelId + " on " + session.sessionID, stack);
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

function compatibleStringify(value: any): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\/script/g, "<\\/script");
}

const validateRoundTrips = true;

function roundTrip<T>(obj: T) : T {
	if (validateRoundTrips) {
		// Round-trip values through JSON so that the server receives exactly the same type of values as the client
		return typeof obj == "undefined" ? obj : JSON.parse(JSON.stringify([obj]))[0] as T;
	} else {
		return obj;
	}
}

let patchedJSDOM = false;
function patchJSDOM(document: Document) {
	if (!patchedJSDOM) {
		patchedJSDOM = true;
		const HTMLInputElementPrototype = document.createElement("input").constructor.prototype;
		const descriptor = Object.create(Object.getOwnPropertyDescriptor(HTMLInputElementPrototype, "value"));
		const oldSet = descriptor.set;
		descriptor.set = function(value: string) {
			oldSet.call(this, value);
			this.setAttribute("value", value);
		}
		Object.defineProperty(HTMLInputElementPrototype, "value", descriptor);
	}
}

class ConcurrenceHost {
	sessions: { [key: string]: ConcurrenceSession; } = {};
	script: vm.Script;
	htmlSource: string;
	dom: JSDOM;
	document: Document;
	staleSessionTimeout: any;
	constructor(scriptPath: string, htmlPath: string) {
		this.sessions = {};
		this.script = new vm.Script(fs.readFileSync(scriptPath).toString(), {
			filename: scriptPath
		});
		this.dom = new JSDOM(fs.readFileSync(htmlPath).toString());
		this.document = (this.dom.window as Window).document as Document;
		patchJSDOM(this.document);
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (let i in this.sessions) {
				if (this.sessions.hasOwnProperty(i)) {
					if (now - this.sessions[i].lastMessageTime > 5 * 60 * 1000) {
						this.sessions[i].destroy();
					}
				}
			}
		}, 60 * 1000);
	}
	sessionById(sessionID: string, newSessionFromRequest: Express.Request | undefined) {
		let session = this.sessions[sessionID];
		if (!session) {
			if (!sessionID) {
				throw new Error("No session ID specified!");
			}
			if (!newSessionFromRequest) {
				throw new Error("Session ID is not valid: " + sessionID);
			}
			session = new ConcurrenceSession(this, sessionID, newSessionFromRequest);
			this.sessions[sessionID] = session;
			session.run();
		}
		return session;
	}
	serializeBody(body: Element) {
		const realBody = this.document.body;
		const parent = realBody.parentElement!;
		parent.replaceChild(body, realBody);
		try {
			return this.dom.serialize();
		} finally {
			parent.replaceChild(realBody, body);
		}
	}
	newSession(request: Express.Request) {
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions[sessionID]) {
				return this.sessions[sessionID] = new ConcurrenceSession(this, sessionID, request);
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
		for (let i in this.sessions) {
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

const enum ConcurrenceRenderingMode {
	ClientOnly = 0,
	Prerendering = 1,
	FullEmulation = 2,
	ForcedEmulation = 3,
};

const renderingMode : ConcurrenceRenderingMode = ConcurrenceRenderingMode.ForcedEmulation;

class ConcurrencePageRenderer {
	session: ConcurrenceSession;
	body: Element;
	bootstrapScript: Element | undefined;
	formNode: Element | undefined;
	messageIdInput: HTMLInputElement | undefined;
	channelCount: number = 0;
	pageIsReady: Promise<string> | undefined;
	resolvePageIsReady: ((html: string) => void) | undefined;
	constructor(session: ConcurrenceSession) {
		this.session = session;
		const document = session.host.document;
		this.body = document.body.cloneNode(true) as Element;
		const clientScript = this.body.querySelector("script[src=\"client.js\"]");
		if (!clientScript) {
			throw new Error("HTML does not contain a client.js reference: " + this.body.outerHTML);
		}
		if (renderingMode >= ConcurrenceRenderingMode.ForcedEmulation) {
			clientScript.parentElement!.removeChild(clientScript);
		} else if (renderingMode >= ConcurrenceRenderingMode.Prerendering) {
			const bootstrapScript = this.bootstrapScript = document.createElement("script");
			bootstrapScript.type = "application/x-concurrence-bootstrap";
			clientScript.parentNode!.insertBefore(bootstrapScript, clientScript);
		}
		if (renderingMode >= ConcurrenceRenderingMode.FullEmulation) {
			const formNode = this.formNode = document.createElement("form");
			formNode.setAttribute("action", "?js=no");
			formNode.setAttribute("method", "POST");
			formNode.setAttribute("id", "concurrence-form");
			const sessionInput = document.createElement("input");
			sessionInput.setAttribute("name", "sessionID");
			sessionInput.setAttribute("type", "hidden");
			sessionInput.setAttribute("value", session.sessionID);
			formNode.appendChild(sessionInput);
			const messageIdInput = this.messageIdInput = document.createElement("input");
			messageIdInput.setAttribute("name", "messageID");
			messageIdInput.setAttribute("type", "hidden");
			formNode.appendChild(messageIdInput);
		}
	}
	enterLocalChannel() {
		++this.channelCount;
	}
	exitLocalChannel() {
		if (--this.channelCount == 0) {
			immediate(undefined).then(() => {
				if (this.channelCount == 0) {
					this.destroy();
				}
			});
		}
	}
	destroy() {
		const resolve = this.resolvePageIsReady;
		if (resolve) {
			this.resolvePageIsReady = undefined;
			this.pageIsReady = undefined;
			resolve(this.generateHTML());
			this.session.sendQueuedEvents();
		}
	}
	render() {
		if (this.channelCount == 0) {
			return Promise.resolve(this.generateHTML());
		}
		return this.pageIsReady || (this.pageIsReady = this.pageIsReady = new Promise<string>(resolve => this.resolvePageIsReady = resolve));
	}
	generateHTML() {
		const session = this.session;
		const bootstrapScript = this.bootstrapScript;
		if (bootstrapScript) {
			const queuedLocalEvents = session.queuedLocalEvents;
			session.queuedLocalEvents = undefined;
			bootstrapScript.appendChild(session.host.document.createTextNode(compatibleStringify({ sessionID: this.session.sessionID, events: queuedLocalEvents, idle: session.localChannelCount == 0 })))
		}
		const messageIdInput = this.messageIdInput;
		if (messageIdInput) {
			messageIdInput.setAttribute("value", (++session.incomingMessageId).toString());
		}
		const formNode = this.formNode;
		if (formNode) {
			migrateChildren(this.body, formNode);
			this.body.appendChild(formNode);
		}
		try {
			return session.host.serializeBody(this.body);
		} finally {
			if (formNode) {
				migrateChildren(formNode, this.body);
				this.body.removeChild(formNode);
			}
			if (bootstrapScript) {
				const parentElement = bootstrapScript.parentElement;
				if (parentElement) {
					parentElement.removeChild(bootstrapScript);
				}
				this.bootstrapScript = undefined;
			}
		}
	}
}

class ConcurrenceSession {
	host: ConcurrenceHost;
	sessionID: string;
	dead: boolean = false;
	lastMessageTime: number = Date.now();
	localChannelCounter: number = 0;
	localChannelCount: number = 0;
	localPrerenderChannelCount: number = 0;
	remoteChannelCounter: number = 0;
	pendingChannels: { [channelId: number]: (event: ConcurrenceEvent) => void; } = {};
	pendingChannelCount: number = 0;
	incomingMessageId: number = 0;
	reorderedMessages: ConcurrenceMessage[] = [];
	context: any;
	queuedLocalEvents: ConcurrenceEvent[] | undefined;
	queuedLocalEventsResolve: ((events: ConcurrenceEvent[] | undefined) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	pageRenderer: ConcurrencePageRenderer;
	constructor(host: ConcurrenceHost, sessionID: string, request: Express.Request) {
		this.host = host;
		this.sessionID = sessionID;
		this.pageRenderer = new ConcurrencePageRenderer(this);
		// Server-side version of the API
		const context = Object.create(global);
		context.self = context;
		context.global = global;
		context.require = require;
		context.document = Object.create(this.host.document, {
			body: { value: this.pageRenderer.body }
		});
		context.request = request;
		context.concurrence = {
			disconnect : this.destroy.bind(this),
			secrets: secrets,
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
		const messageId = (message.messageID as number) | 0;
		if (messageId > this.incomingMessageId) {
			return false;
		}
		if (messageId < this.incomingMessageId) {
			return true;
		}
		this.incomingMessageId++;
		// Read each event and dispatch the appropriate message in order
		const jsonEvents = message.events;
		if (jsonEvents) {
			const events = JSON.parse("[" + jsonEvents + "]");
			for (let i = 0; i < events.length; i++) {
				const event = events[i];
				const channelId = event[0];
				let channel;
				if (channelId < 0) {
					// Server decided the ordering on "fenced" events
					this.sendEvent([channelId]);
					channel = this.pendingChannels[-channelId];
				} else {
					// Regular client-side events are handled normally
					channel = this.pendingChannels[channelId];
				}
				if (channel) {
					channel(event);
				} else {
					// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
					// This event will be silently dropped--dispatching would cause split brain!
				}
			}
		}
		return true;
	}
	receiveMessage(message: ConcurrenceMessage) {
		this.lastMessageTime = Date.now();
		if (this.processMessage(message)) {
			// Process any messages we received out of order
			for (let i = 0; i < this.reorderedMessages.length; i++) {
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
			// Wait until events are ready, a new event handler comes in, or no more local channels exist
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
			} else if (this.localChannelCount) {
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
			// If no channels remain, the session is in a state where no more events
			// can be sent from either the client or server. Session can be destroyed
			if (this.pendingChannelCount + this.localChannelCount == 0) {
				this.destroy();
			}
		});
	}
	enterLocalChannel(delayPageLoading: boolean = true) : number {
		if (delayPageLoading) {
			this.pageRenderer.enterLocalChannel();
		}
		return ++this.localChannelCount;
	}
	exitLocalChannel(resumePageLoading: boolean = true) : number {
		if (resumePageLoading) {
			this.pageRenderer.exitLocalChannel();
		}
		return --this.localChannelCount;
	}
	waitForEvents() {
		this.enterLocalChannel();
		immediate(undefined).then(() => this.exitLocalChannel());
	}
	observeLocalPromise<T extends ConcurrenceJsonValue>(value: Promise<T> | T, includedInPrerender: boolean = true): Promise<T> {
		// Record and ship values/errors of server-side promises
		this.enterLocalChannel(includedInPrerender);
		const channelId = ++this.localChannelCounter;
		logOrdering("server", "open", channelId, this);
		return Promise.resolve(value).then(value => {
			// Forward the value to the client
			immediate(undefined).then(() => this.exitLocalChannel(includedInPrerender));
			logOrdering("server", "message", channelId, this);
			this.sendEvent(typeof value == "undefined" ? [channelId] : [channelId, roundTrip(value)]);
			logOrdering("server", "close", channelId, this);
			return roundTrip(value);
		}, error => {
			// Serialize the reject error type or string
			immediate(undefined).then(() => this.exitLocalChannel(includedInPrerender));
			let type: number | string = 1;
			let serializedError = error;
			if (error instanceof Error) {
				// Convert Error types to a representation that can be reconstituted on the client
				type = error.constructor.name;
				serializedError = Object.assign({ message: error.message, stack: error.stack }, error);
			}
			logOrdering("server", "message", channelId, this);
			this.sendEvent([channelId, serializedError, type]);
			logOrdering("server", "close", channelId, this);
			return error;
		});
	}
	observeLocalEventCallback<T extends Function>(callback: T, includedInPrerender: boolean = true): ConcurrenceLocalChannel<T> {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		// Record and ship arguments of server-side events
		const session = this;
		session.enterLocalChannel(includedInPrerender);
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this);
		return {
			channelId,
			send: function() {
				if (channelId >= 0) {
					let args = [...arguments];
					setImmediate(() => {
						logOrdering("server", "message", channelId, session);
						(callback as any as Function).apply(null, roundTrip(args));
					});
					if (!session.dead) {
						session.sendEvent([channelId, ...roundTrip(args)] as ConcurrenceEvent);
					}
				}
			} as any as T,
			close() {
				if (this.channelId >= 0) {
					logOrdering("server", "close", this.channelId, session);
					this.channelId = -1;
					channelId = -1;
					if (session.exitLocalChannel(includedInPrerender) == 0) {
						// If this was the last server channel, reevaluate queued events so the session can be potentially collected
						session.sendQueuedEvents();
					}
				}
			}
		};
	}

	registerRemoteChannel(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceChannel {
		if (this.dead) {
			throw new Error("Session has died!");
		}
		const session = this;
		session.pendingChannelCount++;
		const channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this);
		// this.pendingChannels[channelId] = callback;
		session.pendingChannels[channelId] = function() {
			immediate([].slice.call(arguments)).then(args => {
				logOrdering("client", "message", channelId, session);
				callback.apply(null, args);
			});
		};
		return {
			channelId,
			close() {
				if (session.pendingChannels[channelId]) {
					logOrdering("client", "close", this.channelId, session);
					delete session.pendingChannels[this.channelId];
					this.channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.sendQueuedEvents();
					}
				}
			}
		};
	}
	receiveRemotePromise<T extends ConcurrenceJsonValue>() {
		return new Promise<T>((resolve, reject) => {
			const channel = this.registerRemoteChannel(event => {
				channel.close();
				if (!event) {
					reject(new Error("Disconnected from client!"));
				} else {
					let value : any = event[1];
					const type = event[2];
					if (type) {
						// Convert serialized representation into the appropriate Error type
						if (type != 1 && /Error$/.test(type)) {
							const ErrorType : typeof Error = (self as any)[type] || Error;
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
	receiveRemoteEventStream<T extends Function>(callback: T): ConcurrenceChannel {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		const channel = this.registerRemoteChannel(function(event) {
			if (event) {
				event.shift();
				callback.apply(null, event);
			} else {
				channel.close();
			}
		});
		return channel;
	}

	destroy() {
		if (!this.dead) {
			this.dead = true;
			this.context.concurrence.dead = true;
			this.pageRenderer.destroy();
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

const host = new ConcurrenceHost(relativePath("server.js"), relativePath("../public/index.html"));

server.use(bodyParser.urlencoded({
	extended: true,
	type: () => true // Accept all MIME types
}));

function migrateChildren(fromNode: Node, toNode: Node) {
	let firstChild: Node | null;
	while (firstChild = fromNode.firstChild) {
		toNode.appendChild(firstChild);
	}
}

if (renderingMode >= ConcurrenceRenderingMode.Prerendering) {
	server.get("/", (req, res) => {
		new Promise<string>(resolve => {
			const session = host.newSession(req);
			session.run();
			session.waitForEvents();
			session.incomingMessageId++;
			resolve(session.pageRenderer.render());
		}).then(html => {
			noCache(res);
			res.set("Content-Type", "text/html");
			res.send(html);
		}).catch(e => {
			res.status(500);
			res.set("Content-Type", "text/plain");
			res.send(util.inspect(e));
		});
	});
}

server.post("/", function(req, res) {
	new Promise(resolve => {
		noCache(res);
		const body = req.body;
		if (body.destroy) {
			// Forcefully clean up sessions
			host.destroySessionById(req.body.sessionID);
			res.set("Content-Type", "text/plain");
			res.send("");
			resolve();
		} else {
			// Process incoming events
			const session = host.sessionById(body.sessionID, (body.messageID | 0) == 0 ? req : undefined);
			if (renderingMode >= ConcurrenceRenderingMode.FullEmulation && req.query["js"] == "no") {
				const inputEvents: ConcurrenceEvent[] = [];
				const buttonEvents: ConcurrenceEvent[] = [];
				for (let key in body) {
					const match = key.match(/^channelID(\d+)$/);
					if (match && Object.hasOwnProperty.call(body, key)) {
						const element = session.pageRenderer.body.querySelector("[name=\"" + key + "\"]");
						if (element) {
							const event: ConcurrenceEvent = [Number(match[1]), { value: body[key] }];
							switch (element.nodeName) {
								case "INPUT":
									if ((element as HTMLInputElement).value != body[key]) {
										inputEvents.unshift(event);
									}
									break;
								case "BUTTON":
									buttonEvents.unshift(event);
									break;
							}
						}
					}
				}
				body.events = JSON.stringify(inputEvents.concat(buttonEvents)).slice(1, -1);
				session.receiveMessage(body);
				session.waitForEvents();
				session.pageRenderer.render().then(html => {
					res.set("Content-Type", "text/html");
					res.send(html);
				});
			} else {
				if (session.receiveMessage(body)) {
					// Wait to send the response until we have events ready or until there are no more server-side channels open
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
		let messageId = body.messageID | 0;
		const session = host.sessionById(body.sessionID, (messageId == 0) ? req : undefined);
		let closed = false;
		function processBody(body: ConcurrenceMessage) {
			if (session.receiveMessage(body)) {
				session.dequeueEvents().then(events => {
					if (!closed) {
						ws.send(events && events.length ? JSON.stringify(events).slice(1, -1) : "");
					} else {
						session.destroy();
					}
				});
			} else {
				ws.close();
			}
		}
		processBody(body);
		ws.on("message", function(msg: string) {
			processBody({
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
