import * as path from "path";
import * as fs from "fs";
import * as util from "util";

import * as vm from "vm";

import * as express from "express";
import * as bodyParser from "body-parser";
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

const resolvedPromise: PromiseLike<void> = Promise.resolve();

function defer() : PromiseLike<void>;
function defer<T>() : PromiseLike<T>;
function defer(value?: any) : PromiseLike<any> {
	return new Promise<any>(resolve => setImmediate(resolve.bind(null, value)));
}

function escape(e: any) {
	setImmediate(() => {
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

function eventForValue(channelId: number, value: ConcurrenceJsonValue | void) : ConcurrenceEvent {
	return typeof value == "undefined" ? [channelId] : [channelId, roundTrip(value)];
}

function eventForException(channelId: number, error: any) : ConcurrenceEvent {
	// Serialize the reject error type or string
	let type: number | string = 1;
	let serializedError = error;
	if (error instanceof Error) {
		// Convert Error types to a representation that can be reconstituted on the client
		type = error.constructor.name;
		serializedError = Object.assign({ message: error.message, stack: error.stack }, error);
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
		const ErrorType : typeof Error = (self as any)[type] || Error;
		const error : Error = new ErrorType(value.message);
		delete value.message;
		return reject(Object.assign(error, value));
	}
	return reject(value);
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

const enum ConcurrenceSandboxMode {
	Simple = 0,
	Full = 1,
};

const sandboxMode: ConcurrenceSandboxMode = ConcurrenceSandboxMode.Full;

interface ConcurrenceSandboxContext {
	self: ConcurrenceSandboxContext,
	global: NodeJS.Global,
	require: (name: string) => any,
	document: Document,
	request: Express.Request,
	concurrence: any
};

class ConcurrenceHost {
	sessions: { [key: string]: ConcurrenceSession; } = {};
	sandbox: (context: ConcurrenceSandboxContext) => void;
	htmlSource: string;
	dom: JSDOM;
	document: Document;
	staleSessionTimeout: any;
	constructor(scriptPath: string, htmlPath: string) {
		const serverScript = fs.readFileSync(scriptPath).toString();
		if (sandboxMode == ConcurrenceSandboxMode.Simple) {
			// Full sandboxing, creating a new global context each time
			const vmScript = new vm.Script(serverScript, {
				filename: scriptPath
			});
			this.sandbox = vmScript.runInNewContext.bind(vmScript) as (context: ConcurrenceSandboxContext) => void;
		} else {
			// Simple sandboxing, relying on function scope
			const context = {
				app: (context: ConcurrenceSandboxContext) => {
				},
			};
			vm.runInNewContext("function app(self){with(self){return(function(self,global,require,document,request,concurrence){" + serverScript + "\n})(self,self.global,self.require,self.document,self.request,self.concurrence)}}", context, {
				filename: scriptPath
			});
			this.sandbox = context.app;
			delete context.app;
		}
		this.dom = new JSDOM(fs.readFileSync(htmlPath).toString());
		this.document = (this.dom.window as Window).document as Document;
		patchJSDOM(this.document);
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (let i in this.sessions) {
				if (Object.hasOwnProperty.call(this.sessions, i)) {
					if (now - this.sessions[i].lastMessageTime > 5 * 60 * 1000) {
						this.sessions[i].destroy();
					}
				}
			}
		}, 60 * 1000);
	}
	sessionFromId(sessionID: string, request?: Express.Request) {
		let session = this.sessions[sessionID];
		if (!session) {
			if (!sessionID) {
				throw new Error("No session ID specified!");
			}
			if (!request) {
				throw new Error("Session ID is not valid: " + sessionID);
			}
			session = new ConcurrenceSession(this, sessionID, request);
			this.sessions[sessionID] = session;
		}
		return session;
	}
	clientFromMessage(message: ConcurrenceClientMessage, request: Express.Request) {
		const allowCreation = message.messageID == 0;
		const session = this.sessionFromId(message.sessionID || "", allowCreation ? request : undefined);
		let client = session.clients[message.clientID as number | 0];
		if (!client) {
			if (!allowCreation) {
				throw new Error("Message ID is not valid: " + message.messageID);
			}
			client = session.newClient();
		}
		return client;
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
	newClient(request: Express.Request) {
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions[sessionID]) {
				const session = this.sessions[sessionID] = new ConcurrenceSession(this, sessionID, request);
				return session.newClient();
			}
		}
	}
	destroyClientById(sessionID: string, clientID: number) {
		const session = this.sessions[sessionID];
		if (session) {
			const client = session.clients[clientID];
			if (client) {
				client.destroy();
			}
		}
	}
	destroy() {
		for (let i in this.sessions) {
			if (Object.hasOwnProperty.call(this.sessions, i)) {
				this.sessions[i].destroy();
			}
		}
		clearInterval(this.staleSessionTimeout);
	}
}

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
	allEvents?: ConcurrenceEvent[];
}

const enum ConcurrenceRenderingMode {
	ClientOnly = 0,
	Prerendering = 1,
	FullEmulation = 2,
	ForcedEmulation = 3,
};

interface BootstrapData {
	sessionID: string;
	clientID?: number;
	events?: ConcurrenceEvent[];
	multiple?: true;
}

const renderingMode : ConcurrenceRenderingMode = ConcurrenceRenderingMode.Prerendering;
const allowMultipleClientsPerSession = false;

class ConcurrencePageRenderer {
	session: ConcurrenceSession;
	body: Element;
	clientScript: Element;
	bootstrapScript: Element | undefined;
	formNode: Element | undefined;
	messageIdInput: HTMLInputElement | undefined;
	channelCount: number = 0;
	pageIsReady: PromiseLike<void> | undefined;
	resolvePageIsReady: (() => void) | undefined;
	constructor(session: ConcurrenceSession) {
		this.session = session;
		const document = session.host.document;
		this.body = document.body.cloneNode(true) as Element;
		const clientScript = this.body.querySelector("script[src=\"client.js\"]");
		if (!clientScript) {
			throw new Error("HTML does not contain a client.js reference: " + this.body.outerHTML);
		}
		this.clientScript = clientScript;
		if (renderingMode >= ConcurrenceRenderingMode.ForcedEmulation) {
			clientScript.parentElement!.removeChild(clientScript);
		} else if (renderingMode >= ConcurrenceRenderingMode.Prerendering) {
			const bootstrapScript = this.bootstrapScript = document.createElement("script");
			bootstrapScript.type = "application/x-concurrence-bootstrap";
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
	enterChannel() {
		++this.channelCount;
	}
	exitChannel() {
		if (--this.channelCount == 0) {
			defer().then(() => {
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
			resolve();
		}
	}
	render() : PromiseLike<void> {
		if (this.channelCount == 0) {
			return resolvedPromise;
		}
		return this.pageIsReady || (this.pageIsReady = this.pageIsReady = new Promise<void>(resolve => this.resolvePageIsReady = resolve));
	}
	generateHTML(client: ConcurrenceClient) {
		const session = this.session;
		const bootstrapScript = this.bootstrapScript;
		let textNode: Node | undefined;
		if (bootstrapScript) {
			const bootstrapData: BootstrapData = { sessionID: this.session.sessionID };
			const queuedLocalEvents = client.queuedLocalEvents;
			if (queuedLocalEvents) {
				client.queuedLocalEvents = undefined;
				bootstrapData.events = queuedLocalEvents;
			}
			if (client.clientID) {
				bootstrapData.clientID = client.clientID;
			}
			if (session.allEvents) {
				bootstrapData.multiple = true;
			}
			textNode = session.host.document.createTextNode(compatibleStringify(bootstrapData));
			bootstrapScript.appendChild(textNode);
			this.clientScript.parentNode!.insertBefore(bootstrapScript, this.clientScript);
		}
		const messageIdInput = this.messageIdInput;
		if (messageIdInput) {
			messageIdInput.setAttribute("value", (++client.incomingMessageId).toString());
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
				if (textNode) {
					bootstrapScript.removeChild(textNode);
				}
			}
		}
	}
}

class ConcurrenceClient {
	session: ConcurrenceSession;
	clientID: number;
	incomingMessageId: number = 0;
	outgoingMessageId: number = 0;
	reorderedMessages: { [messageId: number]: ConcurrenceClientMessage } = {};
	queuedLocalEvents: ConcurrenceEvent[] | undefined;
	queuedLocalEventsResolve: ((shouldContinue: true | void) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	willSynchronizeChannels = false;

	constructor(session: ConcurrenceSession, clientID: number, startingEvents?: ConcurrenceEvent[]) {
		this.session = session;
		this.clientID = clientID;
		this.queuedLocalEvents = startingEvents;
	}

	destroy = () => {
		this.synchronizeChannels();
		delete this.session.clients[this.clientID];
		// Destroy the session if we were the last client
		for (const client of this.session.clients) {
			if (client) {
				return;
			}
		}
		this.session.destroy();
	}

	processMessage(message: ConcurrenceClientMessage) : PromiseLike<void> {
		// Process messages in order
		const messageId = message.messageID;
		if (messageId > this.incomingMessageId) {
			// Message was received out of order, queue it for later
			this.reorderedMessages[messageId] = message;
			return Promise.resolve();
		}
		if (messageId < this.incomingMessageId) {
			return Promise.resolve();
		}
		const allEvents = message.allEvents;
		if (allEvents) {
			this.session.allEvents = allEvents;
		}
		this.incomingMessageId++;
		this.willSynchronizeChannels = true;
		const result = this.session.processEvents(message.events || []).then(() => {
			const reorderedMessage = this.reorderedMessages[this.incomingMessageId];
			if (reorderedMessage) {
				delete this.reorderedMessages[this.incomingMessageId];
				return this.processMessage(reorderedMessage);
			}
		}).then(escaping(this.synchronizeChannels));
		// Destroy if asked to by client
		return message.destroy ? result.then(escaping(this.destroy)) : result;
	}

	receiveMessage(message: ConcurrenceClientMessage) {
		this.session.lastMessageTime = Date.now();
		return this.processMessage(message);
	}

	produceMessage() : Partial<ConcurrenceServerMessage> {
		const result: Partial<ConcurrenceServerMessage> = { messageID: this.outgoingMessageId++ };
		if (this.queuedLocalEvents) {
			result.events = this.queuedLocalEvents;
			this.queuedLocalEvents = undefined;
		}
		return result;
	}

	dequeueEvents() : PromiseLike<true | void> {
		return new Promise<true | void>((resolve, reject) => {
			// Wait until events are ready, a new event handler comes in, or no more local channels exist
			const oldResolve = this.queuedLocalEventsResolve;
			if (this.queuedLocalEvents) {
				if (oldResolve) {
					this.queuedLocalEventsResolve = resolve;
					oldResolve(true);
				} else {
					resolve(true);
					return;
				}
			} else if (this.session.localChannelCount || this.session.allEvents) {
				this.queuedLocalEventsResolve = resolve;
				if (oldResolve) {
					oldResolve(undefined);
				}
			} else {
				resolve(undefined);
				return;
			}
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
			}
			this.localResolveTimeout = setTimeout(resolve, 30000);
		});
	}

	sendClientEvent(event: ConcurrenceEvent) {
		// Queue an event
		const queuedLocalEvents = this.queuedLocalEvents;
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			this.queuedLocalEvents = [event];
		}
		this.scheduleSynchronize();
	}

	synchronizeChannels = () => {
		this.willSynchronizeChannels = false;
		const resolve = this.queuedLocalEventsResolve;
		if (resolve) {
			this.queuedLocalEventsResolve = undefined;
			resolve(true);
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
				this.localResolveTimeout = undefined;
			}
		}
		this.session.destroyIfExhausted();
	}

	scheduleSynchronize() {
		if (!this.willSynchronizeChannels) {
			this.willSynchronizeChannels = true;
			defer().then(escaping(this.synchronizeChannels));
		}
	}
}

class ConcurrenceSession {
	host: ConcurrenceHost;
	sessionID: string;
	dead: boolean = false;
	sendWhenDisconnected: () => void | undefined;
	lastMessageTime: number = Date.now();
	localChannelCounter: number = 0;
	localChannelCount: number = 0;
	remoteChannelCounter: number = 0;
	pendingChannels: { [channelId: number]: (event?: ConcurrenceEvent) => void; } = {};
	pendingChannelCount: number = 0;
	dispatchingEvent: number = 0;
	dispatchingAPIImplementation: number = 0;
	context: ConcurrenceSandboxContext;
	pageRenderer: ConcurrencePageRenderer;
	currentEvents: ConcurrenceEvent[] | undefined;
	hadOpenServerChannel: boolean = false;
	hasRun: boolean = false;
	clients: (ConcurrenceClient | undefined)[] = [];
	allEvents: ConcurrenceEvent[] | undefined;
	constructor(host: ConcurrenceHost, sessionID: string, request: Express.Request) {
		this.host = host;
		this.sessionID = sessionID;
		this.pageRenderer = new ConcurrencePageRenderer(this);
		// Server-side version of the API
		const context = Object.create(global) as ConcurrenceSandboxContext;
		context.self = context;
		context.global = global;
		context.require = require;
		context.document = Object.create(this.host.document, {
			body: { value: this.pageRenderer.body }
		});
		context.request = request;
		context.concurrence = {
			disconnect: this.destroy,
			whenDisconnected: new Promise(resolve => this.sendWhenDisconnected = resolve),
			get insideCallback() {
				return this.insideCallback;
			},
			secrets: secrets,
			dead: false,
			createClientPromise: this.createClientPromise.bind(this),
			createServerPromise: this.createServerPromise.bind(this),
			createClientChannel: this.createClientChannel.bind(this),
			createServerChannel: this.createServerChannel.bind(this),
			coordinateValue: this.coordinateValue.bind(this),
			synchronize: () => this.createServerPromise(() => undefined),
			showDeterminismWarning: showDeterminismWarning
		};
		this.context = context;
		if (allowMultipleClientsPerSession) {
			this.allEvents = [];
		}
	}

	newClient() {
		const events = this.allEvents;
		const newClientId = this.clients.length;
		if (events || (newClientId == 0)) {
			const result = new ConcurrenceClient(this, newClientId, events);
			this.clients[newClientId] = result;
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}

	run() : PromiseLike<void> {
		if (this.hasRun) {
			return resolvedPromise;
		}
		this.hasRun = true;
		this.enteringCallback();
		return new Promise(resolve => resolve(host.sandbox(this.context)));
	}

	sendEvent(event: ConcurrenceEvent) {
		const allEvents = this.allEvents;
		if (allEvents) {
			allEvents.push(event);
		}
		for (const client of this.clients) {
			if (client) {
				client.sendClientEvent(event);
			}
		}
	}

	dispatchEvent(event: ConcurrenceEvent) {
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.sendEvent(this.allEvents ? event.slice() as ConcurrenceEvent : [channelId]);
			channelId = -channelId;
		}
		const channel = this.pendingChannels[channelId];
		if (channel) {
			logOrdering("client", "message", channelId, this);
			channel(event);
		} else {
			// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	processEvents(events: ConcurrenceEvent[]) : PromiseLike<void> {
		// Read each event and dispatch the appropriate event in order
		this.hadOpenServerChannel = this.localChannelCount != 0;
		this.currentEvents = events;
		return events.reduce((promise: PromiseLike<any>, event: ConcurrenceEvent) => promise.then(escaping(this.dispatchEvent.bind(this, event))).then(defer), this.run()).then(() => {
			this.currentEvents = undefined;
		});
	}

	scheduleSynchronize() {
		for (const client of this.clients) {
			if (client) {
				client.scheduleSynchronize();
			}
		}
	}

	enterLocalChannel(delayPageLoading: boolean = true) : number {
		if (delayPageLoading) {
			this.pageRenderer.enterChannel();
		}
		return ++this.localChannelCount;
	}
	exitLocalChannel(resumePageLoading: boolean = true) : number {
		if (resumePageLoading) {
			this.pageRenderer.exitChannel();
		}
		return --this.localChannelCount;
	}
	waitForEvents() {
		this.enterLocalChannel();
		return this.run().then(defer).then(escaping(this.exitLocalChannel.bind(this)));
	}
	get insideCallback() {
		return this.dispatchingEvent != 0 && this.dispatchingAPIImplementation == 0;
	}
	enteringCallback() {
		this.dispatchingEvent++;
		defer().then(() => this.dispatchingEvent--);
	}
	createServerPromise<T extends ConcurrenceJsonValue | void>(ask: () => (PromiseLike<T> | T), includedInPrerender: boolean = true): PromiseLike<T> {
		if (!this.insideCallback) {
			return new Promise(resolve => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		this.enterLocalChannel(includedInPrerender);
		const channelId = ++this.localChannelCounter;
		logOrdering("server", "open", channelId, this);
		this.dispatchingAPIImplementation++;
		let result: PromiseLike<T>;
		try {
			result = Promise.resolve(ask());
		} catch (e) {
			result = Promise.reject(e);
		}
		this.dispatchingAPIImplementation--;
		return result.then(value => {
			return resolvedPromise.then(escaping(() => this.sendEvent(eventForValue(channelId, value)))).then(() => {
				logOrdering("server", "message", channelId, this);
				logOrdering("server", "close", channelId, this);
				resolvedPromise.then(escaping(() => this.exitLocalChannel(includedInPrerender)));
				let roundtripped = roundTrip(value);
				this.enteringCallback();
				return roundtripped;
			});
		}, error => {
			return resolvedPromise.then(escaping(() => this.sendEvent(eventForException(channelId, error)))).then(() => {
				logOrdering("server", "message", channelId, this);
				logOrdering("server", "close", channelId, this);
				resolvedPromise.then(escaping(() => this.exitLocalChannel(includedInPrerender)));
				this.enteringCallback();
				return Promise.reject(error) as any as T;
			});
		});
	}
	createServerChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true): ConcurrenceChannel {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let state: U | undefined;
		if (!this.insideCallback) {
			// Not coordinating
			let open = true;
			try {
				const potentialState = onOpen(function() {
					if (!closed) {
						callback.apply(null, arguments);
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
			} catch (e) {
				onClose = undefined;
				escape(e);
			}
			return {
				channelId: -1,
				close() {
					if (open) {
						open = false;
						if (onClose) {
							session.dispatchingAPIImplementation++;
							escaping(onClose)(state as U);
							session.dispatchingAPIImplementation--;
						}
					}
				}
			};
		}
		// Record and ship arguments of server-side events
		const session = this;
		session.enterLocalChannel(includedInPrerender);
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this);
		try {
			this.dispatchingAPIImplementation++;
			const potentialState = onOpen(function() {
				if (channelId >= 0) {
					let args = roundTrip([...arguments]);
					resolvedPromise.then(escaping(() => session.sendEvent([channelId, ...roundTrip(args)] as ConcurrenceEvent))).then(() => {
						logOrdering("server", "message", channelId, session);
						session.enteringCallback();
						(callback as any as Function).apply(null, args)
					});
				}
			} as any as T);
			if (onClose) {
				state = potentialState
			}
			this.dispatchingAPIImplementation--;
		} catch (e) {
			this.dispatchingAPIImplementation--;
			onClose = undefined;
			escape(e);
		}
		return {
			channelId,
			close() {
				if (channelId >= 0) {
					logOrdering("server", "close", this.channelId, session);
					this.channelId = channelId = -1;
					resolvedPromise.then(escaping(() => {
						if (session.exitLocalChannel(includedInPrerender) == 0) {
							// If this was the last server channel, reevaluate queued events so the session can be potentially collected
							session.scheduleSynchronize();
						}
					}));
					if (onClose) {
						session.dispatchingAPIImplementation++;
						escaping(onClose)(state as U);
						session.dispatchingAPIImplementation--;
					}
				}
			}
		};
	}

	createRawClientChannel(callback: (event: ConcurrenceEvent | undefined) => void) : ConcurrenceChannel {
		const session = this;
		session.pendingChannelCount++;
		const channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this);
		this.pendingChannels[channelId] = callback;
		return {
			channelId,
			close() {
				if (session.pendingChannels[channelId]) {
					logOrdering("client", "close", this.channelId, session);
					delete session.pendingChannels[this.channelId];
					this.channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.scheduleSynchronize();
					}
				}
			}
		};
	}
	createClientPromise<T extends ConcurrenceJsonValue>() {
		return new Promise<T>((resolve, reject) => {
			if (!this.insideCallback) {
				return reject(new Error("Unable to create client promise in this context!"));
			}
			if (this.dead) {
				return reject(new Error("Session has been disconnected!"));
			}
			const channel = this.createRawClientChannel(event => {
				channel.close();
				this.enteringCallback();
				parseValueEvent(event, resolve as (value: ConcurrenceJsonValue) => void, reject);
			});
		});
	}
	createClientChannel<T extends Function>(callback: T): ConcurrenceChannel {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		if (!this.insideCallback) {
			throw new Error("Unable to create client channel in this context!");
		}
		const channel = this.createRawClientChannel(event => {
			if (event) {
				event.shift();
				this.enteringCallback();
				resolvedPromise.then(() => callback.apply(null, event));
			} else {
				channel.close();
			}
		});
		return channel;
	}

	coordinateValue<T extends ConcurrenceJsonValue>(generator: () => T) : T {
		if (!this.insideCallback) {
			return generator();
		}
		let value: T;
		let events = this.currentEvents;
		if (events && !this.hadOpenServerChannel && !this.allEvents) {
			let channelId = ++this.remoteChannelCounter;
			logOrdering("client", "open", channelId, this);
			// Peek at incoming events to find the value generated on the client
			for (let event of events) {
				if (event[0] == channelId) {
					return parseValueEvent(event, value => {
						logOrdering("client", "message", channelId, this);
						logOrdering("client", "close", channelId, this);
						return value;
					}, error => {
						logOrdering("client", "message", channelId, this);
						logOrdering("client", "close", channelId, this);
						throw error;
					}) as T;
				}
			}
			console.log("Expected a value from the client, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			value = generator();
			logOrdering("client", "message", channelId, this);
			logOrdering("client", "close", channelId, this);
		} else {
			let channelId = ++this.localChannelCounter;
			logOrdering("server", "open", channelId, this);
			try {
				value = generator();
				try {
					this.sendEvent(eventForValue(channelId, value));
				} catch(e) {
					escape(e);
				}
				logOrdering("server", "message", channelId, this);
				logOrdering("server", "close", channelId, this);
			} catch(e) {
				try {
					this.sendEvent(eventForException(channelId, e));
				} catch(e) {
					escape(e);
				}
				logOrdering("server", "message", channelId, this);
				logOrdering("server", "close", channelId, this);
				throw e;
			}
		}
		return roundTrip(value);
	}

	destroy = () => {
		if (!this.dead) {
			this.dead = true;
			this.context.concurrence.dead = true;
			for (let i in this.pendingChannels) {
				if (Object.hasOwnProperty.call(this.pendingChannels, i)) {
					this.pendingChannels[i]();
					delete this.pendingChannels[i];
				}
			}
			for (const client of this.clients) {
				if (client) {
					client.destroy();
				}
			}
			this.pageRenderer.destroy();
			delete this.host.sessions[this.sessionID];
			if (this.sendWhenDisconnected) {
				this.sendWhenDisconnected();
			}
		}
	}

	destroyIfExhausted() {
		// If no channels remain, the session is in a state where no more events
		// can be sent from either the client or server. Session can be destroyed
		if (this.pendingChannelCount + this.localChannelCount == 0) {
			this.destroy();
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

function messageFromBody(body: { [key: string]: any }) : ConcurrenceClientMessage {
	const message: ConcurrenceClientMessage = {
		sessionID: body.sessionID || "",
		messageID: (body.messageID as number) | 0,
		clientID: (body.clientID as number) | 0,
		events: body.events ? JSON.parse("[" + body.events + "]") : []
	}
	if (body.allEvents) {
		message.allEvents = JSON.parse("[" + body.allEvents + "]");
	}
	if ("close" in body) {
		message.close = (body.close | 0) == 1;
	}
	if ("destroy" in body) {
		message.destroy = true;
	}
	return message;
}

function messageFromSocket(messageText: string, defaultMessageID: number) : ConcurrenceClientMessage {
	const result = ((messageText.length == 0 || messageText[0] == "[") ? { events: JSON.parse("[" + messageText + "]") } : JSON.parse(messageText)) as ConcurrenceClientMessage;
	result.messageID = result.messageID | defaultMessageID;
	if (!result.events) {
		result.events = [];
	}
	return result;
}

function serializeMessage(message: Partial<ConcurrenceServerMessage>) : string {
	if ("events" in message && !("messageID" in message) && !("close" in message) && !("destroy" in message)) {
		// Only send events, if that's all we have to send
		return JSON.stringify(message.events).slice(1, -1);
	}
	return JSON.stringify(message);
}

server.get("/", (request, response) => {
	resolvedPromise.then(() => {
		const sessionID = request.query.sessionID;
		let session: ConcurrenceSession;
		let client: ConcurrenceClient;
		if (sessionID) {
			session = host.sessionFromId(sessionID, request);
			client = session.newClient();
		} else if (renderingMode < ConcurrenceRenderingMode.Prerendering) {
			return host.htmlSource;
		} else {
			client = host.newClient(request);
			session = client.session;
		}
		session.hadOpenServerChannel = true;
		if (renderingMode >= ConcurrenceRenderingMode.Prerendering) {
			return session.waitForEvents().then(() => {
				client.incomingMessageId++;
				client.outgoingMessageId++;
				return session.pageRenderer.render().then(() => session.pageRenderer.generateHTML(client));
			});
		} else {
			return session.pageRenderer.generateHTML(client);
		}
	}).then(html => {
		noCache(response);
		response.set("Content-Type", "text/html");
		response.send(html);
	}, e => {
		response.status(500);
		response.set("Content-Type", "text/plain");
		response.send(util.inspect(e));
	});
});

server.post("/", function(req, res) {
	new Promise(resolve => {
		noCache(res);
		const body = req.body;
		const message = messageFromBody(body);
		// Process incoming events
		if (renderingMode >= ConcurrenceRenderingMode.FullEmulation && req.query["js"] == "no") {
			const client = host.clientFromMessage(message, req);
			const session = client.session;
			const inputEvents: ConcurrenceEvent[] = [];
			const buttonEvents: ConcurrenceEvent[] = [];
			for (let key in body) {
				if (!Object.hasOwnProperty.call(body, key)) {
					continue;
				}
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
			message.events = message.events.concat(inputEvents.concat(buttonEvents));
			client.receiveMessage(message).then(session.waitForEvents.bind(session)).then(() => {
				return session.pageRenderer.render();
			}).then(() => {
				res.set("Content-Type", "text/html");
				res.send(session.pageRenderer.generateHTML(client));
			});
		} else {
			if (message.destroy) {
				host.destroyClientById(message.sessionID || "", message.clientID as number | 0);
			} else {
				const client = host.clientFromMessage(message, req);
				client.receiveMessage(message).then(() => client.dequeueEvents()).then(() => {
					// Wait to send the response until we have events ready or until there are no more server-side channels open
					res.set("Content-Type", "text/plain");
					res.send(serializeMessage(client.produceMessage()));
				});
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
		let closed = false;
		ws.on("error", function() {
			ws.close();
		});
		ws.on("close", function() {
			closed = true;
		});
		const startMessage = messageFromBody(req.query);
		const client = host.clientFromMessage(startMessage, req);
		let lastIncomingMessageId = startMessage.messageID;
		let lastOutgoingMessageId = -1;
		function processSocketMessage(message: ConcurrenceClientMessage) {
			if (typeof message.close == "boolean") {
				if (closed = message.close) {
					ws.close();
				}
			}
			resolvedPromise.then(() => client.receiveMessage(message)).then(processMoreEvents, e => {
				ws.close();
			});
		}
		let processingEvents = false;
		function processMoreEvents() {
			if (processingEvents || closed) {
				return;
			}
			processingEvents = true;
			client.dequeueEvents().then(keepGoing => {
				processingEvents = false;
				if (!closed) {
					const message = client.produceMessage();
					if (lastOutgoingMessageId == message.messageID) {
						delete message.messageID;
					}
					lastOutgoingMessageId = client.outgoingMessageId;
					if ((client.session.localChannelCount == 0 || !keepGoing) && !client.session.allEvents) {
						message.close = true;
						closed = true;
					} else {
						processMoreEvents();
					}
					ws.send(serializeMessage(message));
				}
			});
		}
		ws.on("message", function(msg: string) {
			const message = messageFromSocket(msg, lastIncomingMessageId + 1);
			lastIncomingMessageId = message.messageID;
			processSocketMessage(message);
		});
		processSocketMessage(startMessage);
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
