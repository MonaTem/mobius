#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import * as util from "util";
import * as crypto from "crypto";
const Module = require("module");

import * as express from "express";
import * as bodyParser from "body-parser";

import * as uuid from "uuid";
import { JSDOM } from "jsdom";

import { diff_match_patch } from "diff-match-patch";
const diff_match_patch_node = new (require("diff-match-patch-node") as typeof diff_match_patch);

import { JsonValue, Channel } from "mobius-types";
import * as mobius from "mobius";
import { loadModule, SandboxModule } from "./host/sandbox";
import { PageRenderer, PageRenderMode } from "./host/page-renderer";
import clientCompile from "./host/client-compiler";
import * as csrf from "./host/csrf";
import { packageRelative, readFile, writeFile, mkdir, unlink, rimraf, stat, exists, readJSON } from "./host/fileUtils";

import { interceptGlobals, FakedGlobals } from "./common/determinism";
import { logOrdering, roundTrip, eventForValue, eventForException, parseValueEvent, serializeMessageAsText, deserializeMessageFromText, disconnectedError, Event, ServerMessage, ClientMessage, BootstrapData } from "./common/_internal";

import patchJSDOM from "./host/jsdom-patch";

import * as commandLineArgs from "command-line-args";

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

interface MobiusGlobalProperties {
	document: Document,
	request: express.Request,
}

class Host {
	sessions = new Map<string, Session>();
	destroying: boolean = false;
	scriptPath: string;
	scriptURL: string;
	hostname?: string;
	serverModulePaths: string[];
	modulePaths: string[];
	internalModulePath: string;
	htmlSource: string;
	dom: JSDOM;
	document: Document;
	noscript: Element;
	metaRedirect: Element;
	staleSessionTimeout: any;
	secrets: JsonValue;
	allowMultipleClientsPerSession: boolean;
	sessionsPath: string;
	constructor(scriptPath: string, scriptURL: string, serverModulePaths: string[], modulePaths: string[], sessionsPath: string, htmlSource: string, secrets: JsonValue, allowMultipleClientsPerSession: boolean, hostname?: string) {
		this.destroying = false;
		this.allowMultipleClientsPerSession = allowMultipleClientsPerSession;
		this.secrets = secrets;
		this.sessionsPath = sessionsPath;
		this.htmlSource = htmlSource;
		this.dom = new (require("jsdom").JSDOM)(htmlSource) as JSDOM;
		this.document = (this.dom.window as Window).document as Document;
		this.noscript = this.document.createElement("noscript");
		this.metaRedirect = this.document.createElement("meta");
		this.metaRedirect.setAttribute("http-equiv", "refresh");
		this.noscript.appendChild(this.metaRedirect);
		this.scriptPath = scriptPath;
		this.scriptURL = scriptURL;
		this.serverModulePaths = serverModulePaths;
		this.modulePaths = modulePaths;
		this.hostname = hostname;
		// Client-side emulation
		patchJSDOM(this.document);
		// Session timeout
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
	async sessionFromId(sessionID: string | undefined, request: express.Request, allowNewSession: boolean) {
		if (!sessionID) {
			throw new Error("No session ID specified!");
		}
		let session = this.sessions.get(sessionID);
		if (session) {
			return session;
		}
		if (!this.destroying) {
			if (this.allowMultipleClientsPerSession) {
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
			if (allowNewSession) {
				session = new Session(this, sessionID, request);
				session.newClient(request);
				this.sessions.set(sessionID, session);
				return session;
			}
		}
		throw new Error("Session ID is not valid: " + sessionID);
	}
	pathForSessionId(sessionId: string) {
		return path.join(this.sessionsPath, encodeURIComponent(sessionId) + ".json");
	}
	async clientFromMessage(message: ClientMessage, request: express.Request, allowNewSession: boolean) {
		const clientID = message.clientID as number | 0;
		const session = await this.sessionFromId(message.sessionID, request, allowNewSession && message.messageID == 0 && clientID == 0);
		let client = session.clients.get(clientID);
		if (!client) {
			throw new Error("Client ID is not valid: " + message.clientID);
		}
		client.request = request;
		session.request = request;
		return client;
	}
	async newClient(request: express.Request) {
		if (this.destroying) {
			throw new Error("Cannot create new client while shutting down!");
		}
		for (;;) {
			const sessionID = uuid();
			if (!this.sessions.has(sessionID) && (!this.allowMultipleClientsPerSession || !await exists(this.pathForSessionId(sessionID)))) {
				const session = new Session(this, sessionID, request);
				this.sessions.set(sessionID, session);
				return session.newClient(request);
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
		this.destroying = true;
		clearInterval(this.staleSessionTimeout);
		const promises: Promise<void>[] = [];
		for (let session of this.sessions.values()) {
			promises.push(session.destroy());
		}
		await Promise.all(promises);
	}
}

class Client {
	session: Session;
	request: express.Request;
	clientID: number;
	incomingMessageId: number = 0;
	outgoingMessageId: number = 0;
	reorderedMessages: { [messageId: number]: ClientMessage } = {};
	queuedLocalEvents: Event[] | undefined;
	queuedLocalEventsResolve: ((shouldContinue: true | void) => void) | undefined;
	localResolveTimeout: NodeJS.Timer | undefined;
	willSynchronizeChannels = false;
	lastSentFormHTML?: string;
	pendingCookies?: [string, string][];
	clientIsActive?: true;

	constructor(session: Session, request: express.Request, clientID: number) {
		this.session = session;
		this.request = request;
		this.clientID = clientID;
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

	produceMessage(close: boolean) : Partial<ServerMessage> {
		const result: Partial<ServerMessage> = { messageID: this.outgoingMessageId++ };
		if (close) {
			result.close = true;
		}
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
			} else if (this.session.localChannelCount) {
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

	setCookie(key: string, value: string) {
		const cookies = this.pendingCookies || (this.pendingCookies = []);
		cookies.push([key, value]);
	}
	applyCookies(response: express.Response) {
		const cookies = this.pendingCookies;
		if (cookies) {
			this.pendingCookies = undefined;
			for (let [ key, value ] of cookies) {
				response.cookie(key, value);
			}
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

const bakedModules: { [moduleName: string]: (session: Session) => any } = {
	mobius: (session: Session) => session.mobius,
	request: (session: Session) => session.request,
	setCookie: (session: Session) => session.setCookie.bind(session),
	document: (session: Session) => session.globalProperties.document,
	head: (session: Session) => session.pageRenderer.head,
	body: (session: Session) => session.pageRenderer.body,
	secrets: (session: Session) => session.host.secrets,
};

// Hack so that Module._findPath will find TypeScript files
Module._extensions[".ts"] = Module._extensions[".tsx"] = function() {}

// Lazy version of loadModule so that the sandbox module is loaded on first use
let loadModuleLazy: typeof loadModule = (path, module, globalProperties, require) => {
	loadModuleLazy = require("./host/sandbox").loadModule as typeof loadModule;
	return loadModuleLazy(path, module, globalProperties, require);
}

class Session {
	host: Host;
	sessionID: string;
	dead: boolean = false;
	// Script context
	modules = new Map<string, SandboxModule>();
	mobius: typeof mobius;
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
	prerenderChannelCount: number = 0;
	prerenderCompleted?: Promise<void>;
	completePrerender?: () => void;
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
		this.pageRenderer = new PageRenderer(this.host.dom, this.host.noscript, this.host.metaRedirect, this.host.scriptURL);
		// Server-side version of the API
		this.mobius = {
			disconnect: () => this.destroy().catch(escape),
			dead: false,
			createClientPromise: this.createClientPromise,
			createServerPromise: this.createServerPromise,
			createClientChannel: this.createClientChannel,
			createServerChannel: this.createServerChannel,
			coordinateValue: this.coordinateValue,
			synchronize: () => this.createServerPromise(() => undefined),
			flush: async () => {
				if (this.dead) {
					throw disconnectedError();
				}
				this.scheduleSynchronize();
				return resolvedPromise;
			},
			shareSession: this.shareSession
		};
		this.request = request;
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: this.host.document,
			request: this.request
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, this.createServerChannel);
		if (this.host.allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	newClient(request: express.Request) {
		const newClientId = this.currentClientID++;
		if (this.sharingEnabled || (newClientId == 0)) {
			const result = new Client(this, request, newClientId);
			this.request = request;
			this.clients.set(newClientId, result);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}

	hasCapableClient() {
		for (const client of this.clients) {
			if (client[1].clientIsActive) {
				return true;
			}
		}
		return false;
	}

	loadModule(path: string, newModule: SandboxModule, allowNodeModules: boolean) {
		loadModuleLazy(path, newModule, this.globalProperties, (name: string) => {
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
				this.loadModule(modulePath, subModule, !!Module._findPath(name, this.host.serverModulePaths));
				return subModule.exports;
			}
			const result = require(name);
			if (!allowNodeModules) {
				var e = new Error(`Cannot access module '${name}' in this context`);
				(e as any).code = "MODULE_NOT_FOUND";
				throw e;
			}
			return result;
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
			}, false);
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

	enterLocalChannel(delayPrerender: boolean = true) : number {
		if (delayPrerender) {
			++this.prerenderChannelCount;
		}
		return ++this.localChannelCount;
	}
	exitLocalChannel(resumePrerender: boolean = true) : number {
		if (resumePrerender) {
			if (--this.prerenderChannelCount == 0) {
				defer().then(() => {
					if (this.completePrerender) {
						this.completePrerender();
						delete this.completePrerender;
						delete this.prerenderCompleted;
					}
				});
			}
		}
		return --this.localChannelCount;
	}
	waitForPrerender() : Promise<void> {
		if (this.prerenderCompleted) {
			return this.prerenderCompleted;
		}
		this.enterLocalChannel();
		this.run();
		defer().then(() => this.exitLocalChannel());
		return this.prerenderCompleted = new Promise<void>(resolve => {
			this.completePrerender = resolve;
		});
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
	createServerPromise = <T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender: boolean = true) => {
		if (!this.insideCallback) {
			return new Promise<T>(resolve => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		let channelId = ++this.localChannelCounter;
		const exit = escaping(() => {
			if (channelId != -1) {
				this.localChannels.delete(channelId);
				channelId = -1;
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
				const event = eventForValue(channelId, value);
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
						this.sendEvent(event);
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					const roundtripped = roundTrip(value);
					this.enteringCallback();
					resolve(roundtripped);
				}
			}).catch(async error => {
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
	createServerChannel = <T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let state: U | undefined;
		if (!this.insideCallback) {
			// Not coordinating
			let open = true;
			try {
				const potentialState = onOpen(function() {
					if (open) {
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
	createClientPromise = <T extends JsonValue | void>(fallback?: () => Promise<T> | T) => {
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
				}).catch(async error => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForException(-channel.channelId, error));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	createClientChannel = <T extends Function>(callback: T) => {
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
				const event = eventForValue(channelId, value);
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(event);
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
			if (!this.host.allowMultipleClientsPerSession) {
				throw new Error("Sharing has been disabled!");
			}
			this.sharingEnabled = true;
			const request: express.Request = this.request;
			return request.protocol + "://" + (this.host.hostname || request.get("host")) + request.url.replace(/(\.websocket)?\?.*$/, "") + "?sessionID=" + this.sessionID;
		});
		const result = await server;
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		return result;
	}

	setCookie(key: string, value: string) {
		for (const client of this.clients.values()) {
			client.setCookie(key, value);
		}
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
			for (const client of this.clients.values()) {
				await client.destroy();
			}
			this.host.sessions.delete(this.sessionID);
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

function noCache(response: express.Response) {
	response.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
	response.header("Expires", new Date(0).toUTCString());
	response.header("Pragma", "no-cache");
}

async function topFrameHTML(response: express.Response, html: string) {
	if (simulatedLatency) {
		await delay(simulatedLatency);
	}
	// Return HTML
	noCache(response);
	response.set("Content-Security-Policy", "frame-ancestors 'none'");
	response.set("Content-Type", "text/html");
	response.send(html);
}

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

interface Config {
	sourcePath: string;
	secrets: { [key: string]: any };
	sessionsPath?: string;
	allowMultipleClientsPerSession?: boolean;
	minify?: boolean;
	sourceMaps?: boolean;
	hostname?: string;
}

function defaultSessionPath(sourcePath: string) {
	return path.join(sourcePath, ".sessions");
}

export async function prepare({ sourcePath, sessionsPath = defaultSessionPath(sourcePath), secrets, allowMultipleClientsPerSession = true, minify = false, sourceMaps, hostname }: Config) {
	let serverJSPath: string;
	const packagePath = path.resolve(sourcePath, "package.json");
	if (await exists(packagePath)) {
		serverJSPath = path.resolve(sourcePath, (await readJSON(packagePath)).main);
	} else {
		const foundPath = Module._findPath("app", [sourcePath]);
		if (!foundPath) {
			throw new Error("Could not find app.ts or app.tsx in " + sourcePath);
		}
		serverJSPath = foundPath;
	}

	const htmlPath = packageRelative("public/index.html");
	const htmlContents = readFile(htmlPath);

	const gracefulPath = path.join(sessionsPath, ".graceful");

	// Check if we can reuse existing sessions
	let lastGraceful = 0;
	try {
		lastGraceful = (await stat(gracefulPath)).mtimeMs;
	} catch (e) {
	}
	if (lastGraceful < (await stat(serverJSPath)).mtimeMs) {
		await rimraf(sessionsPath);
		await mkdir(sessionsPath);
	} else {
		await unlink(gracefulPath);
	}

	const serverModulePaths = [packageRelative("server"), path.join(sourcePath, "server")];
	const modulePaths = serverModulePaths.concat([packageRelative("common"), packageRelative("dist/common"), path.join(sourcePath, "common")]);

	const clientScript = await (require("./host/client-compiler").default as typeof clientCompile)(serverJSPath, sourcePath, minify);
	const clientURL = "/" + crypto.createHash("sha1").update(clientScript.code).digest("hex").substr(16) + ".js";
	const host = new Host(serverJSPath, clientURL, serverModulePaths, modulePaths, sessionsPath, (await htmlContents).toString(), secrets, allowMultipleClientsPerSession, hostname);

	// Render default state with noscript URL added
	const defaultRenderedHTML = new PageRenderer(host.dom, host.noscript, host.metaRedirect, clientURL).render(PageRenderMode.Bare, { clientID: 0, incomingMessageId: 0 }, { sessionID: "", localChannelCount: 0 }, "/?js=no");

	return {
		install(server: express.Express) {
			server.use(bodyParser.urlencoded({
				extended: true,
				type: () => true // Accept all MIME types
			}));

			server.get("/", async (request, response) => {
				try {
					const sessionID = request.query.sessionID;
					let session: Session;
					let client: Client;
					if (sessionID) {
						// Joining existing session
						session = await host.sessionFromId(sessionID, request, false);
						client = session.newClient(request);
						client.incomingMessageId++;
					} else {
						// Not prerendering or joining a session, just return the original source with the noscript added
						if (request.query["js"] !== "no") {
							return await topFrameHTML(response, defaultRenderedHTML);
						}
						// New session
						client = await host.newClient(request);
						session = client.session;
					}
					session.updateOpenServerChannelStatus(true);
					// Prerendering was enabled, wait for content to be ready
					client.outgoingMessageId++;
					await session.waitForPrerender();
					// Read bootstrap data
					const queuedLocalEvents = await session.readAllEvents() || client.queuedLocalEvents;
					const bootstrapData: BootstrapData = { sessionID: session.sessionID, channels: Array.from(session.pendingChannels.keys()) };
					if (queuedLocalEvents) {
						client.queuedLocalEvents = undefined;
						bootstrapData.events = queuedLocalEvents;
					}
					if (client.clientID) {
						bootstrapData.clientID = client.clientID;
					}
					client.incomingMessageId++;
					// Render the DOM into HTML source
					const html = session.pageRenderer.render(PageRenderMode.IncludeForm, client, session, undefined, bootstrapData);
					client.applyCookies(response);
					return topFrameHTML(response, html);
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					// Internal error of some kind
					response.status(500);
					response.set("Content-Type", "text/plain");
					response.set("Content-Security-Policy", "frame-ancestors 'none'");
					response.send(util.inspect(e));
				}
			});

			server.post("/", async (request, response) => {
				try {
					csrf.validate(request, hostname);
					const body = request.body;
					const message = messageFromBody(body);
					if (message.destroy) {
						// Destroy the client's session (this is navigator.sendBeacon)
						await host.destroyClientById(message.sessionID || "", message.clientID as number | 0);
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						noCache(response);
						response.set("Content-Type", "text/plain");
						response.send("");
						return;
					}
					const postback = body["postback"];
					let client: Client;
					if (!message.sessionID && postback == "js") {
						client = await host.newClient(request);
					} else {
						client = await host.clientFromMessage(message, request, !postback);
					}
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
							// Wait for content to be ready
							await session.waitForPrerender();
						}
						// Render the DOM into HTML source
						const html = session.pageRenderer.render(PageRenderMode.IncludeFormAndStripScript, client, session);
						let responseContent = html;
						if (isJavaScript) {
							if (client.lastSentFormHTML) {
								const diff = diff_match_patch_node.patch_toText(diff_match_patch_node.patch_make(client.lastSentFormHTML, html));
								if (diff.length < html.length && diff.length) {
									responseContent = diff;
								}
							}
							client.lastSentFormHTML = html;
						}
						client.queuedLocalEvents = undefined;
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", isJavaScript ? "text/plain" : "text/html");
						response.set("Content-Security-Policy", "frame-ancestors 'none'");
						response.send(responseContent);
					} else {
						client.clientIsActive = true;
						// Dispatch the events contained in the message
						await client.receiveMessage(message);
						// Wait for events to be ready
						const keepGoing = await client.dequeueEvents();
						// Send the serialized response message back to the client
						const responseMessage = serializeMessageAsText(client.produceMessage(!keepGoing));
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", "text/plain");
						response.send(responseMessage);
					}
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					response.status(500);
					noCache(response);
					response.set("Content-Type", "text/plain");
					response.send(util.inspect(e));
				};
			});

			require("express-ws")(server);
			(server as any).ws("/", async (ws: any, request: express.Request) => {
				// WebSockets protocol implementation
				try {
					csrf.validate(request, hostname);
					let closed = false;
					ws.on("error", () => {
						ws.close();
					});
					ws.on("close", () => {
						closed = true;
					});
					// Get the startup message contained in the WebSocket URL (avoid extra round trip to send events when websocket is opened)
					const startMessage = messageFromBody(request.query);
					const client = await host.clientFromMessage(startMessage, request, true);
					client.clientIsActive = true;
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
								const message = client.produceMessage(!keepGoing);
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
					await processSocketMessage(startMessage);
				} catch (e) {
					console.error(e);
					ws.close();
				}
			});

			server.use("/fallback.js", (require("express") as typeof express).static(packageRelative("dist/fallback.js")));
			server.get("/client.js", async (request: express.Request, response: express.Response) => {
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				response.set("Content-Type", "text/javascript");
				if (sourceMaps) {
					response.set("SourceMap", "/client.js.map");
				}
				response.send(clientScript.code);
			});
			server.get(clientURL, async (request: express.Request, response: express.Response) => {
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				response.set("Content-Type", "text/javascript");
				response.set("Cache-Control", "max-age=31536000");
				response.set("Expires", "Sun, 17 Jan 2038 19:14:07 GMT");
				if (sourceMaps) {
					response.set("SourceMap", "/client.js.map");
				}
				response.send(clientScript.code);
			});
			if (sourceMaps) {
				server.get("/client.js.map", async (request: express.Request, response: express.Response) => {
					response.set("Content-Type", "application/json");
					response.send(clientScript.map);
				});
			}
		},
		async stop() {
			await host.destroy();
			await writeFile(gracefulPath, "");
		}
	};
}

export default function main() {
	(async () => {
		const cwd = process.cwd();
		const args = commandLineArgs([
			{ name: "port", type: Number, defaultValue: 3000 },
			{ name: "base", type: String, defaultValue: cwd },
			{ name: "minify", type: Boolean, defaultValue: false },
			{ name: "source-map", type: Boolean, defaultValue: false },
			{ name: "hostname", type: String },
			{ name: "init", type: Boolean, defaultValue: false },
			{ name: "help", type: Boolean }
		]);
		if (args.help) {
			console.log(require("command-line-usage")([
				{
					header: "Mobius",
					content: "Unified frontend and backend framework for building web apps"
				},
				{
					header: "Options",
					optionList: [
						{
							name: "init",
							description: "Initialize a new mobius project"
						},
						{
							name: "port",
							typeLabel: "[underline]{number}",
							description: "The port number to listen on"

						},
						{
							name: "base",
							typeLabel: "[underline]{path}",
							description: "The base path of the app to serve"
						},
						{
							name: "minify",
							description: "Minify JavaScript code served to the browser",
						},
						{
							name: "source-map",
							description: "Expose source maps for debugging in supported browsers",
						},
						{
							name: "hostname",
							typeLabel: "[underline]{name}",
							description: "Public hostname to serve content from; used to validate CSRF if set",
						},
						{
							name: "help",
							description: "Prints this usage guide. Yahahah! You found me!"
						}
					]
				},
				{
					content: "Project home: [underline]{https://github.com/rpetrich/mobius}"
				}
			]));
			process.exit(1);
		}

		if (args.init) {
			try {
				await require("./host/init").default(args.base);
			} catch (e) {
				if (e instanceof Error && e.message === "canceled") {
					process.exit(1);
				}
				throw e;
			}
			process.exit(0);
		}

		const basePath = path.resolve(cwd, args.base as string);

		let secrets = {};
		try {
			secrets = await readJSON(path.join(basePath, "secrets.json"));
		} catch (e) {
		}
		const mobius = await prepare({
			sourcePath: basePath,
			secrets,
			minify: args.minify as boolean,
			sourceMaps: args["source-map"] as boolean,
			hostname: args.hostname as string | undefined
		});

		const expressAsync = require("express") as typeof express;
		const server = expressAsync();

		server.disable("x-powered-by");
		server.disable("etag");

		mobius.install(server);

		server.use(expressAsync.static(path.join(basePath, "public")));

		const port = args.port;
		const hostname = args.hostname;
		const acceptSocket = server.listen(port, () => {
			const publicURL = typeof hostname == "string" ? "http://" + hostname : "http://localhost:" + port;
			console.log(`Serving ${basePath} on ${publicURL}`);
		});

		// Graceful shutdown
		process.on("SIGTERM", onInterrupted);
		process.on("SIGINT", onInterrupted);
		async function onInterrupted() {
			process.removeListener("SIGTERM", onInterrupted);
			process.removeListener("SIGINT", onInterrupted);
			const acceptSocketClosed = new Promise(resolve => {
				acceptSocket.close(resolve);
			});
			await mobius.stop();
			await acceptSocketClosed;
			process.exit(0);
		}

		server.get("/term", async (request, response) => {
			response.send("exiting");
			const acceptSocketClosed = new Promise(resolve => {
				acceptSocket.close(resolve);
			});
			await mobius.stop();
			await acceptSocketClosed;
		});

	})().catch(escape);
}

if (require.main === module) {
	main();
}
