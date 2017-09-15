import * as path from "path";
import * as fs from "fs";
import * as rimrafAsync from "rimraf";
import * as util from "util";
const Module = require("module");

import * as express from "express";
import * as bodyParser from "body-parser";
const expressWs = require("express-ws");

import * as uuid from "uuid";
import { JSDOM } from "jsdom";

import { diff_match_patch } from "diff-match-patch";
const diff_match_patch_node = new (require("diff-match-patch-node") as typeof diff_match_patch);

import { JsonValue, JsonMap, Channel } from "mobius-types";
import { loadModule, SandboxModule } from "./sandbox";
import { interceptGlobals, roundTrip, FakedGlobals } from "../common/determinism";
import { logOrdering, eventForValue, eventForException, parseValueEvent, serializeMessageAsText, deserializeMessageFromText, disconnectedError, Event, ServerMessage, ClientMessage, BootstrapData } from "../common/_internal";

const server = express();

const relativePath = (relative: string) => path.join(__dirname, relative);

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const unlink = util.promisify(fs.unlink);
const stat = util.promisify(fs.stat);
const exists = (path: string) => new Promise<boolean>(resolve => fs.exists(path, resolve));
const rimraf = util.promisify(rimrafAsync);

server.disable("x-powered-by");
server.disable("etag");

const resolvedPromise: Promise<void> = Promise.resolve();

function defer() : Promise<void>;
function defer<T>() : Promise<T>;
function defer(value?: any) : Promise<any> {
	return new Promise<any>(resolve => setImmediate(resolve.bind(null, value)));
}

function delay(amount: number) {
	return new Promise<void>(resolve => setTimeout(resolve, amount));
}

const simulatedLatency: number = 0;

function escape(e: any) {
	setImmediate(() => {
		throw e;
	});
}

function escaping(handler: () => any | Promise<any>) : () => Promise<void>;
function escaping<T>(handler: (value: T) => any | Promise<any>) : (value: T) => Promise<T | void>;
function escaping(handler: (value?: any) => any | Promise<any>) : (value?: any) => Promise<any> {
	return async (value?: any) => {
		try {
			return await handler(value);
		} catch(e) {
			escape(e);
		}
	};
}

function emptyFunction() {
}

function compatibleStringify(value: any): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\/script/g, "<\\/script");
}

let patchedJSDOM = false;
function patchJSDOM(document: Document) {
	// Make input.value = ... update the DOM attribute
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

interface MobiusGlobalProperties {
	document: Document,
	request: express.Request,
}

class Host {
	sessions = new Map<string, Session>();
	scriptPath: string;
	modulePaths: string[];
	htmlSource: string;
	dom: JSDOM;
	document: Document;
	staleSessionTimeout: any;
	secrets: JsonValue;
	renderingMode: RenderingMode = RenderingMode.ClientPreferred;
	constructor(scriptPath: string, modulePaths: string[], htmlPath: string, htmlSource: string, secrets: JsonValue) {
		this.secrets = secrets;
		this.htmlSource = htmlSource;
		this.dom = new JSDOM(htmlSource);
		this.document = (this.dom.window as Window).document as Document;
		this.scriptPath = scriptPath;
		this.modulePaths = modulePaths;
		patchJSDOM(this.document);
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (let session of this.sessions.values()) {
				if (now - session.lastMessageTime > 5 * 60 * 1000) {
					session.destroy().catch(escape);
				} else {
					session.archiveEvents(false).catch(escape);
				}
			}
		}, 10 * 1000);
	}
	async sessionFromId(sessionID: string, request?: express.Request) {
		let session = this.sessions.get(sessionID);
		if (session) {
			return session;
		}
		if (!sessionID) {
			throw new Error("No session ID specified!");
		}
		if (!request) {
			throw new Error("Session ID is not valid: " + sessionID);
		}
		if (allowMultipleClientsPerSession) {
			let archive;
			try {
				archive = await Session.readArchivedSession(this.pathForSessionId(sessionID));
			} catch (e) {
			}
			if (archive) {
				session = new Session(this, sessionID, request);
				this.sessions.set(sessionID, session);
				await session.restoreFromArchive(archive as ArchivedSession);
				return session;
			}
		}
		session = new Session(this, sessionID, request);
		this.sessions.set(sessionID, session);
		return session;
	}
	pathForSessionId(sessionId: string) {
		return "sessions/" + sessionId + ".json";
	}
	async clientFromMessage(message: ClientMessage, request: express.Request) {
		const allowCreation = message.messageID == 0;
		const session = await this.sessionFromId(message.sessionID || "", allowCreation ? request : undefined);
		let client = session.clients.get(message.clientID as number | 0);
		if (!client) {
			if (!allowCreation) {
				throw new Error("Message ID is not valid: " + message.messageID);
			}
			client = session.newClient(request);
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
	async newClient(request: express.Request, renderingMode?: RenderingMode) {
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions.has(sessionID) && (!allowMultipleClientsPerSession || !await exists(this.pathForSessionId(sessionID)))) {
				const session = new Session(this, sessionID, request);
				this.sessions.set(sessionID, session);
				return session.newClient(request, renderingMode);
			}
		}
	}
	async destroyClientById(sessionID: string, clientID: number) {
		const session = this.sessions.get(sessionID);
		if (session) {
			const client = session.clients.get(clientID);
			if (client) {
				await client.destroy();
			}
		}
	}
	async destroy() {
		clearInterval(this.staleSessionTimeout);
		const promises: Promise<void>[] = [];
		for (let session of this.sessions.values()) {
			promises.push(session.destroy());
		}
		await Promise.all(promises);
		await writeFile("sessions/.graceful", "");
	}
}

const enum RenderingMode {
	ClientPreferred = 0,
	Prerendering = 1,
	FullEmulation = 2,
	ForcedEmulation = 3,
};

const allowMultipleClientsPerSession = true;

class PageRenderer {
	session: Session;
	body: Element;
	clientScript: HTMLScriptElement;
	bootstrapScript?: HTMLScriptElement;
	formNode?: HTMLFormElement;
	postbackInput?: HTMLInputElement;
	sessionIdInput?: HTMLInputElement;
	clientIdInput?: HTMLInputElement;
	messageIdInput?: HTMLInputElement;
	hasServerChannelsInput?: HTMLInputElement;
	channelCount: number = 0;
	pageIsReady?: Promise<void>;
	resolvePageIsReady?: () => void;
	constructor(session: Session) {
		this.session = session;
		this.body = session.host.document.body.cloneNode(true) as Element;
		const clientScript = this.body.querySelector("script[src=\"client.js\"]") as HTMLScriptElement | null;
		if (!clientScript) {
			throw new Error("HTML does not contain a client.js reference: " + this.body.outerHTML);
		}
		this.clientScript = clientScript;
	}
	enterChannel() {
		++this.channelCount;
	}
	async exitChannel() {
		if (--this.channelCount == 0) {
			await defer();
			if (this.channelCount == 0) {
				this.completeRender();
			}
		}
	}
	completeRender() {
		const resolve = this.resolvePageIsReady;
		if (resolve) {
			this.resolvePageIsReady = undefined;
			this.pageIsReady = undefined;
			resolve();
		}
	}
	render() : Promise<void> {
		this.session.enterLocalChannel();
		this.session.run();
		defer().then(() => this.session.exitLocalChannel());
		if (this.channelCount != 0) {
			return this.pageIsReady || (this.pageIsReady = new Promise<void>(resolve => this.resolvePageIsReady = resolve));
		}
		return resolvedPromise;
	}
	async generateHTML(client: Client, justFormElement: boolean = false) : Promise<string> {
		const renderingMode = client.renderingMode;
		const session = this.session;
		const document = session.host.document;
		let bootstrapScript: HTMLScriptElement | undefined;
		let textNode: Node | undefined;
		let formNode: HTMLFormElement | undefined;
		let postbackInput: HTMLInputElement | undefined;
		let sessionIdInput: HTMLInputElement | undefined;
		let clientIdInput: HTMLInputElement | undefined;
		let messageIdInput: HTMLInputElement | undefined;
		let hasServerChannelsInput: HTMLInputElement | undefined;
		let siblingNode: Node | null = null;
		// Bootstrap script for prerendering/session restoration
		if ((renderingMode == RenderingMode.Prerendering) || client.clientID) {
			bootstrapScript = this.bootstrapScript;
			if (!bootstrapScript) {
				bootstrapScript = this.bootstrapScript = document.createElement("script");
				bootstrapScript.type = "application/x-mobius-bootstrap";
			}
			const events = await session.readAllEvents();
			const bootstrapData: BootstrapData = { sessionID: session.sessionID, channels: Array.from(session.pendingChannels.keys()) };
			const queuedLocalEvents = events || client.queuedLocalEvents;
			if (queuedLocalEvents) {
				client.queuedLocalEvents = undefined;
				bootstrapData.events = queuedLocalEvents;
			}
			if (client.clientID) {
				bootstrapData.clientID = client.clientID;
			}
			textNode = document.createTextNode(compatibleStringify(bootstrapData));
			bootstrapScript.appendChild(textNode);
			this.clientScript.parentNode!.insertBefore(bootstrapScript, this.clientScript);
		}
		// Hidden form elements for no-script fallback
		if (renderingMode >= RenderingMode.FullEmulation) {
			formNode = this.formNode;
			if (!formNode) {
				formNode = this.formNode = document.createElement("form");
				formNode.setAttribute("action", "?");
				formNode.setAttribute("method", "POST");
				formNode.setAttribute("id", "mobius-form");
			}
			postbackInput = this.postbackInput;
			if (!postbackInput) {
				postbackInput = this.postbackInput = document.createElement("input");
				postbackInput.setAttribute("name", "postback");
				postbackInput.setAttribute("type", "hidden");
				postbackInput.setAttribute("value", "form");
			}
			formNode.appendChild(postbackInput);
			sessionIdInput = this.sessionIdInput;
			if (!sessionIdInput) {
				sessionIdInput = this.sessionIdInput = document.createElement("input");
				sessionIdInput.setAttribute("name", "sessionID");
				sessionIdInput.setAttribute("type", "hidden");
				sessionIdInput.setAttribute("value", session.sessionID);
			}
			formNode.appendChild(sessionIdInput);
			clientIdInput = this.clientIdInput;
			if (!clientIdInput) {
				clientIdInput = this.clientIdInput = document.createElement("input");
				clientIdInput.setAttribute("name", "clientID");
				clientIdInput.setAttribute("type", "hidden");
			}
			clientIdInput.setAttribute("value", client.clientID.toString());
			formNode.appendChild(clientIdInput);
			messageIdInput = this.messageIdInput;
			if (!messageIdInput) {
				messageIdInput = this.messageIdInput = document.createElement("input");
				messageIdInput.setAttribute("name", "messageID");
				messageIdInput.setAttribute("type", "hidden");
			}
			messageIdInput.setAttribute("value", client.incomingMessageId.toString());
			formNode.appendChild(messageIdInput);
			hasServerChannelsInput = this.hasServerChannelsInput;
			if (!hasServerChannelsInput) {
				hasServerChannelsInput = this.hasServerChannelsInput = document.createElement("input");
				hasServerChannelsInput.setAttribute("name", "hasServerChannels");
				hasServerChannelsInput.setAttribute("type", "hidden");
			}
			hasServerChannelsInput.setAttribute("value", session.localChannelCount ? "1" : "");
			formNode.appendChild(hasServerChannelsInput);
			migrateChildren(this.body, formNode);
			this.body.appendChild(formNode);
		}
		if (renderingMode >= RenderingMode.ForcedEmulation) {
			if (justFormElement) {
				siblingNode = document.createTextNode("");
				this.clientScript.parentNode!.insertBefore(siblingNode, this.clientScript);
				this.clientScript.parentNode!.removeChild(this.clientScript);
			} else {
				this.clientScript.src = "fallback.js";
			}
		}
		try {
			if (justFormElement && formNode) {
				return formNode.outerHTML;
			} else {
				return session.host.serializeBody(this.body);
			}
		} finally {
			if (renderingMode >= RenderingMode.FullEmulation && formNode) {
				if (formNode) {
					if (postbackInput) {
						formNode.removeChild(postbackInput);
					}
					if (sessionIdInput) {
						formNode.removeChild(sessionIdInput);
					}
					if (clientIdInput) {
						formNode.removeChild(clientIdInput);
					}
					if (messageIdInput) {
						formNode.removeChild(messageIdInput);
					}
					if (hasServerChannelsInput) {
						formNode.removeChild(hasServerChannelsInput);
					}
					migrateChildren(formNode, this.body);
					this.body.removeChild(formNode);
				}
			}
			if ((renderingMode == RenderingMode.Prerendering) || client.clientID) {
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
			if (client.renderingMode >= RenderingMode.ForcedEmulation) {
				if (siblingNode) {
					siblingNode.parentNode!.insertBefore(this.clientScript, siblingNode);
					siblingNode.parentNode!.removeChild(siblingNode);
				} else {
					this.clientScript.src = "client.js";
				}
			}
		}
	}
}

class Client {
	session: Session;
	clientID: number;
	renderingMode: RenderingMode;
	incomingMessageId: number = 0;
	outgoingMessageId: number = 0;
	reorderedMessages: { [messageId: number]: ClientMessage } = {};
	queuedLocalEvents: Event[] | undefined;
	queuedLocalEventsResolve: ((shouldContinue: true | void) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	willSynchronizeChannels = false;
	lastSentFormHTML?: string;

	constructor(session: Session, clientID: number, renderingMode: RenderingMode) {
		this.session = session;
		this.clientID = clientID;
		this.renderingMode = renderingMode;
	}

	static requestRequiresForcedEmulation(request: express.Request) : boolean {
		const userAgent = request.headers['user-agent']+"";
		return /\bMSIE [1-8]\b/.test(userAgent);
	}

	async destroy() {
		this.session.clients.delete(this.clientID);
		if (this.queuedLocalEventsResolve) {
			this.queuedLocalEventsResolve(undefined);
		}
		this.synchronizeChannels();
		// Destroy the session if we were the last client
		if (this.session.clients.size == 0) {
			await this.session.destroy();
		}
	}

	async processMessage(message: ClientMessage) : Promise<void> {
		// Process messages in order
		const messageId = message.messageID;
		if (messageId > this.incomingMessageId) {
			// Message was received out of order, queue it for later
			this.reorderedMessages[messageId] = message;
			return;
		}
		if (messageId < this.incomingMessageId) {
			return;
		}
		this.incomingMessageId++;
		this.willSynchronizeChannels = true;
		await this.session.processEvents(message.events || [], message.noJavaScript);
		const reorderedMessage = this.reorderedMessages[this.incomingMessageId];
		if (reorderedMessage) {
			delete this.reorderedMessages[this.incomingMessageId];
			await this.processMessage(reorderedMessage);
		}
		this.synchronizeChannels();
		// Destroy if asked to by client
		if (message.destroy) {
			await this.destroy();
		}
	}

	receiveMessage(message: ClientMessage) : Promise<void> {
		this.session.lastMessageTime = Date.now();
		return this.processMessage(message);
	}

	produceMessage() : Partial<ServerMessage> {
		const result: Partial<ServerMessage> = { messageID: this.outgoingMessageId++ };
		if (this.queuedLocalEvents) {
			result.events = this.queuedLocalEvents;
			this.queuedLocalEvents = undefined;
		}
		return result;
	}

	dequeueEvents() : Promise<true | void> {
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
			} else if (this.session.localChannelCount || this.session.sharingEnabled) {
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

	sendEvent(event: Event) {
		// Queue an event
		const queuedLocalEvents = this.queuedLocalEvents;
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			this.queuedLocalEvents = [event];
		}
		this.scheduleSynchronize();
	}

	synchronizeChannels = escaping(() => {
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
		this.session.destroyIfExhausted().catch(escape);
	})

	scheduleSynchronize() {
		if (!this.willSynchronizeChannels) {
			this.willSynchronizeChannels = true;
			defer().then(this.synchronizeChannels);
		}
	}
}

interface ArchivedSession {
	events: (Event | boolean)[];
	channels: number[];
}

const enum ArchiveStatus {
	None = 0,
	Partial = 1,
	Full
};

interface MobiusModuleExports {
	insideCallback: boolean;
	dead: boolean;
	whenDisconnected: Promise<void>;
	disconnect(): void;
	flush() : void;
	synchronize() : Promise<void>;
	createClientPromise<T extends JsonValue | void>(...args: any[]): Promise<T>;
	createServerPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender?: boolean): Promise<T>;
	createClientChannel<T extends Function>(callback: T): Channel;
	createServerChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean): Channel;
	coordinateValue<T extends JsonValue>(generator: () => T) : T;
	shareSession() : Promise<string>;
	secrets: { [key: string]: any };
}

const bakedModules: { [moduleName: string]: (session: Session) => any } = {
	mobius: (session: Session) => session.mobius,
	request: (session: Session) => session.request,
	documet: (session: Session) => session.globalProperties.document,
};

class Session {
	host: Host;
	sessionID: string;
	dead: boolean = false;
	sendWhenDisconnected: () => void | undefined;
	// Script context
	modules = new Map<string, SandboxModule>();
	mobius: MobiusModuleExports;
	request: express.Request;
	hasRun: boolean = false;
	pageRenderer: PageRenderer;
	globalProperties: MobiusGlobalProperties & FakedGlobals;
	Math: typeof Math;
	clients = new Map<number, Client>();
	currentClientID: number = 0;
	lastMessageTime: number = Date.now();
	// Local channels
	localChannelCounter: number = 0;
	localChannels = new Map<number, (event?: Event) => void>();
	localChannelCount: number = 0;
	dispatchingAPIImplementation: number = 0;
	// Remote channels
	remoteChannelCounter: number = 0;
	pendingChannels = new Map<number, (event?: Event) => void>();
	pendingChannelCount: number = 0;
	dispatchingEvent: number = 0;
	// Incoming Events
	currentEvents: (Event | boolean)[] | undefined;
	hadOpenServerChannel: boolean = false;
	// Archival
	recentEvents?: (Event | boolean)[];
	archivingEvents?: Promise<void>;
	archiveStatus: ArchiveStatus = ArchiveStatus.None;
	bootstrappingChannels?: Set<number>;
	bootstrappingPromise?: Promise<void>;
	// Session sharing
	sharingEnabled?: true;
	constructor(host: Host, sessionID: string, request: express.Request) {
		this.host = host;
		this.sessionID = sessionID;
		this.pageRenderer = new PageRenderer(this);
		// Server-side version of the API
		const session = this;
		const createServerChannel = this.createServerChannel.bind(this);
		this.mobius = {
			disconnect: () => this.destroy().catch(escape),
			whenDisconnected: new Promise(resolve => this.sendWhenDisconnected = resolve),
			get insideCallback() {
				return session.insideCallback;
			},
			secrets: host.secrets as JsonMap,
			dead: false,
			createClientPromise: this.createClientPromise.bind(this),
			createServerPromise: this.createServerPromise.bind(this),
			createClientChannel: this.createClientChannel.bind(this),
			createServerChannel,
			coordinateValue: this.coordinateValue,
			synchronize: () => this.createServerPromise(() => undefined),
			flush: this.scheduleSynchronize.bind(this),
			shareSession: this.shareSession
		};
		this.request = request;
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: Object.create(this.host.document, { body: { value: this.pageRenderer.body } }),
			request: this.request
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, createServerChannel);
		if (allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	newClient(request: express.Request, renderingMode?: RenderingMode) {
		const newClientId = this.currentClientID++;
		if (this.sharingEnabled || (newClientId == 0)) {
			const result = new Client(this, newClientId, typeof renderingMode != "undefined" ? renderingMode : Client.requestRequiresForcedEmulation(request) ? RenderingMode.ForcedEmulation : this.host.renderingMode);
			this.clients.set(newClientId, result);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}

	hasCapableClient() {
		for (const client of this.clients) {
			if (client[1].renderingMode <= RenderingMode.Prerendering) {
				return true;
			}
		}
		return false;
	}

	loadModule(path: string, newModule: SandboxModule) {
		loadModule(path, newModule, this.globalProperties, (name: string) => {
			const bakedModule = bakedModules[name];
			if (bakedModule) {
				return bakedModule(this);
			}
			const modulePath = Module._findPath(name, newModule.paths, false);
			if (modulePath) {
				const existingModule = this.modules.get(modulePath);
				if (existingModule) {
					return existingModule.exports;
				}
				const subModule: SandboxModule = {
					exports: {},
					paths: newModule.paths
				};
				this.modules.set(modulePath, subModule);
				this.loadModule(modulePath, subModule);
				return subModule.exports;
			}
			return require(name);
		});
		return newModule;
	}

	// Async so that errors inside user code startup will log to console as unhandled promise rejection, but app will proceed
	async run() {
		if (!this.hasRun) {
			this.hasRun = true;
			this.enteringCallback();
			this.loadModule(this.host.scriptPath, {
				exports: {},
				paths: this.host.modulePaths
			});
		}
	}

	sendEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		for (const client of this.clients.values()) {
			client.sendEvent(event);
		}
	}

	dispatchClientEvent(event: Event) {
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.sendEvent(event);
			channelId = -channelId;
		} else {
			// Record the event ordering, but don't send to client as they've already processed it
			event[0] = -channelId;
			if (this.recentEvents) {
				this.recentEvents.push(event);
			}
		}
		const channel = this.pendingChannels.get(channelId);
		if (channel) {
			logOrdering("client", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	updateOpenServerChannelStatus(newValue: boolean) {
		if (this.hadOpenServerChannel != newValue) {
			this.hadOpenServerChannel = newValue;
			if (this.recentEvents) {
				this.recentEvents.push(newValue);
			}
		}
	}

	async processEvents(events: Event[], noJavaScript?: boolean) : Promise<void> {
		// Read each event and dispatch the appropriate event in order
		this.updateOpenServerChannelStatus(noJavaScript ? true : (this.localChannelCount != 0));
		this.currentEvents = events;
		this.run();
		for (let event of events) {
			this.dispatchClientEvent(event);
			await defer();
		}
		this.updateOpenServerChannelStatus(this.localChannelCount != 0);
		this.currentEvents = undefined;
	}

	scheduleSynchronize() {
		for (const client of this.clients.values()) {
			client.scheduleSynchronize();
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
	shouldImplementLocalChannel(channelId: number) : boolean {
		return !this.bootstrappingChannels || this.bootstrappingChannels.has(channelId);
	}

	get insideCallback() {
		return this.dispatchingEvent != 0 && this.dispatchingAPIImplementation == 0;
	}
	async enteringCallback() {
		this.dispatchingEvent++;
		await defer();
		this.dispatchingEvent--;
	}
	createServerPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender: boolean = true): Promise<T> {
		if (!this.insideCallback) {
			return new Promise(resolve => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		let channelId = ++this.localChannelCounter;
		const exit = escaping(() => {
			if (channelId != -1) {
				channelId = -1;
				this.localChannels.delete(channelId);
				this.exitLocalChannel(includedInPrerender);
			}
		});
		return new Promise<T>((resolve, reject) => {
			logOrdering("server", "open", channelId, this.sessionID);
			this.enterLocalChannel(includedInPrerender);
			this.localChannels.set(channelId, (event?: Event) => {
				if (channelId >= 0) {
					if (event) {
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						resolvedPromise.then(exit);
						this.enteringCallback();
						parseValueEvent(global, event, resolve as (value: JsonValue) => void, reject);
					} else {
						logOrdering("server", "close", channelId, this.sessionID);
						exit();
					}
				}
			});
			if (!this.shouldImplementLocalChannel(channelId)) {
				return;
			}
			this.dispatchingAPIImplementation++;
			let result = new Promise<T>(resolve => resolve(ask()));
			this.dispatchingAPIImplementation--;
			result.then(async value => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(eventForValue(channelId, value));
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					const roundtripped = roundTrip(value);
					this.enteringCallback();
					resolve(roundtripped);
				}
			}, async error => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(eventForException(channelId, error));
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					this.enteringCallback();
					reject(error);
				}
			});
		});
	}
	createServerChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true): Channel {
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
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this.sessionID);
		session.enterLocalChannel(includedInPrerender);
		const close = () => {
			if (channelId >= 0) {
				logOrdering("server", "close", channelId, session.sessionID);
				session.localChannels.delete(channelId);
				channelId = -1;
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
		};
		session.localChannels.set(channelId, (event?: Event) => {
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				session.enteringCallback();
				(callback as any as Function).apply(null, roundTrip(event.slice(1)));
			} else {
				close();
			}
		});
		if (this.shouldImplementLocalChannel(channelId)) {
			try {
				this.dispatchingAPIImplementation++;
				const potentialState = onOpen(function() {
					if (channelId >= 0) {
						let args = roundTrip([...arguments]);
						(async () => {
							if (session.currentEvents) {
								if (session.bootstrappingPromise) {
									await session.bootstrappingPromise;
								}
								await defer();
							}
							try {
								session.updateOpenServerChannelStatus(true);
								session.sendEvent([channelId, ...roundTrip(args)] as Event);
							} catch (e) {
								escape(e);
							}
							logOrdering("server", "message", channelId, session.sessionID);
							session.enteringCallback();
							(callback as any as Function).apply(null, args);
						})();
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
				this.dispatchingAPIImplementation--;
			} catch (e) {
				this.dispatchingAPIImplementation--;
				onClose = undefined;
				escape(e);
			}
		} else {
			onClose = undefined;
		}
		return {
			channelId,
			close
		};
	}

	createRawClientChannel(callback: (event: Event | undefined) => void) : Channel {
		const session = this;
		session.pendingChannelCount++;
		let channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this.sessionID);
		this.pendingChannels.set(channelId, callback);
		return {
			channelId,
			close() {
				if (channelId != -1) {
					logOrdering("client", "close", channelId, session.sessionID);
					session.pendingChannels.delete(channelId);
					channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.scheduleSynchronize();
					}
				}
			}
		};
	}
	createClientPromise<T extends JsonValue | void>(fallback?: () => Promise<T> | T) {
		return new Promise<T>((resolve, reject) => {
			if (!this.insideCallback) {
				return reject(new Error("Unable to create client promise in this context!"));
			}
			if (this.dead) {
				return reject(disconnectedError());
			}
			const channel = this.createRawClientChannel(event => {
				this.enteringCallback();
				channel.close();
				if (event) {
					parseValueEvent(global, event, resolve as (value: JsonValue | void) => void, reject);
				} else {
					reject(disconnectedError());
				}
			});
			if (!this.hasCapableClient() && !this.bootstrappingPromise) {
				this.enterLocalChannel(true);
				this.dispatchingAPIImplementation++;
				const promise = fallback ? new Promise<T>(resolve => resolve(fallback())) : Promise.reject(new Error("Browser does not support client-side rendering!"))
				this.dispatchingAPIImplementation--;
				promise.then(async value => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForValue(-channel.channelId, value));
				}, async error => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForException(-channel.channelId, error));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	createClientChannel<T extends Function>(callback: T): Channel {
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

	findValueEvent(channelId: number) : Event | undefined {
		let events = this.currentEvents;
		if (events) {
			// Events are represented differently inside currentEvents depending on whether we're processing a client message or unarchiving
			// Makes more sense to handle the special case here than to transform the array just for this one case
			if (!this.bootstrappingChannels) {
				if (channelId >= 0) {
					return;
				}
				channelId = -channelId;
			}
			for (let event of events as Event[]) {
				if (event[0] == channelId) {
					return event;
				}
			}
		}
	}

	coordinateValue = <T extends JsonValue>(generator: () => T) => {
		if (!this.insideCallback) {
			return generator();
		}
		let value: T;
		if (!this.hadOpenServerChannel) {
			let channelId = ++this.remoteChannelCounter;
			logOrdering("client", "open", channelId, this.sessionID);
			// Peek at incoming events to find the value generated on the client
			const event = this.findValueEvent(-channelId);
			if (event) {
				logOrdering("client", "message", channelId, this.sessionID);
				logOrdering("client", "close", channelId, this.sessionID);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			console.log("Expected a value from the client, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			value = generator();
			logOrdering("client", "message", channelId, this.sessionID);
			logOrdering("client", "close", channelId, this.sessionID);
		} else {
			let channelId = ++this.localChannelCounter;
			logOrdering("server", "open", channelId, this.sessionID);
			const event = this.findValueEvent(channelId);
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				logOrdering("server", "close", channelId, this.sessionID);
				this.sendEvent(event);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			try {
				value = generator();
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(eventForValue(channelId, value));
				} catch(e) {
					escape(e);
				}
			} catch(e) {
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(eventForException(channelId, e));
				} catch(e) {
					escape(e);
				}
				throw e;
			}
		}
		return roundTrip(value) as T;
	}

	shareSession = async () => {
		// Server promise so that client can confirm that sharing is enabled
		const server = this.createServerPromise(async () => {
			if (!allowMultipleClientsPerSession) {
				throw new Error("Sharing has been disabled!");
			}
			this.sharingEnabled = true;
			const request: express.Request = this.request;
			return request.protocol + "://" + request.get("host") + request.url + "?sessionID=" + this.sessionID;
		});
		const result = await server;
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		return result;
	}

	async destroy() {
		if (!this.dead) {
			this.dead = true;
			this.mobius.dead = true;
			await this.archiveEvents(true);
			// await unlink(this.host.pathForSessionId(this.sessionID));
			for (const pair of this.pendingChannels) {
				pair[1]();
			}
			this.pendingChannels.clear();
			for (const pair of this.localChannels) {
				pair[1]();
			}
			this.localChannels.clear();
			this.pageRenderer.completeRender();
			for (const client of this.clients.values()) {
				await client.destroy();
			}
			this.host.sessions.delete(this.sessionID);
			if (this.sendWhenDisconnected) {
				this.sendWhenDisconnected();
			}
		}
	}

	async destroyIfExhausted() {
		// If no channels remain, the session is in a state where no more events
		// can be sent from either the client or server. Session can be destroyed
		if (this.pendingChannelCount + this.localChannelCount == 0) {
			await this.destroy();
		}
	}

	async archiveEvents(includeTrailer: boolean) : Promise<void> {
		// Can only archive if we're recording events
		if (!this.recentEvents || (!this.recentEvents.length && !includeTrailer)) {
			return;
		}
		// Only one archiver can run at a time
		while (this.archivingEvents) {
			await this.archivingEvents;
		}
		const recentEvents = this.recentEvents;
		if (recentEvents) {
			this.recentEvents = [];
		}
		// Actually archive
		await (this.archivingEvents = (async () => {
			// Determine where to write and whether or not this is a fresh session
			const path = this.host.pathForSessionId(this.sessionID);
			const freshFile = this.archiveStatus != ArchiveStatus.Partial || !(await exists(path));
			// Prepare events
			let unarchivedEvents: (Event | boolean)[] | undefined;
			if (this.archiveStatus == ArchiveStatus.Full) {
				try {
					unarchivedEvents = (await Session.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
				} catch (e) {
				}
			}
			const events = unarchivedEvents ? unarchivedEvents.concat(recentEvents || []) : (recentEvents || []);
			const serializedEvents = JSON.stringify(events);
			// Attempt to write as stream
			const stream = fs.createWriteStream(path, { flags: freshFile ? "w" : "a" });
			if (freshFile) {
				stream.write("{\"events\":");
				stream.write(serializedEvents.substring(0, serializedEvents.length - 1));
			} else if (events.length) {
				stream.write(",");
				stream.write(serializedEvents.substring(1, serializedEvents.length - 1));
			}
			// Include full trailer if required
			if (includeTrailer) {
				stream.write("],\"channels\":" + JSON.stringify(Array.from(this.localChannels.keys())) + "}");
			}
			stream.end();
			return stream;
		})().then(stream => new Promise<void>(resolve => {
			const finished = () => {
				this.archiveStatus = includeTrailer ? ArchiveStatus.Full : ArchiveStatus.Partial;
				delete this.archivingEvents;
				resolve();
			};
			stream.on("finish", finished);
			stream.on("error", () => {
				// Failed to write, put the events back
				this.recentEvents = recentEvents.concat(this.recentEvents || []);
				finished();
			});
		})));
	}

	static async readArchivedSession(path: string) : Promise<Partial<ArchivedSession>> {
		const rawContents = (await readFile(path)).toString();
		const validJSONContents = rawContents[rawContents.length - 1] == "}" ? rawContents : rawContents + "]}";
		return JSON.parse(validJSONContents) as Partial<ArchivedSession>;
	}

	async readAllEvents() : Promise<(Event | boolean)[] | undefined> {
		if (this.archiveStatus == ArchiveStatus.None) {
			return this.recentEvents;
		}
		let archivedEvents: (Event | boolean)[] | undefined;
		do {
			if (this.archivingEvents) {
				await this.archivingEvents;
			}
			archivedEvents = (await Session.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
		} while (this.archivingEvents);
		const recentEvents = this.recentEvents;
		if (!recentEvents) {
			return undefined;
		}
		return archivedEvents ? archivedEvents.concat(recentEvents) : recentEvents;
	}

	async restoreFromArchive(archive: ArchivedSession) : Promise<void> {
		this.bootstrappingChannels = new Set<number>(archive.channels);
		let completedBootstrapping: () => void;
		this.bootstrappingPromise = new Promise<void>(resolve => completedBootstrapping = resolve);
		// Read each event and dispatch the appropriate event in order
		const events = archive.events;
		this.currentEvents = events;
		const firstEvent = events[0];
		if (typeof firstEvent == "boolean") {
			this.updateOpenServerChannelStatus(firstEvent);
		}
		this.run();
		for (let event of events) {
			if (typeof event == "boolean") {
				this.updateOpenServerChannelStatus(event);
				continue;
			}
			const channelId = event[0];
			if (channelId < 0) {
				this.dispatchClientEvent(event);
			} else {
				if (this.recentEvents) {
					this.recentEvents.push(event);
				}
				const callback = this.localChannels.get(channelId);
				if (callback) {
					logOrdering("server", "message", channelId, this.sessionID);
					callback(event);
				}
			}
			await defer();
		}
		this.currentEvents = undefined;
		this.recentEvents = archive.events;
		this.bootstrappingChannels = undefined;
		this.bootstrappingPromise = undefined;
		completedBootstrapping!();
	}
};

function noCache(res: express.Response) {
	res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
	res.header("Expires", new Date(0).toUTCString());
	res.header("Pragma", "no-cache");
}

function migrateChildren(fromNode: Node, toNode: Node) {
	let firstChild: Node | null;
	while (firstChild = fromNode.firstChild) {
		toNode.appendChild(firstChild);
	}
}

(async () => {
	const serverJSPath = relativePath("../src/app.js");

	const htmlPath = relativePath("../../public/index.html");
	const htmlContents = readFile(htmlPath);

	const secretsPath = relativePath("../../secrets.json");
	const secrets = readFile(secretsPath);

	// Check if we can reuse existing sessions
	let lastGraceful = 0;
	try {
		lastGraceful = (await stat("sessions/.graceful")).mtimeMs;
	} catch (e) {
	}
	if (lastGraceful < (await stat(serverJSPath)).mtimeMs) {
		await rimraf("sessions");
		await mkdir("sessions");
	} else {
		await unlink("sessions/.graceful");
	}

	//(global.module as any).paths as string[]
	const modulePaths = [relativePath("../server"), relativePath("../common"), relativePath("../../preact/dist")];

	const host = new Host(serverJSPath, modulePaths, htmlPath, (await htmlContents).toString(), JSON.parse((await secrets).toString()));
	// host.newClient({
	// 	headers: []
	// } as any as express.Request).then(client => client.session.run());

	function messageFromBody(body: { [key: string]: any }) : ClientMessage {
		const message: ClientMessage = {
			sessionID: body.sessionID || "",
			messageID: (body.messageID as number) | 0,
			clientID: (body.clientID as number) | 0,
			events: body.events ? JSON.parse("[" + body.events + "]") : []
		}
		if ("close" in body) {
			message.close = (body.close | 0) == 1;
		}
		if ("destroy" in body) {
			message.destroy = true;
		}
		return message;
	}

	server.use(bodyParser.urlencoded({
		extended: true,
		type: () => true // Accept all MIME types
	}));

	server.get("/", (request, response) => {
		(async () => {
			const sessionID = request.query.sessionID;
			let session: Session;
			let client: Client;
			if (sessionID) {
				// Joining existing session, must render document even if prerendering is disabled
				session = await host.sessionFromId(sessionID, request);
				client = session.newClient(request);
			} else if ((host.renderingMode < RenderingMode.Prerendering) && !Client.requestRequiresForcedEmulation(request)) {
				// Not prerendering or joining a session, just return the original source
				return host.htmlSource;
			} else {
				client = await host.newClient(request);
				session = client.session;
			}
			session.updateOpenServerChannelStatus(true);
			if (client.renderingMode >= RenderingMode.Prerendering) {
				// Prerendering was enabled, wait for content to be ready
				client.incomingMessageId++;
				client.outgoingMessageId++;
				await session.pageRenderer.render();
			}
			// Steal events when using forced emulation
			if (client.renderingMode == RenderingMode.ForcedEmulation) {
				client.queuedLocalEvents = undefined;
			}
			// Render the DOM into HTML source
			return await session.pageRenderer.generateHTML(client);
		})().then(async html => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			// Return HTML
			noCache(response);
			response.set("Content-Type", "text/html");
			response.send(html);
		}, async e => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			// Internal error of some kind
			response.status(500);
			response.set("Content-Type", "text/plain");
			response.send(util.inspect(e));
		});
	});

	server.post("/", (req: express.Request, res: express.Response) => {
		(async () => {
			noCache(res);
			const body = req.body;
			const message = messageFromBody(body);
			if (message.destroy) {
				// Destroy the client's session (this is navigator.sendBeacon)
				await host.destroyClientById(message.sessionID || "", message.clientID as number | 0);
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				res.set("Content-Type", "text/plain");
				res.send("");
				return;
			}
			const client = await (body.sessionID ? host.clientFromMessage(message, req) : host.newClient(req, RenderingMode.FullEmulation));
			if (client.renderingMode >= RenderingMode.FullEmulation) {
				const postback = body["postback"];
				if (postback) {
					const isJavaScript = postback == "js";
					// JavaScript is disabled, emulate events from form POST
					const session = client.session;
					const inputEvents: Event[] = [];
					const buttonEvents: Event[] = [];
					message.noJavaScript = true;
					for (let key in body) {
						if (!Object.hasOwnProperty.call(body, key)) {
							continue;
						}
						const match = key.match(/^channelID(\d+)$/);
						if (match && Object.hasOwnProperty.call(body, key)) {
							const element = session.pageRenderer.body.querySelector("[name=\"" + key + "\"]");
							if (element) {
								const event: Event = [-match[1], { value: body[key] }];
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
					// Process the faked message normally
					await client.receiveMessage(message);
					if (isJavaScript) {
						// Wait for events to be ready
						await client.dequeueEvents();
					} else {
						// client.produceMessage();
						// Wait for content to be ready
						await session.pageRenderer.render();
					}
					// Render the DOM into HTML source
					const html = await session.pageRenderer.generateHTML(client, isJavaScript);
					let responseContent = html;
					if (isJavaScript) {
						if (client.lastSentFormHTML) {
							const diff = diff_match_patch_node.patch_toText(diff_match_patch_node.patch_make(client.lastSentFormHTML, html));
							if (diff.length < html.length) {
								responseContent = diff;
							}
						}
						client.lastSentFormHTML = html;
					}
					client.queuedLocalEvents = undefined;
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					res.set("Content-Type", isJavaScript ? "text/plain" : "text/html");
					res.send(responseContent);
					return;
				}
			}
			// Dispatch the events contained in the message
			await client.receiveMessage(message);
			// Wait for events to be ready
			await client.dequeueEvents();
			// Send the serialized response message back to the client
			const responseMessage = serializeMessageAsText(client.produceMessage());
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			res.set("Content-Type", "text/plain");
			res.send(responseMessage);
		})().catch(async e => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			res.status(500);
			res.set("Content-Type", "text/plain");
			res.send(util.inspect(e));
		});
	});

	expressWs(server);
	(server as any).ws("/", (ws: any, req: express.Request) => {
		// WebSockets protocol implementation
		(async () => {
			let closed = false;
			ws.on("error", () => {
				ws.close();
			});
			ws.on("close", () => {
				closed = true;
			});
			// Get the startup message contained in the WebSocket URL (avoid extra round trip to send events when websocket is opened)
			const startMessage = messageFromBody(req.query);
			const client = await host.clientFromMessage(startMessage, req);
			// Track what the last sent/received message IDs are so we can avoid transmitting them
			let lastIncomingMessageId = startMessage.messageID;
			let lastOutgoingMessageId = -1;
			async function processSocketMessage(message: ClientMessage) {
				if (typeof message.close == "boolean") {
					// Determine if client accepted our close instruction
					if (closed = message.close) {
						ws.close();
					}
				}
				try {
					await client.receiveMessage(message);
					await processMoreEvents();
				} catch (e) {
					ws.close();
				}
			}
			let processingEvents = false;
			async function processMoreEvents() {
				// Dequeue response messages in a loop until socket is closed
				while (!processingEvents && !closed) {
					processingEvents = true;
					const keepGoing = await client.dequeueEvents();
					processingEvents = false;
					if (!closed) {
						const message = client.produceMessage();
						if (lastOutgoingMessageId == message.messageID) {
							delete message.messageID;
						}
						lastOutgoingMessageId = client.outgoingMessageId;
						if (client.session.localChannelCount == 0 || !keepGoing) {
							message.close = true;
							closed = true;
						}
						const serialized = serializeMessageAsText(message);
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						ws.send(serialized);
					}
				}
			}
			// Process incoming messages
			ws.on("message", (msg: string) => {
				const message = deserializeMessageFromText<ClientMessage>(msg, lastIncomingMessageId + 1);
				lastIncomingMessageId = message.messageID;
				processSocketMessage(message);
			});
			processSocketMessage(startMessage);
		})().catch(e => {
			console.error(e);
			ws.close();
		});
	});

	server.use(express.static(relativePath("../../public")));

	const port = 3000;
	const acceptSocket = server.listen(port, () => {
		console.log(`Listening on port ${port}...`);
		// (server as any).on("close", () => {
		// });
	});

	// Graceful shutdown
	process.on("SIGTERM", onInterrupted);
	process.on("SIGINT", onInterrupted);
	function onInterrupted() {
		process.removeListener("SIGTERM", onInterrupted);
		process.removeListener("SIGINT", onInterrupted);
		console.log("Exiting...");
		acceptSocket.close((err: any) => {
			if (err) {
				escape(err);
			}
		});
		host.destroy().catch(escape);
	}

})().catch(escape);
